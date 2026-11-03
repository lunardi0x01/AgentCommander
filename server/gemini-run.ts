// A Gemini session Agent Commander runs: one Antigravity ACP server process
// per session, kept up between messages like a Claude run (runner.ts owns
// both kinds and talks to them through the same methods).
//
// Unlike Claude, there is no transcript file we can cheaply follow, so the
// run keeps the whole conversation in memory (replayed by session/load, then
// grown by live updates) and sessions.ts reads it from here while it runs.
//
// Claude Code features mapped onto ACP:
// - Permission modes: Ask → default, Accept edits → auto_edit, Bypass → yolo.
//   Plan has no ACP mode: we prefix prompts with agy's /plan command, and when
//   the turn has written a plan.md we offer it for approval like ExitPlanMode.
// - Effort → thinking_level (low/medium/high); model → the model config option.
// - agy's questions (ask_question) arrive as permission requests whose options
//   are the answers; they are shown as AskUserQuestion (single choice).

import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import type { EffortLevel, PermissionMode, PermissionRequest, RunState, SessionSettings } from "../shared/types.ts";
import { AcpConnection } from "./acp.ts";
import { toolFromCall, Transcript, userBlocks } from "./gemini-transcript.ts";
import { BRAIN_DIR, rememberContext, rememberModels } from "./gemini.ts";

const IDLE_CLOSE_MS = 15 * 60 * 1000;
const MESSAGES_THROTTLE_MS = 120;

// Our permission modes as ACP session modes.
const ACP_MODE: Partial<Record<PermissionMode, string>> = {
  default: "default",
  acceptEdits: "auto_edit",
  bypassPermissions: "yolo",
  plan: "default", // plus the /plan prefix
};
export const GEMINI_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

const PLAN_APPROVED = "The plan is approved. Go ahead and carry it out.";

export interface RunHooks {
  state: (id: string, state: RunState | null) => void;
  messages: (id: string) => void;
  ended: (id: string) => void;
}

interface AcpOption {
  optionId: string;
  name?: string;
  kind?: string;
}

interface Pending {
  request: PermissionRequest;
  options: AcpOption[];
  question: boolean;
  resolve: (result: unknown) => void;
}

type Content = string | Array<Record<string, unknown>>;

// Claude-style message content (text, or blocks from attachments.ts) as an ACP prompt.
export function acpPrompt(content: Content): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((b) => {
    const source = b.source as { data?: string; media_type?: string } | undefined;
    if (b.type === "image") return { type: "image", mimeType: source?.media_type, data: source?.data };
    if (b.type === "document") {
      const name = String(b.title ?? "document.pdf");
      return { type: "resource", resource: { uri: `file:///attachments/${encodeURIComponent(name)}`, mimeType: source?.media_type, blob: source?.data } };
    }
    return { type: "text", text: String(b.text ?? "") };
  });
}

export class GeminiRun {
  state: RunState = { status: "starting", draft: [], permissions: [] };
  readonly transcript = new Transcript();
  id: string;
  private conn: AcpConnection | null = null;
  private session: Promise<void>; // the connection is up and the session exists
  private ready: Promise<void>; // …and the picked settings are applied
  private queue: Content[] = [];
  private turn: Promise<void> | null = null;
  private pumping = false;
  private pending = new Map<string, Pending>();
  private permissionCount = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private messagesTimer: NodeJS.Timeout | null = null;
  private interrupted = false;
  private turnStarted = 0;
  private closed = false;

  readonly dir: string;
  private hooks: RunHooks;

  // `id` null: create a new session (its id is known once `started()` resolves).
  constructor(id: string | null, dir: string, settings: SessionSettings, hooks: RunHooks) {
    this.id = id ?? "";
    this.dir = dir;
    this.hooks = hooks;
    this.state.mode = settings.mode && GEMINI_MODES.includes(settings.mode) ? settings.mode : "default";
    this.session = this.open(id);
    this.ready = this.session.then(() => this.start(settings));
    this.ready.catch((err) => this.fail(err instanceof Error ? err.message : String(err)));
  }

  // Resolves with the session id once the session exists (new) or is loaded.
  async started(): Promise<string> {
    await this.ready;
    return this.id;
  }

  private async open(id: string | null): Promise<void> {
    this.conn = await AcpConnection.open(this.dir, {
      onUpdate: (sessionId, update) => this.onUpdate(sessionId, update),
      onRequest: (method, params) => this.onRequest(method, params),
      onExit: (error) => this.onExit(error),
    });
    const result = id
      ? await this.conn.request("session/load", { sessionId: id, cwd: this.dir, mcpServers: [] })
      : await this.conn.request("session/new", { cwd: this.dir, mcpServers: [] });
    if (!id) this.id = String(result.sessionId);
    rememberModels(result);
    const config = (result.configOptions ?? []) as Array<{ id: string; currentValue?: string }>;
    const current = (key: string) => config.find((o) => o.id === key)?.currentValue;
    this.state.model = current("model");
    this.state.effort = (current("thinking_level") as EffortLevel | undefined) ?? null;
    this.transcript.live = true; // from now on messages get timestamps
  }

  private async start(settings: SessionSettings): Promise<void> {
    const mode = this.state.mode;
    this.state.mode = undefined; // so apply() sets it on the new process
    await this.apply({ ...settings, mode });
    this.update({ status: "idle" });
    this.emitMessages();
    if (!this.queue.length) this.armIdle();
  }

  send(content: Content): void {
    this.clearIdle();
    // A message while a plan waits for approval is feedback on it: the offer goes.
    for (const [id, entry] of this.pending) if (entry.request.toolName === "ExitPlanMode") this.pending.delete(id);
    this.queue.push(content);
    if (this.state.status === "idle" || this.state.status === "error") this.update({ status: "working", error: undefined });
    void this.pump();
  }

  // Sends queued messages one turn at a time (ACP takes one prompt at a time).
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      await this.ready;
      while (this.queue.length && !this.closed) {
        const content = this.queue.shift()!;
        this.turn = this.runTurn(content);
        await this.turn;
        this.turn = null;
      }
    } catch {
      // start failed: fail() has reported it
    } finally {
      this.pumping = false;
    }
  }

  private async runTurn(content: Content): Promise<void> {
    const prompt = acpPrompt(content);
    // The user's message as they wrote it, then what agy gets.
    this.transcript.addUser(userBlocks(prompt));
    this.emitMessages();
    if (this.state.mode === "plan") {
      const text = prompt.find((b) => b.type === "text" && typeof b.text === "string" && !String(b.text).startsWith("<attached-file"));
      if (text && !String(text.text).startsWith("/")) text.text = `/plan ${text.text}`;
      else if (!text) prompt.push({ type: "text", text: "/plan" });
    }
    this.turnStarted = Date.now();
    this.interrupted = false;
    this.update({ status: "working", error: undefined });
    try {
      const result = await this.conn!.request<{ stopReason?: string; usage?: { inputTokens?: number } }>("session/prompt", {
        sessionId: this.id,
        prompt,
      });
      const stop = result.stopReason;
      const error = stop === "refusal" ? "Gemini refused to continue" : stop === "max_tokens" ? "Stopped: the reply hit its length limit" : undefined;
      if (this.queue.length) return;
      const plan = !this.interrupted && this.state.mode === "plan" ? await this.latestPlan() : null;
      if (plan) return this.offerPlan(plan);
      this.update({ status: "idle", error });
      this.armIdle();
    } catch (err) {
      if (this.closed) return;
      this.queue = [];
      this.update({ status: "idle", error: err instanceof Error ? err.message : String(err) });
      this.armIdle();
    }
  }

  // A plan.md agy wrote during this turn, under its artifact folder.
  private async latestPlan(): Promise<string | null> {
    const dir = path.join(BRAIN_DIR, this.id);
    let best: { file: string; mtime: number } | null = null;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!/plan.*\.md$/i.test(name)) continue;
      const info = await stat(path.join(dir, name)).catch(() => null);
      if (info && info.mtimeMs >= this.turnStarted - 1000 && (!best || info.mtimeMs > best.mtime)) best = { file: name, mtime: info.mtimeMs };
    }
    return best ? readFile(path.join(dir, best.file), "utf8").catch(() => null) : null;
  }

  // Shown like Claude's ExitPlanMode request: approve (switching mode) or keep planning.
  private offerPlan(plan: string): void {
    const id = `plan-${++this.permissionCount}`;
    const request: PermissionRequest = { toolUseId: id, toolName: "ExitPlanMode", input: { plan } };
    this.pending.set(id, { request, options: [], question: false, resolve: () => {} });
    this.update({ status: "waiting" });
  }

  // `answers`: for a question, question text → the chosen option's label.
  answer(toolUseId: string, allow: boolean, mode?: PermissionMode, answers?: Record<string, string>): boolean {
    const entry = this.pending.get(toolUseId);
    if (!entry) return false;
    this.pending.delete(toolUseId);
    if (entry.request.toolName === "ExitPlanMode") {
      if (allow) {
        void this.apply({ mode: mode && mode !== "plan" ? mode : "default" }).then(() => this.send(PLAN_APPROVED));
      } else {
        // Keep planning: the user says what to change in their next message.
        this.update({ status: "idle" });
        this.armIdle();
      }
      return true;
    }
    entry.resolve(this.outcome(entry, allow, answers));
    this.update({ status: this.pending.size ? "waiting" : "working" });
    return true;
  }

  private outcome(entry: Pending, allow: boolean, answers?: Record<string, string>) {
    const cancelled = { outcome: { outcome: "cancelled" } };
    const selected = (option?: AcpOption) => (option ? { outcome: { outcome: "selected", optionId: option.optionId } } : cancelled);
    if (entry.question) {
      const label = allow ? Object.values(answers ?? {})[0] : undefined;
      return selected(entry.options.find((o) => o.name === label));
    }
    if (allow) return selected(entry.options.find((o) => o.kind === "allow_once") ?? entry.options.find((o) => o.kind?.startsWith("allow")));
    return selected(entry.options.find((o) => o.kind === "reject_once") ?? entry.options.find((o) => o.kind?.startsWith("reject")));
  }

  // Permission requests and questions from agy.
  private async onRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method !== "session/request_permission") throw new Error(`Unsupported request ${method}`);
    const call = (params.toolCall ?? {}) as Record<string, unknown>;
    const options = (Array.isArray(params.options) ? params.options : []) as AcpOption[];
    const question = !call.kind && !options.some((o) => o.kind?.startsWith("reject"));
    // agy's own artifacts (plans, task lists) don't need asking, as with Claude's plan file.
    const { name, input } = toolFromCall(call);
    const file = String((input as { file_path?: string }).file_path ?? "");
    if (!question && file.startsWith(path.join(BRAIN_DIR, this.id) + path.sep)) {
      const allow = options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind?.startsWith("allow"));
      if (allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
    }
    const id = `p${++this.permissionCount}`;
    const title = typeof call.title === "string" ? call.title : undefined;
    const request: PermissionRequest = question
      ? {
          toolUseId: id,
          toolName: "AskUserQuestion",
          input: {
            questions: [{ question: title ?? "Gemini asks", options: options.map((o) => ({ label: o.name ?? o.optionId })), multiSelect: false, other: false }],
          },
        }
      : { toolUseId: id, toolName: name, input, title };
    return new Promise((resolve) => {
      this.pending.set(id, { request, options, question, resolve });
      this.update({ status: "waiting" });
    });
  }

  private onUpdate(sessionId: string, update: Record<string, unknown>): void {
    if (sessionId !== this.id && this.id) return;
    if (update.sessionUpdate === "usage_update" && typeof update.used === "number") {
      this.state.contextTokens = update.used;
      rememberContext(this.id, update.used);
      return;
    }
    if (update.sessionUpdate === "current_mode_update") return; // we track the mode we set
    if (this.transcript.apply(update)) this.scheduleMessages();
  }

  // Applies what changed: permission mode, model, effort.
  async apply(settings: SessionSettings): Promise<void> {
    await this.session;
    const conn = this.conn!;
    if (settings.mode && GEMINI_MODES.includes(settings.mode)) {
      const before = ACP_MODE[this.state.mode ?? "default"];
      if (!this.state.mode || ACP_MODE[settings.mode] !== before) {
        await conn.request("session/set_mode", { sessionId: this.id, modeId: ACP_MODE[settings.mode] });
      }
      if (settings.mode !== this.state.mode) this.update({ mode: settings.mode });
    }
    if (settings.model && settings.model !== "default" && settings.model !== this.state.model) {
      await conn.request("session/set_config_option", { sessionId: this.id, configId: "model", value: settings.model });
      this.update({ model: settings.model });
    }
    if (settings.effort && settings.effort !== this.state.effort && ["low", "medium", "high"].includes(settings.effort)) {
      await conn.request("session/set_config_option", { sessionId: this.id, configId: "thinking_level", value: settings.effort });
      this.update({ effort: settings.effort });
    }
  }

  async interrupt(): Promise<void> {
    if (!this.conn || !this.turn) return;
    this.interrupted = true;
    this.queue = [];
    // ACP: cancelling answers every open permission request with "cancelled".
    for (const [id, entry] of this.pending) {
      entry.resolve({ outcome: { outcome: "cancelled" } });
      this.pending.delete(id);
    }
    this.conn.notify("session/cancel", { sessionId: this.id });
  }

  close(): void {
    this.closed = true;
    this.clearIdle();
    this.conn?.close();
    this.hooks.ended(this.id);
    if (this.id) this.hooks.state(this.id, null);
  }

  private onExit(error?: string): void {
    if (this.closed) return;
    this.fail(error ?? "The Antigravity ACP server exited");
  }

  private fail(error: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    this.conn?.close();
    this.pending.clear();
    this.hooks.ended(this.id);
    this.update({ status: "error", error });
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleMessages(): void {
    if (this.messagesTimer) return;
    this.messagesTimer = setTimeout(() => {
      this.messagesTimer = null;
      this.emitMessages();
    }, MESSAGES_THROTTLE_MS);
  }

  private emitMessages(): void {
    if (this.id) this.hooks.messages(this.id);
  }

  private update(changes: Partial<RunState>): void {
    this.state = { ...this.state, ...changes, permissions: [...this.pending.values()].map((p) => p.request) };
    if (this.id) this.hooks.state(this.id, this.state);
  }
}

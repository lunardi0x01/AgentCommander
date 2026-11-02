// Sessions Agent Commander runs itself: one Claude Code process per session,
// driven through the Agent SDK with streaming input so it stays up between
// messages. It lives in the server, so closing the browser doesn't stop it.
//
// Completed messages reach the UI through the transcript file, like any
// session. A run adds what the file doesn't have: the message being
// streamed right now, permission requests waiting for an answer, and status.

import {
  query,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { BackendId, ChatMessage, DraftBlock, LiveStatus, PermissionMode, PermissionRequest, RunState, SessionSettings } from "../shared/types.ts";
import { CHILD_ENV, CLAUDE_PATH } from "./claude.ts";
import { GeminiRun } from "./gemini-run.ts";

// Close a run's process after this long without activity; resuming it
// later just starts a new one.
const IDLE_CLOSE_MS = 15 * 60 * 1000;
// Model when the UI doesn't pick one; unset means Claude Code's own default.
const DEFAULT_MODEL = process.env.AGENT_COMMANDER_MODEL || undefined;
// Streamed text arrives in many small pieces; send updates at most this often.
const DRAFT_THROTTLE_MS = 100;

// null: the run has ended (its process is gone).
type Listener = (id: string, state: RunState | null) => void;
const listeners: Listener[] = [];
const listener: Listener = (id, state) => listeners.forEach((fn) => fn(id, state));

// events.ts forwards run updates to open pages; the queue follows its runs.
export function onRunChange(fn: Listener): void {
  listeners.push(fn);
}

// Gemini runs keep their messages in memory; this says they changed (Claude's
// show up in the transcript file, which events.ts watches).
const messageListeners: Array<(id: string) => void> = [];
export function onRunMessages(fn: (id: string) => void): void {
  messageListeners.push(fn);
}

// The plan's usage limit, as running sessions last reported it.
export interface RateLimit {
  rejected: boolean;
  resetsAt?: number; // ms since epoch
  at: number;
}
let rateLimit: RateLimit | null = null;
let rateLimitListener: (limit: RateLimit) => void = () => {};

export function lastRateLimit(): RateLimit | null {
  return rateLimit;
}

export function onRateLimit(fn: (limit: RateLimit) => void): void {
  rateLimitListener = fn;
}

function reportRateLimit(rejected: boolean, resetsAt?: number): void {
  rateLimit = { rejected, resetsAt, at: Date.now() };
  rateLimitListener(rateLimit);
}

// An async iterable the SDK reads user messages from; push() feeds it.
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  // `content`: text, or content blocks (images, documents) with it.
  push(content: string | Array<Record<string, unknown>>): void {
    const message = { role: "user", content } as SDKUserMessage["message"];
    this.queue.push({ type: "user", message, parent_tool_use_id: null });
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: (result: PermissionResult) => void;
}

class Run {
  state: RunState = { status: "starting", draft: [], permissions: [] };
  private inbox = new Inbox();
  private query: Query;
  private pending = new Map<string, PendingPermission>();
  private idleTimer: NodeJS.Timeout | null = null;
  private draftTimer: NodeJS.Timeout | null = null;
  private interrupted = false;
  readonly id: string;

  // `isNew`: start a new session with this id instead of resuming one.
  constructor(id: string, dir: string, settings: SessionSettings, isNew: boolean) {
    this.id = id;
    this.state.effort = settings.effort;
    this.query = query({
      prompt: this.inbox,
      options: {
        cwd: dir,
        ...(isNew ? { sessionId: id } : { resume: id }),
        model: settings.model ?? DEFAULT_MODEL,
        ...(settings.effort ? { effort: settings.effort } : {}),
        // Unset: Claude Code's default from the user's settings.
        permissionMode: settings.mode,
        // Only makes Bypass selectable; it's in force only when picked.
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        systemPrompt: { type: "preset", preset: "claude_code" },
        pathToClaudeCodeExecutable: CLAUDE_PATH,
        env: CHILD_ENV,
        canUseTool: (toolName, input, options) =>
          new Promise<PermissionResult>((resolve) => {
            const request: PermissionRequest = {
              toolUseId: options.toolUseID,
              toolName,
              input,
              title: options.title,
              description: options.description,
              reason: options.decisionReason,
            };
            this.pending.set(request.toolUseId, { request, resolve });
            options.signal.addEventListener("abort", () => this.settle(request.toolUseId, null));
            this.update({ status: "waiting" });
          }),
      },
    });
    this.consume();
  }

  send(content: string | Array<Record<string, unknown>>): void {
    this.clearIdleTimer();
    this.inbox.push(content);
    this.update({ status: "working", error: undefined, rateLimited: undefined });
  }

  // `mode` switches permission mode along with allowing, e.g. when a plan
  // is approved ("Approve, auto-accept edits"). `answers` are the user's
  // answers to an AskUserQuestion call (question text -> chosen label(s)).
  answer(toolUseId: string, allow: boolean, mode?: PermissionMode, answers?: Record<string, string>): boolean {
    const entry = this.pending.get(toolUseId);
    if (!entry) return false;
    const tool = entry.request.toolName;
    const deniedMessage =
      tool === "ExitPlanMode"
        ? "The user wants to keep planning; revise the plan."
        : tool === "AskUserQuestion"
          ? "The user dismissed the questions without answering."
          : "The user declined this tool call.";
    this.settle(
      toolUseId,
      allow
        ? {
            behavior: "allow",
            updatedInput: answers ? { ...entry.request.input, answers } : entry.request.input,
            ...(mode ? { updatedPermissions: [{ type: "setMode", mode, destination: "session" }] } : {}),
          }
        : { behavior: "deny", message: deniedMessage },
    );
    if (allow && mode) this.update({ mode });
    return true;
  }

  // Applies what changed: permission mode, model, effort (null: model default).
  async apply(settings: SessionSettings): Promise<void> {
    if (settings.mode && settings.mode !== this.state.mode) {
      await this.query.setPermissionMode(settings.mode);
      this.update({ mode: settings.mode });
    }
    if (settings.model && settings.model !== this.state.model) {
      await this.query.setModel(settings.model);
      this.update({ model: settings.model });
    }
    if (settings.effort !== undefined && settings.effort !== this.state.effort) {
      await this.query.applyFlagSettings({ effortLevel: settings.effort });
      this.update({ effort: settings.effort });
    }
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    await this.query.interrupt();
  }

  close(): void {
    this.clearIdleTimer();
    this.inbox.close();
    this.query.close();
  }

  // Resolve (or drop, if aborted) a permission request.
  private settle(toolUseId: string, result: PermissionResult | null): void {
    const entry = this.pending.get(toolUseId);
    if (!entry) return;
    this.pending.delete(toolUseId);
    if (result) entry.resolve(result);
    this.update({ status: this.pending.size ? "waiting" : "working" });
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.query) this.handle(message);
      this.finish();
    } catch (err) {
      this.finish(err instanceof Error ? err.message : String(err));
    }
  }

  private handle(message: SDKMessage): void {
    if (message.type === "stream_event") return this.stream(message.event);

    // The process reports its permission mode at start and when it changes.
    if (message.type === "system" && (message.subtype === "init" || message.subtype === "status")) {
      const { permissionMode: mode, model } = message as { permissionMode?: PermissionMode; model?: string };
      if (mode && mode !== this.state.mode) this.update({ mode });
      // The init message names the model in use; keep a value we picked since.
      if (message.subtype === "init" && model && !this.state.model) this.update({ model });
      return;
    }

    // Plan usage: "rejected" means the limit is hit until resetsAt (the
    // types don't say seconds or ms; both are handled).
    if (message.type === "rate_limit_event") {
      const info = message.rate_limit_info;
      const resetsAt = info.resetsAt ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : undefined;
      if (info.status === "rejected") this.update({ rateLimited: true });
      return reportRateLimit(info.status === "rejected", resetsAt);
    }

    if (message.type === "assistant") {
      if (message.error === "rate_limit") {
        this.update({ rateLimited: true });
        if (!rateLimit?.rejected) reportRateLimit(true, rateLimit?.resetsAt);
      }
      // A finished assistant message (usually one content block). Its uuid is
      // the transcript entry the UI will load, so the draft can hand over:
      // tool calls match by id, text and thinking by kind, in order.
      for (const c of message.message.content) {
        const block =
          c.type === "tool_use"
            ? this.state.draft.find((b) => b?.toolId === c.id)
            : this.state.draft.find((b) => b && b.done && !b.uuid && b.type === (c.type === "thinking" ? "thinking" : "text"));
        if (block) block.uuid = message.uuid;
      }
      return this.scheduleDraft();
    }

    if (message.type === "result") {
      // An interrupted turn ends as an error result; that's expected, not a failure.
      const error = message.subtype === "success" || this.interrupted ? undefined : resultError(message);
      this.interrupted = false;
      this.update({ status: "idle", draft: [], error });
      this.idleTimer = setTimeout(() => closeRun(this.id), IDLE_CLOSE_MS);
    }
  }

  // Builds the draft of the assistant message being streamed.
  private stream(event: SDKPartialAssistantMessage["event"]): void {
    const draft = this.state.draft;
    switch (event.type) {
      case "message_start":
        this.state.draft = [];
        break;
      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "text") draft[event.index] = { type: "text", text: block.text, done: false };
        else if (block.type === "thinking") draft[event.index] = { type: "thinking", text: block.thinking, done: false };
        else if (block.type === "tool_use") draft[event.index] = { type: "tool", name: block.name, toolId: block.id, text: "", done: false };
        break;
      }
      case "content_block_delta": {
        const block = draft[event.index];
        const delta = event.delta;
        if (!block) break;
        if (delta.type === "text_delta") block.text += delta.text;
        else if (delta.type === "thinking_delta") block.text += delta.thinking;
        else if (delta.type === "input_json_delta") block.text += delta.partial_json;
        break;
      }
      case "content_block_stop": {
        const block = draft[event.index];
        if (block) block.done = true;
        break;
      }
      default:
        return;
    }
    this.scheduleDraft();
  }

  private scheduleDraft(): void {
    if (this.draftTimer) return;
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      this.emit();
    }, DRAFT_THROTTLE_MS);
  }

  // The process has ended: forget the run. A crash leaves its error showing.
  private finish(error?: string): void {
    this.pending.clear();
    this.clearIdleTimer();
    if (runs.get(this.id) === this) runs.delete(this.id);
    if (error) this.update({ status: "error", draft: [], error });
    else listener(this.id, null);
  }

  private update(changes: Partial<RunState>): void {
    this.state = { ...this.state, ...changes, permissions: [...this.pending.values()].map((p) => p.request) };
    this.emit();
  }

  private emit(): void {
    listener(this.id, { ...this.state, draft: this.state.draft.filter(Boolean) });
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function resultError(message: SDKMessage & { type: "result" }): string {
  const errors = "errors" in message && Array.isArray(message.errors) ? message.errors.join("; ") : "";
  return errors || `Stopped: ${message.subtype.replace(/_/g, " ")}`;
}

// What runner.ts needs from a run, Claude's or Gemini's.
interface SessionRun {
  state: RunState;
  send(content: string | Array<Record<string, unknown>>): void;
  answer(toolUseId: string, allow: boolean, mode?: PermissionMode, answers?: Record<string, string>): boolean;
  apply(settings: SessionSettings): Promise<void>;
  interrupt(): Promise<void>;
  close(): void;
}

const runs = new Map<string, SessionRun>();

function geminiRun(id: string | null, dir: string, settings: SessionSettings): GeminiRun {
  const run: GeminiRun = new GeminiRun(id, dir, settings, {
    state: listener,
    messages: (sid) => messageListeners.forEach((fn) => fn(sid)),
    ended: (sid) => runs.get(sid) === run && runs.delete(sid),
  });
  return run;
}

// A running Gemini session's messages (it has no transcript file to read).
export function runMessages(id: string): ChatMessage[] | null {
  const run = runs.get(id);
  return run instanceof GeminiRun ? run.transcript.messages : null;
}

export function getRun(id: string): RunState | null {
  const run = runs.get(id);
  return run ? { ...run.state, draft: run.state.draft.filter(Boolean) } : null;
}

export function isRunning(id: string): boolean {
  return runs.has(id);
}

// Live status of the sessions we run, for the navigator's dots.
export function runStatuses(): Map<string, LiveStatus> {
  const statuses = new Map<string, LiveStatus>();
  for (const [id, run] of runs) {
    const s = run.state.status;
    statuses.set(id, s === "waiting" ? "waiting" : s === "working" || s === "starting" ? "working" : "idle");
  }
  return statuses;
}

// Sends a message, starting a run if needed: resuming the session, or
// creating it (`isNew`). `settings` are what's picked in the UI; a running
// session switches to them first. Returns the session id: a new Gemini
// session gets its id from agy, not from us.
export async function sendMessage(
  id: string,
  dir: string,
  content: string | Array<Record<string, unknown>>,
  settings: SessionSettings,
  isNew = false,
  backend: BackendId = "claude",
): Promise<string> {
  let run = runs.get(id);
  if (!run && backend === "gemini") {
    const created = geminiRun(isNew ? null : id, dir, settings);
    // Without its id there's nothing to register it under; wait for agy.
    if (isNew) id = await created.started();
    runs.set(id, (run = created));
  } else if (!run) {
    run = new Run(id, dir, settings, isNew);
    runs.set(id, run);
  } else {
    await run.apply(settings);
  }
  run.send(content);
  return id;
}

// Changes a running session's settings. False if it isn't running (the UI
// then sends them with the next message).
export async function applySettings(id: string, settings: SessionSettings): Promise<boolean> {
  const run = runs.get(id);
  if (!run) return false;
  await run.apply(settings);
  return true;
}

export function answerPermission(
  id: string,
  toolUseId: string,
  allow: boolean,
  mode?: PermissionMode,
  answers?: Record<string, string>,
): boolean {
  return runs.get(id)?.answer(toolUseId, allow, mode, answers) ?? false;
}

export async function interrupt(id: string): Promise<boolean> {
  const run = runs.get(id);
  if (!run) return false;
  await run.interrupt();
  return true;
}

export function closeRun(id: string): void {
  const run = runs.get(id);
  if (!run) return;
  runs.delete(id); // a message sent now starts a fresh run
  run.close();
}

export function closeAllRuns(): void {
  for (const run of runs.values()) run.close();
}

// Runs in the middle of a turn (or waiting for a permission answer).
export function busyRuns(): number {
  return [...runs.values()].filter((r) => ["starting", "working", "waiting"].includes(r.state.status)).length;
}

// Exits once no run is busy, for a supervisor (systemd) to start the server
// again with new code. Returns how many runs it is waiting for.
let restartTimer: NodeJS.Timeout | null = null;
export function restartWhenIdle(): number {
  if (!restartTimer) {
    restartTimer = setInterval(() => {
      if (busyRuns()) return;
      console.log("Restarting: no session is busy.");
      closeAllRuns();
      process.exit(0);
    }, 1000);
  }
  return busyRuns();
}

// Builds a Gemini session's chat messages from ACP session/update
// notifications: the replay that session/load sends, then a run's live
// updates. Tool calls are named after Claude Code's tools where they match
// (Bash, Edit, Write, Read…) so the UI's renderers apply.

import type { Block, ChatMessage, ImageBlock, ToolBlock } from "../shared/types.ts";

type Update = Record<string, unknown>;

const asObject = (v: unknown): Record<string, unknown> => {
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
};

const firstPath = (u: Update): string | undefined => {
  const loc = Array.isArray(u.locations) ? (u.locations[0] as { path?: unknown } | undefined) : undefined;
  return typeof loc?.path === "string" ? loc.path : undefined;
};

const diffOf = (u: Update) =>
  Array.isArray(u.content) ? (u.content as Array<Record<string, unknown>>).find((c) => c.type === "diff") : undefined;

// An ACP tool call as a tool block (name and input as the UI expects them).
export function toolFromCall(u: Update): { name: string; input: Record<string, unknown> } {
  const raw = asObject(u.rawInput);
  const title = typeof u.title === "string" ? u.title : "";
  const diff = diffOf(u);
  // agy's questions (ask_question) are "interactions"; shown like Claude's.
  if (typeof u.toolCallId === "string" && u.toolCallId.startsWith("interaction_")) {
    return { name: "AskUserQuestion", input: { questions: [{ question: title }] } };
  }
  const file = (typeof diff?.path === "string" ? diff.path : undefined) ?? firstPath(u) ?? (typeof raw.file_path === "string" ? raw.file_path : "");
  switch (u.kind) {
    case "execute":
      return { name: "Bash", input: { command: String(raw.CommandLine ?? raw.command_line ?? title), description: raw.toolSummary } };
    case "edit":
      if (diff && diff.oldText) return { name: "Edit", input: { file_path: file, old_string: diff.oldText, new_string: diff.newText ?? "" } };
      if (diff) return { name: "Write", input: { file_path: file, content: diff.newText ?? "" } };
      return { name: "Edit", input: { file_path: file } };
    case "read":
      return { name: "Read", input: { file_path: file || title } };
    case "search":
      return { name: "Grep", input: { pattern: title, ...raw } };
    case "fetch":
      return { name: "WebFetch", input: { url: raw.url ?? raw.Url ?? title, ...raw } };
    default:
      return { name: title.replace(/^Running /, "") || String(u.kind ?? "Tool"), input: raw };
  }
}

function outputText(out: unknown): string {
  if (typeof out === "string") return out;
  const o = asObject(out);
  const text = o.combinedOutput ?? o.formatted_output ?? o.output;
  if (typeof text === "string") return text.replace(/\r\n/g, "\n");
  return Object.keys(o).length ? JSON.stringify(o, null, 2) : "";
}

// What agy reports for the permission-pending call it then runs under another
// id; the run itself is reported separately, so this one is noise.
const NEVER_EXECUTED = "Tool call was approved but never executed.";

// A user message as ACP content blocks become chat blocks.
export function userBlocks(content: Array<Record<string, unknown>>): Block[] {
  const blocks: Block[] = [];
  for (const c of content) {
    if (c.type === "text" && typeof c.text === "string") {
      const file = c.text.match(/^<attached-file name="([^"\n]*)">\n/);
      blocks.push(file ? { type: "file", name: file[1], mediaType: "text/plain" } : { type: "text", text: c.text });
    } else if (c.type === "image" && typeof c.data === "string") {
      const mediaType = String(c.mimeType ?? "image/png");
      blocks.push({ type: "image", mediaType, url: `data:${mediaType};base64,${c.data}` } satisfies ImageBlock);
    } else if (c.type === "resource") {
      const r = asObject(c.resource);
      const name = String(r.uri ?? "file").split("/").pop() || "file";
      blocks.push({ type: "file", name, mediaType: String(r.mimeType ?? "") });
    }
  }
  return blocks;
}

export class Transcript {
  messages: ChatMessage[] = [];
  live = false; // replayed history has no times; live messages do
  private tools = new Map<string, ToolBlock>();
  private counter = 0;

  // A message we sent (ACP doesn't echo prompts back during a live turn).
  addUser(blocks: Block[]): void {
    this.messages.push({ id: this.nextId(), role: "user", blocks, timestamp: this.now() });
  }

  // Applies one session/update. Returns true if the messages changed.
  apply(u: Update): boolean {
    const kind = u.sessionUpdate;
    const content = u.content as { type?: string; text?: string } | undefined;
    if (kind === "user_message_chunk") {
      const blocks = content ? userBlocks([content as Record<string, unknown>]) : [];
      // Plan mode prefixes prompts with agy's /plan; show what was typed.
      const first = blocks[0];
      if (first?.type === "text" && this.messages.at(-1)?.role !== "user") first.text = first.text.replace(/^\/plan\s+/, "");
      for (const b of blocks) this.add("user", b);
      return blocks.length > 0;
    }
    if (kind === "agent_message_chunk" && typeof content?.text === "string") return this.add("assistant", { type: "text", text: content.text });
    if (kind === "agent_thought_chunk" && typeof content?.text === "string") return this.add("assistant", { type: "thinking", text: content.text });
    if (kind === "tool_call" && typeof u.toolCallId === "string") return this.toolCall(u);
    if (kind === "tool_call_update" && typeof u.toolCallId === "string") return this.toolUpdate(u);
    return false;
  }

  private toolCall(u: Update): boolean {
    const id = u.toolCallId as string;
    const existing = this.tools.get(id);
    const { name, input } = toolFromCall(u);
    if (existing) {
      // The same call again, e.g. pending → in progress: keep the richer input.
      if (Object.keys(input).length > Object.keys(existing.input as object).length) Object.assign(existing, { name, input });
      this.result(existing, u);
      return true;
    }
    // A file edit is reported twice: as the permission request (with the
    // diff) and as the run (without it, other id). Show it once.
    if (u.kind === "edit") {
      const file = firstPath(u);
      const twin = [...this.tools.values()].find(
        (t) => !t.result && (t.name === "Edit" || t.name === "Write") && (t.input as { file_path?: string }).file_path === file,
      );
      if (twin && file) {
        this.tools.set(id, twin);
        this.result(twin, u);
        return true;
      }
    }
    const block: ToolBlock = { type: "tool", id, name, input };
    this.tools.set(id, block);
    this.add("assistant", block);
    this.result(block, u);
    return true;
  }

  private toolUpdate(u: Update): boolean {
    const block = this.tools.get(u.toolCallId as string);
    if (!block) return false;
    if (u.status === "failed" && u.rawOutput === NEVER_EXECUTED) {
      // Drop it if the run was reported under another id (it has a result).
      if (!block.result) this.remove(block);
      return true;
    }
    this.result(block, u);
    return true;
  }

  private result(block: ToolBlock, u: Update): void {
    if (u.status !== "completed" && u.status !== "failed") return;
    block.result = { text: outputText(u.rawOutput), isError: u.status === "failed", truncated: false, images: [] };
  }

  private remove(block: ToolBlock): void {
    for (const [key, t] of this.tools) if (t === block) this.tools.delete(key);
    for (const m of this.messages) m.blocks = m.blocks.filter((b) => b !== block);
    this.messages = this.messages.filter((m) => m.blocks.length);
  }

  // Consecutive chunks of one side form one message; text chunks join.
  private add(role: "user" | "assistant", block: Block): boolean {
    let last = this.messages.at(-1);
    if (!last || last.role !== role) {
      last = { id: this.nextId(), role, blocks: [], timestamp: this.now() };
      this.messages.push(last);
    }
    const prev = last.blocks.at(-1);
    if (prev && (prev.type === "text" || prev.type === "thinking") && prev.type === block.type) {
      // A new copy, so the UI sees the change (it memoizes messages).
      last.blocks[last.blocks.length - 1] = { ...prev, text: prev.text + (block as { text: string }).text };
    } else last.blocks.push(block);
    this.messages[this.messages.length - 1] = { ...last };
    return true;
  }

  private now(): string | undefined {
    return this.live ? new Date().toISOString() : undefined;
  }

  private nextId(): string {
    return `g${this.counter++}`;
  }
}

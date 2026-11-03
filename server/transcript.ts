// Turns SDK transcript messages into the UI's ChatMessage shape.
//
// The transcript stores one entry per content block, and tool results come
// back as separate "user" entries. Here we merge an assistant turn (text,
// thinking, tool calls) into one message and attach each tool result to the
// tool call that produced it.

import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Block, ChatMessage, FileBlock, ImageBlock, TextBlock, ThinkingBlock, ToolBlock, ToolResult } from "../shared/types.ts";
import { attachedFileName } from "./attachments.ts";

const MAX_RESULT_CHARS = 20_000;

// Loose shapes of the Anthropic content blocks we read.
interface RawBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | RawBlock[];
  is_error?: boolean;
  source?: { type: string; media_type?: string; data?: string };
  title?: string;
  tool_name?: string;
}

interface RawMessage {
  content?: string | RawBlock[];
}

// Images aren't inlined (they are most of a transcript's size); each gets a
// URL built from its entry's uuid and its position among that entry's images.
export type ImageUrl = (entryUuid: string, n: number) => string;

// An entry's images in a fixed order: its own image blocks and those inside
// its tool results.
function entryImages(entry: SessionMessage): RawBlock[] {
  const content = (entry.message as RawMessage | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) =>
    b.type === "image" ? [b] : b.type === "tool_result" && Array.isArray(b.content) ? b.content.filter((p) => p.type === "image") : [],
  );
}

export function findImage(entries: SessionMessage[], entryUuid: string, n: number): { mediaType: string; data: Buffer } | null {
  const entry = entries.find((e) => e.uuid === entryUuid);
  const source = entry ? entryImages(entry)[n]?.source : undefined;
  if (source?.type !== "base64" || !source.data) return null;
  // No SVG or HTML: those would run script from our origin if opened directly.
  const type = source.media_type ?? "image/png";
  const mediaType = /^image\/(png|jpeg|gif|webp)$/.test(type) ? type : "application/octet-stream";
  return { mediaType, data: Buffer.from(source.data, "base64") };
}

// `commandOutput` holds the text of local slash-command entries (system
// entries the SDK returns without their content), by entry uuid.
export function toChatMessages(entries: SessionMessage[], imageUrl: ImageUrl, commandOutput: Map<string, string>): ChatMessage[] {
  const out: ChatMessage[] = [];
  const toolsById = new Map<string, ToolBlock>();
  let turn: ChatMessage | null = null; // the assistant message being built

  for (const entry of entries) {
    const timestamp = (entry as { timestamp?: string }).timestamp;
    if (entry.type === "system") {
      const text = commandOutput.get(entry.uuid);
      const shown = text === undefined ? null : (specialText(text) ?? text.trim());
      if (shown) {
        out.push({ id: entry.uuid, role: "notice", blocks: [{ type: "text", text: shown }], timestamp });
        turn = null;
      }
      continue;
    }
    const raw = entry.message as RawMessage | undefined;
    const content = raw?.content;
    if (content === undefined) continue;
    const images = entryImages(entry);
    const image: ToImage = (b) => {
      const n = images.indexOf(b);
      if (n < 0 || b.source?.type !== "base64") return null;
      return { type: "image", mediaType: b.source.media_type ?? "image/png", url: imageUrl(entry.uuid, n) };
    };

    if (entry.type === "assistant") {
      if (!turn) {
        turn = { id: entry.uuid, role: "assistant", blocks: [], timestamp };
        out.push(turn);
      }
      for (const block of asBlocks(content)) {
        const converted = assistantBlock(block);
        if (!converted) continue;
        converted.uuid = entry.uuid;
        if (converted.type === "tool") toolsById.set(converted.id, converted);
        turn.blocks.push(converted);
      }
      continue;
    }

    if (entry.type !== "user") continue;

    // A user entry made only of tool results continues the assistant turn.
    const blocks = asBlocks(content);
    if (blocks.length > 0 && blocks.every((b) => b.type === "tool_result")) {
      for (const b of blocks) {
        const tool = b.tool_use_id ? toolsById.get(b.tool_use_id) : undefined;
        if (tool) tool.result = toolResult(b, image);
      }
      continue;
    }

    turn = null;
    const message = userMessage(entry.uuid, blocks, image, timestamp, (entry as { origin?: Origin }).origin);
    if (message) out.push(message);
  }
  return out;
}

function asBlocks(content: string | RawBlock[]): RawBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function assistantBlock(b: RawBlock): TextBlock | ThinkingBlock | ToolBlock | null {
  switch (b.type) {
    case "text":
      return b.text?.trim() ? { type: "text", text: b.text } : null;
    case "thinking":
      // Thinking is often stored redacted (signature only); skip empty ones.
      return b.thinking?.trim() ? { type: "thinking", text: b.thinking } : null;
    case "tool_use":
      return { type: "tool", id: b.id ?? "", name: b.name ?? "tool", input: b.input ?? {} };
    default:
      return null;
  }
}

type ToImage = (b: RawBlock) => ImageBlock | null;

function toolResult(b: RawBlock, image: ToImage): ToolResult {
  const parts = typeof b.content === "string" ? [{ type: "text", text: b.content }] : (b.content ?? []);
  const texts: string[] = [];
  const images: ImageBlock[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text) texts.push(part.text);
    else if (part.type === "image") {
      const img = image(part);
      if (img) images.push(img);
    } else if (part.type === "tool_reference" && part.tool_name) texts.push(`Loaded tool: ${part.tool_name}`);
  }
  let text = texts.join("\n");
  const truncated = text.length > MAX_RESULT_CHARS;
  if (truncated) text = text.slice(0, MAX_RESULT_CHARS);
  return { text, isError: b.is_error === true, truncated, images };
}

function userMessage(id: string, blocks: RawBlock[], image: ToImage, timestamp?: string, origin?: Origin): ChatMessage | null {
  const agent = agentMessage(id, blocks, timestamp, origin);
  if (agent) return agent;
  const out: Block[] = [];
  let notice = false;
  for (const b of blocks) {
    const file = b.type === "text" && b.text ? attachedFileName(b.text) : null;
    if (file) {
      out.push({ type: "file", name: file, mediaType: "text/plain" });
    } else if (b.type === "document") {
      out.push({ type: "file", name: b.title || "Document", mediaType: b.source?.media_type ?? "application/pdf" } satisfies FileBlock);
    } else if (b.type === "text" && b.text) {
      const special = specialText(b.text);
      if (special !== null) {
        notice = true;
        if (special) out.push({ type: "text", text: special });
      } else if (b.text.trim()) {
        out.push({ type: "text", text: b.text });
      }
    } else if (b.type === "image") {
      const img = image(b);
      if (img) out.push(img);
    }
  }
  if (out.length === 0) return null;
  return { id, role: notice ? "notice" : "user", blocks: out, timestamp };
}

// Messages that another session or a subagent sent into this one arrive as
// user turns: "Another Claude session sent a message:\n<agent-message from="…">…".
// Show them as their own kind so they don't look like the user's own words.
const AGENT_MESSAGE = /<agent-message from="([^"]*)">([\s\S]*?)<\/agent-message>/;

// Claude Code records who a user turn really came from in `origin`; "peer" is
// another session or a subagent. The text format is the fallback for older
// transcripts, which carry no origin.
interface Origin {
  kind?: string;
  from?: string;
  body?: string;
}

function agentMessage(id: string, blocks: RawBlock[], timestamp?: string, origin?: Origin): ChatMessage | null {
  const text = blocks.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n");
  const peer = origin?.kind === "peer";
  if (!peer && !text.trimStart().startsWith("Another Claude session sent a message")) return null;
  const m = text.match(AGENT_MESSAGE);
  if (!m && !peer) return null;
  // The harness indents the report and prefixes a framing line; drop both.
  const body = (m?.[2] ?? origin?.body ?? text)
    .replace(/^\s*\[Subagent hand-back\][\s\S]*?The report follows:\n/, "")
    .replace(/^ {2}/gm, "")
    .trim();
  if (!body) return null;
  return { id, role: "agent", from: m?.[1] ?? origin?.from, blocks: [{ type: "text", text: body }], timestamp };
}

// Claude Code stores slash commands, `!` shell commands and background task
// notifications as tagged user text. Returns a short plain-text rendering for
// those, or null for ordinary prompts.
function specialText(text: string): string | null {
  const t = text.trimStart();
  // Claude Code's marker for an interrupted turn ("[Request interrupted by user]", "… for tool use]").
  if (t.startsWith("[Request interrupted by user")) return "Interrupted";
  if (!t.startsWith("<")) return null;
  const tag = (name: string) => t.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? "";

  if (t.startsWith("<task-notification>")) return tag("summary") || "Background task finished";
  if (t.startsWith("<command-name>")) return [tag("command-name"), tag("command-args")].filter(Boolean).join(" ");
  if (t.startsWith("<local-command-stdout>")) return tag("local-command-stdout");
  if (t.startsWith("<local-command-stderr>")) return tag("local-command-stderr");
  if (t.startsWith("<bash-input>")) return `! ${tag("bash-input")}`;
  if (t.startsWith("<bash-stdout>")) return [tag("bash-stdout"), tag("bash-stderr")].filter(Boolean).join("\n");
  return null;
}

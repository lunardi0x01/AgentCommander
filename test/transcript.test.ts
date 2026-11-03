import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { toChatMessages, findImage } from "../server/transcript.ts";

const entry = (type: string, uuid: string, content: unknown): SessionMessage =>
  ({ type, uuid, session_id: "s", parent_tool_use_id: null, message: { content } }) as unknown as SessionMessage;
const convert = (entries: SessionMessage[], out = new Map<string, string>()) =>
  toChatMessages(entries, (u, n) => `/img/${u}/${n}`, out);

test("plain user prompt", () => {
  const [m] = convert([entry("user", "u1", "hello")]);
  assert.equal(m.role, "user");
  assert.deepEqual(m.blocks, [{ type: "text", text: "hello" }]);
});

test("assistant blocks merge and tool results attach", () => {
  const msgs = convert([
    entry("user", "u1", "go"),
    entry("assistant", "a1", [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
    entry("user", "u2", [{ type: "tool_result", tool_use_id: "t1", content: "file.txt" }]),
    entry("assistant", "a2", [{ type: "text", text: "done" }]),
  ]);
  assert.equal(msgs.length, 2);
  const a = msgs[1];
  assert.equal(a.role, "assistant");
  assert.equal(a.blocks.length, 3);
  const tool = a.blocks[1] as any;
  assert.equal(tool.type, "tool");
  assert.equal(tool.result.text, "file.txt");
  assert.equal(tool.result.isError, false);
});

test("empty text and redacted thinking are skipped", () => {
  const [m] = convert([entry("assistant", "a1", [{ type: "text", text: "  " }, { type: "thinking", thinking: "" }, { type: "text", text: "hi" }])]);
  assert.equal(m.blocks.length, 1);
});

test("long tool results are truncated and error flag kept", () => {
  const msgs = convert([
    entry("assistant", "a1", [{ type: "tool_use", id: "t1", name: "Read", input: {} }]),
    entry("user", "u2", [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(25_000), is_error: true }]),
  ]);
  const r = (msgs[0].blocks[0] as any).result;
  assert.equal(r.text.length, 20_000);
  assert.equal(r.truncated, true);
  assert.equal(r.isError, true);
});

test("a user prompt ends the assistant turn", () => {
  const msgs = convert([
    entry("assistant", "a1", [{ type: "text", text: "one" }]),
    entry("user", "u1", "next"),
    entry("assistant", "a2", [{ type: "text", text: "two" }]),
  ]);
  assert.deepEqual(msgs.map((m) => m.role), ["assistant", "user", "assistant"]);
});

test("specialText: interrupt, slash command, bash, task notification", () => {
  const text = (t: string) => convert([entry("user", "u", t)])[0];
  assert.deepEqual([text("[Request interrupted by user]").role, (text("[Request interrupted by user for tool use]").blocks[0] as any).text], ["notice", "Interrupted"]);
  const cmd = text("<command-name>/model</command-name><command-args>haiku</command-args>");
  assert.equal(cmd.role, "notice");
  assert.equal((cmd.blocks[0] as any).text, "/model haiku");
  assert.equal((text("<bash-input>ls -la</bash-input>").blocks[0] as any).text, "! ls -la");
  assert.equal((text("<bash-stdout>out</bash-stdout><bash-stderr>err</bash-stderr>").blocks[0] as any).text, "out\nerr");
  assert.equal((text("<task-notification><summary>Build done</summary></task-notification>").blocks[0] as any).text, "Build done");
  assert.equal((text("<task-notification></task-notification>").blocks[0] as any).text, "Background task finished");
});

test("ordinary text starting with < stays a user message", () => {
  const m = convert([entry("user", "u", "<div>hi</div>")])[0];
  assert.equal(m.role, "user");
});

test("local command output comes from the commandOutput map", () => {
  const msgs = convert([entry("system", "s1", undefined)], new Map([["s1", "  Context: 5%  "]]));
  assert.equal(msgs[0].role, "notice");
  assert.equal((msgs[0].blocks[0] as any).text, "Context: 5%");
  assert.equal(convert([entry("system", "s2", undefined)]).length, 0);
});

test("agentMessage: sender, framing and indentation stripped", () => {
  const text = 'Another Claude session sent a message:\n<agent-message from="worker">\n  [Subagent hand-back] framing\nThe report follows:\n  line one\n  line two\n</agent-message>';
  const [m] = convert([entry("user", "u", text)]);
  assert.equal(m.role, "agent");
  assert.equal((m as any).from, "worker");
  assert.equal((m.blocks[0] as any).text, "line one\nline two");
});

test("agent-message prefix without a tag falls back to a user message", () => {
  const [m] = convert([entry("user", "u", "Another Claude session sent a message: nothing")]);
  assert.equal(m.role, "user");
});

test("images get URLs by entry uuid and position; findImage decodes them", () => {
  const png = Buffer.from("abc").toString("base64");
  const e = entry("user", "u9", [{ type: "text", text: "see" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: png } }]);
  const [m] = convert([e]);
  assert.deepEqual(m.blocks[1], { type: "image", mediaType: "image/jpeg", url: "/img/u9/0" });
  const found = findImage([e], "u9", 0);
  assert.equal(found?.mediaType, "image/jpeg");
  assert.equal(found?.data.toString(), "abc");
  assert.equal(findImage([e], "u9", 1), null);
  assert.equal(findImage([e], "nope", 0), null);
});

test("a peer origin marks an agent message even when the text has no framing line", () => {
  const text = `<agent-message from="abc12345xyz">\n[Subagent hand-back] Framing. The report follows:\n  All good.\n</agent-message>`;
  const e: any = { type: "user", uuid: "u9", session_id: "s", parent_tool_use_id: null, origin: { kind: "peer", from: "abc12345xyz" }, message: { role: "user", content: text } };
  const [m] = toChatMessages([e], () => "", new Map());
  assert.equal(m.role, "agent");
  assert.equal(m.from, "abc12345xyz");
  assert.deepEqual(m.blocks, [{ type: "text", text: "All good." }]);
  // Without an origin, the same text typed by the user stays a user message.
  const [u] = toChatMessages([{ ...e, origin: undefined }], () => "", new Map());
  assert.equal(u.role, "user");
});

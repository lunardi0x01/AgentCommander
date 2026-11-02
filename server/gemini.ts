// Gemini sessions (Google Antigravity, agy), read from the store of agy's ACP
// server, ~/.gemini/antigravity-acp. That is the store Agent Commander can
// resume through ACP. The CLI's own sessions (~/.gemini/antigravity-cli) are a
// separate store that the ACP server doesn't see.
//
// Per session: <id>.meta (JSON with the cwd) and <id>.db (SQLite, steps as
// protobuf blobs). The title is the first prompt, pulled out of the first
// user-input step with a minimal protobuf reader; if that fails we fall back to
// "Session <id>", which is also what ACP's session/list calls it.

import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { EFFORT_LEVELS, type ChatMessage, type EffortLevel, type ModelOption } from "../shared/types.ts";
import type { AgentBackend, BackendSession } from "./backends.ts";
import { AcpConnection } from "./acp.ts";
import { Transcript } from "./gemini-transcript.ts";

const ACP_DIR = process.env.AGY_ACP_DIR || path.join(os.homedir(), ".gemini", "antigravity-acp");
const STORE = path.join(ACP_DIR, "conversations");
export const BRAIN_DIR = path.join(ACP_DIR, "brain");
const USER_INPUT_STEP = 14; // step_type of a user's prompt, from looking at real sessions
const TITLE_MAX = 80;

// Reads buf as a protobuf message and returns the text of its leaf fields, or
// null if it isn't a well-formed message. A length-delimited field is either a
// nested message or text; we try message first and fall back to text, so
// enclosing messages never show up as (garbled) strings.
function leafStrings(buf: Buffer, depth = 0): string[] | null {
  const found: string[] = [];
  const varint = (i: number): [number, number] | null => {
    let value = 0;
    for (let shift = 0; i < buf.length && shift < 49; shift += 7) {
      const b = buf[i++];
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return [value, i];
    }
    return null;
  };
  for (let i = 0; i < buf.length; ) {
    const tag = varint(i);
    if (!tag || tag[0] >>> 3 === 0) return null;
    i = tag[1];
    const wire = tag[0] & 7;
    if (wire === 0) {
      const v = varint(i);
      if (!v) return null;
      i = v[1];
    } else if (wire === 1 || wire === 5) {
      i += wire === 1 ? 8 : 4;
      if (i > buf.length) return null;
    } else if (wire === 2) {
      const len = varint(i);
      if (!len || len[1] + len[0] > buf.length) return null;
      const field = buf.subarray(len[1], len[1] + len[0]);
      i = len[1] + len[0];
      const nested = depth < 5 && field.length ? leafStrings(field, depth + 1) : null;
      if (nested?.length) found.push(...nested);
      else {
        const text = field.toString("utf8");
        if (text && !text.includes("\uFFFD") && !/[\u0000-\u0008\u000e-\u001f]/.test(text)) found.push(text);
      }
    } else return null;
  }
  return found;
}

const ID_LIKE = /^[0-9a-f-]{32,36}$/;

// undefined: the session has no prompt yet; null: it has one we couldn't read.
function firstPrompt(file: string): string | null | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare("SELECT step_payload FROM steps WHERE step_type = ? ORDER BY idx LIMIT 1").get(USER_INPUT_STEP) as
      | { step_payload: Uint8Array | null }
      | undefined;
    if (!row) return undefined;
    if (!row.step_payload) return null;
    // The prompt is the longest text in the step that isn't an id.
    let best = "";
    for (const text of leafStrings(Buffer.from(row.step_payload)) ?? []) {
      if (!ID_LIKE.test(text) && text.length > best.length) best = text;
    }
    return best.trim() || null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function toTitle(prompt: string): string {
  // Plan mode sends prompts as agy's /plan command; the title is what was typed.
  prompt = prompt.replace(/^\/plan\s+/, "");
  const line = prompt.split("\n").find((l) => l.trim()) ?? prompt;
  return line.length > TITLE_MAX ? line.slice(0, TITLE_MAX - 1) + "…" : line;
}

const titles = new Map<string, { mtime: number; title: string | null }>();

async function listSessions(): Promise<BackendSession[]> {
  let files: string[];
  try {
    files = await readdir(STORE);
  } catch {
    return []; // agy's ACP server was never run
  }
  const custom = await loadTitles();
  const sessions: BackendSession[] = [];
  for (const file of files) {
    const id = file.match(/^([0-9a-f-]{36})\.db$/)?.[1];
    if (!id) continue;
    try {
      const [meta, info] = await Promise.all([readFile(path.join(STORE, `${id}.meta`), "utf8"), stat(path.join(STORE, file))]);
      const cwd = JSON.parse(meta).cwd;
      if (typeof cwd !== "string") continue;
      let cached = titles.get(id);
      if (!cached || cached.mtime !== info.mtimeMs) {
        const prompt = firstPrompt(path.join(STORE, file));
        cached = { mtime: info.mtimeMs, title: prompt === undefined ? null : prompt ? toTitle(prompt) : `Session ${id.slice(0, 8)}` };
        titles.set(id, cached);
      }
      if (cached.title === null) continue; // never prompted, like Claude's list
      sessions.push({ id, cwd, title: custom[id] || cached.title, lastModified: info.mtimeMs, contextTokens: contexts.get(id) });
    } catch {} // no .meta yet, or unreadable: skip
  }
  return sessions;
}

export function isGeminiSession(id: string): boolean {
  return /^[0-9a-f-]{36}$/.test(id) && existsSync(path.join(STORE, `${id}.db`));
}

// --- Reading a session's history -------------------------------------------
// Through ACP's session/load, which replays the whole conversation as
// session/update notifications; far easier than decoding the protobuf steps.
// While Agent Commander runs a session, sessions.ts reads its run instead.

const LOAD_TIMEOUT_MS = 60_000;

async function loadHistory(id: string, cwd: string): Promise<ChatMessage[]> {
  const transcript = new Transcript();
  const conn = await AcpConnection.open(cwd, { onUpdate: (sid, update) => sid === id && transcript.apply(update) });
  const timer = setTimeout(() => conn.close(), LOAD_TIMEOUT_MS);
  try {
    rememberModels(await conn.request("session/load", { sessionId: id, cwd, mcpServers: [] }));
    return transcript.messages;
  } finally {
    clearTimeout(timer);
    conn.close();
  }
}

const histories = new Map<string, { mtime: number; messages: Promise<ChatMessage[]> }>();

// A session's messages, kept until its store file changes.
export async function readGeminiSession(id: string): Promise<ChatMessage[]> {
  const file = path.join(STORE, `${id}.db`);
  const [cwd, info] = await Promise.all([sessionCwd(id), stat(file)]);
  const cached = histories.get(id);
  if (cached && cached.mtime === info.mtimeMs) return cached.messages;
  const messages = loadHistory(id, cwd);
  const entry = { mtime: info.mtimeMs, messages };
  histories.set(id, entry);
  // Loading may touch the store; key the cache on what it looks like afterwards.
  messages.then(
    async () => {
      entry.mtime = (await stat(file)).mtimeMs;
    },
    () => histories.get(id) === entry && histories.delete(id),
  );
  return messages;
}

export async function sessionCwd(id: string): Promise<string> {
  const cwd = JSON.parse(await readFile(path.join(STORE, `${id}.meta`), "utf8")).cwd;
  if (typeof cwd !== "string") throw new Error("Gemini session has no folder");
  return cwd;
}

// --- What we remember about Gemini sessions ----------------------------------
// agy has no titles of its own (ACP calls every session "Session <id>"), so
// renames live in our data folder. Context sizes are only reported live, so
// the last one seen is kept for the tree's tooltip.

const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "agent-commander");
const TITLES_FILE = path.join(DATA_DIR, "gemini-titles.json");
const MODELS_FILE = path.join(DATA_DIR, "gemini-models.json");

let customTitles: Record<string, string> | null = null;

async function loadTitles(): Promise<Record<string, string>> {
  if (!customTitles) customTitles = JSON.parse(await readFile(TITLES_FILE, "utf8").catch(() => "{}"));
  return customTitles!;
}

async function saveTitles(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${TITLES_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(customTitles ?? {}, null, 2) + "\n");
  await rename(tmp, TITLES_FILE);
}

export async function renameGeminiSession(id: string, title: string): Promise<void> {
  (await loadTitles())[id] = title;
  await saveTitles();
}

const contexts = new Map<string, number>();

export function rememberContext(id: string, tokens: number): void {
  contexts.set(id, tokens);
}

// --- Models ------------------------------------------------------------------
// ACP only lists models in a session's new/load result. The last list seen is
// saved, so the model picker works before any Gemini session has run here.

interface ConfigOption {
  id: string;
  currentValue?: string;
  options?: Array<{ value: string; name: string; description?: string }>;
}

let models: ModelOption[] | null = null;

export function rememberModels(result: Record<string, unknown>): void {
  const config = (result.configOptions ?? []) as ConfigOption[];
  const model = config.find((o) => o.id === "model");
  const thinking = config.find((o) => o.id === "thinking_level");
  if (!model?.options?.length) return;
  const effortLevels = (thinking?.options?.map((o) => o.value) ?? []).filter((v): v is EffortLevel =>
    (EFFORT_LEVELS as string[]).includes(v),
  );
  const current = model.options.find((o) => o.value === model.currentValue);
  const next: ModelOption[] = [
    { value: "default", resolvedModel: model.currentValue, displayName: "Default", description: current ? `Antigravity's default, now ${current.name}` : "Antigravity's default", effortLevels },
    ...model.options.map((o) => ({ value: o.value, resolvedModel: o.value, displayName: o.name, description: o.description ?? "", effortLevels })),
  ];
  if (JSON.stringify(next) === JSON.stringify(models)) return;
  models = next;
  void mkdir(DATA_DIR, { recursive: true })
    .then(() => writeFile(MODELS_FILE, JSON.stringify(next, null, 2) + "\n"))
    .catch(() => {});
}

// Gemini's models. With none known yet, a throwaway session in a temp folder
// is created to ask, then removed.
export async function geminiModels(): Promise<ModelOption[]> {
  if (models) return models;
  try {
    models = JSON.parse(await readFile(MODELS_FILE, "utf8"));
    if (models?.length) return models;
  } catch {}
  const probeDir = await mkdtemp(path.join(os.tmpdir(), "agent-commander-gemini-"));
  const conn = await AcpConnection.open(probeDir);
  try {
    const result = await conn.request("session/new", { cwd: probeDir, mcpServers: [] });
    rememberModels(result);
    await removeSessionFiles(String(result.sessionId));
  } finally {
    conn.close();
    await rm(probeDir, { recursive: true, force: true });
  }
  return models ?? [];
}

// --- Deleting ----------------------------------------------------------------
// A session is three things in agy's store: conversations/<id>.db and .meta,
// and its artifact folder brain/<id>/ (plans, task lists). trash.ts moves them.

export function sessionFiles(id: string): Array<{ path: string; name: string }> {
  return [
    { path: path.join(STORE, `${id}.db`), name: `${id}.db` },
    { path: path.join(STORE, `${id}.meta`), name: `${id}.meta` },
    { path: path.join(BRAIN_DIR, id), name: "brain" },
  ];
}

async function removeSessionFiles(id: string): Promise<void> {
  for (const f of sessionFiles(id)) await rm(f.path, { recursive: true, force: true });
}

export const gemini: AgentBackend = { id: "gemini", listSessions };

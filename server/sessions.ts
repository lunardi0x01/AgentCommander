// Access to Claude Code session history, via the Agent SDK.

import os from "node:os";
import path from "node:path";
import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession as sdkRenameSession,
  type SDKSessionInfo,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { BackendId, ChatMessage, FolderChoice, FolderInfo, LiveStatus, SessionSummary, Tree } from "../shared/types.ts";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { sessionActivity, transcriptPaths } from "./activity.ts";
import { loadConfig } from "./config.ts";
import { liveSessions, type LiveSession } from "./live.ts";
import { findImage, toChatMessages } from "./transcript.ts";
import { runMessages, runStatuses } from "./runner.ts";
import { gemini, isGeminiSession, readGeminiSession, renameGeminiSession } from "./gemini.ts";

const TEMP_DIRS = [...new Set(["/tmp", os.tmpdir()])];

// Scratch and temp folders (e.g. Claude scratchpads) are not projects.
function isProjectFolder(cwd: string | undefined): cwd is string {
  if (!cwd) return false;
  return !TEMP_DIRS.some((dir) => cwd === dir || cwd.startsWith(dir + path.sep));
}

type IndexedSession = SDKSessionInfo & { contextTokens?: number; cacheTtlMs?: number; backend?: BackendId };

// Replaces lastModified (file mtime) with the time of the last message, and
// adds the session's context size and cache lifetime.
async function withActivity(sessions: SDKSessionInfo[]): Promise<IndexedSession[]> {
  const activity = await sessionActivity(sessions.map((s) => s.sessionId));
  return sessions.map((s) => {
    const a = activity.get(s.sessionId);
    return { ...s, lastModified: a?.time ?? s.lastModified, contextTokens: a?.context ?? undefined, cacheTtlMs: a?.cacheTtlMs ?? undefined };
  });
}

// The SDK lists only sessions with at least one prompt. A running session
// can have none yet (e.g. a fresh Remote Control session), so add those
// from the live registry: Claude Code's own (terminal, Remote Control) and
// ours. Other SDK processes without a prompt are short-lived (like our
// command probes) and would only flash up as phantom sessions.
function withUnlistedLive(sessions: SDKSessionInfo[], live: Map<string, LiveSession>): SDKSessionInfo[] {
  const listed = new Set(sessions.map((s) => s.sessionId));
  const extra: SDKSessionInfo[] = [];
  for (const [id, l] of live) {
    if (listed.has(id) || !l.cwd) continue;
    if (l.entrypoint?.startsWith("sdk") && !l.here) continue;
    const time = l.updatedAt ?? l.startedAt ?? Date.now();
    extra.push({ sessionId: id, summary: l.name || "New session", lastModified: time, createdAt: l.startedAt, cwd: l.cwd });
  }
  return [...sessions, ...extra];
}

// The SDK reads a session's folder from the start of its transcript, so a
// first message with a big pasted image pushes it out of reach and the session
// comes back without one (and would vanish from the list). Find it ourselves:
// the live registry knows it, else the first transcript line that has a cwd.
async function transcriptCwd(file: string): Promise<string | undefined> {
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('"cwd":"')) continue;
      try {
        const cwd = JSON.parse(line).cwd;
        if (typeof cwd === "string") return cwd;
      } catch {}
    }
  } catch {}
  finally {
    lines.close();
  }
  return undefined;
}

async function withMissingCwd(sessions: SDKSessionInfo[], live: Map<string, LiveSession>): Promise<SDKSessionInfo[]> {
  if (sessions.every((s) => s.cwd)) return sessions;
  const paths = await transcriptPaths();
  return Promise.all(
    sessions.map(async (s) => {
      if (s.cwd) return s;
      const file = paths.get(s.sessionId);
      const cwd = live.get(s.sessionId)?.cwd ?? (file ? await transcriptCwd(file) : undefined);
      return cwd ? { ...s, cwd } : s;
    }),
  );
}

async function projectSessions(live: Map<string, LiveSession>): Promise<IndexedSession[]> {
  const all = withUnlistedLive(await withMissingCwd(await listSessions(), live), live);
  const claude = await withActivity(all.filter((s) => isProjectFolder(s.cwd)));
  return [...claude, ...(await geminiSessions())];
}

async function geminiSessions(): Promise<IndexedSession[]> {
  try {
    return (await gemini.listSessions())
      .filter((s) => isProjectFolder(s.cwd))
      .map((s) => ({ sessionId: s.id, summary: s.title, lastModified: s.lastModified, cwd: s.cwd, backend: "gemini", contextTokens: s.contextTokens }));
  } catch {
    return []; // a broken Gemini store must not hide the Claude sessions
  }
}

function folderName(dir: string): string {
  return dir === os.homedir() ? "~" : path.basename(dir);
}

// One shared snapshot of all project sessions and their live status.
// Concurrent requests reuse it; file watching (events.ts) and our own changes
// invalidate it, with a maximum age in case a change is missed.
interface SessionIndex {
  sessions: IndexedSession[];
  live: Map<string, LiveSession>;
}

const INDEX_MAX_AGE_MS = 10_000;
// Appends to a transcript only dirty the index; it is rebuilt at most this often then.
const DIRTY_MIN_AGE_MS = 3_000;
let index: { promise: Promise<SessionIndex>; at: number; dirty?: boolean; liveStale?: boolean } | null = null;

async function buildLive(): Promise<Map<string, LiveSession>> {
  const live = await liveSessions();
  // Our own runs know their status best (e.g. waiting for a permission answer).
  for (const [id, status] of runStatuses()) {
    const entry = live.get(id);
    if (entry) Object.assign(entry, { status, here: true });
    // Gemini runs aren't in Claude Code's registry; ours are all there is.
    else if (isGeminiSession(id)) live.set(id, { status, here: true });
  }
  return live;
}

function sessionIndex(): Promise<SessionIndex> {
  const age = index ? Date.now() - index.at : 0;
  if (!index || age > INDEX_MAX_AGE_MS || index.liveStale || (index.dirty && age > DIRTY_MIN_AGE_MS)) {
    const previous = index?.liveStale && age <= INDEX_MAX_AGE_MS && !(index.dirty && age > DIRTY_MIN_AGE_MS) ? index.promise : null;
    const promise = (async () => {
      const live = await buildLive();
      // Only live status changed: keep the session list if it already knows every live session.
      if (previous) {
        const old = await previous.catch(() => null);
        if (old && [...live.keys()].every((id) => old.live.has(id) || old.sessions.some((s) => s.sessionId === id))) {
          return { live, sessions: old.sessions };
        }
      }
      return { live, sessions: await projectSessions(live) };
    })();
    index = previous && index ? { promise, at: index.at, dirty: index.dirty } : { promise, at: Date.now() };
    promise.catch(() => {
      if (index?.promise === promise) index = null;
    });
  }
  return index.promise;
}

// A session's title and folder, for notifications (null if it isn't indexed yet).
export async function sessionLabel(id: string): Promise<{ title: string; dir: string } | null> {
  const { sessions, live } = await sessionIndex();
  const s = sessions.find((x) => x.sessionId === id);
  return s?.cwd ? { title: toSummary(s, live).title, dir: s.cwd } : null;
}

export function invalidateSessions(): void {
  index = null;
}

// Only live status changed (a run started, stopped or is waiting).
export function invalidateLive(): void {
  if (index) index.liveStale = true;
}

// A transcript grew: its row is out of date, but not worth a rebuild per write.
export function markSessionDirty(_id: string): void {
  if (index) index.dirty = true;
}

// Every project folder that has sessions, plus any extra paths given.
function folderStats({ sessions, live }: SessionIndex, extra: string[]): Map<string, FolderInfo> {
  const folders = new Map<string, FolderInfo>();
  const folder = (dir: string) => {
    let f = folders.get(dir);
    if (!f) folders.set(dir, (f = { path: dir, name: folderName(dir), sessionCount: 0, liveCount: 0, lastActivity: 0 }));
    return f;
  };
  for (const dir of extra) folder(dir);
  for (const s of sessions) {
    const f = folder(s.cwd!);
    f.sessionCount++;
    const entry = live.get(s.sessionId);
    if (entry) {
      f.liveCount++;
      f.live = mostUrgent(f.live, entry.status);
      if (entry.here) f.liveHere = true;
    }
    f.lastActivity = Math.max(f.lastActivity, s.lastModified);
  }
  return folders;
}

// Which status a folder shows when several of its sessions are live.
const URGENCY: LiveStatus[] = ["idle", "working", "waiting"];
const mostUrgent = (a: LiveStatus | undefined, b: LiveStatus) =>
  a && URGENCY.indexOf(a) > URGENCY.indexOf(b) ? a : b;

const byActivity = (a: FolderInfo, b: FolderInfo) => b.lastActivity - a.lastActivity || a.name.localeCompare(b.name);

function chosenFolders(idx: SessionIndex, chosen: string[]): FolderInfo[] {
  const stats = folderStats(idx, chosen);
  return chosen.map((dir) => stats.get(dir)!).sort(byActivity);
}

function folderSessions({ sessions, live }: SessionIndex, dir: string): SessionSummary[] {
  return sessions
    .filter((s) => s.cwd === dir)
    .map((s) => toSummary(s, live))
    .sort((a, b) => b.lastActivity - a.lastActivity);
}

// The folders chosen for the navigator.
export async function listFolders(): Promise<FolderInfo[]> {
  const [{ folders: chosen }, idx] = await Promise.all([loadConfig(), sessionIndex()]);
  return chosenFolders(idx, chosen);
}

// Everything the navigator shows: chosen folders, plus the sessions of the
// open ones, in one request.
export async function getTree(open: string[]): Promise<Tree> {
  const [{ folders: chosen }, idx] = await Promise.all([loadConfig(), sessionIndex()]);
  return {
    folders: chosenFolders(idx, chosen),
    sessions: Object.fromEntries(open.map((dir) => [dir, folderSessions(idx, dir)])),
  };
}

// All known project folders, for the project picker.
export async function listFolderChoices(): Promise<FolderChoice[]> {
  const [{ folders: chosen }, idx] = await Promise.all([loadConfig(), sessionIndex()]);
  const stats = folderStats(idx, chosen);
  return [...stats.values()].sort(byActivity).map((f) => ({ ...f, selected: chosen.includes(f.path) }));
}

function toSummary(s: IndexedSession, live?: Map<string, LiveSession>): SessionSummary {
  return {
    live: live?.get(s.sessionId)?.status,
    liveHere: live?.get(s.sessionId)?.here,
    remote: live?.get(s.sessionId)?.bridge ? `https://claude.ai/code/${live.get(s.sessionId)!.bridge}` : undefined,
    id: s.sessionId,
    backend: s.backend,
    title: s.customTitle || s.summary || s.firstPrompt || "Untitled session",
    lastActivity: s.lastModified,
    createdAt: s.createdAt,
    gitBranch: s.gitBranch,
    contextTokens: s.contextTokens,
    cacheTtlMs: s.cacheTtlMs,
  };
}

export async function listFolderSessions(dir: string): Promise<SessionSummary[]> {
  return folderSessions(await sessionIndex(), dir);
}

// The converted chat per transcript, keyed on mtime + size, so polls and
// several open pages share one parse (incremental ?from= reads slice this).
// In-flight parses are shared too. Bounded; oldest entries drop out.
const chatCache = new Map<string, { key: string; chat: Promise<ChatMessage[]> }>();
const CHAT_CACHE_MAX = 8;

async function transcriptKey(id: string): Promise<{ file: string; key: string } | null> {
  const file = (await transcriptPaths()).get(id);
  const info = file ? await stat(file).catch(() => null) : null;
  return file && info ? { file, key: `${info.mtimeMs}:${info.size}` } : null;
}

function remember<T>(cache: Map<string, { key: string; chat: Promise<T> }>, max: number, file: string, key: string, value: Promise<T>): Promise<T> {
  cache.delete(file); // re-insert so the oldest entry is first
  cache.set(file, { key, chat: value });
  value.catch(() => {
    if (cache.get(file)?.chat === value) cache.delete(file);
  });
  while (cache.size > max) cache.delete(cache.keys().next().value!);
  return value;
}

export async function readSession(id: string, dir?: string): Promise<ChatMessage[]> {
  const running = runMessages(id);
  if (running) return running;
  if (isGeminiSession(id)) return readGeminiSession(id);
  const t = await transcriptKey(id);
  if (!t) return convertSession(id, dir);
  const k = `${t.key}|${dir ?? ""}`;
  const hit = chatCache.get(t.file);
  if (hit?.key === k) return hit.chat;
  return remember(chatCache, CHAT_CACHE_MAX, t.file, k, convertSession(id, dir));
}

async function convertSession(id: string, dir?: string): Promise<ChatMessage[]> {
  const [entries, commands] = await Promise.all([
    getSessionMessages(id, { ...(dir ? { dir } : {}), includeSystemMessages: true }),
    localCommands(id),
  ]);
  // The SDK rebuilds the conversation backwards from its newest message and
  // skips a command's output while it's the last entry; add trailing ones.
  for (let last = entries.at(-1); last; ) {
    const next = commands.find((c) => c.parentUuid === last!.uuid);
    if (!next || entries.some((e) => e.uuid === next.uuid)) break;
    const entry = { type: "system", uuid: next.uuid, session_id: id, message: undefined, parent_tool_use_id: null, parent_agent_id: null, timestamp: next.timestamp } as SessionMessage;
    entries.push(entry);
    last = entry;
  }
  const output = new Map(commands.map((c) => [c.uuid, c.content]));
  const q = dir ? `?dir=${encodeURIComponent(dir)}` : "";
  return toChatMessages(entries, (entryUuid, n) => `/api/sessions/${id}/images/${entryUuid}/${n}${q}`, output);
}

interface LocalCommandEntry {
  uuid: string;
  parentUuid: string | null;
  content: string;
  timestamp?: string;
}

// Slash commands that run locally (/context, /model, /cost…) save their
// output as system entries, whose content the SDK doesn't return. Read them
// from the transcript.
// Cached per transcript, keyed on mtime + size; bounded so old sessions drop out.
const localCommandCache = new Map<string, { key: string; entries: LocalCommandEntry[] }>();
const LOCAL_COMMAND_CACHE_MAX = 50;

async function localCommands(id: string): Promise<LocalCommandEntry[]> {
  const file = (await transcriptPaths()).get(id);
  if (!file) return [];
  const info = await stat(file).catch(() => null);
  if (!info) return [];
  const key = `${info.mtimeMs}:${info.size}`;
  const hit = localCommandCache.get(file);
  if (hit?.key === key) return hit.entries;

  const found: LocalCommandEntry[] = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (!line.includes('"local_command"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.subtype === "local_command" && typeof e.content === "string") {
        found.push({ uuid: e.uuid, parentUuid: e.parentUuid ?? null, content: e.content, timestamp: e.timestamp });
      }
    } catch {}
  }
  localCommandCache.delete(file); // re-insert so the oldest entry is first
  localCommandCache.set(file, { key, entries: found });
  while (localCommandCache.size > LOCAL_COMMAND_CACHE_MAX) {
    localCommandCache.delete(localCommandCache.keys().next().value!);
  }
  return found;
}

// Raw SDK entries (with image data) for image requests: a chat with many
// screenshots would otherwise parse the file once per image. Few entries kept,
// they are big.
const imageCache = new Map<string, { key: string; chat: Promise<SessionMessage[]> }>();
const IMAGE_CACHE_MAX = 3;

export async function readImage(id: string, entryUuid: string, n: number, dir?: string) {
  const load = () => getSessionMessages(id, dir ? { dir } : undefined);
  const t = await transcriptKey(id);
  let entries: Promise<SessionMessage[]>;
  if (!t) entries = load();
  else {
    const k = `${t.key}|${dir ?? ""}`;
    const hit = imageCache.get(t.file);
    entries = hit?.key === k ? hit.chat : remember(imageCache, IMAGE_CACHE_MAX, t.file, k, load());
  }
  return findImage(await entries, entryUuid, n);
}

// Same as /rename in Claude Code: appends a custom-title entry to the transcript.
// Returns null if the session does not exist.
export async function renameSession(id: string, dir: string, title: string): Promise<SessionSummary | null> {
  if (isGeminiSession(id)) {
    await renameGeminiSession(id, title);
    invalidateSessions();
    return (await listFolderSessions(dir)).find((s) => s.id === id) ?? null;
  }
  if (!(await getSessionInfo(id, { dir }))) return null;
  await sdkRenameSession(id, title, { dir });
  invalidateSessions();
  const info = await getSessionInfo(id, { dir });
  return info ? toSummary((await withActivity([info]))[0], await liveSessions()) : null;
}

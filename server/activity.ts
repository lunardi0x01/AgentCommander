// When was a session last active?
//
// The SDK's `lastModified` is the transcript file's mtime, but Claude Code
// rewrites and appends metadata to old transcripts (titles, summaries), so the
// mtime can be days newer than the conversation. Instead, take the timestamp
// of the last user or assistant entry, reading only the end of the file.

import os from "node:os";
import path from "node:path";
import { open, readdir, stat } from "node:fs/promises";

const PROJECTS_DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");

async function scanTranscriptPaths(): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  const projects = await readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, project.name);
    for (const file of await readdir(dir).catch(() => [])) {
      if (file.endsWith(".jsonl")) paths.set(file.slice(0, -6), path.join(dir, file));
    }
  }
  prune(new Set(paths.values()));
  return paths;
}

// Session id -> transcript path. Cached; the projects watcher (events.ts)
// drops it on renames (files added, moved, removed), and the max age covers
// missed events. Callers must not mutate the map.
const PATHS_MAX_AGE_MS = 60_000;
let pathsCache: { promise: Promise<Map<string, string>>; at: number } | null = null;

export function transcriptPaths(): Promise<Map<string, string>> {
  if (!pathsCache || Date.now() - pathsCache.at > PATHS_MAX_AGE_MS) {
    const promise = scanTranscriptPaths();
    pathsCache = { promise, at: Date.now() };
    promise.catch(() => {
      if (pathsCache?.promise === promise) pathsCache = null;
    });
  }
  return pathsCache.promise;
}

export function invalidateTranscriptPaths(): void {
  pathsCache = null;
}

// Whether a transcript file path (as seen by the watcher) is a known session's.
export async function isKnownTranscript(file: string): Promise<boolean> {
  const id = path.basename(file).slice(0, -6);
  return (await transcriptPaths()).get(id) === path.join(PROJECTS_DIR, file);
}

// What the transcript's tail says about a session.
export interface Activity {
  time: number | null; // last user/assistant entry
  context: number | null; // tokens the last model call read: what resuming has to send again
  cacheTtlMs: number | null; // how long its prompt cache lives, from the last cache write
}

// Cached per file, keyed on mtime + size so changed files are re-read.
const cache = new Map<string, { key: string; activity: Activity }>();

// Drops entries of transcripts that no longer exist.
function prune(live: Set<string>): void {
  for (const file of cache.keys()) if (!live.has(file)) cache.delete(file);
}

async function fileActivity(file: string): Promise<Activity> {
  const info = await stat(file);
  const key = `${info.mtimeMs}:${info.size}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.activity;

  const activity = await scanTail(file, info.size);
  cache.set(file, { key, activity });
  return activity;
}

// Reads growing chunks from the end until a user/assistant entry and an
// assistant entry with token usage and one that wrote the cache have turned up.
// Upper bound for the tail read; whatever was found within it is returned.
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

async function scanTail(file: string, size: number): Promise<Activity> {
  const handle = await open(file, "r");
  try {
    for (let chunk = 64 * 1024; ; chunk *= 8) {
      const length = Math.min(chunk, size, MAX_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const lines = buffer.toString("utf8").split("\n");
      if (length < size) lines.shift(); // first line is probably cut off

      const activity: Activity = { time: null, context: null, cacheTtlMs: null };
      for (let i = lines.length - 1; i >= 0 && (activity.time === null || activity.context === null || activity.cacheTtlMs === null); i--) {
        if (!lines[i].includes('"timestamp"')) continue;
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type !== "user" && entry.type !== "assistant") continue;
          if (activity.time === null) {
            const time = Date.parse(entry.timestamp);
            if (!Number.isNaN(time)) activity.time = time;
          }
          const usage = entry.type === "assistant" ? entry.message?.usage : undefined;
          if (activity.context === null && usage) {
            // Synthetic entries (errors, interrupts) report no usage at all.
            const total = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
            if (total > 0) activity.context = total;
          }
          // Cache writes say which lifetime was used; subagents may differ from the main thread.
          const written = usage?.cache_creation;
          if (activity.cacheTtlMs === null && written && !entry.isSidechain) {
            if (written.ephemeral_1h_input_tokens > 0) activity.cacheTtlMs = 60 * 60_000;
            else if (written.ephemeral_5m_input_tokens > 0) activity.cacheTtlMs = 5 * 60_000;
          }
        } catch {}
      }
      if (length === size || length === MAX_TAIL_BYTES || (activity.time !== null && activity.context !== null && activity.cacheTtlMs !== null)) return activity;
    }
  } finally {
    await handle.close();
  }
}

// Activity per session id; sessions without a readable transcript are left
// out, and callers fall back to the SDK's lastModified.
export async function sessionActivity(ids: string[]): Promise<Map<string, Activity>> {
  const paths = await transcriptPaths();
  const found = new Map<string, Activity>();
  await Promise.all(
    ids.map(async (id) => {
      const file = paths.get(id);
      const activity = file ? await fileActivity(file).catch(() => null) : null;
      if (activity) found.set(id, activity);
    }),
  );
  return found;
}

// Last message time per session id.
export async function lastActivityTimes(ids: string[]): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  for (const [id, { time }] of await sessionActivity(ids)) if (time !== null) times.set(id, time);
  return times;
}

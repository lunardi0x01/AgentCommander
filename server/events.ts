// Server-sent events, so open pages follow changes made by Claude Code:
//   { type: "session", id }  a session's transcript changed
//   { type: "list" }         sessions were added, removed or changed status
// Both come from watching ~/.claude/projects and the live-session registry.
// Also: { type: "run" } (a run's state), { type: "queue" } (the prompt queue
// changed) and { type: "notes", dir, file } (one of a project's documents changed).

import os from "node:os";
import path from "node:path";
import { existsSync, watch, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { REGISTRY_DIR } from "./live.ts";
import { invalidateTranscriptPaths, isKnownTranscript } from "./activity.ts";
import { invalidateLive, invalidateSessions, markSessionDirty } from "./sessions.ts";
import { onRunChange, onRunMessages } from "./runner.ts";
import { onQueueChange } from "./queue.ts";
import { DOC_FILES } from "./notes.ts";
import { loadConfig } from "./config.ts";
import type { RunState } from "../shared/types.ts";

const PROJECTS_DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");

type Event =
  | { type: "session"; id: string }
  | { type: "list" }
  | { type: "run"; id: string; run: RunState | null }
  | { type: "queue" }
  | { type: "notes"; dir: string; file: string };

const clients = new Set<ServerResponse>();
const timers = new Map<string, { timer: NodeJS.Timeout; due: number }>();

// Collapses bursts of file events into one message per key. A pending
// message is brought forward if a sooner one is asked for.
function emitSoon(key: string, event: Event, delayMs: number): void {
  const due = Date.now() + delayMs;
  const pending = timers.get(key);
  if (pending && pending.due <= due) return;
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(() => {
    timers.delete(key);
    send(event);
  }, delayMs);
  timers.set(key, { timer, due });
}

// Started with the server, so the session index stays fresh even with no
// page open.
export function startWatching(): void {
  keepWatching(PROJECTS_DIR, true, (type, file) => {
      if (!file) return;
      const match = path.basename(file).match(/^([0-9a-f-]{36})\.jsonl$/);
      // Appends to a known transcript only dirty that session; anything else
      // (new, moved or removed files, unknown names) rebuilds the index.
      if (type === "change" && match) {
        void isKnownTranscript(file).then((known) => {
          if (known) markSessionDirty(match[1]);
          else {
            invalidateTranscriptPaths();
            invalidateSessions();
          }
        });
      } else {
        invalidateTranscriptPaths();
        invalidateSessions();
      }
      if (match) emitSoon(`session:${match[1]}`, { type: "session", id: match[1] }, 300);
      // A running session appends constantly; that only moves its "last
      // active" time, so the tree needn't follow every write. New, moved or
      // removed files ("rename") show quickly.
      emitSoon("list", { type: "list" }, type === "rename" ? 1500 : 10_000);
  });
  keepWatching(REGISTRY_DIR, false, () => {
      invalidateSessions();
      emitSoon("list", { type: "list" }, 500);
  });
  watchGeminiStore();
  void watchNotes();
  // Pick up docs/ and .project/ folders created after a folder was first seen.
  setInterval(() => void watchNotes(), 60_000).unref();
}

// Watches a directory that may not exist yet or may vanish: on error the
// watcher is closed and a slow timer tries again.
function keepWatching(dir: string, recursive: boolean, onChange: (type: string, file: string | null) => void): void {
  const retry = () => setTimeout(() => keepWatching(dir, recursive, onChange), 30_000).unref();
  if (!existsSync(dir)) return void retry();
  try {
    const watcher = watch(dir, { recursive }, (type, file) => onChange(type, file));
    watcher.on("error", () => {
      watcher.close();
      retry();
    });
  } catch {
    retry();
  }
}

// agy's conversations dir changes when a Gemini session is made, renamed or
// deleted. Retried if the dir doesn't exist yet or the watcher fails.
function watchGeminiStore(): void {
  const dir = path.join(process.env.AGY_ACP_DIR || path.join(os.homedir(), ".gemini", "antigravity-acp"), "conversations");
  keepWatching(dir, false, () => {
    invalidateSessions();
    emitSoon("list", { type: "list" }, 1500);
  });
}

// Each chosen folder (and its docs/ and .project/) is watched, not recursively, for its documents.
const notesWatchers = new Map<string, { close: () => void; subs: string }>();

export async function watchNotes(): Promise<void> {
  const folders = new Set((await loadConfig()).folders);
  for (const [dir, watcher] of notesWatchers) {
    if (folders.has(dir)) continue;
    watcher.close();
    notesWatchers.delete(dir);
  }
  for (const dir of folders) {
    if (!existsSync(dir)) continue;
    const subs = ["", "docs", ".project"].filter((sub) => existsSync(path.join(dir, sub)));
    const key = subs.join("|");
    if (notesWatchers.get(dir)?.subs === key) continue;
    notesWatchers.get(dir)?.close(); // a sub-folder appeared (or one errored): start over
    notesWatchers.delete(dir);
    const watchers: FSWatcher[] = [];
    try {
      const closeAll = () => {
        watchers.forEach((w) => w.close());
        // Drop the entry so the next refresh re-arms the whole folder.
        if (notesWatchers.get(dir)?.close === closeAll) notesWatchers.delete(dir);
      };
      for (const sub of subs) {
        const watcher = watch(path.join(dir, sub), (_, changed) => {
          const file = path.posix.join(sub, String(changed ?? ""));
          if (DOC_FILES.includes(file)) emitSoon(`notes:${dir}:${file}`, { type: "notes", dir, file }, 300);
        });
        watcher.on("error", closeAll);
        watchers.push(watcher);
      }
      notesWatchers.set(dir, { close: closeAll, subs: key });
    } catch {
      watchers.forEach((w) => w.close()); // a later watch() threw: don't leak the earlier ones
    }
  }
}

onQueueChange(() => emitSoon("queue", { type: "queue" }, 100));

function send(event: Event): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}

// Runs throttle their own updates, so these go out at once. A status change
// also changes the navigator's live dots.
const lastStatus = new Map<string, RunState["status"] | "ended">();
onRunChange((id, run) => {
  send({ type: "run", id, run });
  const status = run?.status ?? "ended";
  if (lastStatus.get(id) !== status) {
    lastStatus.set(id, status);
    // Ended and errored runs are never cleaned up otherwise; keep the newest 500.
    if (lastStatus.size > 500) lastStatus.delete(lastStatus.keys().next().value!);
    invalidateLive(); // only live dots change; the session list is reused
    emitSoon("list", { type: "list" }, 100);
  }
});

// A Gemini run's messages changed (Claude's are followed through their files).
onRunMessages((id) => emitSoon(`session:${id}`, { type: "session", id }, 50));

export function notifyListChanged(): void {
  invalidateSessions();
  emitSoon("list", { type: "list" }, 100);
}

export function handleEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  clients.add(res);
  // Comments keep proxies from closing an idle stream.
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

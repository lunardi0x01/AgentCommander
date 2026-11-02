// Server-sent events, so open pages follow changes made by Claude Code:
//   { type: "session", id }  a session's transcript changed
//   { type: "list" }         sessions were added, removed or changed status
// Both come from watching ~/.claude/projects and the live-session registry.
// Also: { type: "run" } (a run's state), { type: "queue" } (the prompt queue
// changed) and { type: "notes", dir, file } (one of a project's documents changed).

import os from "node:os";
import path from "node:path";
import { existsSync, watch } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { REGISTRY_DIR } from "./live.ts";
import { invalidateSessions } from "./sessions.ts";
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
  if (existsSync(PROJECTS_DIR)) {
    watch(PROJECTS_DIR, { recursive: true }, (type, file) => {
      if (!file) return;
      invalidateSessions();
      const match = path.basename(file).match(/^([0-9a-f-]{36})\.jsonl$/);
      if (match) emitSoon(`session:${match[1]}`, { type: "session", id: match[1] }, 300);
      // A running session appends constantly; that only moves its "last
      // active" time, so the tree needn't follow every write. New, moved or
      // removed files ("rename") show quickly.
      emitSoon("list", { type: "list" }, type === "rename" ? 1500 : 10_000);
    });
  }
  if (existsSync(REGISTRY_DIR)) {
    watch(REGISTRY_DIR, () => {
      invalidateSessions();
      emitSoon("list", { type: "list" }, 500);
    });
  }
  void watchNotes();
}

// Each chosen folder (and its docs/ and .project/) is watched, not recursively, for its documents.
const notesWatchers = new Map<string, { close: () => void }>();

export async function watchNotes(): Promise<void> {
  const folders = new Set((await loadConfig()).folders);
  for (const [dir, watcher] of notesWatchers) {
    if (folders.has(dir)) continue;
    watcher.close();
    notesWatchers.delete(dir);
  }
  for (const dir of folders) {
    if (notesWatchers.has(dir) || !existsSync(dir)) continue;
    try {
      const watchers = ["", "docs", ".project"].flatMap((sub) => {
        if (!existsSync(path.join(dir, sub))) return [];
        const watcher = watch(path.join(dir, sub), (_, changed) => {
          const file = path.posix.join(sub, String(changed ?? ""));
          if (DOC_FILES.includes(file)) emitSoon(`notes:${dir}:${file}`, { type: "notes", dir, file }, 300);
        });
        watcher.on("error", () => {
          watcher.close();
          notesWatchers.delete(dir);
        });
        return [watcher];
      });
      notesWatchers.set(dir, { close: () => watchers.forEach((w) => w.close()) });
    } catch {}
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
    notifyListChanged();
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

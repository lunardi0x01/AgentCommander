// The prompt queue: tasks to run unattended, each in a new session of its
// own (a small fresh context costs the fewest tokens), one at a time. When
// the plan's usage is out, it waits for the reset and carries on by itself.
//
// Stored at $XDG_DATA_HOME/agent-commander/queue.json (default ~/.local/share).

import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { QueueItem, QueueState, QueueTask, SessionSettings } from "../shared/types.ts";
import { CHILD_ENV, CLAUDE_PATH } from "./claude.ts";
import { getSettings } from "./config.ts";
import { closeRun, getRun, lastRateLimit, onRateLimit, onRunChange, sendMessage } from "./runner.ts";
import { renameSession } from "./sessions.ts";
import { getUsage, invalidateUsage, usageBlocked } from "./usage.ts";

const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "agent-commander");
const QUEUE_FILE = path.join(DATA_DIR, "queue.json");
// While waiting for usage, look again at least this often (a reset time can
// be missing or move).
const RECHECK_MS = 15 * 60 * 1000;
// After a reset, give the plan a moment before asking again.
const RESET_GRACE_MS = 60 * 1000;
const SPLIT_TIMEOUT_MS = 90_000;

let state: QueueState | null = null;
let changeListener: () => void = () => {};

export function onQueueChange(fn: () => void): void {
  changeListener = fn;
}

async function load(): Promise<QueueState> {
  if (state) return state;
  try {
    const raw = JSON.parse(await readFile(QUEUE_FILE, "utf8"));
    state = { items: Array.isArray(raw.items) ? raw.items : [], paused: !!raw.paused, waitingUntil: raw.waitingUntil };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    state = { items: [], paused: false };
  }
  return state;
}

// Changes run one at a time and are saved before anyone hears of them.
let writes: Promise<unknown> = Promise.resolve();

function change<T>(fn: (s: QueueState) => T): Promise<T> {
  const run = writes.then(async () => {
    const current = await load();
    // Mutate a clone; it replaces the live state only once the write succeeded.
    const s = structuredClone(current);
    const result = fn(s);
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = `${QUEUE_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2) + "\n");
    await rename(tmp, QUEUE_FILE);
    state = s;
    changeListener();
    return result;
  });
  writes = run.catch(() => {});
  return run;
}

export async function getQueue(): Promise<QueueState> {
  return structuredClone(await load());
}

// `sessionId`: continue that session instead of starting new ones (a
// message queued from a chat that hit the limit).
export async function addTasks(dir: string, tasks: QueueTask[], split = false, sessionId?: string): Promise<void> {
  await change((s) => {
    for (const t of tasks) {
      s.items.push({
        id: randomUUID(),
        dir,
        title: t.title,
        prompt: t.prompt,
        status: "queued",
        createdAt: Date.now(),
        ...(split ? { split } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
    }
  });
  kick();
}

export function updateTask(id: string, edit: Partial<QueueTask>): Promise<boolean> {
  return change((s) => {
    const item = s.items.find((i) => i.id === id && i.status === "queued");
    if (!item) return false;
    if (edit.title !== undefined) item.title = edit.title;
    if (edit.prompt !== undefined) item.prompt = edit.prompt;
    return true;
  });
}

// Running items stay: their session carries on regardless.
export function removeTask(id: string): Promise<boolean> {
  return change((s) => {
    const i = s.items.findIndex((item) => item.id === id && item.status !== "running");
    if (i < 0) return false;
    s.items.splice(i, 1);
    return true;
  });
}

// Moves an item one place up or down among the items.
export function moveTask(id: string, by: -1 | 1): Promise<boolean> {
  return change((s) => {
    const i = s.items.findIndex((item) => item.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= s.items.length) return false;
    [s.items[i], s.items[j]] = [s.items[j], s.items[i]];
    return true;
  });
}

export async function clearFinished(): Promise<void> {
  await change((s) => void (s.items = s.items.filter((i) => i.status !== "done" && i.status !== "failed")));
}

export async function setPaused(paused: boolean): Promise<void> {
  await change((s) => void (s.paused = paused));
  kick();
}

// Try now rather than at the expected reset.
export async function runNow(): Promise<void> {
  invalidateUsage();
  await change((s) => {
    s.paused = false;
    delete s.waitingUntil;
  });
  kick();
}

// --- splitting ---------------------------------------------------------------

const SPLIT_PROMPT = `Split the user's notes below into separate coding tasks for Claude Code.
Each task runs on its own in a NEW session with no memory of the others, in the project folder, so:
- write each prompt so it stands alone: say what to do, where, and how to tell it's done;
- keep related steps that need each other in one task; split only work that can be done independently;
- keep the user's wording and intent; don't invent requirements;
- order the tasks so ones others depend on come first;
- a short title (under 60 characters) for each.
If it's really one task, return one.

Notes:
`;

const SPLIT_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, prompt: { type: "string" } },
        required: ["title", "prompt"],
      },
    },
  },
  required: ["tasks"],
};

// Asks Haiku (no tools, nothing saved) to split a list into tasks.
export async function splitTasks(dir: string, text: string): Promise<QueueTask[]> {
  const q = query({
    prompt: SPLIT_PROMPT + text,
    options: {
      cwd: dir,
      env: CHILD_ENV,
      pathToClaudeCodeExecutable: CLAUDE_PATH,
      persistSession: false,
      model: "haiku",
      tools: [],
      settingSources: [],
      outputFormat: { type: "json_schema", schema: SPLIT_SCHEMA },
    },
  });
  const timer = setTimeout(() => q.close(), SPLIT_TIMEOUT_MS);
  try {
    for await (const message of q) {
      if (message.type !== "result") continue;
      if (message.subtype !== "success") throw new Error(`Couldn't split the list: ${message.subtype.replace(/_/g, " ")}`);
      const tasks = (message.structured_output as { tasks?: QueueTask[] } | undefined)?.tasks;
      const valid = (tasks ?? []).filter((t) => typeof t?.title === "string" && typeof t?.prompt === "string" && t.prompt.trim());
      if (!valid.length) throw new Error("Couldn't split the list: no tasks came back");
      return valid.map((t) => ({ title: t.title.trim().slice(0, 120), prompt: t.prompt.trim() }));
    }
    throw new Error("Couldn't split the list: it took too long");
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

// --- running -----------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let ticking = false;
let again = false;

// Looks for work; safe to call any time.
function kick(): void {
  if (ticking) {
    again = true;
    return;
  }
  ticking = true;
  tick()
    .catch((err) => console.error("Queue:", err))
    .finally(() => {
      ticking = false;
      if (again) {
        again = false;
        kick();
      }
    });
}

function wakeAt(at: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(kick, Math.max(1000, Math.min(at - Date.now(), RECHECK_MS)));
}

async function tick(): Promise<void> {
  const s = await load();
  if (s.paused) return;
  // One at a time; an item waiting for a permission answer doesn't hold the rest up.
  if (s.items.some((i) => i.status === "running")) return;
  const next = s.items.find((i) => i.status === "queued");
  if (!next) {
    if (state?.waitingUntil) await change((st) => void delete st.waitingUntil);
    return;
  }

  const until = await usageOutUntil();
  if (until) {
    if (state?.waitingUntil !== until) await change((st) => void (st.waitingUntil = until));
    return wakeAt(until);
  }
  if (state?.waitingUntil) await change((st) => void delete st.waitingUntil);

  if (next.split) {
    let tasks: QueueTask[];
    try {
      tasks = await splitTasks(next.dir, next.prompt);
    } catch (err) {
      await change((st) => void delete st.items.find((i) => i.id === next.id)?.split); // run it as written instead
      console.error("Queue: splitting failed, running the item as one task:", err);
      return kick();
    }
    await change((st) => {
      const i = st.items.findIndex((x) => x.id === next.id);
      if (i < 0) return;
      st.items.splice(i, 1, ...tasks.map((t): QueueItem => ({ ...next, id: randomUUID(), title: t.title, prompt: t.prompt, split: undefined })));
    });
    return kick();
  }

  const settings = await getSettings();
  const runSettings: SessionSettings = { mode: settings.queueMode, model: settings.defaultModel, effort: settings.defaultEffort };
  // A retry (after hitting the limit) continues the session it started.
  const isNew = !next.sessionId;
  const sessionId = next.sessionId ?? randomUUID();
  await change((st) => {
    const item = st.items.find((i) => i.id === next.id);
    if (!item) return;
    item.status = "running";
    item.sessionId = sessionId;
    delete item.error;
  });
  try {
    await sendMessage(sessionId, next.dir, next.prompt, runSettings, isNew);
  } catch (err) {
    await finishItem(next, "failed", err instanceof Error ? err.message : String(err));
  }
}

// When usage is out: the time to try again (ms since epoch). Null when
// there's room, or when usage can't be read (the run will find out).
async function usageOutUntil(): Promise<number | null> {
  const now = Date.now();
  const limit = lastRateLimit();
  if (limit?.rejected && limit.resetsAt && limit.resetsAt > now) return limit.resetsAt + RESET_GRACE_MS;
  try {
    const blocked = usageBlocked(await getUsage());
    if (blocked.blocked) return (blocked.until && blocked.until > now ? blocked.until : now + RECHECK_MS) + RESET_GRACE_MS;
  } catch (err) {
    console.error("Queue: couldn't read usage:", err);
  }
  return null;
}

async function finishItem(item: QueueItem, status: QueueItem["status"], error?: string): Promise<void> {
  await change((st) => {
    const live = st.items.find((i) => i.id === item.id);
    if (!live) return;
    live.status = status;
    if (error) live.error = error;
    else delete live.error;
  });
  // Name the session after its task (once it exists on disk).
  if (item.sessionId && (status === "done" || status === "waiting")) {
    renameSession(item.sessionId, item.dir, item.title).catch(() => {});
  }
  // Done: the process has nothing left to do. Waiting keeps its run (it needs an answer).
  // Not if the user already sent a follow-up while the write was pending.
  if (item.sessionId && status === "done" && getRun(item.sessionId)?.status === "idle") closeRun(item.sessionId);
  kick();
}

// Follows the runs the queue started.
onRunChange((id, run) => {
  const item = state?.items.find((i) => i.sessionId === id && (i.status === "running" || i.status === "waiting"));
  if (!item) return;
  if (!run) {
    if (item.status === "running") void finishItem(item, "failed", "Its Claude Code process ended before the task finished");
    return;
  }
  if (run.status === "waiting" && item.status === "running") void finishItem(item, "waiting");
  else if (run.status === "working" && item.status === "waiting") void change((st) => void (st.items.find((i) => i.id === item.id)!.status = "running"));
  else if (run.status === "idle" || run.status === "error") {
    if (run.rateLimited) {
      // Out of usage mid-task: back in line, to continue after the reset.
      invalidateUsage();
      void finishItem(item, "queued");
    } else void finishItem(item, run.error ? "failed" : "done", run.error);
  }
});

// A session hitting the limit (queued or not) means the queue should wait.
onRateLimit((limit) => {
  if (!limit.rejected) return;
  invalidateUsage();
  kick();
});

// On startup: runs don't survive a restart, so items caught mid-run say so.
export async function startQueue(): Promise<void> {
  await change((s) => {
    for (const item of s.items) {
      if (item.status === "running" || item.status === "waiting") {
        item.status = "failed";
        item.error = "Stopped by a server restart; open its session to continue";
      }
    }
  });
  kick();
}

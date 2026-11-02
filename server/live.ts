// Which sessions are running right now, and what are they doing?
//
// Every running Claude Code process registers itself in
// ~/.claude/sessions/<pid>.json with its session id and a status. Entries can
// outlive a crashed process, so each one is checked against /proc (pid alive,
// same start time, so a reused pid doesn't count).

import os from "node:os";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { LiveStatus } from "../shared/types.ts";

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
export const REGISTRY_DIR = path.join(CLAUDE_DIR, "sessions");

interface RegistryEntry {
  pid?: number;
  procStart?: string;
  sessionId?: string;
  status?: string;
  cwd?: string;
  name?: string;
  entrypoint?: string;
  bridgeSessionId?: string;
  startedAt?: number;
  updatedAt?: number;
}

export interface LiveSession {
  status: LiveStatus;
  here?: boolean; // run by Agent Commander (set by sessions.ts)
  pid?: number;
  procStart?: string;
  cwd?: string;
  name?: string;
  entrypoint?: string; // "cli" for Claude Code itself, "sdk-…" for SDK hosts
  bridge?: string; // Remote Control session id, when a bridge is active
  startedAt?: number;
  updatedAt?: number;
}

function toLiveStatus(status: string | undefined): LiveStatus {
  if (status === "busy") return "working";
  if (status === "idle") return "idle";
  return "waiting"; // waiting, blocked, requires_action: it needs you
}

// Field 22 of /proc/<pid>/stat is the process start time.
async function processStart(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

// Session id -> live session, for sessions with a running process.
export async function liveSessions(): Promise<Map<string, LiveSession>> {
  const live = new Map<string, LiveSession>();
  const files = await readdir(REGISTRY_DIR).catch(() => []);
  await Promise.all(
    files
      .filter((f) => /^\d+\.json$/.test(f)) // only the registry entries, not the .key files
      .map(async (file) => {
        try {
          const entry: RegistryEntry = JSON.parse(await readFile(path.join(REGISTRY_DIR, file), "utf8"));
          if (!entry.pid || !entry.sessionId) return;
          const started = await processStart(entry.pid);
          if (!started || (entry.procStart && entry.procStart !== started)) return;
          live.set(entry.sessionId, {
            status: toLiveStatus(entry.status),
            pid: entry.pid,
            procStart: started,
            cwd: entry.cwd,
            name: entry.name,
            entrypoint: entry.entrypoint,
            bridge: entry.bridgeSessionId,
            startedAt: entry.startedAt,
            updatedAt: entry.updatedAt,
          });
        } catch {}
      }),
  );
  return live;
}

// Ends the Claude Code process that has a session open (in a terminal, Remote
// Control, another app). Only signals a process found in the registry whose
// start time and command line still match, so a reused pid is never hit.
// Resolves true once it has exited.
export async function closeLiveProcess(id: string): Promise<boolean> {
  const session = (await liveSessions()).get(id);
  if (!session?.pid) return false;
  const pid = session.pid;
  const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
  if (!/claude/.test(cmdline) || (await processStart(pid)) !== session.procStart) return false;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if ((await processStart(pid)) !== session.procStart) return true;
  }
  return false;
}

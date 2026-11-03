// Deleted sessions, kept by Agent Commander so they can be restored from the
// UI. A deleted session's transcript (and its subagent folder, if any) moves
// to ~/.local/share/agent-commander/trash/<id>/ next to a meta.json that
// remembers where it came from. Only "Delete forever" removes files for good.
// A Gemini session's files (gemini.ts sessionFiles) are kept the same way.

import os from "node:os";
import path from "node:path";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { DeletedSession, TrashResult } from "../shared/types.ts";
import { lastActivityTimes, transcriptPaths } from "./activity.ts";
import { liveSessions } from "./live.ts";
import { gemini, isGeminiSession, sessionCwd, sessionFiles } from "./gemini.ts";
import { isRunning } from "./runner.ts";

const TRASH_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
  "agent-commander",
  "trash",
);

interface Meta {
  id: string;
  title: string;
  dir: string; // the session's project folder
  transcript: string; // original transcript path ("" for Gemini)
  lastActivity: number;
  deletedAt: number;
  backend?: "gemini"; // absent: Claude
  files?: Array<{ path: string; name: string }>; // Gemini: where each moved file came from
}

// rename() fails across filesystems; fall back to copy + remove.
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true });
  }
}

// The transcript's companion folder holds subagent transcripts.
const companion = (transcript: string) => transcript.slice(0, -".jsonl".length);

export async function trashSessions(items: Array<{ id: string; dir: string }>): Promise<TrashResult> {
  const result: TrashResult = { done: [], failed: [] };
  const [paths, live, times] = await Promise.all([
    transcriptPaths(),
    liveSessions(),
    lastActivityTimes(items.map((i) => i.id)),
  ]);

  for (const { id, dir } of items) {
    try {
      if (isGeminiSession(id)) {
        await trashGemini(id, dir);
        result.done.push(id);
        continue;
      }
      if (live.has(id)) throw new Error("session is live");
      const info = await getSessionInfo(id, { dir });
      const transcript = paths.get(id);
      if (!info || info.cwd !== dir || !transcript) throw new Error("not found in this folder");

      const target = path.join(TRASH_DIR, id);
      if (existsSync(target)) throw new Error("already in deleted sessions");
      await mkdir(target, { recursive: true });
      const meta: Meta = {
        id,
        title: info.customTitle || info.summary || info.firstPrompt || "Untitled session",
        dir,
        transcript,
        lastActivity: times.get(id) ?? info.lastModified,
        deletedAt: Date.now(),
      };
      // meta.json goes last: an entry only exists once everything is moved.
      const moved: Array<[string, string]> = [];
      try {
        await move(transcript, path.join(target, path.basename(transcript)));
        moved.push([transcript, path.join(target, path.basename(transcript))]);
        if (existsSync(companion(transcript))) {
          await move(companion(transcript), path.join(target, id));
          moved.push([companion(transcript), path.join(target, id)]);
        }
        await writeFile(path.join(target, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
      } catch (err) {
        for (const [from, to] of moved.reverse()) await move(to, from).catch(() => {});
        await rm(target, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      result.done.push(id);
    } catch (err) {
      result.failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

async function trashGemini(id: string, dir: string): Promise<void> {
  if (isRunning(id)) throw new Error("session is running; close it first");
  if ((await sessionCwd(id)) !== dir) throw new Error("not found in this folder");
  const info = (await gemini.listSessions()).find((s) => s.id === id);
  const target = path.join(TRASH_DIR, id);
  if (existsSync(target)) throw new Error("already in deleted sessions");
  await mkdir(target, { recursive: true });
  const files = sessionFiles(id).filter((f) => existsSync(f.path));
  const meta: Meta = {
    id,
    title: info?.title ?? "Gemini session",
    dir,
    transcript: "",
    lastActivity: info?.lastModified ?? Date.now(),
    deletedAt: Date.now(),
    backend: "gemini",
    files,
  };
  await writeFile(path.join(target, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  for (const f of files) await move(f.path, path.join(target, f.name));
}

async function restoreGemini(m: Meta): Promise<void> {
  const entry = path.join(TRASH_DIR, m.id);
  const files = (m.files ?? []).filter((f) => existsSync(path.join(entry, f.name)));
  if (files.some((f) => existsSync(f.path))) throw new Error("a session with this id already exists");
  for (const f of files) {
    await mkdir(path.dirname(f.path), { recursive: true });
    await move(path.join(entry, f.name), f.path);
  }
  await rm(entry, { recursive: true });
}

async function readMeta(id: string): Promise<Meta> {
  return JSON.parse(await readFile(path.join(TRASH_DIR, id, "meta.json"), "utf8"));
}

export async function listDeleted(): Promise<DeletedSession[]> {
  const ids = await readdir(TRASH_DIR).catch(() => []);
  const out: DeletedSession[] = [];
  for (const id of ids) {
    try {
      const m = await readMeta(id);
      out.push({ id: m.id, title: m.title, dir: m.dir, lastActivity: m.lastActivity, deletedAt: m.deletedAt, backend: m.backend });
    } catch {} // not a trash entry
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

export async function restoreSessions(ids: string[]): Promise<TrashResult> {
  const result: TrashResult = { done: [], failed: [] };
  for (const id of ids) {
    try {
      const m = await readMeta(id);
      if (m.backend === "gemini") {
        await restoreGemini(m);
        result.done.push(id);
        continue;
      }
      const entry = path.join(TRASH_DIR, id);
      if (existsSync(m.transcript)) throw new Error("a session with this id already exists");
      await mkdir(path.dirname(m.transcript), { recursive: true });
      await move(path.join(entry, path.basename(m.transcript)), m.transcript);
      const sub = path.join(entry, id);
      if (existsSync(sub) && (await stat(sub)).isDirectory() && !existsSync(companion(m.transcript))) {
        await move(sub, companion(m.transcript));
      }
      await rm(entry, { recursive: true });
      result.done.push(id);
    } catch (err) {
      result.failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

// Returns false if there is no such deleted session.
export async function deleteForever(id: string): Promise<boolean> {
  const exists = await readMeta(id).then(() => true, () => false); // only ever remove real entries
  if (exists) await rm(path.join(TRASH_DIR, id), { recursive: true });
  return exists;
}

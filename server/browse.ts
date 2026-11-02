// Folder browsing for "Add folder": only inside the projects root
// ($AGENT_COMMANDER_PROJECTS_DIR, default ~/Projects), so the UI can't wander the whole disk.

import os from "node:os";
import path from "node:path";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import type { BrowseResult } from "../shared/types.ts";

export class BrowseError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function projectsRoot(): Promise<string> {
  const root = process.env.AGENT_COMMANDER_PROJECTS_DIR || path.join(os.homedir(), "Projects");
  try {
    return await realpath(root);
  } catch {
    throw new BrowseError(404, `Projects folder ${root} doesn't exist`);
  }
}

// The real path of a directory inside the root (symlinks and ".." can't escape it).
export async function resolveInRoot(dir: unknown): Promise<{ root: string; dir: string }> {
  const root = await projectsRoot();
  if (dir === undefined || dir === null || dir === "") return { root, dir: root };
  if (typeof dir !== "string" || !path.isAbsolute(dir)) throw new BrowseError(400, "Expected an absolute path");
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    throw new BrowseError(404, "That folder doesn't exist");
  }
  if (real !== root && !real.startsWith(root + path.sep)) throw new BrowseError(403, "Outside the projects folder");
  if (!(await stat(real)).isDirectory()) throw new BrowseError(400, "Not a folder");
  return { root, dir: real };
}

export async function browse(dir: unknown): Promise<BrowseResult> {
  const { root, dir: here } = await resolveInRoot(dir);
  const entries = await readdir(here, { withFileTypes: true });
  const folders = await Promise.all(
    entries
      .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()))
      .map(async (e) => {
        const full = path.join(here, e.name);
        try {
          const real = await realpath(full);
          if (!real.startsWith(root + path.sep) || !(await stat(real)).isDirectory()) return null;
          const git = await stat(path.join(real, ".git")).then(() => true, () => false);
          return { name: e.name, path: real, git };
        } catch {
          return null; // broken link or no access
        }
      }),
  );
  return {
    root,
    path: here,
    parent: here === root ? null : path.dirname(here),
    folders: folders.filter((f) => f !== null).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function makeFolder(parent: unknown, name: unknown): Promise<string> {
  if (typeof name !== "string" || !name.trim() || name !== name.trim() || /[\\/\0]/.test(name) || name === "." || name === "..") {
    throw new BrowseError(400, "Use a plain folder name (no slashes)");
  }
  const { dir } = await resolveInRoot(parent);
  const target = path.join(dir, name);
  try {
    await mkdir(target); // not recursive: fails if it exists
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new BrowseError(409, "That folder already exists");
    throw err;
  }
  return target;
}

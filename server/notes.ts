// Project documents shown beside the chat: NOTES.md at the root of a chosen
// folder, so the notes sit with the project (Claude can read them, git can
// keep them), plus the task list (.project/tasklist.md), the README and docs/REFERENCE.md when the project has them.

import path from "node:path";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import type { NotesFile } from "../shared/types.ts";

export const NOTES_FILE = "NOTES.md";
// The only files the notes API reads and writes, relative to the folder.
export const DOC_FILES = [NOTES_FILE, ".project/tasklist.md", "docs/REFERENCE.md", "README.md"];

export class BadDoc extends Error {}

function docPath(dir: string, name: string): string {
  if (!DOC_FILES.includes(name)) throw new BadDoc(`Not an editable document: ${name}`);
  return path.join(dir, name);
}

// The documents that exist (NOTES.md is always offered: it is created on save).
export async function listDocs(dir: string): Promise<string[]> {
  const found = await Promise.all(DOC_FILES.map(async (name) => name === NOTES_FILE || (await mtimeOf(path.join(dir, name))) > 0));
  return DOC_FILES.filter((_, i) => found[i]);
}

async function mtimeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

export async function readNotes(dir: string, name = NOTES_FILE): Promise<NotesFile> {
  const file = docPath(dir, name);
  try {
    const [text, mtime] = await Promise.all([readFile(file, "utf8"), mtimeOf(file)]);
    return { text, mtime };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { text: "", mtime: 0 };
    throw err;
  }
}

export class NotesConflict extends Error {}

// Writes only if the file is still the version the editor started from
// (`baseMtime`), so an edit made by Claude or on another device isn't lost.
// Writes are serialized so two saves can't both pass the check.
let queue: Promise<unknown> = Promise.resolve();

export function writeNotes(dir: string, name: string, text: string, baseMtime: number): Promise<NotesFile> {
  const run = queue.then(async () => {
    const file = docPath(dir, name);
    if ((await mtimeOf(file)) !== baseMtime) throw new NotesConflict(`${name} changed since it was loaded`);
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    await writeFile(tmp, text);
    await rename(tmp, file); // atomic replace
    return { text, mtime: await mtimeOf(file) };
  });
  queue = run.catch(() => {});
  return run;
}

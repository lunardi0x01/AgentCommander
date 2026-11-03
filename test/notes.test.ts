import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, utimes } from "node:fs/promises";
import { BadDoc, NotesConflict, listDocs, readNotes, writeNotes } from "../server/notes.ts";

let dir: string;
before(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "ac-notes-")); });
after(() => rm(dir, { recursive: true, force: true }));

test("missing NOTES.md reads as empty with mtime 0 and is always listed", async () => {
  assert.deepEqual(await readNotes(dir), { text: "", mtime: 0 });
  assert.deepEqual(await listDocs(dir), ["NOTES.md"]);
});

test("only whitelisted names are accessible", async () => {
  await assert.rejects(readNotes(dir, "../etc/passwd"), BadDoc);
  await assert.rejects(writeNotes(dir, "package.json", "x", 0), BadDoc);
});

test("create, then update with the current mtime", async () => {
  const first = await writeNotes(dir, "NOTES.md", "one", 0);
  assert.equal(first.text, "one");
  assert.ok(first.mtime > 0);
  assert.deepEqual(await readNotes(dir), first);
  const second = await writeNotes(dir, "NOTES.md", "two", first.mtime);
  assert.equal(await readFile(path.join(dir, "NOTES.md"), "utf8"), "two");
  assert.ok(second.mtime >= first.mtime);
});

test("a stale base mtime is a conflict and leaves the file alone", async () => {
  const cur = await readNotes(dir);
  await assert.rejects(writeNotes(dir, "NOTES.md", "stale", cur.mtime - 1000), NotesConflict);
  await assert.rejects(writeNotes(dir, "NOTES.md", "stale", 0), NotesConflict);
  assert.equal((await readNotes(dir)).text, "two");
});

test("an external edit (changed mtime) conflicts", async () => {
  const cur = await readNotes(dir);
  await writeFile(path.join(dir, "NOTES.md"), "external");
  await utimes(path.join(dir, "NOTES.md"), new Date(), new Date(cur.mtime + 5000));
  await assert.rejects(writeNotes(dir, "NOTES.md", "mine", cur.mtime), NotesConflict);
});

test("two concurrent saves from the same base: exactly one wins", async () => {
  const cur = await readNotes(dir);
  const results = await Promise.allSettled([writeNotes(dir, "NOTES.md", "A", cur.mtime), writeNotes(dir, "NOTES.md", "B", cur.mtime)]);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  // Documented intent: serialized so both can't pass. (Fails if mtime granularity lets both through.)
  assert.equal(ok, 1);
});

test("nested docs are listed when present, and no temp files remain", async () => {
  await mkdir(path.join(dir, "docs"));
  await writeFile(path.join(dir, "docs", "REFERENCE.md"), "r");
  await writeFile(path.join(dir, "README.md"), "r");
  assert.deepEqual(await listDocs(dir), ["NOTES.md", "docs/REFERENCE.md", "README.md"]);
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith(".tmp")), []);
});

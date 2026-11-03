import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, symlink, realpath } from "node:fs/promises";

let tmp: string, root: string, outside: string;
let b: typeof import("../server/browse.ts");

before(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "ac-browse-")));
  root = path.join(tmp, "projects");
  outside = path.join(tmp, "outside");
  await mkdir(path.join(root, "a", ".git"), { recursive: true });
  await mkdir(path.join(root, "plain"));
  await mkdir(path.join(root, ".hidden"));
  await mkdir(outside);
  await symlink(path.join(root, "plain"), path.join(root, "inlink"));
  await symlink(outside, path.join(root, "escape"));
  await symlink(path.join(tmp, "missing"), path.join(root, "broken"));
  // a sibling whose name starts with the root's name must not pass a prefix check
  await mkdir(path.join(tmp, "projects-evil"));
  process.env.AGENT_COMMANDER_PROJECTS_DIR = root;
  b = await import("../server/browse.ts");
});
after(() => rm(tmp, { recursive: true, force: true }));

const status = (p: Promise<unknown>) => p.then(() => 0, (e) => e.status);

test("empty input resolves to the root", async () => {
  assert.deepEqual(await b.resolveInRoot(undefined), { root, dir: root });
  assert.equal((await b.resolveInRoot("")).dir, root);
});

test("rejects relative, non-string, missing, outside and escaping paths", async () => {
  assert.equal(await status(b.resolveInRoot("a")), 400);
  assert.equal(await status(b.resolveInRoot(5)), 400);
  assert.equal(await status(b.resolveInRoot(path.join(root, "nope"))), 404);
  assert.equal(await status(b.resolveInRoot(outside)), 403);
  assert.equal(await status(b.resolveInRoot(path.join(root, "escape"))), 403);
  assert.equal(await status(b.resolveInRoot(path.join(root, "..", "outside"))), 403);
  assert.equal(await status(b.resolveInRoot(path.join(tmp, "projects-evil"))), 403);
});

test("a symlink inside the root resolves to its real path", async () => {
  assert.equal((await b.resolveInRoot(path.join(root, "inlink"))).dir, path.join(root, "plain"));
});

test("browse lists visible folders, flags git, drops escapes and broken links", async () => {
  const r = await b.browse(root);
  assert.deepEqual(r.folders.map((f) => f.name), ["a", "inlink", "plain"]);
  assert.equal(r.folders[0].git, true);
  assert.equal(r.parent, null);
  assert.equal((await b.browse(path.join(root, "a"))).parent, root);
});

test("makeFolder validates names and refuses duplicates", async () => {
  for (const bad of ["", " x", "a/b", "..", ".", "a\\b", 3]) assert.equal(await status(b.makeFolder(root, bad)), 400, String(bad));
  const made = await b.makeFolder(root, "fresh");
  assert.equal(made, path.join(root, "fresh"));
  assert.equal(await status(b.makeFolder(root, "fresh")), 409);
  assert.equal(await status(b.makeFolder(outside, "x")), 403);
});

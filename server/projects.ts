// New Project: project templates (real files you can edit) and creating a
// project from one. Templates ship in the repo's templates/ folder and are
// copied once to ~/.config/agent-commander/templates/, which is what's used,
// so edits there are never overwritten.
//
// A template is a folder of files with `template.json` ({name, description,
// public}). In file names and text, {{name}} {{id}} {{snake}} {{pascal}}
// {{description}} {{date}} {{year}} {{author}} {{user}} {{type}} are replaced
// (also {{name_json}} etc. for JSON strings). Files under `@public/` are only
// created for public projects, and lines between {{#public}} and {{/public}}
// (each tag alone on its line) are kept only for public ones.

import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import type { NewProjectResult, TemplateInfo } from "../shared/types.ts";
import { BrowseError, resolveInRoot } from "./browse.ts";
import { addFolder, CONFIG_DIR } from "./config.ts";

const run = promisify(execFile);

const SHIPPED = path.resolve(import.meta.dirname, "../templates");
const TEMPLATES = path.join(CONFIG_DIR, "templates");
const SEEDED = path.join(TEMPLATES, ".seeded.json");
const ORDER = ["blank", "app", "omarchy-plugin", "wow-addon", "infrastructure"];
const PUBLIC_DIR = "@public";

const isTypeId = (id: unknown): id is string => typeof id === "string" && /^[\w-]+$/.test(id);

// Copies each shipped template once. A template you deleted or changed isn't
// brought back or overwritten; new shipped ones appear.
async function seedTemplates(): Promise<void> {
  const shipped = (await readdir(SHIPPED, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  const seeded: string[] = await readFile(SEEDED, "utf8").then(JSON.parse, () => []);
  const fresh = shipped.filter((id) => !seeded.includes(id));
  if (!fresh.length) return;
  await mkdir(TEMPLATES, { recursive: true });
  for (const id of fresh) await cp(path.join(SHIPPED, id), path.join(TEMPLATES, id), { recursive: true, force: false, errorOnExist: false });
  await writeFile(SEEDED, JSON.stringify([...seeded, ...fresh]) + "\n");
}

// Relative paths of the files in a template folder (symlinks are ignored).
async function walk(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(dir, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

export async function listTemplates(): Promise<TemplateInfo[]> {
  await seedTemplates();
  const found: TemplateInfo[] = [];
  for (const entry of await readdir(TEMPLATES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(await readFile(path.join(TEMPLATES, entry.name, "template.json"), "utf8"));
      const files = (await walk(path.join(TEMPLATES, entry.name))).filter((f) => f !== "template.json");
      const label = (f: string) => f.replace(/\{\{\w+\}\}/g, "<name>");
      found.push({
        id: entry.name,
        name: String(meta.name ?? entry.name),
        description: String(meta.description ?? ""),
        public: meta.public === true,
        files: files.filter((f) => !f.startsWith(PUBLIC_DIR + path.sep)).map(label),
        publicFiles: files.filter((f) => f.startsWith(PUBLIC_DIR + path.sep)).map((f) => label(f.slice(PUBLIC_DIR.length + 1))),
      });
    } catch {} // not a template folder
  }
  const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
  return found.sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}

// --- placeholders ------------------------------------------------------------

async function authorName(): Promise<string> {
  try {
    const name = (await run("git", ["config", "--global", "user.name"], { encoding: "utf8" })).stdout.trim();
    if (name) return name;
  } catch {}
  return os.userInfo().username;
}

function variables(name: string, description: string, type: string, author: string): Record<string, string> {
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const json = (s: string) => JSON.stringify(s).slice(1, -1);
  const now = new Date();
  return {
    name,
    name_json: json(name),
    id: words.join("-").toLowerCase(),
    snake: words.join("_").toLowerCase(),
    pascal: words.map((w) => w[0].toUpperCase() + w.slice(1)).join(""),
    description,
    description_json: json(description),
    date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    year: String(now.getFullYear()),
    author,
    author_json: json(author),
    user: os.userInfo().username,
    type,
  };
}

const PATH_SAFE = new Set(["id", "snake", "pascal"]); // values with no slashes or odd characters

function replace(text: string, vars: Record<string, string>, only?: Set<string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in vars && (!only || only.has(key)) ? vars[key] : match));
}

function render(text: string, vars: Record<string, string>, isPublic: boolean): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    const tag = line.trim();
    if (tag === "{{#public}}") skipping = !isPublic;
    else if (tag === "{{^public}}") skipping = isPublic;
    else if (tag === "{{/public}}") skipping = false;
    else if (!skipping) kept.push(line);
  }
  return replace(kept.join("\n"), vars);
}

// --- creating ------------------------------------------------------------------

export interface NewProject {
  dir: unknown;
  type: unknown;
  name: unknown;
  description: unknown;
  public: unknown;
  git: unknown;
}

export async function createProject(input: NewProject): Promise<NewProjectResult> {
  const { root, dir } = await resolveInRoot(input.dir);
  if (dir === root) throw new BrowseError(400, "Pick a folder inside the projects folder, not the projects folder itself");

  if (input.type === "none") {
    await addFolder(dir);
    return { dir, created: [], skipped: [], git: false };
  }

  if (!isTypeId(input.type)) throw new BrowseError(400, "Unknown project type");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (!name || name.length > 100 || /[\r\n]/.test(name)) throw new BrowseError(400, "Give the project a short name");
  if (description.length > 500 || /[\r\n]/.test(description)) throw new BrowseError(400, "The description must be one line, up to 500 characters");

  await seedTemplates();
  const template = path.join(TEMPLATES, input.type);
  const meta = await readFile(path.join(template, "template.json"), "utf8").then(JSON.parse, () => null);
  if (!meta) throw new BrowseError(404, "Unknown project type");

  const vars = variables(name, description, String(meta.name ?? input.type), await authorName());
  if (!vars.id) throw new BrowseError(400, "The name needs some letters or digits");
  const isPublic = input.public === true;

  const created: string[] = [];
  const skipped: string[] = [];
  for (const file of await walk(template)) {
    if (file === "template.json") continue;
    const overlay = file.startsWith(PUBLIC_DIR + path.sep);
    if (overlay && !isPublic) continue;
    const rel = (overlay ? file.slice(PUBLIC_DIR.length + 1) : file)
      .split(path.sep)
      .map((part) => replace(part, vars, PATH_SAFE))
      .join(path.sep);
    const target = path.join(dir, rel);
    if (path.relative(dir, target).startsWith("..")) continue;

    await mkdir(path.dirname(target), { recursive: true });
    // A folder that was already there might be a link elsewhere.
    if (!(await realpath(path.dirname(target))).startsWith(dir)) throw new BrowseError(400, `${path.dirname(rel)} leads outside the folder`);

    const source = path.join(template, file);
    try {
      await writeFile(target, render(await readFile(source, "utf8"), vars, isPublic), { flag: "wx", mode: (await stat(source)).mode & 0o777 });
      created.push(rel);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      skipped.push(rel); // never overwrite what's already there
    }
  }

  let git = false;
  if (input.git === true && !(await stat(path.join(dir, ".git")).then(() => true, () => false))) {
    git = await run("git", ["init", "-b", "main"], { cwd: dir }).then(() => true, () => false);
  }
  await addFolder(dir);
  return { dir, created, skipped, git };
}

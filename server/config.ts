// Small persistent config: which project folders the navigator shows, and
// the app's settings. Stored at $XDG_CONFIG_HOME/agent-commander/config.json (default ~/.config).

import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { DEFAULT_SETTINGS, type AppSettings } from "../shared/types.ts";

export interface Config {
  folders: string[]; // absolute paths, in the order they were added
  settings: AppSettings;
  logins: string[]; // Tailscale logins allowed in (access.logins)
}

export const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agent-commander");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

let cached: Config | null = null;

export async function loadConfig(): Promise<Config> {
  if (cached) return cached;
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SyntaxError("not a JSON object");
    cached = {
      folders: Array.isArray(raw.folders) ? raw.folders.filter((f: unknown) => typeof f === "string") : [],
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings && typeof raw.settings === "object" ? raw.settings : {}) },
      logins: Array.isArray(raw.logins) ? raw.logins.filter((l: unknown) => typeof l === "string") : [],
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      if (!(err instanceof SyntaxError)) throw err;
      // A hand-edited or half-written file must not crash-loop the server.
      const backup = `${CONFIG_FILE}.bad-${Date.now()}`;
      await rename(CONFIG_FILE, backup).catch(() => {});
      console.error(`!! ${CONFIG_FILE} is not valid JSON (${err.message}). Moved it to ${backup} and starting with defaults.`);
    }
    cached = { folders: [], settings: { ...DEFAULT_SETTINGS }, logins: [] };
  }
  return cached;
}

async function saveConfig(config: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n");
  await rename(tmp, CONFIG_FILE); // atomic replace
  cached = config;
}

// Changes run one at a time so quick successive edits don't overwrite each other.
let queue: Promise<unknown> = Promise.resolve();

function update(change: (config: Config) => Config | null): Promise<void> {
  const run = queue.then(async () => {
    const next = change(await loadConfig());
    if (next) await saveConfig(next);
  });
  queue = run.catch(() => {});
  return run;
}

export function addFolder(dir: string): Promise<void> {
  return update((c) => (c.folders.includes(dir) ? null : { ...c, folders: [...c.folders, dir] }));
}

// Only forgets the folder; nothing on disk is touched.
export function removeFolder(dir: string): Promise<void> {
  return update((c) => (c.folders.includes(dir) ? { ...c, folders: c.folders.filter((f) => f !== dir) } : null));
}

export async function setLogins(logins: string[]): Promise<void> {
  await update((c) => ({ ...c, logins }));
}

export async function getSettings(): Promise<AppSettings> {
  return (await loadConfig()).settings;
}

// Merges a validated change; undefined values clear a default.
export async function updateSettings(change: Partial<AppSettings>): Promise<AppSettings> {
  await update((c) => {
    const settings = { ...c.settings, ...change };
    for (const key of Object.keys(settings) as Array<keyof AppSettings>) if (settings[key] === undefined) delete settings[key];
    return { ...c, settings };
  });
  return getSettings();
}

// What Claude Code offers in a folder: its slash commands (built-ins,
// skills, plugin and project commands) for the composer's / menu, and its
// defaults (permission mode) for sessions not running yet.
//
// Asked from a short-lived Claude Code process that never starts a session
// (persistSession: false), and cached per folder.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { FolderDefaults, PermissionMode, SlashCommandInfo } from "../shared/types.ts";
import { CHILD_ENV, CLAUDE_PATH } from "./claude.ts";

const CACHE_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;

interface FolderInfo {
  commands: SlashCommandInfo[];
  defaults: FolderDefaults;
}

const cache = new Map<string, { at: number; info: Promise<FolderInfo> }>();

function folderInfo(dir: string): Promise<FolderInfo> {
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.info;
  const info = probe(dir);
  cache.set(dir, { at: Date.now(), info });
  info.catch(() => cache.delete(dir));
  return info;
}

export async function listCommands(dir: string): Promise<SlashCommandInfo[]> {
  return (await folderInfo(dir)).commands;
}

export async function folderDefaults(dir: string): Promise<FolderDefaults> {
  return (await folderInfo(dir)).defaults;
}

async function probe(dir: string): Promise<FolderInfo> {
  // An input that never yields: the process starts, answers, and is closed.
  const silent = { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } };
  const q = query({
    prompt: silent as AsyncIterable<never>,
    options: { cwd: dir, env: CHILD_ENV, pathToClaudeCodeExecutable: CLAUDE_PATH, persistSession: false },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out listing commands")), PROBE_TIMEOUT_MS);
    });
    const init = await Promise.race([q.initializationResult(), timeout]);
    const commands = init.commands
      .filter((c) => !c.name.startsWith("__")) // internal
      .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, aliases: c.aliases }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // Present at runtime, not (yet) in the SDK's types.
    const mode = (init as { current_permission_mode?: PermissionMode }).current_permission_mode ?? "default";
    const models = init.models.map((m) => ({
      value: m.value,
      resolvedModel: m.resolvedModel,
      displayName: m.displayName,
      description: m.description,
      effortLevels: m.supportsEffort === false ? undefined : m.supportedEffortLevels,
    }));
    return { commands, defaults: { permissionMode: mode, models } };
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

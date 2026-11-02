// Hand a session off to Remote Control: reopen it as an interactive
// `claude --resume <id> --remote-control` in a background tmux window, which
// is the only way to give that process the terminal it needs. Agent
// Commander then follows it read-only, like any session open elsewhere.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HandoffResult, SessionSettings } from "../shared/types.ts";
import { CLAUDE_PATH } from "./claude.ts";
import { liveSessions } from "./live.ts";

const run = promisify(execFile);

const TMUX_SESSION = "agent-commander";
const TRUST_PROMPT = /trust this folder/;
const START_TIMEOUT_MS = 30_000;

export class HandoffError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const windowName = (id: string) => `ac-${id.slice(0, 8)}`;
const target = (id: string) => `${TMUX_SESSION}:${windowName(id)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function tmux(...args: string[]): Promise<string> {
  try {
    return (await run("tmux", args, { encoding: "utf8" })).stdout;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new HandoffError(501, "tmux isn't installed");
    throw err;
  }
}

async function windowExists(id: string): Promise<boolean> {
  const names = await tmux("list-windows", "-t", TMUX_SESSION, "-F", "#{window_name}").catch(() => "");
  return names.split("\n").includes(windowName(id));
}

const pane = (id: string) => tmux("capture-pane", "-p", "-t", target(id)).catch(() => "");

// The shell script run in the window. It removes variables that would make
// the CLI think it is nested (the tmux server may carry them) and any API key,
// so it uses the claude.ai login.
function launchScript(id: string, settings: SessionSettings): string {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const args = ["--resume", id, "--remote-control"];
  if (settings.model) args.push("--model", settings.model);
  if (settings.effort) args.push("--effort", settings.effort);
  if (settings.mode) {
    args.push("--permission-mode", settings.mode === "default" ? "manual" : settings.mode);
    if (settings.mode === "bypassPermissions") args.push("--allow-dangerously-skip-permissions");
  }
  return (
    `exec env $(env | grep -o '^CLAUDE_CODE[A-Z_]*' | sed 's/^/-u /') ` +
    `-u CLAUDECODE -u CLAUDE_PID -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN ` +
    [quote(CLAUDE_PATH), ...args.map(quote)].join(" ")
  );
}

async function start(id: string, dir: string, settings: SessionSettings): Promise<void> {
  const command = ["sh", "-c", launchScript(id, settings)];
  const hasSession = await tmux("has-session", "-t", TMUX_SESSION).then(() => true, () => false);
  if (hasSession) await tmux("new-window", "-d", "-t", `${TMUX_SESSION}:`, "-n", windowName(id), "-c", dir, ...command);
  else await tmux("new-session", "-d", "-s", TMUX_SESSION, "-n", windowName(id), "-c", dir, ...command);
}

// Waits for the bridge to register, or for the trust question to need an answer.
async function waitForBridge(id: string): Promise<HandoffResult> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    const live = (await liveSessions()).get(id);
    if (live?.bridge) return { status: "remote", url: `https://claude.ai/code/${live.bridge}` };
    if (!(await windowExists(id))) {
      throw new HandoffError(500, `Claude Code exited before Remote Control started.\n${last.trim().split("\n").slice(-6).join("\n")}`);
    }
    last = await pane(id);
    if (TRUST_PROMPT.test(last)) return { status: "trust" };
    await sleep(500);
  }
  await killWindow(id);
  throw new HandoffError(504, `Remote Control didn't start within ${START_TIMEOUT_MS / 1000} seconds.\n${last.trim().split("\n").slice(-6).join("\n")}`);
}

// `trust`: answer yes to Claude Code's "do you trust this folder" question in
// the waiting window, then carry on waiting.
export async function handOff(id: string, dir: string, settings: SessionSettings, trust: boolean): Promise<HandoffResult> {
  if (trust && (await windowExists(id))) {
    await tmux("send-keys", "-t", target(id), "Down", "Enter");
    return waitForBridge(id);
  }
  if (await windowExists(id)) await killWindow(id); // a stale one from an earlier try
  await start(id, dir, settings);
  return waitForBridge(id);
}

export async function killWindow(id: string): Promise<void> {
  await tmux("kill-window", "-t", target(id)).catch(() => {});
}

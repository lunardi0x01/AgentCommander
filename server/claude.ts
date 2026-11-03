// How Agent Commander starts Claude Code processes (shared by runs and probes).

import { execFileSync } from "node:child_process";

// The `claude` binary that's installed and logged in (from PATH, or
// CLAUDE_PATH), so the SDK uses it instead of its bundled copy.
function findClaude(): string {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
  try {
    const found = execFileSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {}
  console.error("!! `claude` was not found on PATH. Install Claude Code, or set CLAUDE_PATH to the binary.");
  process.exit(1);
}

export const CLAUDE_PATH = findClaude();

// The CLI must use the claude.ai login: never pass API keys through, and drop
// variables that would make it think it's nested inside another Claude Code.
export const CHILD_ENV = {
  ...(Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_.*)$/.test(key),
    ),
  ) as Record<string, string>),
  CLAUDE_AGENT_SDK_CLIENT_APP: "agent-commander/0.1",
};

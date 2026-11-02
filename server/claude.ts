// How Agent Commander starts Claude Code processes (shared by runs and probes).

import { execFileSync } from "node:child_process";

// The `claude` binary that's installed and logged in (from PATH, or
// CLAUDE_PATH), so the SDK uses it instead of its bundled copy.
export const CLAUDE_PATH = process.env.CLAUDE_PATH || execFileSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim();

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

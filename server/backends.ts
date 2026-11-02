// What an agent backend offers. Claude Code is still wired in directly
// (sessions.ts, runner.ts); Gemini (Google Antigravity, via agy) is the first
// to go through this. The interface grows as Gemini gains features: reading
// history, running turns, permissions.

import type { BackendId } from "../shared/types.ts";

// A session as a backend lists it, before it becomes a tree row.
export interface BackendSession {
  id: string;
  cwd: string;
  title: string;
  lastModified: number; // ms since epoch
  contextTokens?: number;
}

export interface AgentBackend {
  id: BackendId;
  listSessions(): Promise<BackendSession[]>;
}

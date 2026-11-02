// Plan usage: the data behind Claude Code's /usage (5-hour and weekly
// windows, per-model weekly windows, extra usage), and optionally what's
// driving it from a scan of local transcripts.
//
// Asked from a short-lived Claude Code process (persistSession: false) that
// never sends a prompt, so it costs no tokens. The SDK method is
// experimental; if it goes away we report usage as unavailable.

import os from "node:os";
import { query, type SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { UsageBehaviors, UsageInfo, UsageWindow } from "../shared/types.ts";
import { CHILD_ENV, CLAUDE_PATH } from "./claude.ts";

const CACHE_MS = 60_000;
const PROBE_TIMEOUT_MS = 45_000; // the transcript scan reads a week of sessions

let plain: { at: number; info: Promise<UsageInfo> } | null = null;
let detailed: { at: number; info: Promise<UsageInfo> } | null = null;

// Cached for a minute; `behaviors` adds the slower transcript scan.
export function getUsage(behaviors = false): Promise<UsageInfo> {
  const hit = behaviors ? detailed : (detailed && detailed.at > (plain?.at ?? 0) ? detailed : plain);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.info;
  const entry = { at: Date.now(), info: probe(behaviors) };
  if (behaviors) detailed = entry;
  else plain = entry;
  entry.info.catch(() => {
    if (plain === entry) plain = null;
    if (detailed === entry) detailed = null;
  });
  return entry.info;
}

// The next probe asks again, e.g. after a turn hit the limit.
export function invalidateUsage(): void {
  plain = detailed = null;
}

async function probe(behaviors: boolean): Promise<UsageInfo> {
  const silent = { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } };
  // Any folder works; the temp dir always exists and is no project.
  const q = query({
    prompt: silent as AsyncIterable<never>,
    options: { cwd: os.tmpdir(), env: CHILD_ENV, pathToClaudeCodeExecutable: CLAUDE_PATH, persistSession: false },
  });
  try {
    // Checked in case an SDK upgrade renames it.
    const ask = (q as Partial<typeof q>).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof ask !== "function") return unavailable();
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out reading usage")), PROBE_TIMEOUT_MS));
    const res = await Promise.race([ask.call(q, { skipBehaviors: !behaviors }), timeout]);
    return convert(res);
  } finally {
    q.close();
  }
}

const unavailable = (): UsageInfo => ({ available: false, plan: null, windows: [], fetchedAt: Date.now() });

type Window = { utilization: number | null; resets_at: string | null } | null | undefined;

function convert(res: SDKControlGetUsageResponse): UsageInfo {
  const limits = res.rate_limits;
  if (!res.rate_limits_available || !limits) return { ...unavailable(), plan: res.subscription_type };
  const windows: UsageWindow[] = [];
  const add = (label: string, w: Window, blocksAll?: boolean) =>
    w && windows.push({ label, utilization: w.utilization, resetsAt: w.resets_at, ...(blocksAll ? { blocksAll } : {}) });
  add("Current session (5 hours)", limits.five_hour, true);
  add("Week, all models", limits.seven_day, true);
  add("Week, Opus", limits.seven_day_opus);
  add("Week, Sonnet", limits.seven_day_sonnet);
  for (const m of limits.model_scoped ?? []) add(`Week, ${m.display_name}`, m);
  const extra = limits.extra_usage;
  return {
    available: true,
    plan: res.subscription_type,
    windows,
    extra: extra
      ? {
          enabled: extra.is_enabled,
          usedCredits: extra.used_credits,
          monthlyLimit: extra.monthly_limit,
          utilization: extra.utilization,
          currency: extra.currency,
        }
      : undefined,
    behaviors: res.behaviors
      ? [behaviorsOf("Last 24 hours", res.behaviors.day), behaviorsOf("Last 7 days", res.behaviors.week)]
      : undefined,
    fetchedAt: Date.now(),
  };
}

type Scan = NonNullable<SDKControlGetUsageResponse["behaviors"]>["day"];

function behaviorsOf(label: string, scan: Scan): UsageBehaviors {
  const named = (kind: string, list: Array<{ name: string; pct: number }> | undefined) => (list ?? []).map((x) => ({ kind, ...x }));
  return {
    label,
    requests: scan.request_count,
    sessions: scan.session_count,
    behaviors: scan.behaviors.map(({ key, pct, count }) => ({ key, pct, count })),
    recommendations: (scan.recommendations ?? []).map(({ title, detail, pct }) => ({ title, detail, pct })),
    sources: [
      ...named("Skill", scan.skills),
      ...named("Agent", scan.agents),
      ...named("Plugin", scan.plugins),
      ...named("MCP server", scan.mcp_servers),
    ].sort((a, b) => b.pct - a.pct),
  };
}

// Whether the plan leaves room to work: the 5-hour and all-models weekly
// windows stop everything (a per-model window only stops that model). If
// not, when the full ones have all reset (ms since epoch). Extra usage is
// ignored on purpose: unattended work shouldn't spend money.
export function usageBlocked(info: UsageInfo): { blocked: boolean; until?: number } {
  const full = info.windows.filter((w) => w.blocksAll && (w.utilization ?? 0) >= 100);
  if (!full.length) return { blocked: false };
  const resets = full.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN)).filter((t) => !Number.isNaN(t));
  return { blocked: true, until: resets.length ? Math.max(...resets) : undefined };
}

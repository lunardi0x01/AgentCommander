import { useEffect, useState } from "react";
import type { UsageBehaviors, UsageInfo } from "../../shared/types.ts";
import { api } from "./api.ts";
import { relativeTime, resetsIn, useNow } from "./format.ts";
import { UsageBar } from "./Navigator.tsx";
import { Page } from "./Page.tsx";

interface Props {
  usage: UsageInfo | null; // the plain numbers the app already has
  onUsage: (usage: UsageInfo) => void;
  onBack: () => void;
}

// Claude Code's behaviour keys, worded for people.
const BEHAVIORS: Record<string, string> = {
  cache_miss: "Prompt cache misses (resuming after a break)",
  long_context: "Long conversations",
  subagent_heavy: "Many subagents",
  high_parallel: "Many sessions at once",
  cron: "Scheduled runs",
  max_effort: "Max effort",
  workflow: "Workflows",
  always_on_context: "Always-loaded context (CLAUDE.md, MCP tools)",
  large_tool_results: "Large tool results",
};

// The full report: plan windows, then what's driving usage on this computer.
export function UsageView({ usage, onUsage, onBack }: Props) {
  const now = useNow();
  const [report, setReport] = useState<UsageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api.usage(true).then(
      (info) => {
        setReport(info);
        onUsage(info);
        setLoading(false);
      },
      (err) => {
        setError(String(err.message ?? err));
        setLoading(false);
      },
    );
  };
  useEffect(load, []);

  const info = report ?? usage;

  return (
    <Page
      title="Usage"
      subtitle={info ? `${info.plan ? `Claude ${info.plan[0].toUpperCase()}${info.plan.slice(1)} · ` : ""}as of ${relativeTime(info.fetchedAt, now)}` : "Loading…"}
      onBack={onBack}
      className="usage-page"
      actions={
        <button className="secondary-button" disabled={loading} onClick={load}>
          {loading ? "Reading…" : "Refresh"}
        </button>
      }
    >
      {error && <div className="run-error">{error}</div>}
      {info && !info.available && (
        <div className="empty">Plan usage isn't available: this Claude Code doesn't report it, or isn't using a subscription.</div>
      )}

      {info?.available && (
        <>
          <h3 className="page-heading">Plan limits</h3>
          <div className="usage-windows">
            {info.windows.map((w) => (
              <div key={w.label} className="usage-window">
                <div className="usage-window-head">
                  <span>{w.label}</span>
                  <span className="muted">
                    {w.utilization == null ? "—" : `${Math.round(w.utilization)}% used`}
                    {w.resetsAt && ` · resets ${resetsIn(w.resetsAt, now)}`}
                  </span>
                </div>
                <UsageBar pct={w.utilization ?? 0} />
              </div>
            ))}
            {info.extra?.enabled && (
              <div className="usage-window">
                <div className="usage-window-head">
                  <span>Extra usage this month</span>
                  <span className="muted">
                    {money(info.extra.usedCredits ?? 0, info.extra.currency)}
                    {info.extra.monthlyLimit != null && ` of ${money(info.extra.monthlyLimit, info.extra.currency)}`}
                  </span>
                </div>
                <UsageBar pct={info.extra.utilization ?? 0} />
              </div>
            )}
          </div>
        </>
      )}

      {report?.behaviors?.map((b) => <Behaviors key={b.label} scan={b} />)}
      {loading && !report?.behaviors && info?.available && <div className="muted usage-note">Reading what's driving your usage…</div>}
      {report?.behaviors && (
        <p className="setting-detail usage-note">
          From Claude Code's scan of this computer's transcripts: approximate, and it doesn't include other devices or
          claude.ai. Categories overlap, so shares don't add up to 100%.
        </p>
      )}
    </Page>
  );
}

// Extra usage comes in minor units (pence, cents): 879 of 7500 GBP is
// £8.79 of £75, matching its utilization.
function money(minor: number, currency: string | null | undefined): string {
  if (!currency) return `${minor} credits`;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

function Behaviors({ scan }: { scan: UsageBehaviors }) {
  const behaviors = scan.behaviors.filter((b) => b.pct >= 1).sort((a, b) => b.pct - a.pct);
  return (
    <section className="usage-scan">
      <h3 className="page-heading">
        {scan.label}{" "}
        <span className="muted">
          · {scan.requests.toLocaleString()} requests in {scan.sessions.toLocaleString()} session{scan.sessions === 1 ? "" : "s"}
        </span>
      </h3>
      {behaviors.length > 0 && (
        <table className="usage-table">
          <tbody>
            {behaviors.map((b) => (
              <tr key={b.key}>
                <td>{BEHAVIORS[b.key] ?? b.key}</td>
                <td className="usage-table-bar">
                  <UsageBar pct={b.pct} plain />
                </td>
                <td className="num">{Math.round(b.pct)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {scan.sources.length > 0 && (
        <table className="usage-table">
          <tbody>
            {scan.sources.slice(0, 8).map((s) => (
              <tr key={`${s.kind}:${s.name}`}>
                <td>
                  {s.name} <span className="muted">· {s.kind}</span>
                </td>
                <td className="usage-table-bar">
                  <UsageBar pct={s.pct} plain />
                </td>
                <td className="num">{Math.round(s.pct)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {scan.recommendations.length > 0 && (
        <ul className="usage-tips">
          {scan.recommendations.map((r, i) => (
            <li key={i}>
              <strong>{r.title}</strong>
              {r.detail && <span className="muted"> · {r.detail}</span>}
              <span className="muted"> ({Math.round(r.pct)}% of usage)</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

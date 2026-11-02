import { useState } from "react";
import { BACKEND_LABEL, type BackendId, type FolderInfo, type LiveStatus, type MachineInfo, type QueueState, type SessionSummary, type UsageInfo } from "../../shared/types.ts";
import type { Selection, View } from "./App.tsx";
import { api } from "./api.ts";
import { DeletedPanel } from "./DeletedPanel.tsx";
import { cacheIsCold, formatTokens, relativeTime, resetsIn, shortTime, tildePath, useNow } from "./format.ts";
import { ChevronIcon, FolderIcon, GearIcon, LogoIcon, MoonIcon, SidebarIcon, SunIcon } from "./icons.tsx";
import { Menu } from "./Menu.tsx";
import { NewProject } from "./NewProject.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { useTheme } from "./theme.ts";

// Which agent a session belongs to, instead of a heading per agent: C (orange) for Claude, G (blue) for Gemini.
function BackendTag({ backend = "claude" }: { backend?: BackendId }) {
  return (
    <span className={`backend-tag ${backend}`} title={BACKEND_LABEL[backend]}>
      {BACKEND_LABEL[backend][0]}
    </span>
  );
}

interface SessionRowProps {
  s: SessionSummary;
  now: number;
  selecting: boolean;
  ticked: boolean;
  active: boolean;
  onTick: () => void;
  onSelect: () => void;
}

function SessionRow({ s, now, selecting, ticked, active, onTick, onSelect }: SessionRowProps) {
  const time = <span className="session-time" title={relativeTime(s.lastActivity, now)}>{shortTime(s.lastActivity, now)}</span>;
  const tag = <BackendTag backend={s.backend} />;
  if (selecting) {
    const blocked = !!s.live;
    return (
      <label
        className={`session-row selectable${blocked ? " disabled" : ""}`}
        title={s.live ? "Live sessions can't be deleted" : s.title}
      >
        <input type="checkbox" checked={ticked} disabled={blocked} onChange={onTick} />
        <span className="session-title">{s.title}</span>
        {tag}
        {time}
      </label>
    );
  }
  return (
    <button
      className={`session-row${active ? " active" : ""}`}
      onClick={onSelect}
      title={[
        s.title,
        s.live && `(${liveLabel(s.live, s.liveHere)})`,
        s.contextTokens &&
          `${formatTokens(s.contextTokens)} tokens of context${s.backend !== "gemini" && cacheIsCold(s.lastActivity, s.cacheTtlMs, now) ? ", cache cold" : ""}`,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <LiveSlot status={s.live} here={s.liveHere} />
      <span className="session-title">{s.title}</span>
      {tag}
      {time}
    </button>
  );
}

export type Panel = "tree" | "projects" | "new" | "deleted";

interface Props {
  onHide: () => void; // collapse this column (desktop)
  machine: MachineInfo | null;
  folders: FolderInfo[] | null;
  sessions: Record<string, SessionSummary[]>;
  expanded: Set<string>; // open folders, and open machines as "machine:<hostname>"
  selected: Selection | null;
  error: string | null;
  panel: Panel;
  onPanel: (panel: Panel) => void;
  onToggle: (key: string) => void;
  onSelect: (sel: Selection) => void;
  onNewSession: (dir: string, backend?: BackendId) => void;
  view: View;
  onView: (view: View) => void;
  onSide: (dir: string) => void; // open the notes and queue column for a folder
  usage: UsageInfo | null;
  queue: QueueState | null;
  notice: Notice | null;
  onNotice: (notice: Notice | null) => void;
  onDeleteSessions: (items: Array<{ id: string; dir: string }>, label: string) => Promise<void>;
  onRefresh: () => void;
}

const STATUS_WORDS: Record<LiveStatus, string> = { working: "working", waiting: "needs you", idle: "idle" };

// "Running here · working" for sessions Agent Commander runs, "Open in
// Claude Code · idle" for ones open in a terminal or Remote Control.
export function liveLabel(status: LiveStatus, here: boolean | undefined): string {
  return `${here ? "Running here" : "Open in Claude Code"} · ${STATUS_WORDS[status]}`;
}

// Filled dot: running here. Ring: open elsewhere.
export function LiveDot({ status, here }: { status: LiveStatus; here?: boolean }) {
  return <span className={`live-dot ${status}${here ? "" : " elsewhere"}`} title={liveLabel(status, here)} />;
}

// Fixed-width place for a live dot at the end of a tree row, so counts and
// times line up whether or not a row is live.
function LiveSlot({ status, here }: { status?: LiveStatus; here?: boolean }) {
  return <span className="live-slot">{status && <LiveDot status={status} here={here} />}</span>;
}

// A message under the header. Errors stay until dismissed; others fade by
// themselves (deleted sessions can be brought back with Restore Sessions).
export interface Notice {
  text: string;
  error?: boolean;
}

export function Navigator(props: Props) {
  const { machine, folders, sessions, expanded, selected } = props;
  const now = useNow();
  const [theme, toggleTheme] = useTheme();
  const { notice, onNotice: setNotice } = props;
  const [deletedCount, setDeletedCount] = useState<number | null>(null);

  // Select mode: tick sessions in the open folders, then delete them.
  const [selecting, setSelecting] = useState(false);
  const [ticked, setTicked] = useState<Map<string, string>>(new Map()); // id -> dir
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const stopSelecting = () => {
    setSelecting(false);
    setTicked(new Map());
    setConfirming(false);
  };

  const tick = (id: string, dir: string) => {
    setConfirming(false);
    setTicked((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, dir);
      return next;
    });
  };

  const deleteTicked = async () => {
    setBusy(true);
    try {
      await props.onDeleteSessions([...ticked].map(([id, dir]) => ({ id, dir })), plural(ticked.size, "session"));
      stopSelecting();
    } catch (err) {
      setNotice({ text: String((err as Error).message ?? err), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <nav className="navigator">
      <header className="app-header">
        <LogoIcon />
        <span className="app-name">Agent Commander</span>
      {!selecting && (
        <Menu
          title={`Actions for ${machine?.hostname ?? "this computer"}`}
          onOpen={() => api.deleted().then((list) => setDeletedCount(list.length), () => setDeletedCount(null))}
          items={[
            { label: "New Project…", onClick: () => props.onPanel("new") },
            { label: "Choose Projects…", onClick: () => props.onPanel("projects") },
            "divider",
            {
              label: "Delete Sessions…",
              onClick: () => {
                setNotice(null);
                setSelecting(true);
              },
            },
            {
              label: deletedCount ? `Restore Sessions… (${deletedCount})` : "Restore Sessions…",
              onClick: () => props.onPanel("deleted"),
              disabled: deletedCount === 0,
              hint: deletedCount === 0 ? "Nothing to restore" : undefined,
            },
          ]}
        />
      )}
        <button
          className={`icon-button${props.view.kind === "settings" ? " active" : ""}`}
          title="Settings"
          onClick={() => props.onView({ kind: props.view.kind === "settings" ? "chat" : "settings" })}
        >
          <GearIcon />
        </button>
        <button className="icon-button hide-nav" title="Hide this column (Ctrl+B)" onClick={props.onHide}>
          <SidebarIcon />
        </button>
        <button
          className="icon-button"
          title={theme === "dark" ? "Dark mode (switch to light)" : "Light mode (switch to dark)"}
          onClick={toggleTheme}
        >
          {theme === "dark" ? <MoonIcon /> : <SunIcon />}
        </button>
      </header>

      {props.error && <div className="nav-error">{props.error}</div>}

      {props.panel === "projects" ? (
        <ProjectPicker machine={machine} onDone={() => props.onPanel("tree")} />
      ) : props.panel === "new" ? (
        <NewProject
          machine={machine}
          onDone={() => props.onPanel("tree")}
          onOpenSession={(dir, id) => {
            props.onPanel("tree");
            props.onSelect({ dir, id });
          }}
        />
      ) : props.panel === "deleted" ? (
        <DeletedPanel machine={machine} onDone={() => props.onPanel("tree")} />
      ) : (
        <>
          {selecting && (
            <div className="select-bar">
              <span>Delete Sessions</span>
              <button className="text-button" onClick={stopSelecting}>
                Cancel
              </button>
            </div>
          )}
          {notice && !selecting && (
            <div className={`nav-notice${notice.error ? "" : " fading"}`}>
              <span className="nav-notice-text">{notice.text}</span>
              {notice.error && (
                <button className="text-button" onClick={() => setNotice(null)}>
                  OK
                </button>
              )}
            </div>
          )}

          <div className="tree">
            {/* One computer for now: its actions are in the header's ⋯ menu. A rail of computers could go beside this list later. */}
            <ul className="tree-children top">
              {folders === null && <li className="muted tree-note">Loading…</li>}
              {folders?.length === 0 && (
                <li className="tree-note">
                  <span className="muted">No projects chosen yet. </span>
                  <button className="text-button inline" onClick={() => props.onPanel("projects")}>
                    Choose Projects
                  </button>
                </li>
              )}
              {folders?.map((folder) => {
                const open = expanded.has(folder.path);
                const list = sessions[folder.path];
                const queued = props.queue?.items.filter((i) => i.dir === folder.path && i.status === "queued").length ?? 0;
                return (
                  <li key={folder.path}>
                    <div className={`folder-row${selected?.isNew && selected.dir === folder.path ? " active" : ""}`}>
                      <button
                        className="tree-toggle"
                        title={tildePath(folder.path, machine?.home)}
                        onClick={() => props.onToggle(folder.path)}
                        aria-expanded={open}
                      >
                        <ChevronIcon open={open} />
                        <span className="tree-icon">
                          <FolderIcon />
                        </span>
                        <span className="folder-name">{folder.name}</span>
                        <span className="count">[{folder.sessionCount}]</span>
                        <LiveSlot status={folder.live} here={folder.liveHere} />
                      </button>
                      {!selecting && (
                        <Menu
                          title={`Actions for ${folder.name}`}
                          items={[
                            { label: "New Claude Session…", onClick: () => props.onNewSession(folder.path) },
                            { label: "New Gemini Session…", onClick: () => props.onNewSession(folder.path, "gemini") },
                            {
                              label: queued ? `Notes & Queue… (${queued})` : "Notes & Queue…",
                              detail: "Notes, docs and prompts to run when you have usage",
                              onClick: () => props.onSide(folder.path),
                            },
                          ]}
                        />
                      )}
                    </div>
                    {open && (
                      <ul className="tree-children sessions">
                        {!list && <li className="muted tree-note">Loading…</li>}
                        {list?.map((s) => (
                          <li key={s.id}>
                            <SessionRow
                              s={s}
                              now={now}
                              selecting={selecting}
                              ticked={ticked.has(s.id)}
                              active={selected?.id === s.id}
                              onTick={() => tick(s.id, folder.path)}
                              onSelect={() => props.onSelect({ dir: folder.path, id: s.id, backend: s.backend })}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {selecting && (
            <div className="nav-actions">
              {ticked.size === 0 ? (
                <span className="muted">Tick sessions in the open folders.</span>
              ) : confirming ? (
                <>
                  <button className="danger-button" disabled={busy} onClick={deleteTicked}>
                    {busy ? "Deleting…" : `Yes, delete ${ticked.size}`}
                  </button>
                  <button className="text-button" disabled={busy} onClick={() => setConfirming(false)}>
                    Back
                  </button>
                  <div className="nav-actions-hint">You can bring them back with Restore Sessions in the ⋯ menu.</div>
                </>
              ) : (
                <button className="danger-button outline" onClick={() => setConfirming(true)}>
                  Delete {plural(ticked.size, "session")}
                </button>
              )}
            </div>
          )}
        </>
      )}
      <UsageFooter usage={props.usage} now={now} active={props.view.kind === "usage"} onReport={() => props.onView({ kind: "usage" })} />
    </nav>
  );
}

// The plan's 5-hour window at the bottom of the column, with the way to
// the full usage report.
function UsageFooter({ usage, now, active, onReport }: { usage: UsageInfo | null; now: number; active: boolean; onReport: () => void }) {
  const session = usage?.windows.find((w) => w.blocksAll);
  const pct = session?.utilization;
  return (
    <footer className="usage-footer">
      <div className="usage-footer-text">
        <span>Current session</span>
        <span className="muted">
          {pct == null
            ? usage && !usage.available
              ? "not available"
              : "…"
            : `${Math.round(pct)}% used${session!.resetsAt ? ` · resets ${resetsIn(session!.resetsAt, now)}` : ""}`}
        </span>
      </div>
      <UsageBar pct={pct ?? 0} />
      <button className={`text-button usage-report${active ? " active" : ""}`} onClick={onReport}>
        Full usage report
      </button>
    </footer>
  );
}

// A thin bar: accent, amber from 80%, red when full (`plain`: always accent,
// for shares rather than limits).
export function UsageBar({ pct, plain }: { pct: number; plain?: boolean }) {
  const level = plain ? "" : pct >= 100 ? " full" : pct >= 80 ? " high" : "";
  return (
    <span className={`usage-bar${level}`} role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </span>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type BackendId,
  type FolderDefaults,
  type QueueState,
  type UsageInfo,
  type FolderInfo,
  type MachineInfo,
  type PermissionMode,
  type RunState,
  type SessionSettings,
  type SessionSummary,
} from "../../shared/types.ts";
import { api } from "./api.ts";
import { Navigator, type Notice, type Panel } from "./Navigator.tsx";
import { ChatView } from "./ChatView.tsx";
import { clampWidth, ColumnResizer, savedWidth } from "./ColumnResizer.tsx";
import { SidebarIcon } from "./icons.tsx";
import { SidePanel } from "./SidePanel.tsx";
import { SettingsView } from "./SettingsView.tsx";
import { UsageView } from "./UsageView.tsx";
import { MainTabs, type MainTab } from "./MainTabs.tsx";
import { TerminalView } from "./TerminalView.tsx";

export interface Selection {
  dir: string;
  id: string;
  isNew?: boolean; // a new session, not started yet: the first message creates it
  backend?: BackendId; // absent: Claude (or whatever the session list says)
}

// What the right column shows: the selected session's chat, or a page.
export type View =
  | { kind: "chat" }
  | { kind: "settings" }
  | { kind: "usage" };

const PAGES = ["settings", "usage"];

// The selected session, or the open page, lives in the URL hash so reloads
// and links keep it.
function readHash(): { selection: Selection | null; view: View } {
  const params = new URLSearchParams(location.hash.slice(1));
  const dir = params.get("dir");
  const id = params.get("session");
  const page = params.get("view");
  const view: View =
    page === "settings" || page === "usage" ? { kind: page } : { kind: "chat" };
  const backend = params.get("agent") === "gemini" ? ("gemini" as const) : undefined;
  const selection = dir && id && !PAGES.includes(page ?? "") ? { dir, id, isNew: params.get("new") === "1" || undefined, backend } : null;
  return { selection, view };
}

function writeHash(sel: Selection | null, view: View): void {
  const params: Record<string, string> | null =
    view.kind !== "chat"
      ? { view: view.kind }
      : sel
        ? { dir: sel.dir, session: sel.id, ...(sel.isNew ? { new: "1" } : {}), ...(sel.backend === "gemini" ? { agent: "gemini" } : {}) }
        : null;
  const hash = params ? "#" + new URLSearchParams(params).toString() : "";
  history.replaceState(null, "", location.pathname + location.search + hash);
}

// Which tree nodes are open is remembered per device.
function savedExpanded(): string[] | null {
  try {
    const saved = JSON.parse(localStorage.getItem("expanded") ?? "null");
    return Array.isArray(saved) ? saved : null;
  } catch {
    return null;
  }
}

function saveExpanded(expanded: Set<string>): void {
  try {
    localStorage.setItem("expanded", JSON.stringify([...expanded]));
  } catch {}
}

const isFolder = (key: string) => !key.startsWith("machine:");

const defaultsKey = (backend: BackendId, dir: string) => `${backend}:${dir}`;

type ServerEvent =
  | { type: "session"; id: string }
  | { type: "list" }
  | { type: "run"; id: string; run: RunState | null }
  | { type: "queue" }
  | { type: "notes"; dir: string; file: string };

// How often the header's usage meter refreshes (the server caches it too).
const USAGE_REFRESH_MS = 5 * 60_000;
// A notice that isn't an error goes away by itself after this long.
const NOTICE_MS = 4000;

export function App() {
  const [machine, setMachine] = useState<MachineInfo | null>(null);
  const [folders, setFolders] = useState<FolderInfo[] | null>(null);
  const [sessions, setSessions] = useState<Record<string, SessionSummary[]>>({});
  const [initial] = useState(readHash);
  const [selected, setSelected] = useState<Selection | null>(initial.selection);
  const [view, setView] = useState<View>(initial.view);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [queue, setQueue] = useState<QueueState | null>(null);
  // Bumped per folder when its NOTES.md changes on disk.
  const [notesVersion, setNotesVersion] = useState<Record<string, number>>({});
  // The third column (notes and queue): open or not, and for which folder.
  // null: not chosen this visit, so the setting decides.
  const [sideChoice, setSideChoice] = useState<boolean | null>(null);
  // A folder picked from its menu while no session is open there.
  const [sideDir, setSideDir] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set([...(savedExpanded() ?? []), ...(selected ? [selected.dir] : [])]),
  );
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("tree");
  const [notice, setNotice] = useState<Notice | null>(null);
  // State of sessions Agent Commander is running, by session id.
  const [runs, setRuns] = useState<Record<string, RunState | null>>({});
  // Settings picked for sessions (mode, model, effort): applied to a running
  // session at once, otherwise used when its run starts.
  const [chosen, setChosen] = useState<Record<string, SessionSettings>>({});
  // Defaults per backend and folder (e.g. Claude Code's default permission mode), keyed by defaultsKey.
  const [defaults, setDefaults] = useState<Record<string, FolderDefaults>>({});
  // Bumped when the selected session's transcript changes on disk.
  const [transcriptVersion, setTranscriptVersion] = useState(0);
  const [navWidth, setNavWidth] = useState(() => savedWidth("nav"));
  const [sideWidth, setSideWidth] = useState(() => savedWidth("side"));
  // The middle column's Chat | Terminal tabs. A shell per project folder stays
  // connected while another tab shows; Close shell (or leaving the page) ends it.
  const [mainTab, setMainTab] = useState<MainTab>("chat");
  const [termDirs, setTermDirs] = useState<string[]>([]);
  const [termDir, setTermDir] = useState<string | null>(null);
  const openTerminal = (dir: string) => {
    setTermDirs((prev) => (prev.includes(dir) ? prev : [...prev, dir]));
    setTermDir(dir);
    setMainTab("terminal");
    setView({ kind: "chat" });
  };
  const closeTerminal = (dir: string) => {
    setTermDirs((prev) => prev.filter((d) => d !== dir));
    setMainTab("chat");
  };
  // Desktop only: the list column can be hidden (remembered per device).
  const [navHidden, setNavHidden] = useState(() => {
    try {
      return localStorage.getItem("navHidden") === "1";
    } catch {
      return false;
    }
  });
  const toggleNav = useCallback(() => {
    setNavHidden((hidden) => {
      try {
        localStorage.setItem("navHidden", hidden ? "0" : "1");
      } catch {}
      return !hidden;
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+B belongs to the terminal (tmux's prefix) while one has focus.
      if ((e.target as Element | null)?.closest?.(".terminal-pane")) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleNav();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleNav]);
  const [resizing, setResizing] = useState(false);
  // On narrow screens only one column shows at a time.
  const [mobileView, setMobileView] = useState<"nav" | "chat" | "side">(
    selected || initial.view.kind !== "chat" ? "chat" : "nav",
  );

  const loadSessions = useCallback((dir: string) => {
    api.sessions(dir).then(
      (list) => setSessions((prev) => ({ ...prev, [dir]: list })),
      (err) => setError(String(err.message ?? err)),
    );
  }, []);

  // One request for the whole tree: folders plus the sessions of open ones.
  const refresh = useCallback(() => {
    api.tree([...expanded].filter(isFolder)).then(
      (tree) => {
        setError(null);
        setFolders(tree.folders);
        setSessions((prev) => ({ ...prev, ...tree.sessions }));
      },
      (err) => setError(String(err.message ?? err)),
    );
  }, [expanded]);

  // Server events arrive in a long-lived handler; read current state via refs.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    api.machine().then(
      setMachine,
      (err) => setError(String(err.message ?? err)),
    );
    refresh();
    api.settings().then(setSettings, () => {});
    const loadQueue = () => api.queue().then(setQueue, () => {});
    const loadUsage = () => api.usage().then(setUsage, () => {});
    loadQueue();
    loadUsage();
    const usageTimer = setInterval(loadUsage, USAGE_REFRESH_MS);

    // Re-read everything: after a reconnect, or when the page comes back
    // into view (mobile browsers pause background tabs), events may have
    // been missed.
    const catchUp = () => {
      refreshRef.current();
      setTranscriptVersion((v) => v + 1);
      loadQueue();
      loadUsage();
      const sel = selectedRef.current;
      if (sel) api.run(sel.id).then((run) => setRuns((prev) => ({ ...prev, [sel.id]: run })), () => {});
    };

    // EventSource reconnects by itself after errors, but can give up for good
    // (readyState CLOSED); connect() starts a fresh one when that happens.
    let events: EventSource;
    const connect = () => {
      events = new EventSource("/api/events");
      let opened = false;
      events.onopen = () => {
        if (opened) catchUp();
        opened = true;
      };
      events.onmessage = (e) => {
        const event: ServerEvent = JSON.parse(e.data);
        if (event.type === "list") refreshRef.current();
        else if (event.type === "run") setRuns((prev) => ({ ...prev, [event.id]: event.run }));
        else if (event.type === "queue") loadQueue();
        else if (event.type === "notes") setNotesVersion((prev) => ({ ...prev, [event.dir]: (prev[event.dir] ?? 0) + 1 }));
        else if (event.id === selectedRef.current?.id) setTranscriptVersion((v) => v + 1);
      };
    };
    connect();

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (events.readyState === EventSource.CLOSED) connect();
      catchUp();
    };
    document.addEventListener("visibilitychange", onVisible);

    // Keep the saved width valid when the window shrinks.
    const onResize = () => {
      setNavWidth((w) => clampWidth("nav", w));
      setSideWidth((w) => clampWidth("side", w));
    };
    window.addEventListener("resize", onResize);
    return () => {
      clearInterval(usageTimer);
      events.close();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // The selected session's run state, in case it started before this page loaded.
  useEffect(() => {
    const id = selected?.id;
    if (id) api.run(id).then((run) => setRuns((prev) => ({ ...prev, [id]: run })), () => {});
  }, [selected?.id]);

  const selectedSummary = selected ? sessions[selected.dir]?.find((s) => s.id === selected.id) : undefined;
  const backend: BackendId = selected?.backend ?? selectedSummary?.backend ?? "claude";
  const folderDefaults = selected ? defaults[defaultsKey(backend, selected.dir)] : undefined;

  useEffect(() => {
    const dir = selected?.dir;
    const key = dir && defaultsKey(backend, dir);
    if (dir && key && !defaults[key]) api.folderDefaults(dir, backend).then((d) => setDefaults((prev) => ({ ...prev, [key]: d })), () => {});
  }, [selected?.dir, backend]);

  // A notice that isn't an error fades by itself.
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const selectedRun = selected ? (runs[selected.id] ?? null) : null;
  const picked = selected ? (chosen[selected.id] ?? {}) : {};
  // What's in force: what the run reports, else what was picked, else the
  // app's default from Settings, else Claude Code's default for the folder.
  // The app's defaults are Claude's: for Gemini only a mode it has carries over.
  const gemini = backend === "gemini";
  const appMode = gemini && settings.defaultMode && !folderDefaults?.modes?.includes(settings.defaultMode) ? undefined : settings.defaultMode;
  const mode: PermissionMode = (selected && (selectedRun?.mode ?? picked.mode ?? appMode ?? folderDefaults?.permissionMode)) || "default";
  const model = picked.model ?? selectedRun?.model ?? (gemini ? undefined : settings.defaultModel) ?? "default";
  const effort =
    picked.effort !== undefined
      ? picked.effort
      : selectedRun
        ? (selectedRun.effort ?? null)
        : gemini
          ? null
          : (settings.defaultEffort ?? null);

  const changeSettings = (change: SessionSettings) => {
    if (!selected) return;
    const id = selected.id;
    setChosen((prev) => ({ ...prev, [id]: { ...prev[id], ...change } }));
    if (selectedRun) {
      // Show it at once; the run's own report follows.
      setRuns((prev) => ({ ...prev, [id]: prev[id] && { ...prev[id]!, ...change } }));
      api.applySettings(id, change).catch((err) => setNotice({ text: `Couldn't change settings: ${err.message ?? err}`, error: true }));
    }
  };

  const toggle = (key: string) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else {
      next.add(key);
      if (isFolder(key)) loadSessions(key);
    }
    setExpanded(next);
    saveExpanded(next);
  };

  const select = (sel: Selection | null) => {
    setMainTab("chat");
    setSelected(sel);
    setSideDir(null);
    setView({ kind: "chat" });
    writeHash(sel, { kind: "chat" });
    if (sel) setMobileView("chat");
  };

  const openView = (next: View) => {
    setView(next);
    writeHash(selected, next);
    setMobileView("chat");
  };

  // Back from a page: to the chat it covered, or to the list on a phone.
  const closeView = () => {
    openView({ kind: "chat" });
    if (!selected) setMobileView("nav");
  };

  // The side panel shows the project the chat is in, else the folder whose
  // menu opened it.
  const sideFolder = [selected?.dir, sideDir].find((d) => d && folders?.some((f) => f.path === d)) ?? null;

  const openSide = (dir: string) => {
    setSideDir(dir);
    setSideChoice(true);
    setMobileView("side");
  };

  const closeSide = () => {
    setSideChoice(false);
    setMobileView(selected || view.kind !== "chat" ? "chat" : "nav");
  };

  // The most urgent session status, so a hidden list still shows "needs you".
  const urgent = folders?.some((f) => f.live === "waiting") ? "waiting" : folders?.some((f) => f.live === "working") ? "working" : null;

  const terminalOn = settings.terminalEnabled;
  const showTerminal = terminalOn && mainTab === "terminal" && view.kind === "chat" && !!termDir;

  const showSide = (sideChoice ?? settings.sideOpenByDefault) && !!sideFolder;

  const showPanel = (next: Panel) => {
    setPanel(next);
    if (next === "tree") refresh(); // folders or sessions may have changed
  };

  // Deleted sessions can be restored (Restore Sessions), so deleting
  // doesn't ask first, and its notice just fades.
  const deleteSessions = async (items: Array<{ id: string; dir: string }>, label: string) => {
    const result = await api.deleteSessions(items);
    if (result.failed.length && !result.done.length) {
      setNotice({ text: `Not deleted: ${result.failed[0].error}.`, error: true });
    } else if (result.failed.length) {
      setNotice({ text: `Deleted ${label}. ${result.failed.length} not deleted: ${result.failed[0].error}.`, error: true });
    } else {
      setNotice({ text: `Deleted ${label}.` });
    }
    if (selected && result.done.includes(selected.id)) select(null);
    refresh();
  };

  const deleteSelected = () => {
    if (!selected) return;
    setMobileView("nav"); // on a phone, show the list with the notice
    deleteSessions([selected], `“${selectedSummary?.title ?? "session"}”`).catch((err) =>
      setNotice({ text: String(err.message ?? err), error: true }),
    );
  };

  // Out of usage: the plan's session or weekly window is full, or this
  // session's last turn was refused for it. Messages then go to the queue.
  const usageFull = !!usage?.windows.some((w) => w.blocksAll && (w.utilization ?? 0) >= 100);
  // Claude's plan usage; Gemini has its own (it reports none to us).
  const limited = !gemini && (usageFull || !!selectedRun?.rateLimited);

  const renamed = (dir: string, summary: SessionSummary) =>
    setSessions((prev) => ({
      ...prev,
      [dir]: (prev[dir] ?? []).map((s) => (s.id === summary.id ? summary : s)),
    }));


  return (
    <div
      className={`app show-${mobileView}${navHidden ? " nav-hidden" : ""}${showSide ? " with-side" : ""}${resizing ? " resizing" : ""}`}
      style={{ "--nav-width": `${navWidth}px`, "--side-width": `${sideWidth}px` } as React.CSSProperties}
    >
      <Navigator
        onHide={toggleNav}
        machine={machine}
        folders={folders}
        sessions={sessions}
        expanded={expanded}
        selected={selected}
        error={error}
        panel={panel}
        onPanel={showPanel}
        onToggle={toggle}
        onSelect={select}
        onNewSession={(dir, agent) => select({ dir, id: crypto.randomUUID(), isNew: true, backend: agent })}
        view={view}
        onView={openView}
        onSide={openSide}
        onTerminal={terminalOn ? openTerminal : undefined}
        usage={usage}
        queue={queue}
        notice={notice}
        onNotice={setNotice}
        onDeleteSessions={deleteSessions}
        onRefresh={refresh}
      />
      {navHidden && (
        <button className="icon-button expand-nav" title="Show the session list (Ctrl+B)" onClick={toggleNav}>
          <SidebarIcon />
          {urgent && <span className={`live-dot ${urgent}`} />}
        </button>
      )}
      <ColumnResizer column="nav" width={navWidth} other={showSide ? sideWidth : 0} onWidth={setNavWidth} onDragging={setResizing} />
      <div className="main-slot" style={{ display: showTerminal ? "none" : "contents" }}>
      {view.kind === "settings" ? (
        <SettingsView
          settings={settings}
          folders={folders ?? []}
          onSettings={setSettings}
          onBack={closeView}
        />
      ) : view.kind === "usage" ? (
        <UsageView usage={usage} onUsage={setUsage} onBack={closeView} />
      ) : (
      <ChatView
        machine={machine}
        selection={selected}
        summary={selectedSummary}
        version={transcriptVersion}
        run={selectedRun}
        settings={{ mode, model, effort }}
        models={folderDefaults?.models ?? []}
        modes={folderDefaults?.modes}
        backend={backend}
        onSettings={changeSettings}
        hideTools={settings.hideThinkingAndTools}
        limited={limited}
        onQueue={async (text) => {
          const sel = selected!;
          const title = sel.isNew ? text.split("\n")[0].slice(0, 60) : (selectedSummary?.title ?? "Queued message");
          await api.addTasks(sel.dir, [{ title, prompt: text }], false, sel.isNew ? undefined : sel.id);
          setNotice({ text: "Queued: it runs when your usage resets." });
        }}
        onSend={async (text, files) => {
          const sel = selected!;
          const { id } = await api.sendMessage(sel.id, sel.dir, text, chosen[sel.id] ?? {}, sel.isNew, files, backend);
          // The first message created it; from now on it's an ordinary session.
          if (sel.isNew) {
            if (id !== sel.id) setChosen((prev) => ({ ...prev, [id]: prev[sel.id] }));
            select({ dir: sel.dir, id, backend: sel.backend });
          }
        }}
        onInterrupt={() => api.interrupt(selected!.id)}
        onClose={async () => {
          await api.closeSession(selected!.id);
          refresh();
        }}
        onAnswer={(toolUseId, allow, mode, answers) => api.answerPermission(selected!.id, toolUseId, allow, mode, answers)}
        onRenamed={renamed}
        onDelete={deleteSelected}
        onBack={() => setMobileView("nav")}
        tabs={terminalOn && selected ? <MainTabs tab="chat" onTab={(t) => t === "terminal" && openTerminal(selected.dir)} /> : undefined}
      />
      )}
      </div>
      {terminalOn && termDirs.length > 0 && (
        <TerminalView
          dirs={termDirs}
          dir={termDir}
          active={showTerminal}
          home={machine?.home}
          hostname={machine?.hostname}
          onTab={setMainTab}
          onClose={closeTerminal}
        />
      )}
      {showSide && (
        <>
          <ColumnResizer column="side" width={sideWidth} other={navHidden ? 0 : navWidth} onWidth={setSideWidth} onDragging={setResizing} />
          <SidePanel
            dir={sideFolder!}
            folders={folders ?? []}
            home={machine?.home}
            notesVersion={notesVersion[sideFolder!] ?? 0}
            queue={queue}
            onClose={closeSide}
            onOpenSession={(dir, id) => {
              select({ dir, id });
            }}
          />
        </>
      )}
    </div>
  );
}

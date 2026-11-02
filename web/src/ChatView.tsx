import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  Attachment,
  BackendId,
  ChatMessage,
  MachineInfo,
  ModelOption,
  PermissionMode,
  RunState,
  SessionSettings,
  SessionSummary,
} from "../../shared/types.ts";
import type { Selection } from "./App.tsx";
import { api } from "./api.ts";
import { BIG_CONTEXT_TOKENS, cacheIsCold, formatTokens, tildePath, useNow } from "./format.ts";
import { FileChip, Message, Speaker } from "./Message.tsx";
import { Composer } from "./Composer.tsx";
import { LiveTurn } from "./LiveTurn.tsx";
import { HandoffDialog } from "./HandoffDialog.tsx";
import { Menu } from "./Menu.tsx";
import { TitleInput } from "./TitleInput.tsx";
import { autoRead, speak, stopSpeaking } from "./speech.ts";

interface Props {
  machine: MachineInfo | null;
  selection: Selection | null;
  summary: SessionSummary | undefined;
  version: number; // changes when the transcript changed on disk
  run: RunState | null; // set while Agent Commander runs this session
  onSend: (text: string, files: Attachment[]) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onClose: () => Promise<void>; // end the session's Claude process, here or elsewhere
  onAnswer: (toolUseId: string, allow: boolean, mode?: PermissionMode, answers?: Record<string, string>) => Promise<void>;
  settings: Required<SessionSettings>; // in force, or what a new run starts with
  models: ModelOption[];
  modes?: PermissionMode[]; // the permission modes the session's agent has; absent: all
  backend: BackendId;
  onSettings: (change: SessionSettings) => void;
  hideTools: boolean;
  limited: boolean; // out of usage: messages go to the queue
  onQueue: (text: string) => Promise<void>;
  onRenamed: (dir: string, summary: SessionSummary) => void;
  onDelete: () => void;
  onBack: () => void;
  tabs?: React.ReactNode; // Chat | Terminal switch, when the terminal is available
}

type Load = { state: "idle" } | { state: "loading" } | { state: "error"; error: string } | { state: "ready"; messages: ChatMessage[] };

export function ChatView(props: Props) {
  const { machine, selection, summary, version, run, onRenamed, onDelete, onBack } = props;
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const now = useNow();
  const [editingTitle, setEditingTitle] = useState(false);
  const [handingOff, setHandingOff] = useState(false);
  // Sent messages shown until the transcript has them.
  const [pending, setPending] = useState<Array<{ text: string; files: string[] }>>([]);
  const [readAloud, setReadAloud] = useState(autoRead.get);
  const scroller = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  // Follow new messages only while the reader is at the bottom.
  const stickToBottom = useRef(true);
  // A turn ran since the last time we read a reply aloud.
  const sawBusy = useRef(false);

  useEffect(() => {
    setEditingTitle(false);
    setHandingOff(false);
    setPending([]);
    stopSpeaking(); // a reply from the session we're leaving
    sawBusy.current = false;
    messagesRef.current = [];
    stickToBottom.current = true;
    if (!selection) return setLoad({ state: "idle" });
    let cancelled = false;
    setLoad({ state: "loading" });
    api.messages(selection.id, selection.dir).then(
      (page) => {
        if (cancelled) return;
        messagesRef.current = page.messages;
        setLoad({ state: "ready", messages: page.messages });
      },
      (err) => !cancelled && setLoad({ state: "error", error: String(err.message ?? err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [selection?.id, selection?.dir]);

  // Live updates: fetch only from the last message we have (it may have grown).
  useEffect(() => {
    if (!selection || version === 0) return;
    let cancelled = false;
    const have = messagesRef.current;
    const from = Math.max(0, have.length - 1);
    api.messages(selection.id, selection.dir, from).then(
      async (page) => {
        if (cancelled) return;
        // Transcript shrank (compaction, rewrite): reload it all.
        if (page.total < from) page = await api.messages(selection.id, selection.dir);
        if (cancelled) return;
        const messages = [...have.slice(0, page.from), ...page.messages];
        messagesRef.current = messages;
        setLoad({ state: "ready", messages });
      },
      () => {}, // keep showing what we have; the next change retries
    );
    return () => {
      cancelled = true;
    };
  }, [version]);

  const messages = load.state === "ready" ? load.messages : [];

  // Assistant blocks already loaded, so finished draft blocks can be dropped.
  const savedUuids = useMemo(
    () => new Set(messages.flatMap((m) => m.blocks.map((b) => ("uuid" in b ? b.uuid : undefined)).filter((u) => u !== undefined))),
    [messages],
  );

  // Drop pending messages once the transcript has them: as a user message,
  // or as a command notice for slash commands.
  useEffect(() => {
    if (!pending.length) return;
    const recent = new Set(
      messages
        .filter((m) => m.role !== "assistant")
        .slice(-8)
        .map((m) => m.blocks.map((b) => (b.type === "text" ? b.text : "")).join("").trim()),
    );
    if (pending.some((p) => recent.has(p.text))) setPending((prev) => prev.filter((p) => !recent.has(p.text)));
  }, [messages]);

  // Once a turn has ended, everything sent before it has been handled.
  useEffect(() => {
    if (run?.status === "idle" || run?.status === "error") setPending([]);
  }, [run?.status]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (load.state === "ready" && el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [load, run, pending]);

  // Read each reply aloud once its turn ends. The transcript may lag the
  // status a little, so look a moment later.
  useEffect(() => {
    if (!readAloud || !selection) return;
    if (run?.status === "idle") {
      if (!sawBusy.current) return;
      sawBusy.current = false;
      const timer = setTimeout(() => {
        const all = messagesRef.current;
        const lastUser = all.findLastIndex((m) => m.role === "user");
        const reply = all
          .slice(lastUser + 1)
          .filter((m) => m.role === "assistant")
          .flatMap((m) => m.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])))
          .join("\n\n");
        if (reply) speak("auto", reply);
      }, 700);
      return () => clearTimeout(timer);
    } else if (run && run.status !== "error") {
      sawBusy.current = true;
    }
  }, [run?.status, readAloud]);

  const send = async (text: string, files: Attachment[]) => {
    // Out of usage, and not mid-turn: queue it to run after the reset.
    if (props.limited && !busy) {
      if (files.length) throw new Error("Files can't be queued. Remove them, or send once your usage has reset.");
      return props.onQueue(text);
    }
    stopSpeaking(); // you're talking over it
    await props.onSend(text, files);
    stickToBottom.current = true;
    setPending((prev) => [...prev, { text, files: files.map((f) => f.name) }]);
  };

  const changeReadAloud = (on: boolean) => {
    autoRead.set(on);
    setReadAloud(on);
  };

  // Open in a terminal or Remote Control: two writers would clash, so only follow it.
  const gemini = props.backend === "gemini";
  const liveElsewhere = !!summary?.live && !run;
  const context = run?.contextTokens ?? summary?.contextTokens;
  // Prompt caching is Claude's; Gemini reports only the context size.
  const cold = !gemini && !!summary && cacheIsCold(summary.lastActivity, summary.cacheTtlMs, now);
  const busy = !!run && ["starting", "working", "waiting"].includes(run.status);

  // A big conversation whose cache has lapsed: the next message re-sends all of it.
  const coldWarning = !!context && context >= BIG_CONTEXT_TOKENS && cold && !liveElsewhere;

  // Context size and cache warmth, at the right of the composer's bar.
  const contextInfo = context ? (
    <span
      className={`context-info${coldWarning ? " cold" : ""}`}
      title={
        gemini
          ? `${context.toLocaleString()} tokens of context, as Gemini last reported it.`
          : `${context.toLocaleString()} tokens of context as of the last reply. ${
              cold ? "The prompt cache has probably expired, so the next message re-reads all of it at full price." : "The prompt cache is probably still warm, so the next message is cheap."
            }`
      }
    >
      {!gemini && <span className={`cache-dot${cold ? " cold" : ""}`} />}
      {formatTokens(context)} tokens{gemini ? "" : ` · ${cold ? "cache cold" : "cache warm"}`}
    </span>
  ) : null;

  const onScroll = () => {
    const el = scroller.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <main className="chat">
      <header className="chat-header">
        <button className="icon-button back" onClick={onBack} title="Back to sessions">
          ‹
        </button>
        {selection ? (
          <div className="chat-title">
            <SessionTitle
              title={summary?.title ?? (selection.isNew ? "New session" : "Session")}
              editing={editingTitle}
              onEditing={setEditingTitle}
              onRename={async (title) => onRenamed(selection.dir, await api.renameSession(selection.id, selection.dir, title))}
            />
          </div>
        ) : (
          <div className="chat-title muted">No session selected</div>
        )}
        {props.tabs}
        {selection && (
          <Menu
            title="Session actions"
            items={[
              { label: "Rename", onClick: () => setEditingTitle(true) },
              ...(run || summary?.liveHere
                ? [{ label: "Close", hint: "End its Claude process; the session is kept", onClick: () => void props.onClose() }]
                : []),
              ...(!gemini && !selection.isNew && !summary?.remote && !(summary?.live && !run)
                ? [
                    {
                      label: "Hand off to Remote Control…",
                      hint: run && run.status !== "idle" ? "Wait for the turn to finish" : "Continue it from claude.ai or the phone app",
                      disabled: !!run && run.status !== "idle",
                      onClick: () => setHandingOff(true),
                    },
                  ]
                : []),
              {
                label: "Delete",
                onClick: onDelete,
                disabled: !!summary?.live,
                hint: summary?.live ? (gemini ? "Close it first" : "Live sessions can't be deleted") : undefined,
              },
            ]}
          />
        )}
      </header>

      {handingOff && selection && (
        <HandoffDialog
          id={selection.id}
          dir={selection.dir}
          home={machine?.home}
          settings={props.settings}
          onDone={() => setHandingOff(false)}
        />
      )}

      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        <div className="chat-column">
          {load.state === "idle" && <div className="empty">Pick a session on the left to read it.</div>}
          {load.state === "loading" && <div className="empty">Loading…</div>}
          {load.state === "error" && <div className="empty error">{load.error}</div>}
          {load.state === "ready" && load.messages.length === 0 && !run && (
            <div className="empty">
              {selection?.isNew
                ? `New session in ${tildePath(selection.dir, machine?.home)}. Your first message starts it.`
                : "This session has no messages."}
            </div>
          )}
          {messages.map((m) => (
            <Message key={m.id} message={m} hideTools={props.hideTools} backend={props.backend} />
          ))}
          {pending.map((p, i) => (
            <div key={i} className="message user pending">
              <Speaker who="user" />
              <div className="bubble">
                {p.files.map((name, j) => (
                  <FileChip key={j} name={name} />
                ))}
                {p.text && <div className="user-text">{p.text}</div>}
              </div>
            </div>
          ))}
          {run && (
            <LiveTurn
              run={run}
              savedUuids={savedUuids}
              hideTools={props.hideTools}
              continues={messages[messages.length - 1]?.role === "assistant"}
              backend={props.backend}
              onAnswer={props.onAnswer}
            />
          )}
        </div>
      </div>

      {selection && load.state === "ready" && (
        <footer className="chat-footer">
          <div className="chat-column">
            {coldWarning && (
              <div className="cold-warning">
                Resuming re-reads about {formatTokens(context!)} tokens at full price: the prompt cache has expired. Consider{" "}
                <code>/compact</code> to shrink the conversation first, or <code>/clear</code> to start fresh.
              </div>
            )}
            {props.limited && !liveElsewhere && (
              <div className="cold-warning">
                You're out of usage for now. Messages you send are queued and run by themselves when it resets.
              </div>
            )}
            {liveElsewhere ? (
              <OpenElsewhere remote={summary?.remote} onClose={props.onClose} />
            ) : (
              <Composer
                key={`${selection.backend}:${selection.id}`}
                draftKey={`${selection.backend}:${selection.id}`}
                dir={selection.dir}
                backend={props.backend}
                modes={props.modes}
                busy={busy}
                settings={props.settings}
                models={props.models}
                onSettings={props.onSettings}
                onSend={send}
                onStop={props.onInterrupt}
                readAloud={readAloud}
                onReadAloud={changeReadAloud}
                contextInfo={contextInfo}
              />
            )}
          </div>
        </footer>
      )}
    </main>
  );
}

interface TitleProps {
  title: string;
  editing: boolean;
  onEditing: (editing: boolean) => void;
  onRename: (title: string) => Promise<void>;
}

// The session title, editable in place: click it (or Rename in the ⋯ menu).
function SessionTitle({ title, editing, onEditing, onRename }: TitleProps) {
  if (editing) return <TitleInput initial={title} onSave={onRename} onClose={() => onEditing(false)} />;
  return (
    <button className="chat-title-main editable" title="Rename session" onClick={() => onEditing(true)}>
      <span className="chat-title-text">{title}</span>
      <span className="pencil" aria-hidden>
        ✎
      </span>
    </button>
  );
}

// Footer for a session open in a terminal or Remote Control: it can only be
// followed here, unless its process is closed first.
function OpenElsewhere({ remote, onClose }: { remote?: string; onClose: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = async () => {
    setBusy(true);
    setError(null);
    try {
      await onClose();
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="elsewhere-bar">
      {confirming ? (
        <>
          <span className="elsewhere-text">
            End the Claude Code process that has this session open? Anything typed but not sent there is lost; the
            session itself is kept.
          </span>
          <button className="danger-button" disabled={busy} onClick={close}>
            {busy ? "Closing…" : "Yes, close it"}
          </button>
          <button className="text-button" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <span className="elsewhere-text">
            {remote ? (
              <>
                Open in Remote Control (<a href={remote} target="_blank" rel="noreferrer">continue on claude.ai</a>). This view follows it live.
              </>
            ) : (
              "Open in Claude Code (a terminal or Remote Control). This view follows it live."
            )}
          </span>
          <button className="secondary-button" onClick={() => setConfirming(true)}>
            Close it there
          </button>
        </>
      )}
      {error && <span className="title-error">{error}</span>}
    </div>
  );
}

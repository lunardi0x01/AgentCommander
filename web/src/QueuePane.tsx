import { useState } from "react";
import type { FolderInfo, QueueItem, QueueState, QueueStatus, QueueTask } from "../../shared/types.ts";
import { api } from "./api.ts";
import { relativeTime, resetsIn, tildePath, useNow } from "./format.ts";

interface Props {
  queue: QueueState | null;
  dir: string; // the folder the panel shows: where new tasks go
  folders: FolderInfo[];
  home: string | undefined;
  onOpenSession: (dir: string, id: string) => void;
}

const STATUS_LABELS: Record<QueueStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Needs you",
  done: "Done",
  failed: "Failed",
};

// Prompts that run by themselves, one at a time, each in a new session;
// when usage is out they wait for the reset.
export function QueuePane({ queue, dir, folders, home, onOpenSession }: Props) {
  const now = useNow();
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<unknown>) => fn().catch((err) => setError(String((err as Error).message ?? err)));

  const items = queue?.items ?? [];
  const finished = items.some((i) => i.status === "done" || i.status === "failed");
  const queued = items.filter((i) => i.status === "queued").length;

  const state = !queue
    ? "Loading…"
    : queue.paused
      ? "Paused"
      : items.some((i) => i.status === "running")
        ? "Running"
        : queue.waitingUntil
          ? `Out of usage: carries on by itself ${resetsIn(queue.waitingUntil, now)}`
          : queued
            ? "Starting…"
            : "Nothing waiting";

  return (
    <section className="side-section queue-pane">
      <header className="side-head">
        <div className="side-title">
          <strong>Queue</strong>
          <span className="muted side-state">{state}</span>
        </div>
        {queue && (
          <>
            {finished && (
              <button className="secondary-button" onClick={() => act(api.clearQueue)}>
                Clear finished
              </button>
            )}
            <button className="secondary-button" onClick={() => act(() => api.pauseQueue(!queue.paused))}>
              {queue.paused ? "Resume" : "Pause"}
            </button>
            {queued > 0 && (queue.paused || queue.waitingUntil) && (
              <button className="secondary-button" onClick={() => act(api.runQueue)} title="Try now instead of waiting for the reset">
                Run now
              </button>
            )}
          </>
        )}
      </header>
      <div className="side-body">
      {error && (
        <div className="run-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      <AddTasks dir={dir} onError={setError} />

      {items.length > 0 && <h3 className="page-heading">Tasks</h3>}
      <ol className="queue-list">
        {items.map((item, i) => (
          <QueueRow
            key={item.id}
            item={item}
            first={i === 0}
            last={i === items.length - 1}
            folder={folders.find((f) => f.path === item.dir)?.name ?? tildePath(item.dir, home)}
            now={now}
            act={act}
            onOpenSession={onOpenSession}
          />
        ))}
      </ol>
      {queue && !items.length && (
        <div className="empty">
          Nothing queued. Write what you'd like done above: each task runs in a fresh session, one at a time, and
          waits for your usage to reset if it runs out.
        </div>
      )}
      </div>
    </section>
  );
}

interface AddProps {
  dir: string;
  onError: (error: string | null) => void;
}

// Write what you'd like done, a list is fine. It goes into the queue as
// written; when its turn comes, Haiku splits it into tasks (see queue.ts).
function AddTasks({ dir, onError }: AddProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // Tasks from "Preview tasks", editable before they are added.
  const [preview, setPreview] = useState<QueueTask[] | null>(null);

  const showPreview = async () => {
    setBusy(true);
    onError(null);
    try {
      const { tasks } = await api.splitTasks(dir, text.trim());
      setPreview(tasks);
    } catch (err) {
      onError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const addPreview = async () => {
    if (!preview?.length) return;
    setBusy(true);
    onError(null);
    try {
      await api.addTasks(dir, preview);
      setPreview(null);
      setText("");
    } catch (err) {
      onError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const change = (i: number, patch: Partial<QueueTask>) =>
    setPreview((prev) => prev && prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  const add = async () => {
    setBusy(true);
    onError(null);
    try {
      await api.addTasks(dir, [{ title: text.trim().split("\n")[0].slice(0, 60), prompt: text.trim() }], true);
      setText("");
    } catch (err) {
      onError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  };

  if (preview)
    return (
      <section className="queue-add">
        {preview.map((t, i) => (
          <div key={i} className="task-edit">
            <div className="queue-item-head">
              <input className="task-title-input" value={t.title} onChange={(e) => change(i, { title: e.target.value })} />
              <button className="text-button" title="Remove this task" onClick={() => setPreview((prev) => prev && prev.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
            <textarea className="task-prompt-input" rows={3} value={t.prompt} onChange={(e) => change(i, { prompt: e.target.value })} />
          </div>
        ))}
        {!preview.length && <div className="empty">No tasks left.</div>}
        <div className="queue-add-actions">
          <button
            className="primary-button"
            disabled={busy || !preview.length || preview.some((t) => !t.title.trim() || !t.prompt.trim())}
            onClick={addPreview}
          >
            {busy ? "Adding…" : `Add ${preview.length} to queue`}
          </button>
          <button className="text-button" disabled={busy} onClick={() => setPreview(null)}>
            Back
          </button>
        </div>
      </section>
    );

  return (
    <section className="queue-add">
      <textarea
        className="task-prompt-input"
        value={text}
        rows={4}
        onChange={(e) => setText(e.target.value)}
        placeholder="What should Claude do? A list is fine: it is split into separate tasks, each in its own session, when its turn comes."
      />
      <div className="queue-add-actions">
        <button className="primary-button" disabled={!text.trim() || busy} onClick={add}>
          {busy ? "Working…" : "Add to queue"}
        </button>
        <button className="secondary-button" disabled={!text.trim() || busy} onClick={showPreview} title="Split it into tasks now, and edit them before adding">
          Preview tasks
        </button>
      </div>
    </section>
  );
}

interface RowProps {
  item: QueueItem;
  first: boolean;
  last: boolean;
  folder: string;
  now: number;
  act: (fn: () => Promise<unknown>) => void;
  onOpenSession: (dir: string, id: string) => void;
}

function QueueRow({ item, first, last, folder, now, act, onOpenSession }: RowProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<QueueTask | null>(null);
  const queued = item.status === "queued";

  return (
    <li className={`queue-item ${item.status}`}>
      <div className="queue-item-head">
        <span className={`queue-status ${item.status}`}>{item.split ? "To split" : STATUS_LABELS[item.status]}</span>
        <button className="queue-item-title" onClick={() => setOpen(!open)} title={open ? "Hide the prompt" : "Show the prompt"}>
          {item.title}
        </button>
        <span className="muted queue-item-meta">
          {folder} · {relativeTime(item.createdAt, now)}
        </span>
        {item.sessionId && item.status !== "queued" && (
          <button className="text-button" onClick={() => onOpenSession(item.dir, item.sessionId!)}>
            Open
          </button>
        )}
        {queued && (
          <>
            <button className="text-button" disabled={first} onClick={() => act(() => api.moveTask(item.id, -1))} title="Move up">
              ↑
            </button>
            <button className="text-button" disabled={last} onClick={() => act(() => api.moveTask(item.id, 1))} title="Move down">
              ↓
            </button>
            <button className="text-button" onClick={() => (setOpen(true), setEditing({ title: item.title, prompt: item.prompt }))}>
              Edit
            </button>
          </>
        )}
        {item.status !== "running" && (
          <button className="text-button" onClick={() => act(() => api.removeTask(item.id))} title="Remove from the queue">
            ✕
          </button>
        )}
      </div>
      {item.error && <div className="queue-item-error">{item.error}</div>}
      {open &&
        (editing ? (
          <div className="task-edit">
            <input className="task-title-input" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            <textarea
              className="task-prompt-input"
              rows={5}
              value={editing.prompt}
              onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
            />
            <div className="queue-add-actions">
              <button
                className="primary-button"
                disabled={!editing.prompt.trim() || !editing.title.trim()}
                onClick={() => act(async () => (await api.updateTask(item.id, editing), setEditing(null)))}
              >
                Save
              </button>
              <button className="text-button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <pre className="queue-item-prompt">{item.prompt}</pre>
        ))}
    </li>
  );
}

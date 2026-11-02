import { useEffect, useState } from "react";
import type { FolderInfo, QueueState } from "../../shared/types.ts";
import { api } from "./api.ts";
import { tildePath } from "./format.ts";
import { NotesPane } from "./NotesPane.tsx";
import { QueuePane } from "./QueuePane.tsx";

interface Props {
  dir: string; // the project being worked in
  folders: FolderInfo[];
  home: string | undefined;
  notesVersion: number; // bumped when one of the folder's documents changes on disk
  queue: QueueState | null;
  onClose: () => void;
  onOpenSession: (dir: string, id: string) => void;
}

const TAB_NAMES: Record<string, string> = { "NOTES.md": "Notes", ".project/tasklist.md": "Tasks", "docs/REFERENCE.md": "Reference", "README.md": "Readme" };
const QUEUE = "queue";

// The third column: tabs for the project's notes, reference, readme and the
// prompt queue. The project is whichever one the chat is in.
export function SidePanel({ dir, folders, home, notesVersion, queue, onClose, onOpenSession }: Props) {
  const [files, setFiles] = useState(["NOTES.md"]);
  const [tab, setTab] = useState("NOTES.md");

  useEffect(() => setTab("NOTES.md"), [dir]);
  useEffect(() => {
    api.noteFiles(dir).then(setFiles, () => {});
  }, [dir, notesVersion]);

  const name = folders.find((f) => f.path === dir)?.name ?? dir;
  const queued = queue?.items.filter((i) => i.dir === dir && i.status === "queued").length ?? 0;
  const shown = files.includes(tab) || tab === QUEUE ? tab : "NOTES.md";

  return (
    <aside className="side-panel">
      <header className="side-panel-head">
        <button className="icon-button page-back" onClick={onClose} title="Back">
          ‹
        </button>
        <span className="side-folder" title={tildePath(dir, home)}>
          {name}
        </span>
        <button className="icon-button side-close" onClick={onClose} title="Close">
          ✕
        </button>
      </header>
      <div className="side-tabs" role="tablist">
        {[...files, QUEUE].map((t) => (
          <button key={t} role="tab" aria-selected={t === shown} className={`side-tab${t === shown ? " active" : ""}`} onClick={() => setTab(t)} title={t === QUEUE ? undefined : t}>
            {t === QUEUE ? (queued ? `Queue (${queued})` : "Queue") : (TAB_NAMES[t] ?? t)}
          </button>
        ))}
      </div>
      {shown === QUEUE ? (
        <QueuePane queue={queue} dir={dir} folders={folders} home={home} onOpenSession={onOpenSession} />
      ) : (
        <NotesPane key={`${dir}:${shown}`} dir={dir} file={shown} version={notesVersion} />
      )}
    </aside>
  );
}

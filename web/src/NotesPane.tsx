import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { Markdown } from "./Markdown.tsx";

interface Props {
  dir: string;
  file: string; // NOTES.md, .project/tasklist.md, README.md or docs/REFERENCE.md; the parent keys this component by it
  version: number; // bumped when one of the folder's documents changes on disk
}

type Status = "loading" | "saved" | "unsaved" | "saving" | "conflict" | "error";

// Saves this long after the last keystroke.
const AUTOSAVE_MS = 800;
// A failed save retries after 2 s, 4 s, 8 s… up to this long.
const RETRY_MAX_MS = 30_000;

// One of a project's documents, edited in place and saved as you type.
export function NotesPane({ dir, file, version }: Props) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const base = useRef(0); // mtime of the version being edited
  const textRef = useRef(text);
  textRef.current = text;
  const statusRef = useRef(status);
  statusRef.current = status;
  const retry = useRef<{ timer?: ReturnType<typeof setTimeout>; n: number }>({ n: 0 });

  const load = async () => {
    try {
      const notes = await api.notes(dir, file);
      base.current = notes.mtime;
      setText(notes.text);
      setStatus("saved");
      setError(null);
    } catch (err) {
      setStatus("error");
      setError(String((err as Error).message ?? err));
    }
  };

  useEffect(() => {
    setStatus("loading");
    setPreview(file !== "NOTES.md"); // documents are for reading first
    void load();
  }, [dir, file]);

  // Switching to another tab with edits not saved yet: save them now.
  useEffect(
    () => () => {
      if (statusRef.current === "unsaved") void api.saveNotes(dir, file, textRef.current, base.current).catch(() => {});
    },
    [],
  );

  // Closing or reloading the browser tab: unmount never runs, so save now.
  useEffect(() => {
    const flush = (e: PageTransitionEvent) => {
      if (e.persisted) return; // going into the back/forward cache: the page lives on
      if (statusRef.current === "unsaved") void api.saveNotes(dir, file, textRef.current, base.current, true).catch(() => {});
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [dir, file]);

  // Changed on disk (Claude, another device, our own save): follow it unless
  // there are unsaved edits here, which then conflict.
  useEffect(() => {
    if (version === 0) return;
    api.notes(dir, file).then((notes) => {
      if (notes.mtime === base.current) return; // our own save
      if (statusRef.current === "saved") {
        base.current = notes.mtime;
        setText(notes.text);
      } else if (statusRef.current !== "saving") setStatus("conflict");
    }, () => {});
  }, [version]);

  const save = async (force = false) => {
    setStatus("saving");
    try {
      // Forcing: overwrite whatever is on disk now.
      if (force) base.current = (await api.notes(dir, file)).mtime;
      const sent = textRef.current;
      const saved = await api.saveNotes(dir, file, sent, base.current);
      base.current = saved.mtime;
      setStatus(textRef.current === sent ? "saved" : "unsaved");
      setError(null);
      retry.current.n = 0;
    } catch (err) {
      const message = String((err as Error).message ?? err);
      if (message.includes("changed since")) setStatus("conflict");
      else {
        setStatus("error");
        setError(message);
        // Keep trying with backoff; an edit or a newer save supersedes this.
        clearTimeout(retry.current.timer);
        const delay = Math.min(RETRY_MAX_MS, 2000 * 2 ** retry.current.n++);
        retry.current.timer = setTimeout(() => {
          if (statusRef.current === "error") void save();
        }, delay);
      }
    }
  };

  useEffect(() => () => clearTimeout(retry.current.timer), []);

  useEffect(() => {
    if (status !== "unsaved") return;
    const timer = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [text, status]);

  const edit = (value: string) => {
    clearTimeout(retry.current.timer);
    setText(value);
    if (statusRef.current !== "conflict") setStatus("unsaved");
  };

  const statusText: Record<Status, string> = {
    loading: "Loading…",
    saved: base.current ? "Saved" : "Not created yet",
    unsaved: "Editing…",
    saving: "Saving…",
    conflict: "Changed elsewhere",
    error: "Not saved",
  };

  return (
    <section className="side-section notes-pane">
      <header className="side-head">
        <span className="side-file muted">{file}</span>
        <span className={`page-status ${status}`}>{statusText[status]}</span>
        <button className="secondary-button" onClick={() => setPreview(!preview)}>
          {preview ? "Edit" : "Preview"}
        </button>
      </header>
      <div className="side-body notes-body">
        {status === "conflict" && (
          <div className="cold-warning">
            {file} changed on disk while you were editing.{" "}
            <button className="text-button inline" onClick={() => void load()}>
              Load theirs
            </button>{" "}
            (drops your edits) or{" "}
            <button className="text-button inline" onClick={() => void save(true)}>
              keep mine
            </button>{" "}
            (overwrites theirs).
          </div>
        )}
        {error && <div className="run-error">{error}</div>}
        {status === "loading" ? null : preview ? (
          <div className="notes-preview">{text.trim() ? <Markdown text={text} /> : <div className="empty">Nothing written yet.</div>}</div>
        ) : (
          <textarea
            className="notes-editor"
            value={text}
            onChange={(e) => edit(e.target.value)}
            placeholder={file === "NOTES.md" ? `Ideas, to-dos, things to try… Saved to NOTES.md in the project.` : undefined}
            spellCheck
          />
        )}
      </div>
    </section>
  );
}

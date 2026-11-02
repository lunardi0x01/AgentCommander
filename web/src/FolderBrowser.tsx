import { useEffect, useState } from "react";
import type { BrowseResult, MachineInfo } from "../../shared/types.ts";
import { api } from "./api.ts";
import { tildePath } from "./format.ts";

interface Props {
  machine: MachineInfo | null;
  onPick: (dir: string) => void;
}

// Browse the projects folder to pick a folder, or create one and pick it.
export function FolderBrowser({ machine, onPick }: Props) {
  const [view, setView] = useState<BrowseResult | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const open = (dir?: string) =>
    api.browse(dir).then(
      (result) => {
        setView(result);
        setError(null);
      },
      (err) => setError(String(err.message ?? err)),
    );

  useEffect(() => {
    void open();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!view || !newName.trim()) return;
    try {
      onPick((await api.makeFolder(view.path, newName)).path);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    }
  };

  // Root, then each level down to the current folder.
  const crumbs: Array<{ name: string; path: string }> = [];
  if (view) {
    crumbs.push({ name: tildePath(view.root, machine?.home), path: view.root });
    let at = view.root;
    for (const part of view.path.slice(view.root.length).split("/").filter(Boolean)) {
      at = `${at}/${part}`;
      crumbs.push({ name: part, path: at });
    }
  }

  return (
    <>
      <div className="browse-crumbs">
        {crumbs.map((c, i) => (
          <span key={c.path}>
            {i > 0 && <span className="muted">/</span>}
            <button className="text-button inline" onClick={() => open(c.path)}>
              {c.name}
            </button>
          </span>
        ))}
      </div>
      {error && <div className="nav-error">{error}</div>}
      {view && (
        <>
          <form className="browse-new" onSubmit={create}>
            <input
              className="picker-filter"
              placeholder="New folder here…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button className="text-button" disabled={!newName.trim()}>
              Create
            </button>
          </form>
          {view.path !== view.root && (
            <div className="browse-row">
              <span className="browse-open muted">{tildePath(view.path, machine?.home)}</span>
              <button className="text-button" onClick={() => onPick(view.path)}>
                Use this folder
              </button>
            </div>
          )}
        </>
      )}
      <ul className="picker-list">
        {!view && !error && <li className="muted pad">Loading…</li>}
        {view && view.folders.length === 0 && <li className="muted pad">No subfolders.</li>}
        {view?.folders.map((f) => (
          <li key={f.path} className="browse-row">
            <button className="browse-open" onClick={() => open(f.path)}>
              <span className="picker-name">{f.name}</span>
              {f.git && <span className="muted">git</span>}
            </button>
            <button className="text-button" onClick={() => onPick(f.path)}>
              Select
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

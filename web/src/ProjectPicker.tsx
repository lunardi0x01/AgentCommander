import { useEffect, useState } from "react";
import type { FolderChoice, MachineInfo } from "../../shared/types.ts";
import { api } from "./api.ts";
import { relativeTime, tildePath, useNow } from "./format.ts";

interface Props {
  machine: MachineInfo | null;
  onDone: () => void;
}

// Choose which project folders the navigator shows. Each tick saves at once.
export function ProjectPicker({ machine, onDone }: Props) {
  const [choices, setChoices] = useState<FolderChoice[] | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    api.folderChoices().then(setChoices, (err) => setError(String(err.message ?? err)));
  }, []);

  const toggle = async (folder: FolderChoice) => {
    const selected = !folder.selected;
    const update = (value: boolean) =>
      setChoices((prev) => prev?.map((c) => (c.path === folder.path ? { ...c, selected: value } : c)) ?? null);
    update(selected);
    setError(null);
    try {
      await (selected ? api.addFolder(folder.path) : api.removeFolder(folder.path));
    } catch (err) {
      update(!selected);
      setError(String((err as Error).message ?? err));
    }
  };

  const needle = filter.trim().toLowerCase();
  const visible = choices?.filter((c) => !needle || c.path.toLowerCase().includes(needle));
  const selectedCount = choices?.filter((c) => c.selected).length ?? 0;

  return (
    <div className="picker">
      <div className="picker-head">
        <div className="picker-title">
          Choose Projects on {machine?.hostname ?? "this computer"} <span className="muted">· {selectedCount} shown</span>
        </div>
        <button className="text-button" onClick={onDone}>
          Done
        </button>
      </div>
      <input
        className="picker-filter"
        placeholder="Filter…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        autoFocus
      />
      {error && <div className="nav-error">{error}</div>}
      <ul className="picker-list">
        {!choices && !error && <li className="muted pad">Loading…</li>}
        {visible?.length === 0 && <li className="muted pad">No matching folders.</li>}
        {visible?.map((c) => (
          <li key={c.path}>
            <label className="picker-row">
              <input type="checkbox" checked={c.selected} onChange={() => toggle(c)} />
              <span className="picker-text">
                <span className="picker-name">{c.name}</span>
                <span className="picker-path">{tildePath(c.path, machine?.home)}</span>
              </span>
              <span className="picker-meta">
                {c.sessionCount === 0
                  ? "no sessions"
                  : `${c.sessionCount} · ${relativeTime(c.lastActivity, now)}`}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

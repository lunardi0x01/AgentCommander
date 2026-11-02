import { useEffect, useState } from "react";
import type { DeletedSession, MachineInfo } from "../../shared/types.ts";
import { api } from "./api.ts";
import { relativeTime, tildePath, useNow } from "./format.ts";

interface Props {
  machine: MachineInfo | null;
  onDone: () => void;
}

// Sessions deleted from Agent Commander, with Restore and Delete forever.
export function DeletedPanel({ machine, onDone }: Props) {
  const [items, setItems] = useState<DeletedSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmForever, setConfirmForever] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow();

  const load = () => api.deleted().then(setItems, (err) => setError(String(err.message ?? err)));
  useEffect(() => {
    load();
  }, []);

  const act = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(null);
      setConfirmForever(null);
    }
  };

  const restore = (id: string) =>
    act(id, async () => {
      const result = await api.restore([id]);
      if (result.failed.length) throw new Error(`Couldn't restore: ${result.failed[0].error}`);
    });

  return (
    <div className="picker">
      <div className="picker-head">
        <div className="picker-title">Restore Sessions on {machine?.hostname ?? "this computer"}</div>
        <button className="text-button" onClick={onDone}>
          Done
        </button>
      </div>
      {error && <div className="nav-error">{error}</div>}
      <ul className="picker-list">
        {!items && !error && <li className="muted pad">Loading…</li>}
        {items?.length === 0 && <li className="muted pad">Nothing deleted.</li>}
        {items?.map((s) => (
          <li key={s.id} className="deleted-row">
            <div className="deleted-title" title={s.title}>
              {s.title}
            </div>
            <div className="deleted-meta">
              {s.backend === "gemini" && <>Gemini · </>}
              {tildePath(s.dir, machine?.home)} · deleted {relativeTime(s.deletedAt, now)}
            </div>
            <div className="deleted-actions">
              {confirmForever === s.id ? (
                <>
                  <button className="danger-button small" disabled={busy === s.id} onClick={() => act(s.id, () => api.deleteForever(s.id))}>
                    Yes, delete forever
                  </button>
                  <button className="text-button" disabled={busy === s.id} onClick={() => setConfirmForever(null)}>
                    Back
                  </button>
                </>
              ) : (
                <>
                  <button className="text-button" disabled={busy === s.id} onClick={() => restore(s.id)}>
                    Restore
                  </button>
                  <button className="text-button muted-button" disabled={busy === s.id} onClick={() => setConfirmForever(s.id)}>
                    Delete forever
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

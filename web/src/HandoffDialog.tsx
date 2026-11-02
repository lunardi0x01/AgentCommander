import { useState } from "react";
import type { SessionSettings } from "../../shared/types.ts";
import { api } from "./api.ts";
import { tildePath } from "./format.ts";

interface Props {
  id: string;
  dir: string;
  home?: string;
  settings: SessionSettings;
  onDone: () => void;
}

type Step =
  | { step: "confirm" }
  | { step: "working"; text: string }
  | { step: "trust" }
  | { step: "done"; url: string }
  | { step: "error"; message: string };

// Confirm handing a session off to Remote Control. Claude Code may ask
// whether to trust the folder on its first start there; that is asked here.
export function HandoffDialog({ id, dir, home, settings, onDone }: Props) {
  const [state, setState] = useState<Step>({ step: "confirm" });
  const folder = tildePath(dir, home);

  const run = async (trust: boolean) => {
    setState({ step: "working", text: trust ? "Trusting the folder…" : "Starting Remote Control…" });
    try {
      const result = await api.handOff(id, dir, settings, trust);
      setState(result.status === "trust" ? { step: "trust" } : { step: "done", url: result.url });
    } catch (err) {
      setState({ step: "error", message: String((err as Error).message ?? err) });
    }
  };

  const cancelTrust = async () => {
    await api.cancelHandOff(id).catch(() => {});
    onDone();
  };

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-label="Hand off to Remote Control">
        <div className="dialog-title">Hand off to Remote Control</div>
        {state.step === "confirm" && (
          <>
            <div className="dialog-body">
              Agent Commander ends its own process for this session and reopens it in Claude Code, running in the background
              (<code>tmux attach -t agent-commander</code>) with Remote Control on. You can then continue it from claude.ai
              or the phone app; here it becomes read-only until you close it there.
            </div>
            <div className="dialog-actions">
              <button className="text-button" onClick={onDone}>
                Cancel
              </button>
              <button className="secondary-button" onClick={() => run(false)}>
                Hand off
              </button>
            </div>
          </>
        )}
        {state.step === "working" && <div className="dialog-body">{state.text}</div>}
        {state.step === "trust" && (
          <>
            <div className="dialog-body">
              Claude Code is asking whether you trust <code>{folder}</code>. If you do, it will be able to read, edit and run
              commands there. It remembers the answer for this folder.
            </div>
            <div className="dialog-actions">
              <button className="text-button" onClick={cancelTrust}>
                Cancel
              </button>
              <button className="secondary-button" onClick={() => run(true)}>
                Trust this folder
              </button>
            </div>
          </>
        )}
        {state.step === "done" && (
          <>
            <div className="dialog-body">
              Remote Control is on.{" "}
              <a href={state.url} target="_blank" rel="noreferrer">
                Open it on claude.ai
              </a>
            </div>
            <div className="dialog-actions">
              <button className="secondary-button" onClick={onDone}>
                Done
              </button>
            </div>
          </>
        )}
        {state.step === "error" && (
          <>
            <div className="dialog-error">{state.message}</div>
            <div className="dialog-actions">
              <button className="secondary-button" onClick={onDone}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

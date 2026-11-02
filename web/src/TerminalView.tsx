import { MainTabs, type MainTab } from "./MainTabs.tsx";
import { TerminalPane } from "./TerminalPane.tsx";
import { tildePath } from "./format.ts";

interface Props {
  dirs: string[]; // folders with a shell open; each stays connected while hidden
  dir: string | null; // the folder shown
  active: boolean; // the Terminal tab is showing
  home?: string;
  hostname?: string;
  onTab: (tab: MainTab) => void;
  onClose: (dir: string) => void;
}

// The middle column's Terminal tab: one shell per project folder.
export function TerminalView({ dirs, dir, active, home, hostname, onTab, onClose }: Props) {
  return (
    <main className="chat terminal-view" hidden={!active}>
      <header className="chat-header">
        <div className="chat-title">
          <div className="chat-title-main" title={dir ? `${hostname ? hostname + " · " : ""}${tildePath(dir, home)}` : undefined}>
            <span className="chat-title-text">{dir ? `Terminal · ${dir.split("/").filter(Boolean).pop() ?? "/"}` : "Terminal"}</span>
          </div>
        </div>
        <MainTabs tab="terminal" onTab={onTab} />
        {dir && (
          <button className="icon-button" title="Close this folder's shell" aria-label="Close shell" onClick={() => onClose(dir)}>
            ✕
          </button>
        )}
      </header>
      <div className="terminal-area">
        {dirs.map((d) => (
          <TerminalPane key={d} dir={d} active={active && d === dir} />
        ))}
      </div>
    </main>
  );
}

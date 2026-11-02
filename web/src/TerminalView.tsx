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
          <div className="chat-title-main">
            <span className="chat-title-text">Terminal</span>
          </div>
          {dir && (
            <div className="chat-title-sub">
              {hostname && <>{hostname} · </>}
              {tildePath(dir, home)}
            </div>
          )}
        </div>
        {dir && (
          <button className="secondary-button" title="End this folder's shell" onClick={() => onClose(dir)}>
            Close shell
          </button>
        )}
        <MainTabs tab="terminal" onTab={onTab} />
      </header>
      <div className="terminal-area">
        {dirs.map((d) => (
          <TerminalPane key={d} dir={d} active={active && d === dir} />
        ))}
      </div>
    </main>
  );
}

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// xterm's colours follow the app's theme tokens (and change with the toggle).
function themeColours() {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string) => css.getPropertyValue(name).trim();
  const light = document.documentElement.dataset.theme === "light";
  return {
    background: get("--code-bg") || (light ? "#f6f6f8" : "#0b0c0e"),
    foreground: get("--text"),
    cursor: get("--accent"),
    selectionBackground: light ? "#c9d4f0" : "#3a4260",
  };
}

interface Props {
  dir: string;
  active: boolean; // shown right now (hidden terminals stay connected)
}

// One shell in a project folder, over a WebSocket to the server's pty. It stays
// mounted (and so alive) while another tab is showing; unmounting ends it.
export function TerminalPane({ dir, active }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [ended, setEnded] = useState(false);
  const [run, setRun] = useState(0); // bumped to start a new shell

  useEffect(() => {
    const el = box.current!;
    const t = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono") || "monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: themeColours(),
    });
    const fitAddon = new FitAddon();
    t.loadAddon(fitAddon);
    t.open(el);
    fitAddon.fit();
    term.current = t;
    fit.current = fitAddon;
    setEnded(false);

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/terminal?dir=${encodeURIComponent(dir)}&cols=${t.cols}&rows=${t.rows}`);
    const send = (msg: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
    ws.onmessage = (e) => t.write(String(e.data));
    ws.onclose = () => {
      t.write("\r\n\x1b[2m[disconnected]\x1b[0m\r\n");
      setEnded(true);
    };
    t.onData((d) => send({ t: "i", d }));
    t.onResize(({ cols, rows }) => send({ t: "r", c: cols, r: rows }));

    // Refit when the column changes size; a hidden pane has no size.
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) fitAddon.fit();
    });
    observer.observe(el);

    const themeObserver = new MutationObserver(() => (t.options.theme = themeColours()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      ws.close();
      t.dispose();
    };
  }, [dir, run]);

  // Back on screen: size it and give it the keyboard.
  useEffect(() => {
    if (!active) return;
    fit.current?.fit();
    term.current?.focus();
  }, [active]);

  return (
    <div className="terminal-pane" hidden={!active}>
      <div className="terminal-box" ref={box} />
      {ended && (
        <button className="secondary-button terminal-restart" onClick={() => setRun((n) => n + 1)}>
          Start a new shell
        </button>
      )}
    </div>
  );
}

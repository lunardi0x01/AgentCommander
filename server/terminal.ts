// A shell in the browser: a WebSocket per terminal, wired to a pty running the
// user's login shell in a project folder. Its main use is commands that need a
// real terminal (sudo asks for a password, which Claude can't type).
//
// Protocol on /api/terminal?dir=<folder>&cols=&rows=:
//   browser → server: JSON {t:"i",d:"keys typed"} or {t:"r",c:cols,r:rows}
//   server → browser: the shell's output as text frames
// ...&sid=<random id>: reconnecting with the same sid reattaches to the shell
// (kept 2 min after the socket drops) and replays its recent output.
// Close code 4000 means the shell is gone; any other close is worth retrying.

import type http from "node:http";
import type { Duplex } from "node:stream";
import os from "node:os";
import * as pty from "node-pty";
import { WebSocketServer, type WebSocket } from "ws";
import { check } from "./auth.ts";
import { loadConfig } from "./config.ts";

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

// The shell shouldn't inherit the server's own settings: NODE_ENV=production
// would make `npm install` skip dev dependencies, for one.
const SHELL_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(NODE_ENV|PORT|HOST|AGENT_COMMANDER_.*|CLAUDE_PATH|ANTHROPIC_.*|CLAUDECODE|CLAUDE_CODE_.*)$/.test(key)),
) as Record<string, string>;

const PING_MS = 30_000;
const clamp = (n: unknown, fallback: number, max: number) => (Number.isInteger(n) && (n as number) > 0 ? Math.min(n as number, max) : fallback);

function refuse(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

// Called for every upgrade request; only /api/terminal is ours.
export async function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/terminal") return void socket.destroy();

  // A WebSocket isn't covered by the JSON-only rule for POSTs, and browsers
  // always send Origin on one, so it must be our own page.
  const origin = req.headers.origin;
  if (!origin || URL.parse(origin)?.host !== req.headers.host) return refuse(socket, 403, "Forbidden");
  const denied = await check(req);
  if (denied) return refuse(socket, denied.status, denied.message);

  const config = await loadConfig();
  if (config.settings.terminalEnabled !== true) return refuse(socket, 403, "Terminal is turned off");
  const dir = url.searchParams.get("dir") ?? "";
  if (!config.folders.includes(dir)) return refuse(socket, 400, "Not a project folder");

  wss.handleUpgrade(req, socket, head, (ws) => run(ws, dir, clamp(Number(url.searchParams.get("cols")), 80, 500), clamp(Number(url.searchParams.get("rows")), 24, 200), /^[\w-]{8,64}$/.test(url.searchParams.get("sid") ?? "") ? url.searchParams.get("sid")! : ""));
}

// A shell outlives its socket for a while, so a screen lock or Wi-Fi switch on
// a phone doesn't kill a running install. The browser reattaches with its sid.
interface Shell {
  term: pty.IPty;
  ws: WebSocket | null;
  scrollback: string;
  grace: NodeJS.Timeout | null;
  cols: number;
  rows: number;
}
const shells = new Map<string, Shell>();
const MAX_SHELLS = 8;
const GRACE_MS = 2 * 60_000;
const SCROLLBACK_BYTES = 256 * 1024;
const HIGH_WATER = 1024 * 1024; // pause the pty above this much unsent output
const LOW_WATER = 256 * 1024;

function spawnShell(dir: string, cols: number, rows: number): Shell | string {
  if (shells.size >= MAX_SHELLS) return `Too many terminals open (${MAX_SHELLS})`;
  const shell = process.env.SHELL || os.userInfo().shell || "bash";
  try {
    const term = pty.spawn(shell, ["-l"], { name: "xterm-256color", cols, rows, cwd: dir, env: { ...SHELL_ENV, TERM: "xterm-256color", COLORTERM: "truecolor" } });
    console.log(`Terminal: ${shell} in ${dir} (pid ${term.pid})`);
    return { term, ws: null, scrollback: "", grace: null, cols, rows };
  } catch (err) {
    return `Couldn't start a shell: ${(err as Error).message}`;
  }
}

function run(ws: WebSocket, dir: string, cols: number, rows: number, sid: string): void {
  // Without this a socket error (bad frame, payload over the limit) would be
  // an uncaught exception and take the server down.
  ws.on("error", () => ws.terminate());

  let id = sid;
  let sh = shells.get(id);
  const reattached = !!sh;
  if (sh) {
    if (sh.grace) clearTimeout(sh.grace);
    sh.grace = null;
    sh.ws?.terminate(); // a stale socket for the same shell
    sh.term.resize(cols, rows);
  } else {
    const made = spawnShell(dir, cols, rows);
    if (typeof made === "string") {
      ws.send(`\r\n${made}\r\n`);
      return ws.close(4000);
    }
    sh = made;
    if (!id) id = `anon-${sh.term.pid}`;
    shells.set(id, sh);
    const created = sh;
    created.term.onData((data) => {
      created.scrollback += data;
      if (created.scrollback.length > SCROLLBACK_BYTES) created.scrollback = created.scrollback.slice(-SCROLLBACK_BYTES);
      const sock = created.ws;
      if (!sock || sock.readyState !== sock.OPEN) return;
      sock.send(data);
      // Flow control: stop reading the shell while the socket is backed up.
      if (sock.bufferedAmount > HIGH_WATER) {
        created.term.pause();
        const poll = setInterval(() => {
          if (!created.ws || created.ws.readyState !== created.ws.OPEN || created.ws.bufferedAmount < LOW_WATER) {
            clearInterval(poll);
            created.term.resume();
          }
        }, 50);
      }
    });
    created.term.onExit(() => {
      shells.delete(id);
      if (created.grace) clearTimeout(created.grace);
      if (created.ws?.readyState === created.ws?.OPEN) created.ws?.send("\r\n[shell ended]\r\n");
      created.ws?.close(4000);
    });
  }
  const mine = sh;
  mine.ws = ws;
  if (reattached && mine.scrollback) ws.send(mine.scrollback);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.t === "i" && typeof msg.d === "string") mine.term.write(msg.d);
      else if (msg.t === "x") mine.term.kill(); // the page closed the terminal on purpose
      else if (msg.t === "r") mine.term.resize(clamp(msg.c, cols, 500), clamp(msg.r, rows, 200));
    } catch {
      // not ours; ignore
    }
  });

  // Drop sockets whose browser vanished without closing them.
  let alive = true;
  ws.on("pong", () => (alive = true));
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, PING_MS);

  ws.on("close", () => {
    clearInterval(ping);
    if (mine.ws !== ws) return; // already reattached elsewhere
    mine.ws = null;
    mine.term.resume();
    // Keep the shell for a while in case the browser comes back.
    mine.grace = setTimeout(() => {
      shells.delete(id);
      mine.term.kill();
    }, GRACE_MS);
  });
}

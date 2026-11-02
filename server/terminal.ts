// A shell in the browser: a WebSocket per terminal, wired to a pty running the
// user's login shell in a project folder. Its main use is commands that need a
// real terminal (sudo asks for a password, which Claude can't type).
//
// Protocol on /api/terminal?dir=<folder>&cols=&rows=:
//   browser → server: JSON {t:"i",d:"keys typed"} or {t:"r",c:cols,r:rows}
//   server → browser: the shell's output as text frames
// The shell lives exactly as long as the socket: closing the page ends it.

import type http from "node:http";
import type { Duplex } from "node:stream";
import os from "node:os";
import * as pty from "node-pty";
import { WebSocketServer, type WebSocket } from "ws";
import { check } from "./auth.ts";
import { loadConfig } from "./config.ts";

const wss = new WebSocketServer({ noServer: true });

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
  if (config.settings.terminalEnabled === false) return refuse(socket, 403, "Terminal is turned off");
  const dir = url.searchParams.get("dir") ?? "";
  if (!config.folders.includes(dir)) return refuse(socket, 400, "Not a project folder");

  wss.handleUpgrade(req, socket, head, (ws) => run(ws, dir, clamp(Number(url.searchParams.get("cols")), 80, 500), clamp(Number(url.searchParams.get("rows")), 24, 200)));
}

function run(ws: WebSocket, dir: string, cols: number, rows: number): void {
  const shell = process.env.SHELL || os.userInfo().shell || "bash";
  let term: pty.IPty;
  try {
    term = pty.spawn(shell, ["-l"], { name: "xterm-256color", cols, rows, cwd: dir, env: { ...SHELL_ENV, TERM: "xterm-256color", COLORTERM: "truecolor" } });
  } catch (err) {
    ws.send(`\r\nCouldn't start a shell: ${(err as Error).message}\r\n`);
    return ws.close();
  }
  console.log(`Terminal: ${shell} in ${dir} (pid ${term.pid})`);

  term.onData((data) => ws.readyState === ws.OPEN && ws.send(data));
  term.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.send("\r\n[shell ended]\r\n");
    ws.close();
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.t === "i" && typeof msg.d === "string") term.write(msg.d);
      else if (msg.t === "r") term.resize(clamp(msg.c, cols, 500), clamp(msg.r, rows, 200));
    } catch {
      // not ours; ignore
    }
  });

  // Drop shells whose browser vanished without closing the socket.
  let alive = true;
  ws.on("pong", () => (alive = true));
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, PING_MS);

  ws.on("close", () => {
    clearInterval(ping);
    term.kill();
  });
}

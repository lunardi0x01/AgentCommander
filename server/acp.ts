// A connection to Google Antigravity's ACP server (agy_acp_server): JSON-RPC
// over the child's stdio, one message per line. Used to replay a session's
// history and to run Gemini sessions (gemini-run.ts).

import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";

// The server binary: AGY_ACP_SERVER, else the newest we installed, else the
// newest Zed installed.
export async function serverBinary(): Promise<string> {
  if (process.env.AGY_ACP_SERVER) return process.env.AGY_ACP_SERVER;
  const candidates: Array<[string, string]> = [
    [path.join(os.homedir(), ".local/share/agent-commander/agy-acp"), "bin/agy_acp_server.par"],
    [path.join(os.homedir(), ".local/share/zed/external_agents/registry/antigravity-acp"), "agy_acp_server.par"],
  ];
  for (const [dir, rel] of candidates) {
    const versions = (await readdir(dir).catch(() => [] as string[])).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const v of versions.reverse()) if (existsSync(path.join(dir, v, rel))) return path.join(dir, v, rel);
  }
  throw new Error("Antigravity's ACP server isn't installed");
}

export class AcpError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

interface Message {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface AcpHandlers {
  // session/update notifications.
  onUpdate?: (sessionId: string, update: Record<string, unknown>) => void;
  // Requests from the agent (session/request_permission); the result is sent back.
  onRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  // The process is gone: closed by us (error undefined) or crashed.
  onExit?: (error?: string) => void;
}

export class AcpConnection {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private closed = false;
  private handlers: AcpHandlers;

  private constructor(child: ChildProcess, handlers: AcpHandlers) {
    this.child = child;
    this.handlers = handlers;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.read(chunk));
    child.on("error", (err) => this.end(err.message));
    child.on("exit", (code, signal) => this.end(`The Antigravity ACP server exited (${signal ?? code})`));
    child.stdin!.on("error", () => {}); // the exit handler reports it
  }

  // Starts the server under the systemd user manager: a parent with
  // RLIMIT_RTTIME=0 (Zed sets it; anything started from Zed inherits it) gets
  // the server SIGKILLed at startup. Then initializes the connection.
  static async open(cwd: string, handlers: AcpHandlers = {}): Promise<AcpConnection> {
    const server = await serverBinary();
    const child = spawn("systemd-run", ["--user", "--pipe", "--quiet", "--collect", `--working-directory=${cwd}`, "--", server, "--uid="], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const conn = new AcpConnection(child, handlers);
    await conn.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    return conn;
  }

  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new AcpError("The Antigravity ACP server isn't running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin?.end(); // let it exit cleanly first
    } catch {}
    this.child.kill();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private write(message: Message): void {
    this.child.stdin!.write(JSON.stringify(message) + "\n");
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    for (let n; (n = this.buffer.indexOf("\n")) >= 0; ) {
      const line = this.buffer.slice(0, n).trim();
      this.buffer = this.buffer.slice(n + 1);
      if (!line) continue;
      let m: Message;
      try {
        m = JSON.parse(line);
      } catch {
        continue; // not protocol output
      }
      this.dispatch(m);
    }
  }

  private dispatch(m: Message): void {
    if (m.method && m.id !== undefined) {
      // A request from the agent.
      const id = m.id;
      const handle = this.handlers.onRequest ?? (async () => ({}));
      handle(m.method, m.params ?? {}).then(
        (result) => !this.closed && this.write({ jsonrpc: "2.0", id, result }),
        (err) => !this.closed && this.write({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err?.message ?? err) } } as Message),
      );
    } else if (m.method) {
      if (m.method === "session/update" && m.params) {
        this.handlers.onUpdate?.(String(m.params.sessionId), (m.params.update ?? {}) as Record<string, unknown>);
      }
    } else if (typeof m.id === "number" && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      if (m.error) p.reject(new AcpError(m.error.message ?? "ACP request failed", m.error.code));
      else p.resolve(m.result);
    }
  }

  private end(error: string): void {
    const byUs = this.closed;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new AcpError(error));
    this.pending.clear();
    const onExit = this.handlers.onExit;
    this.handlers.onExit = undefined; // once
    onExit?.(byUs ? undefined : error);
  }
}

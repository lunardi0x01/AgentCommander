// Who may use the API.
//
// The server listens on loopback only. Browsers arrive through `tailscale
// serve`, which adds a Tailscale-User-Login header (and strips any the client
// sent), so a request is allowed when that login is on the allowlist. Direct
// requests on this machine (loopback Host) are allowed too. Anything else,
// such as scripts, needs the token as `Authorization: Bearer`.

import type http from "node:http";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type { AccessInfo } from "../shared/types.ts";
import { CONFIG_DIR, loadConfig, setLogins } from "./config.ts";

const TOKEN_FILE = path.join(CONFIG_DIR, "token");
const TOKEN_FROM_ENV = !!process.env.AGENT_COMMANDER_TOKEN;
let token = process.env.AGENT_COMMANDER_TOKEN || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "");

export const hasToken = () => !!token;

export function isLoopback(host: string | undefined): boolean {
  return !!host && (host === "localhost" || host === "::1" || /^(::ffff:)?127\./.test(host));
}

const hostname = (hostHeader: string) => hostHeader.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");

function tokenMatches(candidate: string | undefined): boolean {
  if (!candidate || !token) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// With no allowlist yet, allow the Tailscale account this machine is signed in to.
export async function initAccess(): Promise<void> {
  if ((await loadConfig()).logins.length) return;
  try {
    const { stdout } = await promisify(execFile)("tailscale", ["status", "--json"], { encoding: "utf8" });
    const status = JSON.parse(stdout);
    const login = status.User?.[status.Self?.UserID]?.LoginName;
    if (login) await setLogins([login]);
    else console.warn("Access: couldn't find this machine's Tailscale login; browsers can't sign in until config.json has logins.");
  } catch {
    console.warn("Access: Tailscale isn't available; only this machine and the token can reach the API.");
  }
}

export interface Auth {
  via: AccessInfo["via"];
  login?: string;
}

const authOf = new WeakMap<http.IncomingMessage, Auth>();
export const requestAuth = (req: http.IncomingMessage): Auth => authOf.get(req) ?? { via: "local" };

// Blocks other websites open in the same browser from using the API:
// state-changing requests must come from our own origin, as JSON.
function sameSite(req: http.IncomingMessage): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.origin;
  if (origin && URL.parse(origin)?.host !== req.headers.host) return false;
  return req.method === "DELETE" || (req.headers["content-type"] ?? "").startsWith("application/json");
}

// The reason a request is refused, or null when it may proceed.
export async function check(req: http.IncomingMessage): Promise<{ status: number; message: string } | null> {
  if (!sameSite(req)) return { status: 403, message: "Forbidden" };

  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (tokenMatches(bearer)) {
    authOf.set(req, { via: "token" });
    return null;
  }

  // Only trust the proxy's header when the request came from this machine;
  // with a wider listen address anyone could send it.
  if (!isLoopback(req.socket.remoteAddress)) return { status: 401, message: "Unauthorized" };
  const login = req.headers["tailscale-user-login"];
  if (typeof login === "string" && login) {
    if (!(await loadConfig()).logins.includes(login)) return { status: 403, message: `${login} isn't allowed to use Agent Commander` };
    authOf.set(req, { via: "tailscale", login });
    return null;
  }
  // Opened on this machine. A rebinding attack arrives with its own Host.
  if (isLoopback(hostname(req.headers.host ?? ""))) {
    authOf.set(req, { via: "local" });
    return null;
  }
  return { status: 401, message: "Unauthorized" };
}

export async function accessInfo(req: http.IncomingMessage): Promise<AccessInfo> {
  const { via, login } = requestAuth(req);
  return {
    via,
    login,
    logins: (await loadConfig()).logins,
    token: token ? (TOKEN_FROM_ENV ? "env" : "file") : "none",
  };
}

// A fresh token for scripts. Returned once; only the file's copy is kept.
export async function rotateToken(): Promise<string | null> {
  if (TOKEN_FROM_ENV) return null;
  const next = randomBytes(32).toString("hex");
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, next + "\n", { mode: 0o600 });
  await chmod(TOKEN_FILE, 0o600);
  token = next;
  return next;
}

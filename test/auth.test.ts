import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type http from "node:http";

const TOKEN = "s3cret-token";
let tmp: string;
let auth: typeof import("../server/auth.ts");

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "ac-auth-"));
  await mkdir(path.join(tmp, "agent-commander"));
  await writeFile(path.join(tmp, "agent-commander", "config.json"), JSON.stringify({ logins: ["me@example.com"] }));
  process.env.XDG_CONFIG_HOME = tmp; // never touch the real config
  process.env.AGENT_COMMANDER_TOKEN = TOKEN;
  auth = await import("../server/auth.ts");
});
after(() => rm(tmp, { recursive: true, force: true }));

function req(o: { method?: string; remote?: string; url?: string; headers?: Record<string, string> }): http.IncomingMessage {
  return { method: o.method ?? "GET", url: o.url ?? "/", headers: o.headers ?? {}, socket: { remoteAddress: o.remote ?? "127.0.0.1" } } as unknown as http.IncomingMessage;
}

test("isLoopback", () => {
  for (const h of ["localhost", "::1", "127.0.0.1", "::ffff:127.0.0.1"]) assert.ok(auth.isLoopback(h), h);
  for (const h of ["10.0.0.1", "example.com", "", undefined, "127evil.com"]) assert.ok(!auth.isLoopback(h as string), String(h));
});

test("local Host on loopback is allowed", async () => {
  const r = req({ headers: { host: "localhost:4317" } });
  assert.equal(await auth.check(r), null);
  assert.equal(auth.requestAuth(r).via, "local");
  assert.equal(await auth.check(req({ headers: { host: "[::1]:4317" } })), null);
});

test("a non-local Host with no credentials is rejected (DNS rebinding)", async () => {
  assert.equal((await auth.check(req({ headers: { host: "evil.example.com" } })))?.status, 401);
});

test("tailscale login: allowlisted ok, others 403, ignored from non-loopback peers", async () => {
  const ok = req({ headers: { host: "box.ts.net", "tailscale-user-login": "me@example.com", "sec-fetch-site": "same-origin" } });
  assert.equal(await auth.check(ok), null);
  assert.deepEqual(auth.requestAuth(ok), { via: "tailscale", login: "me@example.com" });
  assert.equal((await auth.check(req({ headers: { host: "box.ts.net", "tailscale-user-login": "x@example.com", "sec-fetch-site": "same-origin" } })))?.status, 403);
  // A script (no Fetch Metadata) can't ride on the proxy's identity header.
  assert.equal((await auth.check(req({ headers: { host: "box.ts.net", "tailscale-user-login": "me@example.com" } })))?.status, 401);
  const spoof = req({ remote: "100.64.0.9", headers: { host: "localhost", "tailscale-user-login": "me@example.com" } });
  assert.equal((await auth.check(spoof))?.status, 401);
});

test("bearer token works from anywhere; wrong or malformed token does not", async () => {
  const good = req({ remote: "100.64.0.9", headers: { host: "x", authorization: `Bearer ${TOKEN}` } });
  assert.equal(await auth.check(good), null);
  assert.equal(auth.requestAuth(good).via, "token");
  for (const a of ["Bearer wrong", `Bearer ${TOKEN}x`, `bearer ${TOKEN}`, TOKEN, "Bearer "]) {
    assert.equal((await auth.check(req({ remote: "100.64.0.9", headers: { host: "x", authorization: a } })))?.status, 401, a);
  }
});

test("state-changing requests need same origin and JSON", async () => {
  const base = { host: "localhost:4317" };
  assert.equal((await auth.check(req({ method: "POST", headers: { ...base, "content-type": "text/plain" } })))?.status, 403);
  assert.equal((await auth.check(req({ method: "POST", headers: { ...base } })))?.status, 403);
  assert.equal(await auth.check(req({ method: "POST", headers: { ...base, "content-type": "application/json" } })), null);
  assert.equal(await auth.check(req({ method: "POST", headers: { ...base, "content-type": "application/json; charset=utf-8", origin: "http://localhost:4317" } })), null);
  assert.equal((await auth.check(req({ method: "POST", headers: { ...base, "content-type": "application/json", origin: "https://evil.com" } })))?.status, 403);
  assert.equal(await auth.check(req({ method: "DELETE", headers: base })), null);
  assert.equal((await auth.check(req({ method: "DELETE", headers: { ...base, origin: "https://evil.com" } })))?.status, 403);
});

test("cross-site requests are refused, except a link click to the app shell", async () => {
  const h = { host: "localhost:4317", "sec-fetch-site": "cross-site" };
  assert.equal((await auth.check(req({ headers: h, url: "/api/usage" })))?.status, 403);
  assert.equal((await auth.check(req({ headers: { ...h, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }, url: "/api/usage" })))?.status, 403);
  assert.equal(await auth.check(req({ headers: { ...h, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }, url: "/" })), null);
});

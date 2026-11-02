// Agent Commander server: JSON API under /api, and the built web UI.
//
// Config (environment variables):
//   HOST                   listen address, default 127.0.0.1
//   PORT                   listen port, default 4317
//   AGENT_COMMANDER_TOKEN  token for scripts (Authorization: Bearer); required when
//                          HOST is not loopback. Falls back to the file
//                          ~/.config/agent-commander/token. Browsers are let in
//                          by their Tailscale login instead (see auth.ts).

import http from "node:http";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { handleApi, sendJson } from "./api.ts";
import { sendBody } from "./compress.ts";
import { check, hasToken, initAccess, isLoopback } from "./auth.ts";
import { startWatching } from "./events.ts";
import { closeAllRuns } from "./runner.ts";
import { startQueue } from "./queue.ts";
import { startNotifications } from "./notify.ts";
import { handleUpgrade } from "./terminal.ts";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4317);
const WEB_DIST = path.resolve(import.meta.dirname, "../web/dist");

if (!isLoopback(HOST) && !hasToken()) {
  console.error(`Refusing to listen on ${HOST} without AGENT_COMMANDER_TOKEN set.`);
  process.exit(1);
}

// --- static files -----------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
  if (!existsSync(WEB_DIST)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("Web UI not built. Run `npm run build`, or use `npm run dev` and open the Vite URL.\n");
    return;
  }
  let file = path.join(WEB_DIST, path.normalize(decodeURIComponent(pathname)));
  if (!file.startsWith(WEB_DIST)) file = WEB_DIST;
  const isFile = await stat(file).then((s) => s.isFile(), () => false);
  if (!isFile) file = path.join(WEB_DIST, "index.html"); // client-side routes

  const ext = path.extname(file);
  await sendBody(
    res,
    200,
    {
      "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      // Vite puts content hashes in asset names, so those can be cached forever.
      "cache-control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
    },
    await readFile(file),
  );
}

// --- server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    const denied = await check(req);
    if (denied) {
      if (url.pathname.startsWith("/api/")) return void (await sendJson(res, denied.status, { error: denied.message }));
      res.writeHead(denied.status, { "content-type": "text/plain; charset=utf-8" });
      return void res.end(`${denied.message}.\n`);
    }
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
  }
});

server.on("upgrade", (req, socket, head) => {
  handleUpgrade(req, socket, head).catch((err) => {
    console.error(err);
    socket.destroy();
  });
});

// Stop the Claude processes we run along with the server.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    closeAllRuns();
    process.exit(0);
  });
}

await initAccess();
startWatching();
startNotifications();
startQueue().catch((err) => console.error("Queue:", err));
server.listen(PORT, HOST, () => {
  const shownHost = HOST.includes(":") ? `[${HOST}]` : HOST;
  console.log(`Agent Commander listening on http://${shownHost}:${PORT}`);
});

// `npm run restart`: asks the running server (under systemd) to restart as
// soon as no session is busy, so a deploy never cuts a turn short. The
// server exits and systemd starts it again with the new code.

import { readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./config.ts";

const PORT = process.env.PORT || 4317;
let token = process.env.AGENT_COMMANDER_TOKEN || "";
try {
  token ||= readFileSync(path.join(CONFIG_DIR, "token"), "utf8").trim();
} catch {}

const res = await fetch(`http://127.0.0.1:${PORT}/api/admin/restart`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: "{}",
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Restart refused (${res.status}): ${body.error ?? res.statusText}`);
  process.exit(1);
}
console.log(body.busy ? `Restart scheduled: waiting for ${body.busy} busy session(s) to finish.` : "Restarting now.");

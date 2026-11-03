// Desktop notifications on this computer (notify-send, so Omarchy's mako shows
// them): a session finished its turn, or is waiting for you. Driven by the
// same run updates the UI gets, so it works with no page open and covers
// Claude, Gemini and queued tasks alike.

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { getSettings } from "./config.ts";
import { onRunChange } from "./runner.ts";
import { sessionLabel } from "./sessions.ts";
import type { RunState } from "../shared/types.ts";

type Status = RunState["status"];
const ACTIVE: Status[] = ["working", "waiting"];

// Per run: its last status and when the current turn began.
const turns = new Map<string, { status: Status; since: number }>();

// The user service may lack the session bus address; it is at a fixed path.
const ENV = {
  ...process.env,
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${os.userInfo().uid}/bus`,
};
let warned = false;

function show(summary: string, body: string): void {
  console.log(`Notification: ${summary}`);
  execFile("notify-send", ["--app-name=Agent Commander", "--expire-time=10000", "--", summary, body], { env: ENV }, (err) => {
    if (err && !warned) {
      warned = true;
      console.warn(`Notifications: notify-send failed (${err.message.split("\n")[0]}); is it installed and a notification daemon running?`);
    }
  });
}

async function notify(id: string, kind: "done" | "needs-you", run: RunState): Promise<void> {
  const label = await sessionLabel(id).catch(() => null);
  const title = label?.title ?? "A session";
  const folder = label ? path.basename(label.dir) || label.dir : "";
  if (kind === "needs-you") {
    const tool = run.permissions[0]?.toolName;
    const what = tool === "ExitPlanMode" ? "A plan is ready to approve" : tool === "AskUserQuestion" ? "Has a question" : tool ? `Wants to use ${tool}` : "Needs your input";
    show(`Needs you: ${title}`, [what, folder].filter(Boolean).join(" · "));
  } else if (run.status === "error") {
    show(`Stopped: ${title}`, [run.error?.slice(0, 120), folder].filter(Boolean).join(" · "));
  } else {
    show(`Finished: ${title}`, folder);
  }
}

export function startNotifications(): void {
  onRunChange((id, run) => {
    if (run?.status === "error") setTimeout(() => turns.get(id)?.status === "error" && turns.delete(id), 60_000).unref();
    if (!run) return void turns.delete(id);
    const prev = turns.get(id);
    if (prev?.status === run.status) return; // draft updates arrive constantly
    const now = Date.now();
    const wasActive = !!prev && ACTIVE.includes(prev.status);
    turns.set(id, { status: run.status, since: ACTIVE.includes(run.status) && !wasActive ? now : (prev?.since ?? now) });
    // An errored run never emits null; its "since" is only needed for this check.

    if (run.status === "waiting") {
      getSettings().then((s) => void (s.notifyNeedsYou && notify(id, "needs-you", run))).catch(() => {});
    } else if ((run.status === "idle" || run.status === "error") && wasActive) {
      const seconds = (now - prev!.since) / 1000;
      getSettings()
        .then((s) => {
          const send = s.notifyDone && (run.status === "error" || seconds >= s.notifyMinSeconds);
          // Logged so "why no notification?" can be answered from the journal.
          if (!send) console.log(`Notification skipped: turn took ${Math.round(seconds)}s (${s.notifyDone ? `minimum ${s.notifyMinSeconds}s` : "off"})`);
          else void notify(id, "done", run);
        })
        .catch(() => {});
    }
  });
}

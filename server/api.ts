// JSON API routes. The UI only ever talks to the server through these.

import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MachineInfo, MessagesPage } from "../shared/types.ts";
import { BadAttachment, MAX_MESSAGE_BYTES, messageContent, parseAttachments } from "./attachments.ts";
import { sendBody } from "./compress.ts";
import { answerPermission, applySettings, closeRun, getRun, interrupt, isRunning, restartWhenIdle, sendMessage } from "./runner.ts";
import { closeLiveProcess, liveSessions } from "./live.ts";
import { folderDefaults, listCommands } from "./commands.ts";
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  type AppSettings,
  type EffortLevel,
  type PermissionMode,
  type QueueTask,
  type SessionSettings,
} from "../shared/types.ts";
import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { geminiModels, isGeminiSession, sessionCwd } from "./gemini.ts";
import { GEMINI_MODES } from "./gemini-run.ts";
import { addFolder, getSettings, loadConfig, removeFolder, updateSettings } from "./config.ts";
import { BadDoc, listDocs, NotesConflict, readNotes, writeNotes } from "./notes.ts";
import { BadAudio, dictationAvailable, MAX_AUDIO_BYTES, transcribe } from "./dictation.ts";
import { speechAvailable, synthesize } from "./speech.ts";
import { getUsage } from "./usage.ts";
import { addTasks, clearFinished, getQueue, moveTask, removeTask, runNow, setPaused, splitTasks, updateTask } from "./queue.ts";
import { getTree, listFolderChoices, listFolders, listFolderSessions, readImage, readSession, renameSession } from "./sessions.ts";
import { deleteForever, listDeleted, restoreSessions, trashSessions } from "./trash.ts";
import { accessInfo, rotateToken } from "./auth.ts";
import { BrowseError, browse, makeFolder } from "./browse.ts";
import { createProject, listTemplates } from "./projects.ts";
import { handOff, HandoffError, killWindow } from "./handoff.ts";
import { handleEvents, notifyListChanged, watchNotes } from "./events.ts";

interface Request {
  req: IncomingMessage;
  url: URL;
  params: string[];
  body: Record<string, unknown>;
}

type Handler = (req: Request) => Promise<unknown>;

const SESSION_ID = "([0-9a-f-]{36})";

const routes: Array<{ method: string; pattern: RegExp; handler: Handler; maxBody?: number }> = [
  {
    method: "GET",
    pattern: /^\/api\/machine$/,
    handler: async (): Promise<MachineInfo> => ({
      hostname: os.hostname(),
      user: os.userInfo().username,
      home: os.homedir(),
    }),
  },

  // Chosen folders plus the sessions of the open ones (?open=<dir>, repeatable).
  { method: "GET", pattern: /^\/api\/tree$/, handler: ({ url }) => getTree(url.searchParams.getAll("open")) },

  // Folders shown in the navigator, and the picker that chooses them.
  { method: "GET", pattern: /^\/api\/folders$/, handler: () => listFolders() },
  { method: "GET", pattern: /^\/api\/folders\/choices$/, handler: () => listFolderChoices() },
  {
    method: "POST",
    pattern: /^\/api\/folders$/,
    handler: async ({ body }) => {
      await addFolder(absolutePath(body.path));
      notifyListChanged(); // other open pages show the new folder
      void watchNotes();
      return { ok: true };
    },
  },
  // Add-folder browser: confined to the projects root.
  { method: "GET", pattern: /^\/api\/fs$/, handler: ({ url }) => browsing(() => browse(url.searchParams.get("path"))) },
  {
    method: "POST",
    pattern: /^\/api\/fs\/mkdir$/,
    handler: ({ body }) => browsing(async () => ({ path: await makeFolder(body.parent, body.name) })),
  },
  // New Project: templates, and creating a project from one.
  { method: "GET", pattern: /^\/api\/templates$/, handler: () => listTemplates() },
  {
    method: "POST",
    pattern: /^\/api\/projects$/,
    handler: ({ body }) =>
      browsing(async () => {
        const result = await createProject(body as never);
        notifyListChanged();
        void watchNotes();
        return result;
      }),
  },
  {
    method: "DELETE",
    pattern: /^\/api\/folders$/,
    handler: async ({ url }) => {
      await removeFolder(absolutePath(url.searchParams.get("path")));
      notifyListChanged();
      void watchNotes();
      return { ok: true };
    },
  },

  // Who is signed in, and the token for scripts.
  { method: "GET", pattern: /^\/api\/access$/, handler: ({ req }) => accessInfo(req) },
  {
    method: "POST",
    pattern: /^\/api\/access\/rotate-token$/,
    handler: async () => {
      const token = await rotateToken();
      if (!token) throw new HttpError(409, "The token is set by AGENT_COMMANDER_TOKEN; change it there");
      return { token };
    },
  },

  // Sessions.
  {
    method: "GET",
    pattern: /^\/api\/sessions$/,
    handler: ({ url }) => listFolderSessions(requiredParam(url, "dir")),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/sessions/${SESSION_ID}/messages$`),
    // `from` skips messages the client already has; `total` tells it whether
    // the transcript shrank (e.g. compaction) and it should reload fully.
    handler: async ({ url, params: [id] }): Promise<MessagesPage> => {
      const all = await readSession(id, url.searchParams.get("dir") ?? undefined);
      const from = Math.min(Math.max(0, Number(url.searchParams.get("from")) || 0), all.length);
      return { total: all.length, from, messages: all.slice(from) };
    },
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/api/sessions/${SESSION_ID}$`),
    handler: async ({ params: [id], body }) => {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) throw new HttpError(400, "Title must not be empty");
      const summary = await renameSession(id, absolutePath(body.dir), title);
      if (!summary) throw new HttpError(404, "Session not found");
      return summary;
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/sessions\/delete$/,
    handler: async ({ body }) => {
      if (!Array.isArray(body.sessions)) throw new HttpError(400, "Expected sessions: [{ id, dir }]");
      const items = body.sessions.map((s: { id?: unknown; dir?: unknown }) => ({
        id: sessionId(s?.id),
        dir: absolutePath(s?.dir),
      }));
      const result = await trashSessions(items);
      notifyListChanged();
      return result;
    },
  },

  // Slash commands available in a folder, for the composer's / menu.
  // ?backend=gemini: what agy offers over ACP.
  {
    method: "GET",
    pattern: /^\/api\/commands$/,
    handler: async ({ url }) =>
      url.searchParams.get("backend") === "gemini"
        ? [{ name: "plan", description: "Plan before acting: writes a plan for you to approve", argumentHint: "<task>" }]
        : listCommands(absolutePath(url.searchParams.get("dir"))),
  },
  // The defaults in a folder (permission mode, models), for sessions not running.
  {
    method: "GET",
    pattern: /^\/api\/folder-defaults$/,
    handler: async ({ url }) =>
      url.searchParams.get("backend") === "gemini"
        ? { permissionMode: "default", models: await geminiModels(), modes: GEMINI_MODES }
        : folderDefaults(absolutePath(url.searchParams.get("dir"))),
  },

  // Chatting: send a message (resuming the session), answer a permission
  // request, interrupt, and read the run's current state.
  {
    method: "GET",
    pattern: new RegExp(`^/api/sessions/${SESSION_ID}/run$`),
    handler: async ({ params: [id] }) => getRun(id),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/sessions/${SESSION_ID}/messages$`),
    maxBody: MAX_MESSAGE_BYTES, // attachments travel as base64
    handler: async ({ params: [id], body }) => {
      const dir = absolutePath(body.dir);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      let content: ReturnType<typeof messageContent>;
      try {
        const files = parseAttachments(body.attachments);
        if (!text && !files.length) throw new HttpError(400, "Message must not be empty");
        content = messageContent(text, files);
      } catch (err) {
        throw err instanceof BadAttachment ? new HttpError(400, err.message) : err;
      }
      let settings = sessionSettings(body);
      const isNew = body.new === true;
      const gemini = body.backend === "gemini" || (!isNew && isGeminiSession(id));
      if (gemini && !isRunning(id)) {
        // App defaults are Claude's; only a permission mode Gemini has carries over.
        const { defaultMode } = await getSettings();
        if (!settings.mode && defaultMode && GEMINI_MODES.includes(defaultMode)) settings = { ...settings, mode: defaultMode };
        if (!isNew && (!isGeminiSession(id) || (await sessionCwd(id)) !== dir)) throw new HttpError(404, "Session not found in this folder");
      } else if (!isRunning(id)) {
        // A run that starts takes the app's defaults for what wasn't picked.
        const defaults = await getSettings();
        settings = { mode: defaults.defaultMode, model: defaults.defaultModel, effort: defaults.defaultEffort, ...settings };
        // Two processes on one session would both write its transcript.
        if ((await liveSessions()).has(id)) {
          throw new HttpError(409, "This session is open in a terminal or Remote Control. Close it there to continue here.");
        }
        const info = await getSessionInfo(id, { dir });
        if (isNew && info) throw new HttpError(409, "A session with this id already exists");
        if (!isNew && (!info || info.cwd !== dir)) throw new HttpError(404, "Session not found in this folder");
      }
      const started = await sendMessage(id, dir, content, settings, isNew, gemini ? "gemini" : "claude");
      if (started !== id) notifyListChanged();
      return { ok: true, id: started };
    },
  },
  // Close a session's process: ours, or one open elsewhere (a terminal,
  // Remote Control) so it can be continued here.
  {
    method: "POST",
    pattern: new RegExp(`^/api/sessions/${SESSION_ID}/close$`),
    handler: async ({ params: [id] }) => {
      if (isRunning(id)) {
        closeRun(id);
        return { closed: "here" };
      }
      if (!(await closeLiveProcess(id))) throw new HttpError(409, "Couldn't close it: no matching Claude Code process, or it didn't exit");
      notifyListChanged();
      return { closed: "elsewhere" };
    },
  },
  // Hand a session off to Remote Control (a tmux window running the CLI).
  {
    method: "POST",
    pattern: new RegExp(`^/api/sessions/${SESSION_ID}/handoff$`),
    handler: async ({ params: [id], body }) => {
      const dir = absolutePath(body.dir);
      const trust = body.trust === true;
      if (isGeminiSession(id)) throw new HttpError(409, "Remote Control is for Claude sessions only");
      if (!trust) {
        if (getRun(id) && ["starting", "working", "waiting"].includes(getRun(id)!.status)) {
          throw new HttpError(409, "It is in the middle of a turn. Interrupt it or wait for it to finish.");
        }
        if ((await liveSessions()).has(id) && !isRunning(id)) throw new HttpError(409, "This session is already open in a terminal or Remote Control.");
        const info = await getSessionInfo(id, { dir });
        if (!info || info.cwd !== dir) throw new HttpError(404, "Session not found in this folder");
        // Two processes on one session would both write its transcript.
        closeRun(id);
        for (let i = 0; i < 50 && (await liveSessions()).has(id); i++) await new Promise((r) => setTimeout(r, 100));
        if ((await liveSessions()).has(id)) throw new HttpError(409, "Its Claude process didn't exit");
      }
      try {
        const result = await handOff(id, dir, sessionSettings(body), trust);
        notifyListChanged();
        return result;
      } catch (err) {
        throw err instanceof HandoffError ? new HttpError(err.status, err.message) : err;
      }
    },
  },
  // Give up on a handoff that is waiting for the trust answer.
  {
    method: "DELETE",
    pattern: new RegExp(`^/api/sessions/${SESSION_ID}/handoff$`),
    handler: async ({ params: [id] }) => {
      await killWindow(id);
      return { ok: true };
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/sessions/${SESSION_ID}/interrupt$`),
    handler: async ({ params: [id] }) => {
      if (!(await interrupt(id))) throw new HttpError(409, "Not running");
      return { ok: true };
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/sessions/${SESSION_ID}/permissions/([A-Za-z0-9_-]+)$`),
    handler: async ({ params: [id, toolUseId], body }) => {
      if (typeof body.allow !== "boolean") throw new HttpError(400, "Expected allow: boolean");
      const mode = body.mode === undefined ? undefined : permissionMode(body.mode);
      const answers = body.answers === undefined ? undefined : stringMap(body.answers);
      if (!answerPermission(id, toolUseId, body.allow, mode, answers)) throw new HttpError(404, "No such permission request");
      return { ok: true };
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/sessions/${SESSION_ID}/settings$`),
    handler: async ({ params: [id], body }) => ({ applied: await applySettings(id, sessionSettings(body)) }),
  },

  // App settings, shared by every device.
  { method: "GET", pattern: /^\/api\/settings$/, handler: () => getSettings() },
  { method: "POST", pattern: /^\/api\/settings$/, handler: ({ body }) => updateSettings(appSettings(body)) },

  // A project's documents (NOTES.md, README.md, docs/REFERENCE.md). Saving
  // sends the mtime it was loaded at; 409 if it changed since.
  { method: "GET", pattern: /^\/api\/notes\/files$/, handler: async ({ url }) => listDocs(await chosenFolder(url.searchParams.get("dir"))) },
  {
    method: "GET",
    pattern: /^\/api\/notes$/,
    handler: async ({ url }) => {
      const dir = await chosenFolder(url.searchParams.get("dir"));
      try {
        return await readNotes(dir, url.searchParams.get("file") ?? undefined);
      } catch (err) {
        if (err instanceof BadDoc) throw new HttpError(400, err.message);
        throw err;
      }
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/notes$/,
    handler: async ({ body }) => {
      const dir = await chosenFolder(body.dir);
      if (typeof body.text !== "string" || typeof body.baseMtime !== "number") throw new HttpError(400, "Expected text and baseMtime");
      try {
        return await writeNotes(dir, typeof body.file === "string" ? body.file : "NOTES.md", body.text, body.baseMtime);
      } catch (err) {
        if (err instanceof NotesConflict) throw new HttpError(409, err.message);
        if (err instanceof BadDoc) throw new HttpError(400, err.message);
        throw err;
      }
    },
  },

  // Dictation: a recording (base64) in, its words out. Needs Voxtype and ffmpeg.
  { method: "GET", pattern: /^\/api\/dictation$/, handler: async () => ({ available: dictationAvailable() }) },
  {
    method: "POST",
    pattern: /^\/api\/dictation$/,
    maxBody: Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 1000,
    handler: async ({ body }) => {
      if (!dictationAvailable()) throw new HttpError(404, "Voxtype or ffmpeg isn't installed on the server");
      if (typeof body.audio !== "string" || !body.audio) throw new HttpError(400, "Expected audio: base64");
      try {
        return { text: await transcribe(Buffer.from(body.audio, "base64")) };
      } catch (err) {
        throw err instanceof BadAudio ? new HttpError(400, err.message) : err;
      }
    },
  },

  // Whether the server can speak (Piper installed with a voice).
  { method: "GET", pattern: /^\/api\/speech$/, handler: async () => ({ available: await speechAvailable() }) },

  // Plan usage; ?behaviors=1 adds what's driving it (slower).
  { method: "GET", pattern: /^\/api\/usage$/, handler: ({ url }) => getUsage(url.searchParams.get("behaviors") === "1") },

  // The prompt queue.
  { method: "GET", pattern: /^\/api\/queue$/, handler: () => getQueue() },
  {
    method: "POST",
    pattern: /^\/api\/queue\/split$/,
    handler: async ({ body }) => ({ tasks: await splitTasks(await chosenFolder(body.dir), nonEmpty(body.text, "text")) }),
  },
  {
    method: "POST",
    pattern: /^\/api\/queue$/,
    handler: async ({ body }) => {
      const dir = await chosenFolder(body.dir);
      if (!Array.isArray(body.tasks) || !body.tasks.length) throw new HttpError(400, "Expected tasks: [{ title, prompt }]");
      const tasks: QueueTask[] = body.tasks.map((t: { title?: unknown; prompt?: unknown }) => ({
        title: typeof t?.title === "string" && t.title.trim() ? t.title.trim() : "Queued task",
        prompt: nonEmpty(t?.prompt, "prompt"),
      }));
      const continues = body.sessionId === undefined ? undefined : sessionId(body.sessionId);
      if (continues && isRunning(continues)) throw new HttpError(409, "That session is running; send the message to it instead");
      await addTasks(dir, tasks, body.split === true, continues);
      return { ok: true };
    },
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/api/queue/${SESSION_ID}$`),
    handler: async ({ params: [id], body }) => {
      const edit: Partial<QueueTask> = {};
      if (body.title !== undefined) edit.title = nonEmpty(body.title, "title");
      if (body.prompt !== undefined) edit.prompt = nonEmpty(body.prompt, "prompt");
      if (!(await updateTask(id, edit))) throw new HttpError(409, "Only queued tasks can be edited");
      return { ok: true };
    },
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/api/queue/${SESSION_ID}$`),
    handler: async ({ params: [id] }) => {
      if (!(await removeTask(id))) throw new HttpError(409, "A running task can't be removed");
      return { ok: true };
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/queue/${SESSION_ID}/move$`),
    handler: async ({ params: [id], body }) => {
      if (body.by !== -1 && body.by !== 1) throw new HttpError(400, "Expected by: -1 or 1");
      return { moved: await moveTask(id, body.by) };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/queue\/pause$/,
    handler: async ({ body }) => {
      if (typeof body.paused !== "boolean") throw new HttpError(400, "Expected paused: boolean");
      await setPaused(body.paused);
      return { ok: true };
    },
  },
  { method: "POST", pattern: /^\/api\/queue\/run$/, handler: async () => (await runNow(), { ok: true }) },
  { method: "POST", pattern: /^\/api\/queue\/clear$/, handler: async () => (await clearFinished(), { ok: true }) },

  // Restart once no session is busy. Only under systemd (INVOCATION_ID is
  // set), which starts the server again; otherwise it would just stop.
  {
    method: "POST",
    pattern: /^\/api\/admin\/restart$/,
    handler: async () => {
      if (!process.env.INVOCATION_ID) throw new HttpError(409, "Not running under systemd; restart it yourself");
      return { busy: restartWhenIdle() };
    },
  },

  // Deleted sessions: list, restore, delete forever.
  { method: "GET", pattern: /^\/api\/deleted$/, handler: () => listDeleted() },
  {
    method: "POST",
    pattern: /^\/api\/deleted\/restore$/,
    handler: async ({ body }) => {
      if (!Array.isArray(body.ids)) throw new HttpError(400, "Expected ids: string[]");
      const result = await restoreSessions(body.ids.map(sessionId));
      notifyListChanged();
      return result;
    },
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/api/deleted/${SESSION_ID}$`),
    handler: async ({ params: [id] }) => {
      if (!(await deleteForever(id))) throw new HttpError(404, "Not in deleted sessions");
      return { ok: true };
    },
  },
];

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new HttpError(400, `Missing query parameter: ${name}`);
  return value;
}

// Permission mode, model and effort from a request body; each optional.
function sessionSettings(body: Record<string, unknown>): SessionSettings {
  const settings: SessionSettings = {};
  if (body.mode !== undefined) settings.mode = permissionMode(body.mode);
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || !/^[\w.\[\]-]+$/.test(body.model)) throw new HttpError(400, "Bad model");
    settings.model = body.model;
  }
  if (body.effort !== undefined) {
    if (body.effort !== null && !EFFORT_LEVELS.includes(body.effort as EffortLevel)) throw new HttpError(400, "Bad effort level");
    settings.effort = body.effort as EffortLevel | null;
  }
  return settings;
}

// Answers to Claude's questions: question text -> answer text.
function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Expected answers: { question: answer }");
  const entries = Object.entries(value);
  if (!entries.every(([, v]) => typeof v === "string")) throw new HttpError(400, "Answers must be strings");
  return Object.fromEntries(entries) as Record<string, string>;
}

// A change to the app settings; null clears a default.
function appSettings(body: Record<string, unknown>): Partial<AppSettings> {
  const change: Partial<AppSettings> = {};
  if (body.hideThinkingAndTools !== undefined) {
    if (typeof body.hideThinkingAndTools !== "boolean") throw new HttpError(400, "Expected hideThinkingAndTools: boolean");
    change.hideThinkingAndTools = body.hideThinkingAndTools;
  }
  if (body.sideOpenByDefault !== undefined) {
    if (typeof body.sideOpenByDefault !== "boolean") throw new HttpError(400, "Expected sideOpenByDefault: boolean");
    change.sideOpenByDefault = body.sideOpenByDefault;
  }
  if (body.queueMode !== undefined) change.queueMode = permissionMode(body.queueMode);
  if (body.defaultMode !== undefined) change.defaultMode = body.defaultMode === null ? undefined : permissionMode(body.defaultMode);
  if (body.defaultModel !== undefined) {
    change.defaultModel = body.defaultModel === null ? undefined : sessionSettings({ model: body.defaultModel }).model;
  }
  // "default" clears it; null is a real value (the model's default effort).
  if (body.defaultEffort !== undefined) {
    change.defaultEffort = body.defaultEffort === "default" ? undefined : sessionSettings({ effort: body.defaultEffort }).effort;
  }
  return change;
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `Expected a non-empty ${name}`);
  return value.trim();
}

// Notes and the queue only work in folders the user has chosen.
async function chosenFolder(value: unknown): Promise<string> {
  const dir = absolutePath(value);
  if (!(await loadConfig()).folders.includes(dir)) throw new HttpError(403, "Not one of the chosen project folders");
  return dir;
}

function permissionMode(value: unknown): PermissionMode {
  if (!PERMISSION_MODES.includes(value as PermissionMode)) throw new HttpError(400, "Unknown permission mode");
  return value as PermissionMode;
}

function sessionId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value)) throw new HttpError(400, "Bad session id");
  return value;
}

async function browsing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw err instanceof BrowseError ? new HttpError(err.status, err.message) : err;
  }
}

function absolutePath(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new HttpError(400, "Expected an absolute path");
  return path.resolve(value);
}

const MAX_BODY_BYTES = 1_000_000;

async function readBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "DELETE") return {};
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {}
  throw new HttpError(400, "Expected a JSON object body");
}

export function sendJson(res: ServerResponse, status: number, body: unknown): Promise<void> {
  return sendBody(res, status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, JSON.stringify(body));
}

// /api/sessions/:id/images/:entryUuid/:n?dir= — an image from a transcript.
const IMAGE_ROUTE = new RegExp(`^/api/sessions/${SESSION_ID}/images/([0-9a-f-]{36})/(\\d+)$`);

async function handleImage(res: ServerResponse, url: URL, [id, entryUuid, n]: string[]): Promise<void> {
  const image = await readImage(id, entryUuid, Number(n), url.searchParams.get("dir") ?? undefined);
  if (!image) return void (await sendJson(res, 404, { error: "Image not found" }));
  // A transcript's images never change once written.
  await sendBody(res, 200, { "content-type": image.mediaType, "cache-control": "private, max-age=31536000, immutable" }, image.data);
}

// POST /api/speech {text} -> audio/wav of the text, spoken by Piper.
async function handleSpeech(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (!(await speechAvailable())) throw new HttpError(404, "No speech voice is available on the server");
    const text = nonEmpty((await readBody(req, 20_000)).text, "text");
    await sendBody(res, 200, { "content-type": "audio/wav", "cache-control": "no-store" }, await synthesize(text));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error("POST /api/speech:", err);
    await sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const image = req.method === "GET" && url.pathname.match(IMAGE_ROUTE);
  if (image) return handleImage(res, url, image.slice(1));
  if (url.pathname === "/api/events" && req.method === "GET") return handleEvents(req, res);
  if (url.pathname === "/api/speech" && req.method === "POST") return handleSpeech(req, res);
  for (const route of routes) {
    const match = url.pathname.match(route.pattern);
    if (!match || req.method !== route.method) continue;
    try {
      const body = await readBody(req, route.maxBody ?? MAX_BODY_BYTES);
      await sendJson(res, 200, await route.handler({ req, url, params: match.slice(1), body }));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(`${req.method} ${url.pathname}:`, err);
      await sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  await sendJson(res, 404, { error: "Not found" });
}

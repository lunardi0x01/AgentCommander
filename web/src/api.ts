// Thin client for the server's JSON API.

import type {
  AccessInfo,
  BackendId,
  AppSettings,
  Attachment,
  DeletedSession,
  NotesFile,
  QueueState,
  QueueTask,
  UsageInfo,
  BrowseResult,
  FolderChoice,
  HandoffResult,
  FolderInfo,
  MachineInfo,
  MessagesPage,
  NewProjectResult,
  TemplateInfo,
  FolderDefaults,
  PermissionMode,
  RunState,
  SessionSettings,
  SlashCommandInfo,
  SessionSummary,
  TrashResult,
  Tree,
} from "../../shared/types.ts";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

const q = encodeURIComponent;

export const api = {
  machine: () => request<MachineInfo>("GET", "/api/machine"),

  tree: (open: string[]) => request<Tree>("GET", `/api/tree?${open.map((dir) => `open=${q(dir)}`).join("&")}`),
  folders: () => request<FolderInfo[]>("GET", "/api/folders"),
  folderChoices: () => request<FolderChoice[]>("GET", "/api/folders/choices"),
  addFolder: (path: string) => request<void>("POST", "/api/folders", { path }),
  browse: (path?: string) => request<BrowseResult>("GET", `/api/fs${path ? `?path=${q(path)}` : ""}`),
  makeFolder: (parent: string, name: string) => request<{ path: string }>("POST", "/api/fs/mkdir", { parent, name }),
  templates: () => request<TemplateInfo[]>("GET", "/api/templates"),
  createProject: (project: { dir: string; type: string; name: string; description: string; public: boolean; git: boolean }) =>
    request<NewProjectResult>("POST", "/api/projects", project),
  removeFolder: (path: string) => request<void>("DELETE", `/api/folders?path=${q(path)}`),

  sessions: (dir: string) => request<SessionSummary[]>("GET", `/api/sessions?dir=${q(dir)}`),
  messages: (id: string, dir: string, from = 0) =>
    request<MessagesPage>("GET", `/api/sessions/${id}/messages?dir=${q(dir)}&from=${from}`),
  renameSession: (id: string, dir: string, title: string) =>
    request<SessionSummary>("PATCH", `/api/sessions/${id}`, { dir, title }),
  commands: (dir: string, backend: BackendId = "claude") =>
    request<SlashCommandInfo[]>("GET", `/api/commands?dir=${q(dir)}&backend=${backend}`),
  run: (id: string) => request<RunState | null>("GET", `/api/sessions/${id}/run`),
  folderDefaults: (dir: string, backend: BackendId = "claude") =>
    request<FolderDefaults>("GET", `/api/folder-defaults?dir=${q(dir)}&backend=${backend}`),
  // `isNew`: create the session (with this id) instead of resuming it. Returns
  // the session's id: a new Gemini session gets its own from agy.
  sendMessage: (
    id: string,
    dir: string,
    text: string,
    settings: SessionSettings,
    isNew = false,
    attachments: Attachment[] = [],
    backend: BackendId = "claude",
  ) => request<{ ok: true; id: string }>("POST", `/api/sessions/${id}/messages`, { dir, text, ...settings, new: isNew, attachments, backend }),
  applySettings: (id: string, settings: SessionSettings) =>
    request<{ applied: boolean }>("POST", `/api/sessions/${id}/settings`, settings),
  closeSession: (id: string) => request<{ closed: "here" | "elsewhere" }>("POST", `/api/sessions/${id}/close`, {}),
  handOff: (id: string, dir: string, settings: SessionSettings, trust = false) =>
    request<HandoffResult>("POST", `/api/sessions/${id}/handoff`, { dir, ...settings, trust }),
  cancelHandOff: (id: string) => request<void>("DELETE", `/api/sessions/${id}/handoff`),
  interrupt: (id: string) => request<void>("POST", `/api/sessions/${id}/interrupt`, {}),
  answerPermission: (id: string, toolUseId: string, allow: boolean, mode?: PermissionMode, answers?: Record<string, string>) =>
    request<void>("POST", `/api/sessions/${id}/permissions/${toolUseId}`, { allow, mode, answers }),

  deleteSessions: (sessions: Array<{ id: string; dir: string }>) =>
    request<TrashResult>("POST", "/api/sessions/delete", { sessions }),

  deleted: () => request<DeletedSession[]>("GET", "/api/deleted"),
  restore: (ids: string[]) => request<TrashResult>("POST", "/api/deleted/restore", { ids }),
  deleteForever: (id: string) => request<void>("DELETE", `/api/deleted/${id}`),

  access: () => request<AccessInfo>("GET", "/api/access"),
  rotateToken: () => request<{ token: string }>("POST", "/api/access/rotate-token", {}),
  settings: () => request<AppSettings>("GET", "/api/settings"),
  // null clears a default; for effort "default" does (null is the model's default effort).
  updateSettings: (change: Record<string, unknown>) => request<AppSettings>("POST", "/api/settings", change),

  noteFiles: (dir: string) => request<string[]>("GET", `/api/notes/files?dir=${q(dir)}`),
  notes: (dir: string, file: string) => request<NotesFile>("GET", `/api/notes?dir=${q(dir)}&file=${q(file)}`),
  saveNotes: (dir: string, file: string, text: string, baseMtime: number) =>
    request<NotesFile>("POST", "/api/notes", { dir, file, text, baseMtime }),

  usage: (behaviors = false) => request<UsageInfo>("GET", `/api/usage${behaviors ? "?behaviors=1" : ""}`),

  queue: () => request<QueueState>("GET", "/api/queue"),
  splitTasks: (dir: string, text: string) => request<{ tasks: QueueTask[] }>("POST", "/api/queue/split", { dir, text }),
  // `split`: split it later, when usage is back. `sessionId`: continue that session.
  addTasks: (dir: string, tasks: QueueTask[], split = false, sessionId?: string) =>
    request<void>("POST", "/api/queue", { dir, tasks, split, sessionId }),
  updateTask: (id: string, edit: Partial<QueueTask>) => request<void>("PATCH", `/api/queue/${id}`, edit),
  removeTask: (id: string) => request<void>("DELETE", `/api/queue/${id}`),
  moveTask: (id: string, by: -1 | 1) => request<void>("POST", `/api/queue/${id}/move`, { by }),
  pauseQueue: (paused: boolean) => request<void>("POST", "/api/queue/pause", { paused }),
  runQueue: () => request<void>("POST", "/api/queue/run", {}),
  clearQueue: () => request<void>("POST", "/api/queue/clear", {}),
};

// Types shared by the server API and the web UI.

export interface MachineInfo {
  hostname: string;
  user: string;
  home: string;
}

// Status of a session with a running Claude Code process.
export type LiveStatus = "working" | "waiting" | "idle";

export interface FolderInfo {
  path: string;
  name: string;
  sessionCount: number;
  liveCount: number;
  live?: LiveStatus; // most urgent status among its live sessions
  liveHere?: boolean; // some of them are run by Agent Commander
  lastActivity: number; // ms since epoch, 0 if the folder has no sessions
}

// A folder offered in the project picker.
export interface FolderChoice extends FolderInfo {
  selected: boolean;
}

// One level of the add-folder browser.
export interface BrowseResult {
  root: string; // the projects folder; browsing can't leave it
  path: string;
  parent: string | null; // null at the root
  folders: Array<{ name: string; path: string; git: boolean }>;
}

// Which agent runs a session. "gemini" is Google Antigravity (agy); absent means Claude Code.
export type BackendId = "claude" | "gemini";

// Session names in the tree are prefixed with this: "Claude - ", "Gemini - ".
export const BACKEND_LABEL: Record<BackendId, string> = { claude: "Claude", gemini: "Gemini" };

export interface SessionSummary {
  id: string;
  backend?: BackendId;
  title: string;
  lastActivity: number; // ms since epoch
  createdAt?: number;
  gitBranch?: string;
  live?: LiveStatus; // absent when no process is running it
  liveHere?: boolean; // run by Agent Commander, rather than open in a terminal etc.
  remote?: string; // claude.ai link, when it is open in Remote Control
  contextTokens?: number; // size of the conversation as of its last reply; what resuming re-sends
  cacheTtlMs?: number; // how long its prompt cache lives (5 minutes or 1 hour), when known
}

// The navigator's contents: chosen folders and the sessions of open ones.
export interface Tree {
  folders: FolderInfo[];
  sessions: Record<string, SessionSummary[]>; // keyed by folder path
}

// A session moved to Agent Commander's deleted-sessions store.
export interface DeletedSession {
  id: string;
  title: string;
  dir: string;
  lastActivity: number;
  deletedAt: number;
  backend?: BackendId;
}

export interface ToolResult {
  text: string;
  isError: boolean;
  truncated: boolean;
  images: ImageBlock[];
}

// Assistant blocks carry their transcript entry's uuid, so a streamed draft
// block can be dropped once its saved version has loaded.
export interface TextBlock {
  type: "text";
  text: string;
  uuid?: string;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
  uuid?: string;
}

export interface ImageBlock {
  type: "image";
  mediaType: string;
  url: string; // fetched lazily; images are most of a transcript's size
}

export interface ToolBlock {
  type: "tool";
  id: string;
  name: string;
  input: unknown;
  result?: ToolResult;
  uuid?: string;
}

// A document the user attached (PDF or text file); only its name is shown.
export interface FileBlock {
  type: "file";
  name: string;
  mediaType: string;
}

export type Block = TextBlock | ThinkingBlock | ImageBlock | FileBlock | ToolBlock;

// A file sent with a message: base64 data, as the browser read it.
export interface Attachment {
  name: string;
  mediaType: string;
  data: string;
}

// "notice" covers transcript entries that are not really chat:
// slash commands, local command output, background task notifications.
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "notice";
  blocks: Block[];
  timestamp?: string;
}

// A transcript, or its tail from message index `from`.
export interface MessagesPage {
  total: number;
  from: number;
  messages: ChatMessage[];
}

// Outcome of deleting or restoring several sessions.
export interface TrashResult {
  done: string[]; // session ids
  failed: Array<{ id: string; error: string }>;
}

export interface ApiError {
  error: string;
}

// --- chatting: sessions run by Agent Commander -----------------------------

// A block of the assistant message being streamed right now.
export interface DraftBlock {
  type: "text" | "thinking" | "tool";
  text: string; // text, thinking, or the tool input JSON as it streams in
  name?: string; // tool name
  toolId?: string; // tool_use id, to match the block with its saved entry
  done: boolean;
  uuid?: string; // transcript entry, once the block is complete
}

// A tool call waiting for the user to allow or deny it.
export interface PermissionRequest {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  reason?: string;
}

// Claude Code's permission modes (the SDK's PermissionMode).
export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions" | "dontAsk";
export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "bypassPermissions", "dontAsk"];

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

// Settings a session runs with, picked in the UI. Unset = Claude Code's
// default; effort null = the model's default effort.
export interface SessionSettings {
  mode?: PermissionMode;
  model?: string; // a model value from FolderDefaults.models, e.g. "opus"
  effort?: EffortLevel | null;
}

// A model Claude Code offers.
export interface ModelOption {
  value: string; // what to pass as the model, e.g. "opus" or a full id
  resolvedModel?: string; // the id an alias stands for
  displayName: string;
  description: string;
  effortLevels?: EffortLevel[]; // absent: no effort control
}

// A session's state while Agent Commander runs it.
export interface RunState {
  status: "starting" | "working" | "waiting" | "idle" | "error";
  mode?: PermissionMode; // as the running process reports it
  model?: string; // the model in use: a resolved id from the process, or the value last picked
  effort?: EffortLevel | null; // the effort last picked (null: model default)
  draft: DraftBlock[];
  permissions: PermissionRequest[];
  error?: string;
  rateLimited?: boolean; // the last turn hit the plan's usage limit
  contextTokens?: number; // Gemini: the conversation's size, as the agent last reported it
}

// A project template for New Project.
export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  public: boolean; // whether new projects of this type start as public
  files: string[]; // what it creates ({{...}} in names shown as <name>)
  publicFiles: string[]; // created only for public projects
}

export interface NewProjectResult {
  dir: string;
  created: string[];
  skipped: string[]; // already existed, so left alone
  git: boolean; // a git repository was started
}

// Who this request is, and how access is set up (Settings → Access).
export interface AccessInfo {
  via: "tailscale" | "token" | "local"; // how this request got in
  login?: string; // the Tailscale login, when via is "tailscale"
  logins: string[]; // everyone allowed in through Tailscale
  token: "file" | "env" | "none"; // where the script token comes from
}

// Outcome of handing a session off to Remote Control.
export type HandoffResult =
  | { status: "remote"; url: string }
  | { status: "trust" }; // Claude Code is asking whether to trust the folder; confirm, then call again with trust

// Claude Code's defaults in a folder, for sessions that aren't running yet.
export interface FolderDefaults {
  permissionMode: PermissionMode;
  models: ModelOption[];
  modes?: PermissionMode[]; // the modes this backend has; absent: all of them
}

// A slash command offered in the composer's / menu.
export interface SlashCommandInfo {
  name: string; // without the slash
  description: string;
  argumentHint: string;
  aliases?: string[];
}

// --- settings, notes, queue, usage ------------------------------------------

// App-wide settings, saved on the server so every device shares them.
// Unset defaults fall back to Claude Code's own.
export interface AppSettings {
  hideThinkingAndTools: boolean; // collapse them to one line per run of blocks
  defaultMode?: PermissionMode;
  defaultModel?: string;
  defaultEffort?: EffortLevel | null;
  sideOpenByDefault: boolean; // the notes and queue column is open when the page loads
  queueMode: PermissionMode; // queued tasks run unattended, so Ask would stall them
  notifyDone: boolean; // desktop notification on this computer when a turn finishes
  notifyNeedsYou: boolean; // ...and when a session waits for a permission, plan or answer
  terminalEnabled: boolean; // the Terminal tab (a shell as you, in a project folder)
  notifyMinSeconds: number; // "finished" only for turns at least this long (quick replies stay quiet)
}

export const DEFAULT_SETTINGS: AppSettings = { hideThinkingAndTools: false, sideOpenByDefault: true, queueMode: "acceptEdits", notifyDone: true, notifyNeedsYou: true, notifyMinSeconds: 20, terminalEnabled: true };

// A project's NOTES.md. mtime 0: the file doesn't exist yet.
export interface NotesFile {
  text: string;
  mtime: number;
}

export type QueueStatus = "queued" | "running" | "waiting" | "done" | "failed";

// A prompt waiting to run in a new session of its own.
export interface QueueItem {
  id: string;
  dir: string;
  title: string;
  prompt: string;
  status: QueueStatus;
  split?: boolean; // still to be split into tasks (queued while usage was out)
  sessionId?: string; // once started
  error?: string;
  createdAt: number;
}

export interface QueueState {
  items: QueueItem[];
  paused: boolean; // by the user
  waitingUntil?: number; // usage is out; resumes by itself then (ms since epoch)
}

// A proposed task from splitting a list.
export interface QueueTask {
  title: string;
  prompt: string;
}

// One of the plan's usage windows (5-hour, weekly, per model).
export interface UsageWindow {
  label: string;
  utilization: number | null; // percent used, 0-100
  resetsAt: string | null; // ISO time
  blocksAll?: boolean; // full means no model can be used (5-hour, weekly all-models)
}

// What's driving usage, from Claude Code's scan of local transcripts.
export interface UsageBehaviors {
  label: string; // "Last 24 hours", "Last 7 days"
  requests: number;
  sessions: number;
  behaviors: Array<{ key: string; pct: number; count: number }>;
  recommendations: Array<{ title: string; detail?: string; pct: number }>;
  sources: Array<{ kind: string; name: string; pct: number }>; // skills, agents, plugins, MCP servers
}

export interface UsageInfo {
  available: boolean; // false: no plan limits (or an unsupported Claude Code)
  plan: string | null; // "pro", "max", ...
  windows: UsageWindow[];
  extra?: { enabled: boolean; usedCredits: number | null; monthlyLimit: number | null; utilization: number | null; currency?: string | null };
  behaviors?: UsageBehaviors[];
  fetchedAt: number;
}

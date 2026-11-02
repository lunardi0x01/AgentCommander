# Agent Commander

A local web app for working with Claude Code sessions on this machine. A Node
server owns the sessions through the Claude Agent SDK and serves a React UI;
the browser only talks to the server's HTTP API. It can also run Gemini
sessions (Google Antigravity) through Antigravity's ACP server.

The full reference (features, architecture, Claude Code/SDK findings, history)
is in [docs/REFERENCE.md](docs/REFERENCE.md).

## Run

```sh
npm install
npm run build && npm start     # one process: UI + API on http://127.0.0.1:4317
npm run dev                    # development: open http://127.0.0.1:5173 (Vite, hot reload)
npm run typecheck
```

From another machine, either tunnel the port
(`ssh -L 4317:127.0.0.1:4317 omarchy-01`, then open http://127.0.0.1:4317) or
use the tailnet: the server stays on 127.0.0.1 and Tailscale proxies HTTPS to it.

```sh
tailscale serve --bg --https=10000 http://127.0.0.1:4317   # once; persists
# open https://your-host.your-tailnet.ts.net:10000 on any device signed in to your tailnet
```

## Running as a service

```sh
npm run install-service                  # once: systemd user unit, starts at boot (needs linger)
systemctl --user start agent-commander
npm run build && npm run restart         # deploy: restarts once no session is busy
journalctl --user -u agent-commander -f  # logs
```

`npm run restart` waits for running turns to finish, so it is safe to run from a
chat inside Agent Commander.

## Config

| Variable                | Default     | Notes                                              |
| ----------------------- | ----------- | -------------------------------------------------- |
| `HOST`                  | `127.0.0.1` | Non-loopback hosts require a token.                |
| `PORT`                  | `4317`      |                                                    |
| `AGENT_COMMANDER_MODEL` | (none)      | Model for chats when none is picked; unset uses    |
|                         |             | Claude Code's default. (Tests use `haiku`.)        |
| `CLAUDE_PATH`           | from PATH   | The logged-in `claude` binary the SDK runs.        |
| `AGENT_COMMANDER_PROJECTS_DIR` | `~/Projects` | Root of the New Project folder browser; it can't leave it. |
| `AGENT_COMMANDER_TOKEN` | (none)      | Token for scripts (`Authorization: Bearer`). Falls |
|                         |             | back to `~/.config/agent-commander/token`. Browsers|
|                         |             | don't need it: see Access below.                   |
| `AGY_ACP_SERVER`        | see below   | Antigravity's ACP server, for Gemini sessions.     |

The folders shown in the navigator are chosen in the UI (☰ button) and saved in
`~/.config/agent-commander/config.json`. Removing one only hides it.

No API key is used: the SDK runs the logged-in `claude` CLI (Claude Pro), and
the server strips any `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from its
environment. Sending to a session that's open in a terminal or Remote Control is
refused, since two processes would both write its transcript. A run stays up
between messages and closes after 15 idle minutes; restarting the server stops
its runs.

### Gemini (optional)

Gemini sessions need the `agy` CLI logged in to Google, and Antigravity's ACP
server, which ships separately. Take the `linux-x86_64` archive and its sha256
from the ACP registry (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`,
id `antigravity-acp`), check the checksum, and unzip it to
`~/.local/share/agent-commander/agy-acp/v<version>/bin/`. The newest version
there is used; failing that, a copy installed by Zed. Without it, Gemini
sessions report that the server isn't installed.

## Layout

```
server/   Node server (runs .ts directly, no build step)
  index.ts       HTTP server, auth, static files
  compress.ts    gzip for larger responses
  api.ts         JSON routes
  auth.ts        who may use the API: Tailscale login, local, or the token
  config.ts      persisted config (chosen folders)
  handoff.ts     hand a session off to Remote Control (a tmux window running the CLI)
  browse.ts      folder browsing for New Project, confined to the projects root
  projects.ts    project templates and creating a project from one
  activity.ts    last-message time per session
  runner.ts      sessions Agent Commander runs: one claude process each (Agent SDK)
  claude.ts      the claude binary and environment used for every Claude process
  commands.ts    slash commands per folder, from a short-lived probe process
  live.ts        running sessions, from Claude Code's ~/.claude/sessions registry
  events.ts      file watching -> server-sent events
  trash.ts       deleted sessions (~/.local/share/agent-commander/trash), restore
  sessions.ts    session history via the Agent SDK
  transcript.ts  SDK transcript -> UI messages
  attachments.ts message attachments -> content blocks
  dictation.ts   speech to text with Voxtype (optional)
  speech.ts      text to speech with Piper (optional, see docs/REFERENCE.md)
shared/   types shared by server and UI
web/      React + Vite UI
```

## API

```
GET    /api/machine                      { hostname, user, home }
GET    /api/tree?open=<dir>…             chosen folders + sessions of the open ones (one request)
GET    /api/folders                      folders chosen for the navigator
GET    /api/folders/choices              all project folders, with `selected`
POST   /api/folders        {path}        show a folder
GET    /api/fs?path=<dir>                subfolders of a folder inside the projects root (default: the root)
POST   /api/fs/mkdir {parent, name}      create a folder there
GET    /api/templates                    project types for New Project, with the files each creates
POST   /api/projects {dir, type, name, description, public, git}  create a project from a template in a folder inside the root (type "none": just show the folder); never overwrites files
DELETE /api/folders?path=<path>          hide a folder (nothing on disk changes)
GET    /api/sessions?dir=<path>          sessions in a folder, newest first
GET    /api/sessions/:id/messages?dir=&from=  a session's messages (from = skip ones already loaded)
GET    /api/sessions/:id/images/:entry/:n     an image from a transcript (images aren't inlined)
PATCH  /api/sessions/:id   {dir, title}  rename a session (same as /rename; Gemini: our own title)
POST   /api/sessions/:id/messages {dir, text, attachments?, mode?, model?, effort?, new?, backend?}  send a message (resumes the session in a run, or creates it with new: true; backend: "gemini" for Gemini). Returns {id}: a new Gemini session's id comes from agy
POST   /api/sessions/:id/permissions/:toolUseId {allow, mode?}  answer a permission request (mode: switch, e.g. on plan approval)
POST   /api/sessions/:id/settings {mode?, model?, effort?}  change a running session's settings
GET    /api/folder-defaults?dir=<path>&backend=   defaults in a folder (permission mode, models; Gemini adds its modes)
POST   /api/admin/restart                exit once no session is busy (under systemd, which restarts it)
POST   /api/sessions/:id/handoff {dir, mode?, model?, effort?, trust?}  reopen it in Claude Code with Remote Control (tmux); {status:"trust"} = confirm the folder, then repeat with trust
DELETE /api/sessions/:id/handoff         give up on a handoff waiting for the trust answer
POST   /api/sessions/:id/interrupt       stop the current turn
POST   /api/sessions/:id/close           end its Claude process: ours, or one open in a terminal / Remote Control
GET    /api/sessions/:id/run             the run's state: status, streaming draft, pending permissions
GET    /api/commands?dir=<path>&backend=  slash commands available in a folder (for the / menu)
POST   /api/sessions/delete  {sessions}  move sessions to deleted sessions (refuses live ones)
GET    /api/deleted                      deleted sessions
POST   /api/deleted/restore  {ids}       put deleted sessions back
DELETE /api/deleted/:id                  delete forever
GET    /api/settings                     app settings (shared by all devices)
POST   /api/settings  {hideThinkingAndTools?, defaultMode?, defaultModel?, defaultEffort?, queueMode?}  change them (null clears a default)
GET    /api/notes/files?dir=<path>       which of NOTES.md, .project/tasklist.md, docs/REFERENCE.md, README.md exist
GET    /api/notes?dir=<path>&file=<name> one of them {text, mtime} (file defaults to NOTES.md)
POST   /api/notes  {dir, file, text, baseMtime}  save it (409 if it changed since baseMtime)
GET    /api/usage?behaviors=1            plan usage windows (+ what's driving usage, from a local scan)
GET    /api/queue                        the prompt queue {items, paused, waitingUntil?}
POST   /api/queue/split  {dir, text}     have Haiku split a list into self-contained tasks (for review)
POST   /api/queue  {dir, tasks, split?, sessionId?}  add tasks (split: split later; sessionId: continue that session)
PATCH  /api/queue/:id  {title?, prompt?} edit a queued task
DELETE /api/queue/:id                    remove a task (not while running)
POST   /api/queue/:id/move  {by: -1|1}   reorder
POST   /api/queue/pause  {paused}        pause or resume the queue
POST   /api/queue/run                    try now instead of waiting for the usage reset
POST   /api/queue/clear                  drop finished tasks
GET    /api/events                       server-sent events: {type:"session",id} | {type:"list"} | {type:"run",id,run} | {type:"queue"} | {type:"notes",dir}
```

State-changing requests must be same-origin JSON, so other websites can't drive the API.

## Access

Browsers are let in by their **Tailscale login**: `tailscale serve` adds a
`Tailscale-User-Login` header (and strips any the client sent), and the request
is allowed when that login is in `logins` in `~/.config/agent-commander/config.json`
(filled in from `tailscale status` on first start). Requests with a loopback
Host straight to the server (on this machine) are allowed too. Anything else,
such as scripts, sends the token as `Authorization: Bearer`. Settings → Access
shows who is signed in and can make a new token.

GET    /api/access                       {via, login?, logins, token}
POST   /api/access/rotate-token          a new script token (shown once; refused when set by the environment)


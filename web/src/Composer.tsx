import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { BACKEND_LABEL, type Attachment, type BackendId, type ModelOption, type PermissionMode, type SessionSettings, type SlashCommandInfo } from "../../shared/types.ts";
import { api } from "./api.ts";
import { MAX_FILES, readAttachment, type Picked } from "./attachments.ts";
import { FileIcon, MicIcon, PaperclipIcon, SpeakerIcon } from "./icons.tsx";
import { ModePicker, nextMode } from "./modes.tsx";
import { EffortPicker, ModelPicker } from "./ModelPicker.tsx";
import { canSpeak, dictationReady, hasMicrophone, onMicrophoneChange, startRecording, stopSpeaking, type Recording } from "./speech.ts";

interface Props {
  dir: string; // the session's folder: its commands are offered on "/"
  backend: BackendId; // whose commands, modes and name to show
  modes?: PermissionMode[]; // the agent's permission modes; absent: all
  busy: boolean; // a turn is running: offer Stop
  settings: Required<SessionSettings>;
  models: ModelOption[];
  onSettings: (change: SessionSettings) => void;
  onSend: (text: string, files: Attachment[]) => Promise<void>;
  onStop: () => Promise<void>;
  readAloud: boolean; // speak each finished reply (per device)
  onReadAloud: (on: boolean) => void;
  contextInfo?: ReactNode; // context size and cache warmth, at the bar's right end
}

// Commands per folder and agent, fetched once per page load (the server caches too).
const commandCache = new Map<string, Promise<SlashCommandInfo[]>>();

function folderCommands(dir: string, backend: BackendId): Promise<SlashCommandInfo[]> {
  const key = `${backend}:${dir}`;
  let commands = commandCache.get(key);
  if (!commands) {
    commands = api.commands(dir, backend);
    commandCache.set(key, commands);
    commands.catch(() => commandCache.delete(key));
  }
  return commands;
}

// Commands matching what's typed after "/": name prefix first, then
// anything containing it (name or alias).
function matching(commands: SlashCommandInfo[], typed: string): SlashCommandInfo[] {
  const q = typed.toLowerCase();
  const names = (c: SlashCommandInfo) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
  const starts = commands.filter((c) => names(c).some((n) => n.startsWith(q)));
  const contains = commands.filter((c) => !starts.includes(c) && names(c).some((n) => n.includes(q)));
  return [...starts, ...contains];
}

// Message box. Enter sends, Shift+Enter starts a new line. While Claude is
// working, Stop interrupts; a message sent meanwhile is queued for it.
// Typing "/" at the start opens a menu of the folder's slash commands.
// Files can be attached (button, drop, paste) and text dictated (mic).
export function Composer({ dir, backend, modes, busy, settings, models, onSettings, onSend, onStop, readAloud, onReadAloud, contextInfo }: Props) {
  const agent = BACKEND_LABEL[backend];
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Picked[]>([]);
  const [dragging, setDragging] = useState(false);
  // Dictation: record, then transcribe on the server and add the words.
  const [mic, setMic] = useState<"unavailable" | "idle" | "recording" | "transcribing">("unavailable");
  const recording = useRef<Recording | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commands, setCommands] = useState<SlashCommandInfo[] | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // "/name" with no space yet: the menu is open for that name.
  const typed = text.match(/^\/(\S*)$/)?.[1];
  const menuOpen = typed !== undefined && !dismissed;
  const matches = menuOpen && commands ? matching(commands, typed) : [];

  useEffect(() => {
    setCommands(null);
    setCommandError(null);
  }, [dir, backend]);

  useEffect(() => {
    if (!menuOpen || commands) return;
    let cancelled = false;
    folderCommands(dir, backend).then(
      (list) => !cancelled && setCommands(list),
      (err) => !cancelled && setCommandError(String(err.message ?? err)),
    );
    return () => {
      cancelled = true;
    };
  }, [menuOpen, commands, dir, backend]);

  useEffect(() => setHighlight(0), [typed]);

  // Keep the highlighted command in view.
  useEffect(() => {
    list.current?.children[highlight]?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  // Grow with the text, up to the CSS max-height.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const change = (value: string) => {
    setText(value);
    if (!value.startsWith("/")) setDismissed(false);
  };

  useEffect(() => {
    let cancelled = false;
    // Shown only where the server transcribes and this device has a microphone.
    const check = async () => {
      const ok = (await dictationReady()) && (await hasMicrophone());
      if (!cancelled) setMic((m) => (m === "idle" || m === "unavailable" ? (ok ? "idle" : "unavailable") : m));
    };
    void check();
    const stopWatching = onMicrophoneChange(() => void check());
    return () => {
      cancelled = true;
      stopWatching();
      recording.current?.cancel();
    };
  }, []);

  const finishDictation = async () => {
    const current = recording.current;
    if (!current) return;
    recording.current = null;
    setMic("transcribing");
    try {
      const words = await current.finish();
      // Added to the end of whatever is there now: it may have been edited meanwhile.
      if (words) setText((t) => (t && !/\s$/.test(t) ? `${t} ${words}` : t + words));
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setMic("idle");
      box.current?.focus();
    }
  };

  const toggleDictation = async () => {
    if (mic === "recording") return finishDictation();
    if (mic !== "idle") return;
    stopSpeaking(); // the mic would hear it
    setError(null);
    try {
      recording.current = await startRecording(() => void finishDictation());
      setMic("recording");
    } catch (err) {
      setError(String((err as Error).message ?? err));
      if (!(await hasMicrophone())) setMic("unavailable");
    }
  };

  const addFiles = async (incoming: File[]) => {
    setError(null);
    for (const file of incoming) {
      try {
        const picked = await readAttachment(file);
        setFiles((prev) => {
          if (prev.length >= MAX_FILES) {
            setError(`At most ${MAX_FILES} files per message.`);
            return prev;
          }
          return [...prev, picked];
        });
      } catch (err) {
        setError(String((err as Error).message ?? err));
      }
    }
  };

  const removeFile = (file: Picked) => {
    if (file.preview) URL.revokeObjectURL(file.preview);
    setFiles((prev) => prev.filter((f) => f !== file));
  };

  const complete = (command: SlashCommandInfo) => {
    setText(`/${command.name} `);
    box.current?.focus();
  };

  const send = async () => {
    const message = text.trim();
    if ((!message && !files.length) || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(message, files.map(({ name, mediaType, data }) => ({ name, mediaType, data })));
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      setFiles([]);
      setText("");
      setDismissed(false);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setSending(false);
      box.current?.focus();
    }
  };

  const stop = async () => {
    try {
      await onStop();
    } catch (err) {
      setError(String((err as Error).message ?? err));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    // Shift+Tab switches permission mode, as in Claude Code's terminal.
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      onSettings({ mode: nextMode(settings.mode, modes) });
      return;
    }
    if (menuOpen && matches.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setHighlight((i) => (i + step + matches.length) % matches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        complete(matches[highlight]);
        return;
      }
    }
    if (menuOpen && e.key === "Escape") {
      e.preventDefault();
      setDismissed(true);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer">
      {menuOpen && (
        <div className="command-menu" role="listbox">
          {commandError ? (
            <div className="command-note">{commandError}</div>
          ) : !commands ? (
            <div className="command-note">Loading commands…</div>
          ) : matches.length === 0 ? (
            <div className="command-note">No matching commands.</div>
          ) : (
            <ul ref={list}>
              {matches.map((c, i) => (
                <li
                  key={c.name}
                  role="option"
                  aria-selected={i === highlight}
                  className={i === highlight ? "active" : undefined}
                  // mousedown, not click: keep focus in the text box.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    complete(c);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                >
                  <span className="command-name">
                    /{c.name}
                    {c.argumentHint && <span className="command-hint"> {c.argumentHint}</span>}
                  </span>
                  <span className="command-description">{c.description}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <div className="composer-error">{error}</div>}
      <div
        className={`composer-box${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          void addFiles([...e.dataTransfer.files]);
        }}
      >
        {files.length > 0 && (
          <div className="attachments">
            {files.map((f, i) => (
              <span key={i} className="attachment" title={f.name}>
                {f.preview ? <img src={f.preview} alt="" /> : <FileIcon />}
                <span className="attachment-name">{f.name}</span>
                <button className="attachment-remove" onClick={() => removeFile(f)} title="Remove" aria-label={`Remove ${f.name}`}>
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])]);
            e.target.value = ""; // the same file can be picked again
          }}
        />
        <button className="icon-button" onClick={() => picker.current?.click()} title="Attach images, PDFs or text files">
          <PaperclipIcon />
        </button>
        <textarea
          ref={box}
          rows={1}
          value={text}
          placeholder={busy ? `${agent} is working. A message now is sent next…` : `Message ${agent}… (/ for commands)`}
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (!e.clipboardData.files.length) return;
            e.preventDefault();
            void addFiles([...e.clipboardData.files]);
          }}
        />
        {mic !== "unavailable" && (
          <button
            className={`icon-button${mic === "recording" ? " active listening" : ""}`}
            onClick={toggleDictation}
            disabled={mic === "transcribing"}
            title={mic === "recording" ? "Stop and transcribe" : mic === "transcribing" ? "Transcribing…" : "Dictate"}
          >
            <MicIcon />
          </button>
        )}
        {busy && (
          <button className="secondary-button" onClick={stop} title={`Interrupt ${agent}`}>
            Stop
          </button>
        )}
        <button className="primary-button" disabled={(!text.trim() && !files.length) || sending} onClick={send}>
          Send
        </button>
      </div>
      <div className="composer-bar">
        <ModePicker mode={settings.mode} modes={modes} onMode={(mode) => onSettings({ mode })} />
        <ModelPicker model={settings.model} models={models} onModel={(model) => onSettings({ model })} />
        <EffortPicker model={settings.model} effort={settings.effort} models={models} onEffort={(effort) => onSettings({ effort })} />
        {canSpeak && (
          <button
            className={`icon-button${readAloud ? " active" : ""}`}
            onClick={() => {
              if (readAloud) stopSpeaking();
              onReadAloud(!readAloud);
            }}
            title={readAloud ? "Reading replies aloud: click to turn off" : "Read replies aloud"}
            aria-pressed={readAloud}
          >
            <SpeakerIcon />
          </button>
        )}
        {contextInfo}
      </div>
    </div>
  );
}

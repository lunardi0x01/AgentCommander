// Speech in the browser: dictation (SpeechRecognition) and reading replies
// aloud (speechSynthesis). Both depend on what the browser provides; see
// docs/REFERENCE.md.

import { useSyncExternalStore } from "react";

// --- dictation ---------------------------------------------------------------
//
// The browser records; the server transcribes (Voxtype's whisper), so it
// works in any browser with a microphone, not just ones with speech recognition.

const MAX_RECORDING_MS = 5 * 60 * 1000;

let dictationAvailable: Promise<boolean> | null = null;

// Can this browser record and does the server transcribe?
export function dictationReady(): Promise<boolean> {
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return Promise.resolve(false);
  return (dictationAvailable ??= fetch("/api/dictation").then(
    (r) => (r.ok ? r.json().then((j: { available: boolean }) => j.available) : false),
    () => false,
  ));
}

// Does the browser see any audio input? Lists don't need permission (only
// the names do). If it can't tell, assume yes.
export async function hasMicrophone(): Promise<boolean> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).some((d) => d.kind === "audioinput");
  } catch {
    return true;
  }
}

// Runs when microphones are plugged in or removed.
export function onMicrophoneChange(fn: () => void): () => void {
  navigator.mediaDevices?.addEventListener("devicechange", fn);
  return () => navigator.mediaDevices?.removeEventListener("devicechange", fn);
}

export interface Recording {
  // Ends the recording and resolves to the words said ("" for silence).
  finish: () => Promise<string>;
  // Ends it and throws the audio away.
  cancel: () => void;
}

const MIC_ERRORS: Record<string, string> = {
  NotAllowedError: "Microphone access is blocked for this site.",
  NotFoundError: "No microphone found.",
  NotReadableError: "The microphone is in use by something else.",
};

// Starts recording; `onTimeout` runs if the time limit ends it.
export async function startRecording(onTimeout: () => void): Promise<Recording> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw new Error(MIC_ERRORS[(err as Error).name] ?? `Couldn't use the microphone (${(err as Error).message}).`);
  }
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  const release = () => stream.getTracks().forEach((t) => t.stop());
  const timer = setTimeout(onTimeout, MAX_RECORDING_MS);
  recorder.start();

  const end = async () => {
    clearTimeout(timer);
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    release();
  };
  return {
    cancel: () => void end(),
    finish: async () => {
      await end();
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      if (!bytes.length) return "";
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const res = await fetch("/api/dictation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio: btoa(binary) }),
      });
      const body = (await res.json().catch(() => null)) as { text?: string; error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      return body?.text ?? "";
    },
  };
}

// --- reading aloud --------------------------------------------------------------
//
// The server's Piper voice when it has one (natural, same on every device);
// otherwise the browser's own voices, if it has any.

// Always offered: whether anything can speak is found out when asked.
export const canSpeak = true;

// What is being read: the id of whatever asked, or null. One at a time.
let speakingId: string | null = null;
let generation = 0; // late events from a cancelled reading must not end a newer one
let abort: AbortController | null = null;
const subscribers = new Set<() => void>();
const setSpeaking = (id: string | null) => {
  speakingId = id;
  subscribers.forEach((fn) => fn());
};

export function useSpeaking(): string | null {
  return useSyncExternalStore(
    (fn) => (subscribers.add(fn), () => void subscribers.delete(fn)),
    () => speakingId,
  );
}

// One audio element for everything: iOS only lets an element that was started
// by a tap play later, so it is "unlocked" with a silent clip in speak().
const player = typeof Audio === "undefined" ? null : new Audio();
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

export function stopSpeaking(): void {
  generation++;
  abort?.abort();
  abort = null;
  player?.pause();
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  setSpeaking(null);
}

// Markdown to something worth hearing: no symbols, code blocks skipped.
export function spokenText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "") // table rules
    .replace(/\|/g, ", ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/\n{2,}/g, ".\n")
    .trim();
}

// Browsers cut long utterances off (Chrome after ~15 s), so speak sentence-sized pieces.
function pieces(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.match(/[^.!?\n]+[.!?]*\s*|\n+/g) ?? [text]) {
    const last = out[out.length - 1];
    if (last && last.length + sentence.length < 200) out[out.length - 1] = last + sentence;
    else out.push(sentence);
  }
  return out.map((p) => p.trim()).filter(Boolean);
}

let piperAvailable: Promise<boolean> | null = null;
const hasPiper = () =>
  (piperAvailable ??= fetch("/api/speech").then(
    (r) => (r.ok ? r.json().then((j: { available: boolean }) => j.available) : false),
    () => false,
  ));

async function fetchAudio(text: string, signal: AbortSignal): Promise<string> {
  const res = await fetch("/api/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

// Plays the pieces in order, fetching the next while one plays.
async function speakWithServer(id: string, parts: string[]): Promise<string | undefined> {
  const mine = generation;
  abort = new AbortController();
  const { signal } = abort;
  const audio = player!;
  audio.src = SILENCE; // inside the tap that started this
  audio.play().catch(() => {});
  setSpeaking(id);
  try {
    let next = fetchAudio(parts[0], signal);
    for (let i = 0; i < parts.length; i++) {
      const url = await next;
      if (generation !== mine) {
        URL.revokeObjectURL(url);
        return;
      }
      if (i + 1 < parts.length) next = fetchAudio(parts[i + 1], signal);
      next.catch(() => {}); // surfaced when awaited
      audio.src = url;
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("The browser couldn't play the audio."));
        audio.play().catch(reject);
      }).finally(() => URL.revokeObjectURL(url));
      if (generation !== mine) return;
    }
  } catch (err) {
    if (generation === mine) {
      setSpeaking(null);
      return (err as Error).name === "AbortError" ? undefined : String((err as Error).message ?? err);
    }
    return undefined;
  }
  if (generation === mine) setSpeaking(null);
  return undefined;
}

function speakWithBrowser(id: string, parts: string[]): string | undefined {
  if (typeof speechSynthesis === "undefined" || speechSynthesis.getVoices().length === 0) {
    return "Nothing to speak with: install Piper on the server (see docs/REFERENCE.md) or add voices to this browser.";
  }
  setSpeaking(id);
  const mine = generation;
  parts.forEach((part, i) => {
    const u = new SpeechSynthesisUtterance(part);
    u.lang = navigator.language;
    const done = () => generation === mine && i === parts.length - 1 && setSpeaking(null);
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  });
  return undefined;
}

// Reads `markdown` aloud as `id`, replacing anything being read. Resolves to
// an error message if nothing could speak it.
export async function speak(id: string, markdown: string): Promise<string | undefined> {
  stopSpeaking();
  const parts = pieces(spokenText(markdown));
  if (!parts.length) return undefined;
  if (player && (await hasPiper())) return speakWithServer(id, parts);
  return speakWithBrowser(id, parts);
}

// Reading every new reply aloud, remembered per device.
const AUTO_KEY = "agent-commander.readAloud";
export const autoRead = {
  get: () => localStorage.getItem(AUTO_KEY) === "1",
  set: (on: boolean) => localStorage.setItem(AUTO_KEY, on ? "1" : "0"),
};

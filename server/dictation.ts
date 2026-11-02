// Speech to text for the composer's mic: the browser records, the server
// transcribes with Voxtype's engine (whisper) so every device can dictate,
// whatever its browser. Needs `voxtype` and `ffmpeg` installed; uses the
// model in Voxtype's own config.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

const VOXTYPE = process.env.VOXTYPE_PATH || "voxtype";
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
// A recording whose loudest moment is below this is treated as silence.
const QUIET_DB = -45;

function onPath(command: string): boolean {
  if (path.isAbsolute(command)) return exists(command);
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => dir && exists(path.join(dir, command)));
}

function exists(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function dictationAvailable(): boolean {
  return onPath(VOXTYPE) && onPath("ffmpeg");
}

export class BadAudio extends Error {}

// Resolves to stdout and stderr.
function run(command: string, args: string[], input?: Buffer): Promise<{ out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], timeout: TIMEOUT_MS });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${command} failed (${code}): ${err.slice(-300)}`))));
    child.stdin.on("error", () => {}); // ffmpeg may stop reading early
    child.stdin.end(input);
  });
}

// One at a time: whisper loads a large model, and two at once would fight for memory.
let turn: Promise<unknown> = Promise.resolve();

// The words in a recording (any format ffmpeg reads; browsers send webm or mp4).
export function transcribe(audio: Buffer): Promise<string> {
  const job = turn.then(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-commander-dictation-"));
    try {
      const wav = path.join(dir, "speech.wav");
      // Voxtype wants 16 kHz mono WAV.
      await run("ffmpeg", ["-loglevel", "error", "-y", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], audio).catch(
        () => Promise.reject(new BadAudio("Couldn't read that recording")),
      );
      // On silence whisper makes words up ("www.youtube.com"), so don't ask it.
      const { err } = await run("ffmpeg", ["-i", wav, "-af", "volumedetect", "-f", "null", "-"]);
      const loudest = Number(err.match(/max_volume: (-?[\d.]+) dB/)?.[1] ?? 0);
      if (loudest < QUIET_DB) return "";
      const { out } = await run(VOXTYPE, ["-q", "transcribe", wav]);
      // Its stdout starts with a few "Loading audio file…" lines; the words follow "Processing … samples".
      const lines = out.split("\n");
      const at = lines.findIndex((l) => /^Processing \d+ samples/.test(l));
      const words = at >= 0 ? lines.slice(at + 1) : lines.filter((l) => !/^(Loading audio file|Audio format|Processing )/.test(l));
      return words.join(" ").replace(/\s+/g, " ").trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  turn = job.catch(() => {});
  return job;
}

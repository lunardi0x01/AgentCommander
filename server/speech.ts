// Text to speech: the browser asks for audio of a piece of text and plays it.
// Kokoro first (the resident server of the Cortana project, a much more
// natural voice), else Piper, a smaller local voice that lives in
// $XDG_DATA_HOME/agent-commander/piper (see docs/REFERENCE.md for setup).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PIPER_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "agent-commander", "piper");
const VOICE = process.env.PIPER_VOICE || "en_US-lessac-medium";
const MODEL = path.join(PIPER_DIR, "voices", `${VOICE}.onnx`);
const KOKORO_URL = process.env.KOKORO_URL || "http://127.0.0.1:8811";
const KOKORO_VOICE = process.env.KOKORO_VOICE || "bf_emma"; // its server allows bf_emma and bm_george
const KOKORO_SPEED = process.env.KOKORO_SPEED || "1.2";
const MAX_CHARS = 2000; // the browser sends sentence-sized pieces
const TIMEOUT_MS = 30_000;

const piperInstalled = () => existsSync(path.join(PIPER_DIR, "piper")) && existsSync(MODEL);

// Is the Kokoro server answering? Remembered for a few seconds.
let kokoroChecked = { at: 0, up: false };
async function kokoroUp(): Promise<boolean> {
  if (Date.now() - kokoroChecked.at > 10_000) {
    const up = await fetch(`${KOKORO_URL}/health`, { signal: AbortSignal.timeout(1000) }).then(
      (r) => r.ok,
      () => false,
    );
    kokoroChecked = { at: Date.now(), up };
  }
  return kokoroChecked.up;
}

export async function speechAvailable(): Promise<boolean> {
  return (await kokoroUp()) || piperInstalled();
}

export async function synthesize(text: string): Promise<Buffer> {
  if (await kokoroUp()) {
    try {
      const res = await fetch(`${KOKORO_URL}/speak?voice=${KOKORO_VOICE}&speed=${KOKORO_SPEED}`, {
        method: "POST",
        body: text.slice(0, MAX_CHARS),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch {}
    kokoroChecked.at = 0; // look again next time
  }
  if (!piperInstalled()) throw new Error("No voice available: the Kokoro server is down and Piper isn't installed");
  return piper(text);
}

// WAV audio of `text` from Piper. It loads its voice in ~0.2 s and speaks ~30x faster
// than real time here, so one process per piece is fine.
function piper(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const piper = spawn(path.join(PIPER_DIR, "piper"), ["-m", MODEL, "-f", "-", "--quiet"], {
      env: { ...process.env, LD_LIBRARY_PATH: PIPER_DIR },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: TIMEOUT_MS,
    });
    const out: Buffer[] = [];
    let err = "";
    piper.stdout.on("data", (d: Buffer) => out.push(d));
    piper.stderr.on("data", (d: Buffer) => (err += d));
    piper.on("error", reject);
    piper.on("close", (code) =>
      code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error(`piper failed (${code}): ${err.slice(-200)}`)),
    );
    // One line: piper treats each line as a separate utterance.
    piper.stdin.end(text.slice(0, MAX_CHARS).replace(/\s+/g, " ").trim() + "\n");
  });
}

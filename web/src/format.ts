import { useEffect, useState } from "react";

// "just now", "5m ago", "3h ago", "2d ago", "3w ago", "4mo ago", "2y ago".
// crypto.randomUUID only exists in secure contexts (https, localhost); the app
// is also opened over plain http on the LAN.
export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function relativeTime(ms: number, now = Date.now()): string {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// The same, shortened for the session list: "now", "5m", "3h", "2d", "3w", "4mo", "2y".
export const shortTime = (ms: number, now = Date.now()): string => relativeTime(ms, now).replace(/^just now$/, "now").replace(" ago", "");

// Current time, refreshed every minute so relative times stay accurate.
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function tildePath(path: string, home: string | undefined): string {
  return home && (path === home || path.startsWith(home + "/")) ? "~" + path.slice(home.length) : path;
}

// "850", "42k", "1.2M".
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// Anthropic's prompt cache keeps a conversation's prefix for 5 minutes or an
// hour after its last use; a session's transcript says which it was using.
// Without that, assume the shorter one.
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

// Resuming a conversation this big, with its cache gone, re-sends all of it
// at full price on the next message.
export const BIG_CONTEXT_TOKENS = 100_000;

export const cacheIsCold = (lastActivity: number, ttlMs: number | undefined, now = Date.now()) =>
  now - lastActivity > (ttlMs ?? DEFAULT_CACHE_TTL_MS);

// "in 2h 14m", "in 3d 4h", "in under a minute"; "now" once past.
export function resetsIn(iso: string | number, now = Date.now()): string {
  const ms = (typeof iso === "number" ? iso : Date.parse(iso)) - now;
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

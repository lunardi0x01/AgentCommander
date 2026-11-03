// Gzip for larger responses. Transcripts are big JSON (often MBs) and compress
// about 10x, which matters on a tablet or phone over Wi-Fi.

import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { createHash } from "node:crypto";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";

const gzipAsync = promisify(gzip);
const MIN_BYTES = 1024;

// Sent on every response. style-src needs 'unsafe-inline' because xterm.js
// injects a <style> element; scripts stay 'self' only (the one inline theme
// script in index.html is allowed by hash, see index.ts).
export const CSP = (scriptSrc = "'self'") =>
  `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; ` +
  "connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'";

function withSecurity(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  return { "content-security-policy": CSP(), "x-content-type-options": "nosniff", ...headers };
}

const compressible = (headers: OutgoingHttpHeaders) => !/^image\/(png|jpeg|webp)|^font\//.test(String(headers["content-type"]));

// Static files: gzip and ETag are computed once per file version (mtime+size),
// and a matching If-None-Match gets a 304.
const staticCache = new Map<string, { key: string; etag: string; raw: Buffer; zipped: Buffer | null }>();

// If-None-Match may list several validators and mark them weak (W/"…").
function matchesEtag(header: string | undefined, etag: string): boolean {
  return !!header && header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

export async function sendFile(
  res: ServerResponse,
  file: string,
  mtimeMs: number,
  headers: OutgoingHttpHeaders,
  load: () => Promise<Buffer>,
): Promise<void> {
  let entry = staticCache.get(file);
  if (!entry || entry.key !== String(mtimeMs)) {
    const raw = await load();
    const zipped = raw.length >= MIN_BYTES && compressible(headers) ? await gzipAsync(raw) : null;
    entry = { key: String(mtimeMs), etag: `"${createHash("sha1").update(raw).digest("base64url")}"`, raw, zipped };
    staticCache.set(file, entry);
  }
  const h = withSecurity({ ...headers, etag: entry.etag, vary: "accept-encoding" });
  if (matchesEtag(res.req.headers["if-none-match"], entry.etag)) {
    res.writeHead(304, h);
    return void res.end();
  }
  const gz = entry.zipped && /\bgzip\b/.test(String(res.req.headers["accept-encoding"] ?? ""));
  res.writeHead(200, gz ? { ...h, "content-encoding": "gzip" } : h);
  res.end(gz ? entry.zipped : entry.raw);
}

export async function sendBody(
  res: ServerResponse,
  status: number,
  headers: OutgoingHttpHeaders,
  body: string | Buffer,
): Promise<void> {
  headers = withSecurity(headers);
  const data = typeof body === "string" ? Buffer.from(body) : body;
  const accepts = /\bgzip\b/.test(String(res.req.headers["accept-encoding"] ?? ""));
  if (accepts && data.length >= MIN_BYTES && compressible(headers)) {
    const zipped = await gzipAsync(data);
    res.writeHead(status, { ...headers, "content-encoding": "gzip", vary: "accept-encoding" });
    res.end(zipped);
    return;
  }
  res.writeHead(status, headers);
  res.end(data);
}

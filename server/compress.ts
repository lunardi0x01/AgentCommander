// Gzip for larger responses. Transcripts are big JSON (often MBs) and compress
// about 10x, which matters on a tablet or phone over Wi-Fi.

import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";

const gzipAsync = promisify(gzip);
const MIN_BYTES = 1024;

export async function sendBody(
  res: ServerResponse,
  status: number,
  headers: OutgoingHttpHeaders,
  body: string | Buffer,
): Promise<void> {
  const data = typeof body === "string" ? Buffer.from(body) : body;
  const accepts = /\bgzip\b/.test(String(res.req.headers["accept-encoding"] ?? ""));
  if (accepts && data.length >= MIN_BYTES && !/^image\/(png|jpeg|webp)|^font\//.test(String(headers["content-type"]))) {
    const zipped = await gzipAsync(data);
    res.writeHead(status, { ...headers, "content-encoding": "gzip", vary: "accept-encoding" });
    res.end(zipped);
    return;
  }
  res.writeHead(status, headers);
  res.end(data);
}

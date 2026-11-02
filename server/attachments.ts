// Files attached to a message become content blocks of the user turn: images
// and PDFs natively, anything else as text (binary files are refused).

import type { Attachment } from "../shared/types.ts";

export const MAX_FILES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the API's per-image limit
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
// A request carries them all as base64.
export const MAX_MESSAGE_BYTES = 48 * 1024 * 1024;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const PDF_TYPE = "application/pdf";

export class BadAttachment extends Error {}

// Text files are sent inside this tag; the transcript reader turns it back
// into a name chip instead of showing the whole file as your message.
const FILE_TAG = /^<attached-file name="([^"\n]*)">\n[\s\S]*\n<\/attached-file>$/;

export function attachedFileName(text: string): string | null {
  return text.match(FILE_TAG)?.[1] ?? null;
}

export function parseAttachments(value: unknown): Attachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BadAttachment("Expected attachments: [{ name, mediaType, data }]");
  if (value.length > MAX_FILES) throw new BadAttachment(`At most ${MAX_FILES} files per message`);
  return value.map((v: Partial<Attachment>) => {
    if (typeof v?.name !== "string" || typeof v.mediaType !== "string" || typeof v.data !== "string") {
      throw new BadAttachment("Each attachment needs a name, mediaType and base64 data");
    }
    // Only the last path part, and nothing that could break out of the tag.
    const name = v.name.split(/[\\/]/).pop()!.replace(/["\n\r<>]/g, "").slice(0, 200) || "file";
    return { name, mediaType: v.mediaType.toLowerCase(), data: v.data };
  });
}

type Content = string | Array<Record<string, unknown>>;

// The message's content: plain text, or blocks when there are files.
// Throws BadAttachment for what can't be sent.
export function messageContent(text: string, files: Attachment[]): Content {
  if (!files.length) return text;
  const blocks: Array<Record<string, unknown>> = files.map((f) => {
    const size = Buffer.byteLength(f.data, "base64");
    if (IMAGE_TYPES.includes(f.mediaType)) {
      if (size > MAX_IMAGE_BYTES) throw new BadAttachment(`${f.name} is over 5 MB; images that big aren't accepted`);
      return { type: "image", source: { type: "base64", media_type: f.mediaType, data: f.data } };
    }
    if (f.mediaType === PDF_TYPE) {
      if (size > MAX_PDF_BYTES) throw new BadAttachment(`${f.name} is over 25 MB`);
      return { type: "document", title: f.name, source: { type: "base64", media_type: PDF_TYPE, data: f.data } };
    }
    const bytes = Buffer.from(f.data, "base64");
    if (bytes.length > MAX_TEXT_BYTES) throw new BadAttachment(`${f.name} is over 1 MB; attach a smaller text file`);
    if (bytes.includes(0)) {
      throw new BadAttachment(`${f.name} looks binary. Only images, PDFs and text or code files can be attached`);
    }
    return { type: "text", text: `<attached-file name="${f.name}">\n${bytes.toString("utf8").replace(/\r\n/g, "\n")}\n</attached-file>` };
  });
  if (text) blocks.push({ type: "text", text });
  return blocks;
}

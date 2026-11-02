import type { Attachment } from "../../shared/types.ts";

// Mirrors the server's limits so a bad pick fails before uploading.
export const MAX_FILES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
// Phone photos are huge; Claude reads at most ~1.5k px anyway.
const MAX_IMAGE_EDGE = 2000;

export interface Picked extends Attachment {
  preview?: string; // object URL of an image, for its thumbnail
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// A photo or screenshot, shrunk if large. GIFs stay as they are (animation).
async function shrunk(file: File): Promise<Blob> {
  if (file.type === "image/gif") return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_IMAGE_BYTES) return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const type = file.type === "image/png" ? "image/png" : "image/jpeg";
  return (await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9))) ?? file;
}

// Reads a chosen file; throws a readable message for one that can't be sent.
export async function readAttachment(file: File): Promise<Picked> {
  const name = file.name || "pasted-image";
  const isImage = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type);
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(name);
  if (file.type.startsWith("image/") && !isImage) throw new Error(`${name}: only PNG, JPEG, GIF and WebP images can be attached`);

  const blob = isImage ? await shrunk(file) : file;
  const limit = isImage ? MAX_IMAGE_BYTES : isPdf ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
  if (blob.size > limit) throw new Error(`${name} is over ${limit / 1024 / 1024} MB`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!isImage && !isPdf && bytes.includes(0)) {
    throw new Error(`${name} looks binary. Only images, PDFs and text or code files can be attached`);
  }
  return {
    name,
    mediaType: isImage ? blob.type : isPdf ? "application/pdf" : file.type || "text/plain",
    data: base64(bytes),
    preview: isImage ? URL.createObjectURL(blob) : undefined,
  };
}

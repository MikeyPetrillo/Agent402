// The size of the file a converter tool answers with, per tool.
//
// A converter's input cap bounds what it reads; it says nothing about what it
// writes (an hour of audio fits in a few megabytes of a speech codec and
// encodes to many times that). Each tool that answers with bytes a converter
// produced holds its answer to the cap listed here, checked BEFORE the bytes
// are read into the serving process or turned into base64, through the
// helpers below. A refusal is a 413 that names the limit (>= 400: never
// charged).
//
// A cap is the larger of what the tool's own input bounds already allow and
// twice its input cap; a tool with a cap of its own elsewhere (the Office
// builders, the page stills, the compression tools) is listed in
// ANSWER_CAPS_ELSEWHERE with the file that holds it, so the guard
// (scripts/test-answer-cap.js) finds every byte-answering tool in one of the
// two tables.
import { open, stat } from "node:fs/promises";

export const MB = 1024 * 1024;

/** The media tools' answer: twice their 30 MB input cap. */
export const AUDIO_ANSWER_MAX_BYTES = 60 * MB;
/** The PDF tools' answer: twice their 20 MB per-file input cap. */
export const PDF_ANSWER_MAX_BYTES = 40 * MB;
/** An image answer: the uncompressed pixels of the largest source the image
 *  tools decode (40 megapixels, four bytes each) and a header. Every encoder
 *  here writes at most that, so this is the bound the pixel cap already set. */
export const IMAGE_ANSWER_MAX_BYTES = 40_000_000 * 4 + MB;

/** slug -> the most bytes its converted file may hold. */
export const ANSWER_CAPS = Object.freeze({
  "audio-convert": AUDIO_ANSWER_MAX_BYTES,
  "audio-normalize": AUDIO_ANSWER_MAX_BYTES,
  "pdf-merge": PDF_ANSWER_MAX_BYTES,
  "pdf-extract-pages": PDF_ANSWER_MAX_BYTES,
  "pdf-rotate": PDF_ANSWER_MAX_BYTES,
  "images-to-pdf": PDF_ANSWER_MAX_BYTES,
  "image-resize": IMAGE_ANSWER_MAX_BYTES,
  "image-convert": IMAGE_ANSWER_MAX_BYTES,
  "image-thumbnail": IMAGE_ANSWER_MAX_BYTES,
  "image-crop": IMAGE_ANSWER_MAX_BYTES,
});

/** slug -> where its own answer bound lives. */
export const ANSWER_CAPS_ELSEWHERE = Object.freeze({
  "xlsx-create": "src/tools/office-ops.js OFFICE_LIMITS.outputBytes",
  "docx-create": "src/tools/office-ops.js OFFICE_LIMITS.outputBytes",
  "pptx-create": "src/tools/office-ops.js OFFICE_LIMITS.outputBytes",
  "html-frames": "src/tools/render.js maxOutputBytes",
  "gzip": "src/tools/compression-kit.js MAX_BYTES",
  "gunzip": "src/tools/compression-kit.js MAX_BYTES",
  "brotli-compress": "src/tools/compression-kit.js MAX_BYTES",
  "brotli-decompress": "src/tools/compression-kit.js MAX_BYTES",
});

/** "60 MB" for a cap in bytes (whole megabytes; one decimal otherwise). */
export function capText(bytes) {
  const mb = bytes / MB;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/** The refusal for an answer past its cap: a 413 naming the limit. */
export function answerTooLarge(what, cap, { bytes = null, hint = "" } = {}) {
  const size = Number.isFinite(bytes) ? ` (${capText(Math.ceil(bytes / (MB / 10)) * (MB / 10))})` : "";
  return Object.assign(new Error(`${what} would be larger than the ${capText(cap)} answer limit${size}${hint ? `; ${hint}` : ""}`), { statusCode: 413, answerCapBytes: cap });
}

/** Throws the 413 when `bytes` is past `cap`; returns `bytes` otherwise. */
export function assertAnswerBytes(bytes, cap, what, opts = {}) {
  if (!(bytes <= cap)) throw answerTooLarge(what, cap, { bytes, ...opts });
  return bytes;
}

/** A converter's output file as a Buffer, refused (413) before a byte of it
 *  is read when it is past `cap`. The read itself stops at the cap too, so a
 *  file that grows after the stat is still never held past it. */
export async function readFileWithin(path, cap, what, opts = {}) {
  const { size } = await stat(path);
  assertAnswerBytes(size, cap, what, opts);
  const fh = await open(path, "r");
  try {
    const buf = Buffer.allocUnsafe(size);
    let at = 0;
    while (at < size) {
      const { bytesRead } = await fh.read(buf, at, size - at, at);
      if (bytesRead === 0) break;
      at += bytesRead;
    }
    return at === size ? buf : buf.subarray(0, at);
  } finally {
    await fh.close();
  }
}

/** The bytes a constant-bitrate encode of `seconds` of audio writes. */
export function projectedAudioBytes(seconds, kbps) {
  return Math.ceil((seconds * kbps * 1000) / 8);
}

/** The longest audio, in whole seconds, whose encode at `kbps` fits `cap`. */
export function audioSecondsWithin(cap, kbps) {
  return Math.floor((cap * 8) / (kbps * 1000));
}

/** "41 min 40 s" for a length in seconds. */
export function lengthText(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return [h ? `${h} h` : "", m ? `${m} min` : "", r || (!h && !m) ? `${r} s` : ""].filter(Boolean).join(" ");
}

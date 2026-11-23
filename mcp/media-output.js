// Media answers as files. A tool answer that is bytes (an image, audio, video
// or PDF body), or a JSON answer that carries a large base64 media field, is
// written to a file in the output folder and the tool result names the
// absolute path, the size and the content type instead of carrying the bytes
// inline, where they would fill the model's context.
//
//   AGENT402_OUTPUT_DIR    the folder (default ~/Downloads/agent402 when
//                          ~/Downloads exists, else agent402 in the OS temp
//                          folder; the temp folder too when the first cannot
//                          be written)
//   AGENT402_MEDIA_INLINE  "1" (or true/on) returns media inline as before
//
// File names are made here from a fixed alphabet (the tool's slug, the field
// name, a time stamp and random characters, with an extension from a fixed
// table), bounded in length, and checked to land inside the folder, so
// nothing a seller sends can choose where a file is written.
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mkdirSync, accessSync, existsSync, writeFileSync, constants } from "node:fs";
import { randomBytes } from "node:crypto";

export const OUTPUT_DIR_ENV = "AGENT402_OUTPUT_DIR";
export const MEDIA_INLINE_ENV = "AGENT402_MEDIA_INLINE";
/** A base64 string field at least this long (characters) is a candidate. */
export const LARGE_BASE64_CHARS = 8 * 1024;
const MAX_WALK_DEPTH = 12;
const MAX_FILES_PER_ANSWER = 32;

export const mediaInline = (env = process.env) => /^(1|true|on|yes)$/i.test(String(env[MEDIA_INLINE_ENV] || "").trim());

const EXT = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg",
  "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/ogg": "ogg",
  "audio/opus": "opus", "audio/flac": "flac", "audio/x-flac": "flac", "audio/aac": "aac", "audio/mp4": "m4a", "audio/webm": "weba",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv",
  "application/pdf": "pdf", "application/zip": "zip", "application/gzip": "gz", "application/octet-stream": "bin",
};
// A `format` field's value, mapped to its content type.
const FORMAT_TYPES = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/opus", flac: "audio/flac", aac: "audio/aac", m4a: "audio/mp4",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf" };

/** The bare media type of a Content-Type value, lowercased ("" when none). */
export const bareType = (ct) => String(ct || "").split(";")[0].trim().toLowerCase();

/** True for a type this module writes to a file: image, audio, video, PDF, or other bytes. */
export function isMediaType(ct) {
  const t = bareType(ct);
  return /^(image|audio|video)\/[a-z0-9.+-]+$/.test(t) || t === "application/pdf";
}
/** True for a response body that is bytes, not text or JSON. */
export function isBinaryBody(ct) {
  const t = bareType(ct);
  if (!t) return false;
  if (t.startsWith("text/") || t.includes("json") || t.endsWith("+xml") && !t.startsWith("image/") || t === "application/xml" || t === "application/javascript" || t === "application/x-www-form-urlencoded") return false;
  return true;
}

/** The media type the first bytes name, or null. */
export function sniffType(buf) {
  if (!buf || buf.length < 4) return null;
  const at = (i, ...b) => b.every((x, j) => buf[i + j] === x);
  const ascii = (i, s) => buf.length >= i + s.length && buf.subarray(i, i + s.length).toString("latin1") === s;
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF8")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio/wav";
  if (ascii(0, "%PDF")) return "application/pdf";
  if (ascii(0, "ID3") || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(0, "OggS")) return "audio/ogg";
  if (ascii(0, "fLaC")) return "audio/flac";
  if (ascii(4, "ftyp")) return ascii(8, "M4A") ? "audio/mp4" : "video/mp4";
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return "video/webm";
  return null;
}

/** Candidate folders, in order. */
export function outputDirCandidates({ env = process.env, home = homedir(), tmp = tmpdir() } = {}) {
  const own = String(env[OUTPUT_DIR_ENV] || "").trim();
  const out = [];
  if (own) out.push(resolve(own));
  else if (existsSync(join(home, "Downloads"))) out.push(join(home, "Downloads", "agent402"));
  out.push(join(tmp, "agent402"));
  return out;
}

/** The first candidate folder that can be made and written, or null. */
export function writableOutputDir(candidates) {
  for (const dir of candidates) {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); accessSync(dir, constants.W_OK); return dir; } catch { /* the next one */ }
  }
  return null;
}

const part = (s, max) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);

/** A file name made only from [a-z0-9-.], at most 100 characters. */
export function mediaFileName({ slug, field, contentType, now = new Date() }) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const ext = EXT[bareType(contentType)] || "bin";
  const base = [part(slug, 40) || "result", part(field, 24), stamp, randomBytes(4).toString("hex")].filter(Boolean).join("-");
  return `${base}.${ext}`;
}

/** Write `buf` into `dir` under a made name; returns { path, bytes, contentType }. */
export function saveMedia(buf, { dir, slug, field = "", contentType }) {
  const type = bareType(contentType) || sniffType(buf) || "application/octet-stream";
  const root = resolve(dir);
  const path = resolve(root, mediaFileName({ slug, field, contentType: type }));
  if (!path.startsWith(root + sep)) throw new Error("refused a media file name outside the output folder");
  writeFileSync(path, buf, { mode: 0o600, flag: "wx" });
  return { path, bytes: buf.length, contentType: type };
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const DATA_URI = /^data:([a-z]+\/[a-z0-9.+-]+)(?:;[a-z0-9=._-]+)*;base64,/i;
const TYPE_KEYS = ["contentType", "content_type", "mimeType", "mime_type", "mediaType", "media_type"];

/** The media a string field holds, as { buf, contentType }, or null. A field
 *  counts when it is long, is base64 (or a base64 data: URI), and its type is
 *  media: named by the data: URI, by its own first bytes, or (for a field
 *  whose name reads as media) by a sibling content-type or format field. */
export function mediaOfField(value, siblings = {}, { minChars = LARGE_BASE64_CHARS, field = "" } = {}) {
  if (typeof value !== "string" || value.length < minChars) return null;
  let body = value, declared = null;
  const m = DATA_URI.exec(value.slice(0, 200));
  if (m) { declared = m[1].toLowerCase(); body = value.slice(m[0].length); }
  if (!(B64.test(body) || B64URL.test(body))) return null;
  const buf = Buffer.from(body, B64.test(body) ? "base64" : "base64url");
  if (!buf.length) return null;
  const sniffed = sniffType(buf);
  // A sibling field describes the object, not each field in it, so it names
  // this field's type only when the field's own name reads as media and its
  // first bytes do not say otherwise.
  if (!declared && MEDIA_FIELD.test(field) && !sniffed) {
    for (const k of TYPE_KEYS) if (typeof siblings[k] === "string" && isMediaType(siblings[k])) { declared = bareType(siblings[k]); break; }
    if (!declared && typeof siblings.format === "string") declared = FORMAT_TYPES[siblings.format.trim().toLowerCase()] || null;
  }
  const type = declared && isMediaType(declared) ? declared : sniffed;
  return type && isMediaType(type) ? { buf, contentType: type } : null;
}
const MEDIA_FIELD = /audio|image|img|video|picture|photo|png|jpe?g|webp|mp3|mp4|wav|pdf|^data$|b64|base64|bytes/i;

/** A copy of `doc` in which each large base64 media field is replaced by
 *  { savedTo, bytes, contentType }, with the list of files written.
 *  `save(buf, { field, contentType })` writes one and returns { path, bytes, contentType }. */
export function extractMediaFields(doc, save, opts = {}) {
  const files = [];
  const walk = (v, key, depth) => {
    if (depth > MAX_WALK_DEPTH || v == null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, key, depth + 1));
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const media = files.length < MAX_FILES_PER_ANSWER ? mediaOfField(x, v, { ...opts, field: k }) : null;
      if (media) {
        const f = save(media.buf, { field: k, contentType: media.contentType });
        files.push({ field: k, ...f });
        out[k] = { savedTo: f.path, bytes: f.bytes, contentType: f.contentType };
      } else out[k] = walk(x, k, depth + 1);
    }
    return out;
  };
  return { value: walk(doc, "", 0), files };
}

/** The line a tool result carries for one saved file. */
export const savedLine = (f) => `Saved ${f.contentType} (${f.bytes.toLocaleString("en-US")} bytes) to ${f.path}`;

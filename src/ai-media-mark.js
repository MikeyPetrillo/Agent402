// The AI-generated mark written INTO a generated file (EU AI Act Art. 50(2):
// machine-readable and detectable in the output itself, so the mark survives
// once the file is saved and the response header is gone).
//
// What is written: the IPTC Digital Source Type "trainedAlgorithmicMedia"
//   - PNG: an iTXt chunk "XML:com.adobe.xmp" (an XMP packet) after IHDR;
//   - JPEG: an APP1 XMP segment after SOI (and after a JFIF APP0);
//   - WebP: an "XMP " chunk, with the extended (VP8X) header's XMP flag set
//     (a simple-format file gets a VP8X header built from its own frame size);
//   - MP3: an ID3v2.3 tag with a TXXX frame "DigitalSourceType", only when
//     the file carries no ID3 tag yet.
// What is never touched: a file that already carries content credentials
// (C2PA / JUMBF: a PNG caBX chunk, a JPEG APP11 segment, a WebP C2PA chunk),
// whose hard binding a byte change would break, or an XMP packet of its own
// (one packet per file); any other format; anything that does not parse as
// the format its magic bytes claim. Every path returns the input unchanged on
// doubt, and nothing here throws. Pure (scripts/test-ai-generated.js).
import { crc32 } from "node:zlib";

export const DIGITAL_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
const XMP_NS = "http://ns.adobe.com/xap/1.0/";

export const AI_XMP_PACKET = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" Iptc4xmpExt:DigitalSourceType="${DIGITAL_SOURCE_TYPE}"/></rdf:RDF></x:xmpmeta><?xpacket end="r"?>`;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isBuf = (b) => Buffer.isBuffer(b) || b instanceof Uint8Array;

/** The media kind the bytes' own magic says, or null. */
export function sniffMedia(buf) {
  if (!isBuf(buf) || buf.length < 12) return null;
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.subarray(0, 8).equals(PNG_SIG)) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (b.toString("latin1", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "mp3";
  return null;
}

function markPng(b) {
  // Walk the chunks: refuse on a malformed file, a C2PA chunk or an XMP of its own.
  let off = 8, ihdrEnd = -1;
  while (off + 12 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("latin1", off + 4, off + 8);
    const end = off + 12 + len;
    if (end > b.length) return null;
    if (type === "IHDR") ihdrEnd = end;
    if (type === "caBX") return null;
    if ((type === "iTXt" || type === "tEXt" || type === "zTXt") && b.toString("latin1", off + 8, off + 8 + Math.min(len, 17)) === "XML:com.adobe.xmp") return null;
    if (type === "IEND") break;
    off = end;
  }
  if (ihdrEnd < 0) return null;
  const data = Buffer.concat([Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "latin1"), Buffer.from(AI_XMP_PACKET, "utf8")]);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write("iTXt", 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([b.subarray(0, ihdrEnd), head, data, crc, b.subarray(ihdrEnd)]);
}

function markJpeg(b) {
  // Read the marker segments up to the image data.
  let off = 2, insertAt = 2;
  while (off + 4 <= b.length && b[off] === 0xff) {
    const marker = b[off + 1];
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
    const len = b.readUInt16BE(off + 2);
    if (len < 2 || off + 2 + len > b.length) return null;
    if (marker === 0xeb) return null; // APP11: JUMBF (C2PA)
    if (marker === 0xe1 && b.toString("latin1", off + 4, off + 4 + XMP_NS.length) === XMP_NS) return null;
    if (marker === 0xe0 && off === 2) insertAt = off + 2 + len; // after a leading JFIF APP0
    off += 2 + len;
  }
  const payload = Buffer.concat([Buffer.from(`${XMP_NS}\0`, "latin1"), Buffer.from(AI_XMP_PACKET, "utf8")]);
  if (payload.length + 2 > 0xffff) return null;
  const seg = Buffer.alloc(4);
  seg[0] = 0xff; seg[1] = 0xe1;
  seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([b.subarray(0, insertAt), seg, payload, b.subarray(insertAt)]);
}

function webpChunk(type, data) {
  const h = Buffer.alloc(8);
  h.write(type, 0, "latin1");
  h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function markWebp(b) {
  const chunks = [];
  let off = 12;
  const riffEnd = Math.min(b.length, 8 + b.readUInt32LE(4));
  while (off + 8 <= riffEnd) {
    const type = b.toString("latin1", off, off + 4);
    const len = b.readUInt32LE(off + 4);
    const end = off + 8 + len + (len % 2);
    if (off + 8 + len > b.length) return null;
    chunks.push({ type, start: off, end: Math.min(end, b.length), data: b.subarray(off + 8, off + 8 + len) });
    off = end;
  }
  if (!chunks.length || chunks.some((c) => c.type === "XMP " || c.type === "C2PA")) return null;
  let vp8x = chunks.find((c) => c.type === "VP8X");
  let out;
  const xmp = webpChunk("XMP ", Buffer.from(AI_XMP_PACKET, "utf8"));
  if (vp8x) {
    if (vp8x.data.length < 10) return null;
    const head = Buffer.from(b.subarray(vp8x.start, vp8x.end));
    head[8] |= 0x04; // the XMP flag
    out = Buffer.concat([b.subarray(12, vp8x.start), head, b.subarray(vp8x.end, off), xmp]);
  } else {
    // Simple format: one VP8 or VP8L chunk; the canvas size comes from it.
    const img = chunks[0];
    let w, h;
    if (img.type === "VP8L" && img.data.length >= 5 && img.data[0] === 0x2f) {
      const bits = img.data.readUInt32LE(1);
      w = (bits & 0x3fff) + 1; h = ((bits >>> 14) & 0x3fff) + 1;
    } else if (img.type === "VP8 " && img.data.length >= 10 && img.data[3] === 0x9d && img.data[4] === 0x01 && img.data[5] === 0x2a) {
      w = img.data.readUInt16LE(6) & 0x3fff; h = img.data.readUInt16LE(8) & 0x3fff;
    } else return null;
    if (!(w > 0 && h > 0)) return null;
    const d = Buffer.alloc(10);
    // The XMP flag, and the alpha flag when a lossless frame says it uses alpha
    // (a simple lossy file has no alpha).
    d[0] = 0x04 | (img.type === "VP8L" && (img.data.readUInt32LE(1) >>> 28) & 1 ? 0x10 : 0);
    d.writeUIntLE(w - 1, 4, 3);
    d.writeUIntLE(h - 1, 7, 3);
    out = Buffer.concat([webpChunk("VP8X", d), b.subarray(12, off), xmp]);
  }
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(out.length + 4, 4);
  riff.write("WEBP", 8, "latin1");
  return Buffer.concat([riff, out]);
}

function markMp3(b) {
  if (b.toString("latin1", 0, 3) === "ID3") return null; // a tag of its own: left as it is
  const enc = (s) => Buffer.from(s, "latin1");
  const frameData = Buffer.concat([Buffer.from([0x00]), enc("DigitalSourceType"), Buffer.from([0x00]), enc(DIGITAL_SOURCE_TYPE)]);
  const fh = Buffer.alloc(10);
  fh.write("TXXX", 0, "latin1");
  fh.writeUInt32BE(frameData.length, 4);
  const body = Buffer.concat([fh, frameData]);
  const th = Buffer.alloc(10);
  th.write("ID3", 0, "latin1");
  th[3] = 3; th[4] = 0; th[5] = 0;
  const n = body.length; // syncsafe size
  th[6] = (n >>> 21) & 0x7f; th[7] = (n >>> 14) & 0x7f; th[8] = (n >>> 7) & 0x7f; th[9] = n & 0x7f;
  return Buffer.concat([th, body, b]);
}

/** The bytes with the AI-generated mark written in, or the same bytes when
 *  the format is not one we mark, already carries credentials or XMP, or does
 *  not parse. Never throws. */
export function markMediaBytes(buf) {
  try {
    const kind = sniffMedia(buf);
    if (!kind) return buf;
    const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const out = kind === "png" ? markPng(b) : kind === "jpeg" ? markJpeg(b) : kind === "webp" ? markWebp(b) : markMp3(b);
    return out || buf;
  } catch {
    return buf;
  }
}

/** The same, for base64 text (an image inside a JSON answer). */
export function markMediaBase64(text) {
  if (typeof text !== "string" || text.length < 16) return text;
  try {
    const bytes = Buffer.from(text, "base64");
    const out = markMediaBytes(bytes);
    return out === bytes ? text : out.toString("base64");
  } catch {
    return text;
  }
}

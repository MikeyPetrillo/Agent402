// Container structure readers for the image tools: what each decoder will
// size its buffers from, read without decoding a pixel.
//
// The pixel cap in image-ops.js is only as good as the agreement between the
// header it reads and the header the decoder acts on. Each reader here follows
// the decoder's own walk of the container (or runs the decoder's own parser),
// so a file whose first size field is small and whose decoded size is not is
// refused with a 400 before any canvas is allocated. The section for each
// format says which field its decoder really sizes from.
//
// Pure byte reads plus zlib: no network, no filesystem, no jimp import.
import { createRequire } from "node:module";
import zlib from "node:zlib";

function bad(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// ---------------------------------------------------------------- PNG ------

const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** The chunk list as pngjs walks it: length-prefixed, linear, ending at IEND.
 *  Returns how many IHDR chunks it holds and the IDAT payloads in order. */
export function pngChunks(buf) {
  let ihdr = 0;
  const idat = [];
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    if (type === "IHDR") ihdr++;
    else if (type === "IDAT") idat.push(buf.subarray(i + 8, Math.min(i + 8 + len, buf.length)));
    else if (type === "IEND") break;
    i += 12 + len;
  }
  return { ihdr, idat, firstIsIhdr: buf.length >= 16 && buf.toString("latin1", 12, 16) === "IHDR" };
}

/** A PNG the decoder would size from a header other than the first: refused. */
export function assertPngHeader(buf) {
  const { ihdr, firstIsIhdr } = pngChunks(buf);
  if (!firstIsIhdr) throw bad("png does not start with an IHDR chunk");
  if (ihdr > 1) throw bad(`png carries ${ihdr} IHDR chunks; exactly one is allowed`);
}

/** Bytes an interlaced PNG's image data inflates to: seven Adam7 passes, each
 *  row one filter byte plus its packed samples. Null for a header pngjs
 *  refuses on its own (it never inflates those). */
export function pngInterlacedSize(buf) {
  if (buf.length < 29) return null;
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  const bits = buf[24] * (PNG_CHANNELS[buf[25]] || 0);
  if (!bits || ![1, 2, 4, 8, 16].includes(buf[24])) return null;
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  let total = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const w = Math.ceil((width - x0) / dx), h = Math.ceil((height - y0) / dy);
    if (w > 0 && h > 0) total += h * (1 + Math.ceil((w * bits) / 8));
  }
  return total;
}

// Inflate under an output bound. True when the stream stays within it; a
// stream that is damaged or cut short is left for the decoder to report.
function inflatesWithin(data, bound, raw) {
  const opts = { maxOutputLength: Math.max(1, Math.floor(bound)), finishFlush: zlib.constants.Z_SYNC_FLUSH };
  try { (raw ? zlib.inflateRawSync : zlib.inflateSync)(data, opts); return true; }
  catch (e) { return e?.code !== "ERR_BUFFER_TOO_LARGE"; }
}

const INFLATE_SLACK = 64;

// ---------------------------------------------------------------- JPEG -----

const isFrameHeader = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** Frame headers (SOFn) on a JPEG's top-level marker chain, in order, up to
 *  `max` of them: [{ width, height }]. Segments are skipped by their length, so
 *  a thumbnail inside an APPn segment is never read as a frame of this image;
 *  after a start-of-scan the entropy-coded data is skipped to the next marker
 *  (0xFF followed by anything but a stuffed zero or a restart marker). Stops at
 *  the end-of-image marker, as the decoder does. */
export function jpegFrameHeaders(buf, max = Infinity) {
  const frames = [];
  let i = 2;
  while (i + 3 < buf.length && frames.length < max) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    if (marker === 0xd9) break;
    const len = buf.readUInt16BE(i + 2);
    if (isFrameHeader(marker) && i + 9 <= buf.length) {
      frames.push({ height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) });
    }
    if (len < 2) break;
    i += 2 + len;
    if (marker === 0xda) {
      // Entropy-coded data: hop between 0xFF bytes (native search) to the next
      // real marker.
      for (;;) {
        const ff = buf.indexOf(0xff, i);
        if (ff < 0 || ff + 1 >= buf.length) { i = buf.length; break; }
        const next = buf[ff + 1];
        if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) { i = ff; break; }
        i = ff + 2;
      }
    }
  }
  return frames;
}

/** The decoder keeps the last frame header it meets, so more than one is refused. */
export function assertJpegHeader(buf) {
  const frames = jpegFrameHeaders(buf, 2);
  if (frames.length > 1) throw bad("jpeg carries more than one frame header (SOF); exactly one is allowed");
}

// ---------------------------------------------------------------- GIF ------

// The parser the decoder itself uses: the omggif copy that jimp's GIF codec
// loads, resolved through jimp's own packages so this file declares no
// dependency of its own. Loaded on the first GIF, not at boot.
let GifReader = null;
function loadGifReader() {
  if (!GifReader) {
    const here = createRequire(import.meta.url);
    const jimpGif = createRequire(here.resolve("jimp")).resolve("@jimp/js-gif");
    GifReader = createRequire(jimpGif)("omggif").GifReader;
  }
  return GifReader;
}

/** Frame 0 of a GIF as the decoder reads it: { screen: { width, height },
 *  frame: { x, y, width, height } }. The constructor only walks the block
 *  list. Throws a 400 for a GIF the reader rejects or that has no frame. */
export function gifFirstFrame(buf) {
  let reader;
  try { reader = new (loadGifReader())(buf); }
  catch (e) { throw bad(`gif could not be read: ${String(e?.message || e).slice(0, 120)}`); }
  if (reader.numFrames() < 1) throw bad("gif has no image frame");
  const f = reader.frameInfo(0);
  return { screen: { width: reader.width, height: reader.height }, frame: { x: f.x, y: f.y, width: f.width, height: f.height } };
}

/** The decoder sizes its index buffer from frame 0's own rectangle, so a frame
 *  that reaches past the screen in either direction is refused. */
export function assertGifHeader(buf) {
  const { screen, frame } = gifFirstFrame(buf);
  if (frame.x + frame.width > screen.width || frame.y + frame.height > screen.height) {
    throw bad(`gif frame (${frame.width}x${frame.height} at ${frame.x},${frame.y}) extends past its ${screen.width}x${screen.height} canvas`);
  }
}

// ---------------------------------------------------------------- TIFF -----

// Bytes per value for the tag types the decoder reads; any other type is skipped.
const TIFF_UNIT = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
// Types the decoder reads with one loop turn per declared value.
const TIFF_LOOPED = new Set([3, 4, 5, 8, 9, 10, 11, 12, 13]);
// Tags whose first value sizes an allocation or picks a code path.
const TIFF_SCALAR = new Set([256, 257, 258, 259, 262, 277, 278, 322, 323]);
const TIFF_OFFSETS = new Set([273, 279, 324, 325]);
// Tags whose values the decoder follows as further directories.
const TIFF_POINTER = new Set([330, 34665, 34853, 61440]);
// Compressions whose decoder holds nothing but the buffer the directory sized:
// none, LZW, deflate (inflated under a bound first), PackBits. The others keep
// state that grows with the data (the CCITT schemes build each row as an
// array with no width limit) or carry size fields of their own (JPEG, the
// camera raw schemes), so the header does not bound them.
const TIFF_COMPRESSION = new Set([1, 5, 8, 32946, 32773]);
export const TIFF_MAX_PAGES = 32;
const TIFF_MAX_DIRECTORIES = 64;
// Decoded sample bytes allowed per pixel of the cap (16-bit RGBA).
const TIFF_BYTES_PER_CAP_PIXEL = 8;

/** Every directory the TIFF decoder will read, walked the way it walks them:
 *  the page chain (next-directory offsets), plus the sub-directories it
 *  follows. Returns { pages, pixels, bytes }: per page its size, compression
 *  and strip or tile table, the pixel total and the decoded-sample byte total
 *  across pages. Throws a 400 for a layout whose decode is not bounded by
 *  those totals: a looping or over-long chain, tags declaring more values
 *  than the file holds, a size tag that is not SHORT or LONG, a strip or tile
 *  that runs past the end of the file, a tile larger than `maxPixels`, a
 *  compression or maker note read by a decoder with its own size fields. */
export function tiffLayout(buf, maxPixels = Infinity) {
  const le = buf[0] === 0x49;
  // Reads past the end answer zero, as the decoder's do.
  const g = (p) => (p >= 0 && p < buf.length ? buf[p] : 0);
  const u16 = (p) => (le ? (g(p + 1) << 8) | g(p) : (g(p) << 8) | g(p + 1));
  const u32 = (p) => (le ? (g(p) | (g(p + 1) << 8) | (g(p + 2) << 16) | (g(p + 3) << 24)) : ((g(p) << 24) | (g(p + 1) << 16) | (g(p + 2) << 8) | g(p + 3))) >>> 0;
  let directories = 0;
  // Bytes of tag values the decoder copies out of the file, across every
  // directory. Values do not overlap in a real file, so the file's own length
  // bounds them; BYTE and UNDEFINED values are views, never copies.
  let valueBytes = 0;

  // One directory. Returns its tags (tag -> { type, num, at }), or null when
  // the decoder drops it (an unreadable first entry).
  const readDirectory = (offset) => {
    if (++directories > TIFF_MAX_DIRECTORIES) throw bad(`tiff holds more than ${TIFF_MAX_DIRECTORIES} directories`);
    const count = u16(offset);
    const tags = new Map();
    for (let k = 0; k < count; k++) {
      const e = offset + 2 + k * 12;
      if (e >= buf.length) break; // the rest read as empty entries
      const tag = u16(e), type = u16(e + 2), num = u32(e + 4), voff = u32(e + 8);
      const unit = TIFF_UNIT[type];
      // A tag that sizes an allocation or names an offset must be the integer
      // type the format gives it, so this reader and the decoder see one value.
      if ((TIFF_SCALAR.has(tag) || TIFF_OFFSETS.has(tag)) && ((type !== 3 && type !== 4) || num < 1)) {
        throw bad(`tiff tag ${tag} is not a SHORT or LONG value`);
      }
      if (TIFF_POINTER.has(tag) && ((type !== 4 && type !== 13) || num < 1)) {
        throw bad(`tiff tag ${tag} is not a directory offset`);
      }
      if (tag === 37500 && type !== 1 && type !== 7) throw bad("tiff maker note is not a byte field");
      if (!unit) { if (num !== 0 && k === 0) return null; continue; }
      if (TIFF_LOOPED.has(type) && num * unit > buf.length) {
        throw bad(`tiff tag ${tag} declares ${num} values, more than the file holds`);
      }
      if (type !== 1 && type !== 7) {
        valueBytes += Math.min(num * unit, buf.length);
        if (valueBytes > buf.length) throw bad("tiff tags declare more value bytes than the file holds");
      }
      // Where the values sit: inline when they fit the 4-byte field.
      const inline = type === 3 || type === 8 ? num < 3 : type === 4 || type === 9 || type === 13 ? num < 2 : num < 5;
      const at = inline ? e + 8 : voff;
      tags.set(tag, { type, num, at });
      if (tag === 45 || tag === 50740 || tag === 50885) throw bad(`tiff tag ${tag} marks a camera raw file, which is not supported; send png or jpeg`);
      if (TIFF_POINTER.has(tag)) {
        for (let j = 0; j < num; j++) readDirectory(u32(at + 4 * j));
      }
      if (tag === 37500) {
        const head = buf.toString("latin1", Math.min(at, buf.length), Math.min(at + Math.min(num, 9), buf.length));
        if (head.startsWith("Nikon") || head.startsWith("OLYMP") || head.startsWith("OM SYSTEM")) {
          throw bad("tiff carries a camera maker note in a layout that is not supported; send png or jpeg");
        }
        if (u16(voff) < 300 && u16(voff + 4) <= 12) readDirectory(voff);
      }
    }
    return tags;
  };

  const value = (tags, tag, j = 0) => {
    const t = tags.get(tag);
    if (!t || j >= t.num) return undefined;
    return t.type === 3 ? u16(t.at + 2 * j) : u32(t.at + 4 * j);
  };

  const pages = [];
  const seen = new Set();
  let offset = u32(4);
  for (;;) {
    const count = u16(offset), firstType = u16(offset + 4);
    if (count !== 0 && (firstType < 1 || firstType > 13)) break;
    if (seen.has(offset)) throw bad("tiff directory chain loops back on itself");
    seen.add(offset);
    if (seen.size > TIFF_MAX_PAGES) throw bad(`tiff holds more than ${TIFF_MAX_PAGES} pages`);
    const tags = readDirectory(offset);
    if (tags && tags.has(256)) pages.push(tags);
    offset = u32(offset + 2 + count * 12);
    if (offset === 0) break;
  }

  let pixels = 0, bytes = 0;
  const out = [];
  for (const tags of pages) {
    const width = value(tags, 256), height = value(tags, 257) ?? 0;
    const compression = value(tags, 259) ?? 1;
    if (!TIFF_COMPRESSION.has(compression)) throw bad(`tiff compression ${compression} is not supported; send png or jpeg`);
    const photometric = value(tags, 262);
    if (photometric === 32803 || photometric === 34892) throw bad("tiff holds raw sensor data, which is not supported; send png or jpeg");
    const bitsPerPixel = (value(tags, 258) ?? 1) * (value(tags, 277) ?? 1);
    const sampleBytes = height * Math.ceil((width * bitsPerPixel) / 8);
    const tiled = tags.has(322);
    let tileBytes = 0, tiles = 0;
    if (tiled) {
      const tw = value(tags, 322), th = value(tags, 323) ?? 0;
      if (tw < 1 || th < 1) throw bad("tiff tile size is zero");
      if (tw * th > maxPixels) throw bad(`source image too large (tiff tile ${tw}x${th}; max ${maxPixels} pixels)`);
      tileBytes = Math.ceil((tw * th * bitsPerPixel) / 8);
      tiles = Math.floor((width + tw - 1) / tw) * Math.floor((height + th - 1) / th);
    }
    pixels += width * height;
    bytes += sampleBytes + tileBytes;
    // The decoder takes strip offsets from 273 and byte counts from 279, and
    // the tile tables (324, 325) when the page is tiled or those are absent.
    const offsetsTag = !tags.has(273) || tiled ? 324 : 273;
    const countsTag = !tags.has(279) || tiled ? 325 : 279;
    const parts = tiled ? Math.min(tiles, tags.get(offsetsTag)?.num ?? 0) : tags.get(offsetsTag)?.num ?? 0;
    const part = (j) => ({ offset: value(tags, offsetsTag, j), length: value(tags, countsTag, j) });
    // Each strip or tile is read for as many bytes as its count says. One
    // uncompressed strip is the exception: the decoder sizes it from the page.
    if (tags.has(countsTag) && !(compression === 1 && !tiled && parts === 1)) {
      for (let j = 0; j < parts; j++) {
        const { offset: at, length } = part(j);
        if (length === undefined) throw bad(`tiff ${tiled ? "tile" : "strip"} ${j} has no byte count`);
        if (at + length > buf.length) throw bad(`tiff ${tiled ? "tile" : "strip"} ${j} runs past the end of the file`);
      }
    }
    out.push({ width, height, compression, sampleBytes, tileBytes, tiled, parts, part });
  }
  return { pages: out, pixels, bytes };
}

/** The pixel cap applied to everything a TIFF makes the decoder allocate. */
export function assertTiffHeader(buf, maxPixels) {
  const { pixels, bytes } = tiffLayout(buf, maxPixels);
  if (pixels > maxPixels) throw bad(`source image too large (tiff pages total ${pixels} pixels; max ${maxPixels} pixels)`);
  const maxBytes = maxPixels * TIFF_BYTES_PER_CAP_PIXEL;
  if (bytes > maxBytes) throw bad(`source image too large (tiff samples decode to ${bytes} bytes; max ${maxBytes})`);
}

// ---------------------------------------------------------------- inflate --

/** Where a decoder inflates with no output bound, runs the same inflate first
 *  under the size the header declares, and throws a 400 when the data inflates
 *  past it. `format` is sniffFormat's answer. This is real work (it inflates),
 *  so it runs in the worker, never on the main thread. */
export function assertInflateWithinDeclared(buf, format) {
  // pngjs bounds its inflate by the image size only when the PNG is not interlaced.
  if (format === "png" && buf.length >= 29 && buf[28] === 1) {
    const size = pngInterlacedSize(buf);
    if (size === null) return;
    const { idat } = pngChunks(buf);
    if (!inflatesWithin(Buffer.concat(idat), size + INFLATE_SLACK, false)) {
      throw bad(`interlaced png inflates past the ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)} image its header declares`);
    }
  }
  // utif2 inflates each strip or tile of a deflate TIFF whole.
  if (format === "tiff") {
    for (const page of tiffLayout(buf).pages) {
      if (page.compression !== 8 && page.compression !== 32946) continue;
      const bound = (page.tiled ? page.tileBytes : page.sampleBytes) + INFLATE_SLACK;
      for (let j = 0; j < page.parts; j++) {
        // The decoder inflates the bytes between a 2-byte head and a 4-byte tail.
        const { offset, length } = page.part(j);
        const start = offset + 2, n = (length ?? NaN) - 6;
        if (!(n >= 0) || start + n > buf.length) break; // the decoder stops here on its own
        if (!inflatesWithin(buf.subarray(start, start + n), bound, true)) {
          throw bad(`tiff ${page.tiled ? "tile" : "strip"} ${j} inflates past the ${page.width}x${page.height} page its directory declares`);
        }
      }
    }
  }
}

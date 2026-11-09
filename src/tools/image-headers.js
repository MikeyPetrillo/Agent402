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
//
// The image tools use one image of a TIFF: the first directory the decoder
// keeps. The decoder itself reads every directory in the chain and decodes
// each page, follows sub-directories and maker notes, loops once per value a
// tag declares, and sizes buffers from the sample layout, the tile size and
// (for JPEG and deflate data) from fields inside the compressed stream. So:
//  - tiffLayout reads that one directory the way the decoder does and bounds
//    what it declares;
//  - tiffDecoderView hands the decoder a copy of the file in which that
//    directory is the only one, the tags that start a further walk carry an
//    unused tag number, and no strip or tile runs past the end of the file.
//    None of that changes the pixels of the image the tools use;
//  - assertTiffStreams (worker) bounds the data whose size the directory does
//    not state: deflate output and embedded JPEG frame headers.
// CCITT data is the one kind the header cannot bound (the decoder's row buffer
// grows with the data, not with the page width), so readImage decodes those in
// a one-shot child process with its own heap ceiling and deadline.

// Bytes per value for the tag types the decoder reads; any other type is skipped.
const TIFF_UNIT = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
// Types the decoder reads with one loop turn per declared value.
const TIFF_LOOPED = new Set([3, 4, 5, 8, 9, 10, 11, 12, 13]);
// Tags whose first value sizes an allocation or picks a code path, and tags
// that hold file offsets or byte counts. Each must be BYTE, SHORT or LONG, so
// this reader and the decoder take the same number from it.
const TIFF_SCALAR = new Set([256, 257, 258, 259, 262, 277, 278, 322, 323, 513, 514, 50885]);
const TIFF_OFFSETS = new Set([273, 279, 324, 325, 519, 520, 521]);
// Tags that make the decoder read further directories or parse a maker note.
// Nothing they lead to feeds the pixels of the first image.
const TIFF_WALKED = new Set([330, 34665, 34853, 61440, 50740, 37500]);
const TIFF_INERT_TAG = 65000;
const TIFF_FAX = new Set([2, 3, 4]);
const TIFF_JPEG = new Set([6, 7, 34892]);
// Compressions whose decoder sizes its buffers from fields inside its own
// stream, with no reader here: CineForm (9) and Panasonic raw (34316).
const TIFF_UNBOUNDED = new Set([9, 34316]);
// Directories the decoder may drop before the one it keeps.
const TIFF_MAX_SKIPPED = 64;
// Decoded sample bytes allowed per pixel of the cap (16-bit RGBA).
const TIFF_BYTES_PER_CAP_PIXEL = 8;

/** The first image of a TIFF as the decoder will read it. Returns
 *  { directory, next, renames, clamps, page }: the directory's offset, where
 *  its next-directory offset sits, the entries tiffDecoderView renames or
 *  clamps, and for a directory with a width the page's size, compression and
 *  strip or tile table (null otherwise). Throws a 400 for a directory whose
 *  decode the header cannot bound: tags declaring more values than the file
 *  holds, a size tag of a non-integer type, a page, tile or sample layout
 *  past `maxPixels`, or a compression with size fields no reader here covers. */
export function tiffLayout(buf, maxPixels = Infinity) {
  const le = buf[0] === 0x49;
  // Reads past the end answer zero, as the decoder's do.
  const g = (p) => (p >= 0 && p < buf.length ? buf[p] : 0);
  const u16 = (p) => (le ? (g(p + 1) << 8) | g(p) : (g(p) << 8) | g(p + 1));
  const u32 = (p) => (le ? (g(p) | (g(p + 1) << 8) | (g(p + 2) << 16) | (g(p + 3) << 24)) : ((g(p) << 24) | (g(p + 1) << 16) | (g(p + 2) << 8) | g(p + 3))) >>> 0;
  let renames = [];

  // One directory. Returns its tags (tag -> { type, num, at }), or null when
  // the decoder drops it (an unreadable first entry).
  const readDirectory = (offset) => {
    const count = u16(offset);
    const tags = new Map();
    renames = [];
    // Bytes of tag values the decoder copies out of the file. Values do not
    // overlap in a real file, so the file's own length bounds them; BYTE and
    // UNDEFINED values are views, never copies.
    let valueBytes = 0;
    for (let k = 0; k < count; k++) {
      const e = offset + 2 + k * 12;
      if (e >= buf.length) break; // the rest read as empty entries
      const tag = u16(e), type = u16(e + 2), num = u32(e + 4), voff = u32(e + 8);
      const unit = TIFF_UNIT[type];
      // Renamed whatever its type: the decoder follows these even when it
      // could not read their value.
      if (TIFF_WALKED.has(tag) && e + 2 <= buf.length) renames.push(e);
      if ((TIFF_SCALAR.has(tag) || TIFF_OFFSETS.has(tag)) && ((type !== 1 && type !== 3 && type !== 4) || num < 1)) {
        throw bad(`tiff tag ${tag} is not a BYTE, SHORT or LONG value`);
      }
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
      tags.set(tag, { type, num, at: inline ? e + 8 : voff });
    }
    return tags;
  };
  const value = (tags, tag, j = 0) => {
    const t = tags.get(tag);
    if (!t || j >= t.num) return undefined;
    return t.type === 1 ? g(t.at + j) : t.type === 3 ? u16(t.at + 2 * j) : u32(t.at + 4 * j);
  };
  // Where value j of an integer tag sits, and how wide it is.
  const slot = (tags, tag, j) => { const t = tags.get(tag); const size = t.type === 1 ? 1 : t.type === 3 ? 2 : 4; return { at: t.at + size * j, size }; };

  // The decoder returns the first directory it keeps; a chain start it cannot
  // read ends the file there.
  let offset = u32(4), directory = -1, tags = null, count = 0;
  const seen = new Set();
  while (!tags) {
    count = u16(offset);
    const firstType = u16(offset + 4);
    if ((count !== 0 && (firstType < 1 || firstType > 13)) || seen.has(offset) || seen.size >= TIFF_MAX_SKIPPED) break;
    seen.add(offset);
    tags = readDirectory(offset);
    if (tags) { directory = offset; break; }
    offset = u32(offset + 2 + count * 12);
    if (offset === 0) break;
  }
  if (!tags) throw bad("tiff has no readable image directory");
  const layout = { le, directory, next: directory + 2 + count * 12, renames, clamps: [], page: null };
  if (!tags.has(256)) return layout; // the decoder answers "no image width"

  const width = value(tags, 256), height = value(tags, 257) ?? 0;
  const compression = value(tags, 259) ?? 1;
  // Tag 45 switches the decoder to the Panasonic raw scheme whatever tag 259 says.
  if (TIFF_UNBOUNDED.has(compression) || tags.has(45)) {
    throw bad(`tiff compression ${tags.has(45) ? 34316 : compression} is not supported; send png or jpeg`);
  }
  const bitsPerSample = value(tags, 258) ?? 1, samples = value(tags, 277) ?? 1;
  // Bits per pixel, with the two overrides the decoder applies for raw files.
  let bitsPerPixel = bitsPerSample * samples;
  if (compression === 1 && tags.has(279) && tags.has(278) && value(tags, 262) === 32803) {
    bitsPerPixel = Math.round((value(tags, 279) * 8) / (width * value(tags, 278)));
  }
  if (value(tags, 50885) === 4) bitsPerPixel = bitsPerSample * 3;
  if (!(bitsPerPixel >= 0)) bitsPerPixel = Infinity;
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
  if (width * height > maxPixels) throw bad(`source image too large (${width}x${height}; max ${maxPixels} pixels)`);
  const maxBytes = maxPixels * TIFF_BYTES_PER_CAP_PIXEL;
  if (sampleBytes + tileBytes > maxBytes) throw bad(`source image too large (tiff samples decode to ${sampleBytes + tileBytes} bytes; max ${maxBytes})`);

  // The decoder takes strip offsets from 273 and byte counts from 279, and
  // the tile tables (324, 325) when the page is tiled or those are absent.
  const offsetsTag = !tags.has(273) || tiled ? 324 : 273;
  const countsTag = !tags.has(279) || tiled ? 325 : 279;
  const parts = tiled ? Math.min(tiles, tags.get(offsetsTag)?.num ?? 0) : tags.get(offsetsTag)?.num ?? 0;
  // Each strip or tile is read for as many bytes as its count says, so a count
  // that runs past the end of the file is clamped to the file in the decoder's
  // view. One uncompressed strip is sized from the page instead.
  const lengths = new Map();
  if (tags.has(countsTag) && !(compression === 1 && !tiled && parts === 1)) {
    for (let j = 0; j < parts; j++) {
      const at = value(tags, offsetsTag, j), length = value(tags, countsTag, j);
      if (length === undefined || at + length <= buf.length) continue;
      const kept = Math.max(0, buf.length - at);
      lengths.set(j, kept);
      layout.clamps.push({ ...slot(tags, countsTag, j), value: kept });
    }
  }
  const part = (j) => ({ offset: value(tags, offsetsTag, j), length: lengths.get(j) ?? value(tags, countsTag, j) });
  let jpeg = null;
  if (TIFF_JPEG.has(compression)) {
    const list = (tag) => Array.from({ length: tags.get(tag)?.num ?? 0 }, (_, j) => value(tags, tag, j));
    // JPEGTables, a byte field the decoder puts ahead of every strip.
    const tables = tags.get(347);
    if (tables && tables.type !== 1 && tables.type !== 7) throw bad("tiff tag 347 is not a byte field");
    jpeg = {
      old: compression === 6,
      tables: tables ? { at: tables.at, length: tables.num } : null,
      interchange: tags.has(513) ? { offset: value(tags, 513), length: value(tags, 514) ?? 0 } : null,
      quant: list(519), huffman: [...list(520), ...list(521)],
      scanHeader: value(tags, 324) ?? value(tags, 273) ?? value(tags, 513),
    };
    // The old-style decoder copies the interchange stream into a buffer of its
    // declared length and writes a frame header with one entry per sample.
    if (jpeg.old && jpeg.interchange && jpeg.interchange.offset + jpeg.interchange.length > buf.length) {
      throw bad("tiff jpeg interchange stream runs past the end of the file");
    }
    if (jpeg.old && samples > 4) throw bad(`tiff jpeg page declares ${samples} samples per pixel; at most 4 can be decoded`);
  }
  layout.page = { width, height, compression, sampleBytes, tileBytes, tiled, parts, part, jpeg, fax: TIFF_FAX.has(compression) };
  return layout;
}

/** The cap applied to everything the first image makes the decoder allocate. */
export function assertTiffHeader(buf, maxPixels) {
  tiffLayout(buf, maxPixels);
}

/** The file as the decoder is shown it: a copy in which the chain ends at the
 *  directory the tools use (its next-directory offset is zero),
 *  sub-directory and maker-note tags carry an unused tag number so the decoder
 *  stores them without following them, and byte counts stop at the end of the
 *  file. The caller's buffer is not written to. */
export function tiffDecoderView(buf, layout = tiffLayout(buf)) {
  const view = Buffer.from(buf);
  const w16 = (v, at) => (layout.le ? view.writeUInt16LE(v, at) : view.writeUInt16BE(v, at));
  const w32 = (v, at) => (layout.le ? view.writeUInt32LE(v, at) : view.writeUInt32BE(v, at));
  if (layout.next + 4 <= view.length) w32(0, layout.next);
  for (const e of layout.renames) w16(TIFF_INERT_TAG, e);
  for (const { at, size, value } of layout.clamps) {
    if (at + size > view.length) continue;
    if (size === 1) view[at] = Math.min(value, 255); else if (size === 2) w16(Math.min(value, 65535), at); else w32(value, at);
  }
  return view;
}

// Every place in [start, end) where a JPEG decoder could read a frame header:
// the two bytes 0xFF, SOFn. This is a scan of raw bytes on purpose. It sees a
// superset of what any marker walk sees, and a false match costs nothing
// unless it also declares a frame past the cap. The first byte is also read as
// if 0xFF came before it, since the decoder joins this range to other bytes.
function eachFrameHeader(buf, start, end, visit) {
  start = Math.max(0, start); end = Math.min(end, buf.length);
  if (!(end > start)) return 0;
  const at = (p) => {
    // A frame header the range ends inside would take its size from bytes
    // this scan cannot place.
    if (p + 10 > end) throw bad("tiff jpeg data ends inside a frame header");
    visit({ height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7), components: buf[p + 9] });
  };
  if (isFrameHeader(buf[start])) at(start - 1);
  for (let i = start; ;) {
    const ff = buf.indexOf(0xff, i);
    if (ff < 0 || ff + 1 >= end) break;
    if (isFrameHeader(buf[ff + 1])) at(ff);
    i = ff + 1;
  }
  return end - start;
}

/** Bounds the data whose decoded size the directory does not state, and throws
 *  a 400 when it passes what the page allows: each deflate strip or tile is
 *  inflated under the page's own size, and every frame header in the bytes an
 *  embedded-JPEG decoder is given must fit `maxPixels` with at most four
 *  components. This reads the strip data, so it runs in the worker. */
export function assertTiffStreams(buf, layout, maxPixels) {
  const page = layout.page;
  if (!page) return;
  if (page.compression === 8 || page.compression === 32946) {
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
  if (page.jpeg) {
    const { old, tables, interchange, quant, huffman, scanHeader } = page.jpeg;
    const visit = ({ width, height, components }) => {
      if (width * height > maxPixels) throw bad(`source image too large (tiff embedded jpeg frame ${width}x${height}; max ${maxPixels} pixels)`);
      if (components > 4) throw bad(`tiff embedded jpeg frame declares ${components} components; at most 4 can be decoded`);
    };
    // Strips may share bytes, but not without limit: the scan stops once it
    // has read the file sixteen times over.
    let scanned = 0;
    const scan = (start, end) => {
      scanned += eachFrameHeader(buf, start, end, visit);
      if (scanned > buf.length * 16 + 65536) throw bad("tiff jpeg strips cover the same bytes too many times");
    };
    const g = (p) => (p >= 0 && p < buf.length ? buf[p] : 0);
    // Each range below is one run of file bytes the decoder copies into the
    // stream it parses, with the same start and end the decoder uses.
    if (!old) {
      if (tables) {
        // The tables, up to their end-of-image marker (or less their last byte).
        const n = Math.max(0, Math.min(tables.length, buf.length - tables.at));
        let end = tables.at + Math.max(0, n - 1);
        for (let k = 0; k < n - 1; k++) if (buf[tables.at + k] === 0xff && buf[tables.at + k + 1] === 0xd9) { end = tables.at + k; break; }
        scan(tables.at, end);
      }
      for (let j = 0; j < page.parts; j++) {
        const { offset, length } = page.part(j);
        if (offset === undefined || length === undefined) continue;
        // Behind tables, a leading start-of-image marker is dropped.
        const start = tables && g(offset) === 0xff && g(offset + 1) === 0xd8 ? offset + 2 : offset;
        scan(start, offset + length);
      }
    } else {
      if (scanHeader !== undefined && g(scanHeader) === 0xff && g(scanHeader + 1) === 0xda) {
        scan(scanHeader, scanHeader + 2 + ((g(scanHeader + 2) << 8) | g(scanHeader + 3)));
      }
      for (let j = 0; j < page.parts; j++) {
        const { offset, length } = page.part(j);
        if (offset === undefined || length === undefined) continue;
        scan(offset, offset + length);
        // The old-style decoder reads its tables relative to each strip.
        if (interchange) {
          const from = offset + interchange.offset, n = interchange.length;
          scan(from, offset + length);
          scan(from, from + (g(from + n - 2) === 0xff && g(from + n - 1) === 0xd8 ? n - 2 : n));
        }
        for (const q of quant) scan(offset + q, offset + q + 64);
        for (const h of huffman) {
          let codes = 19; for (let k = 0; k < 16; k++) codes += g(offset + h + k);
          scan(offset + h, offset + h + 16 + codes);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- inflate --

/** Where a decoder inflates with no output bound, runs the same inflate first
 *  under the size the header declares, and throws a 400 when the data inflates
 *  past it. `format` is sniffFormat's answer. This is real work (it inflates),
 *  so it runs in the worker, never on the main thread. A deflate TIFF is
 *  bounded the same way by assertTiffStreams. */
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
}

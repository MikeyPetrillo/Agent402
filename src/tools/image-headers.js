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
}

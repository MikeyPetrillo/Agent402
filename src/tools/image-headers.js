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
// Pure byte reads: no network, no filesystem, no jimp import.
import { createRequire } from "node:module";

function bad(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
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

// One-shot decoder process for the image tools: reads one image on stdin,
// decodes it with the same decoder the worker uses, and writes width, height
// (two little-endian uint32) and the RGBA bitmap to stdout. src/tools/
// image-ops.js starts it (decodeInChild) for the one kind of data whose memory
// no header bounds, with a heap ceiling on the command line and a deadline:
// when that data grows past the ceiling this process ends, and nothing else.
// It is handed the file already checked and reduced to the image the tools
// use, an allowlisted environment, and no arguments.
import { loadJimp } from "./lazy-deps.js";

// The decoders print progress notes with console.log; stdout carries the answer.
console.log = () => {};

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const { Jimp } = await loadJimp();
  const img = await Jimp.fromBuffer(Buffer.concat(chunks));
  const head = Buffer.alloc(8);
  head.writeUInt32LE(img.width, 0);
  head.writeUInt32LE(img.height, 4);
  process.stdout.write(head);
  process.stdout.write(img.bitmap.data, () => process.exit(0));
} catch (e) {
  process.stderr.write(String(e?.message || e).slice(0, 200), () => process.exit(2));
}

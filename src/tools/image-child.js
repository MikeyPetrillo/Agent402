// One-shot TIFF decoder process for the image tools: reads one TIFF on stdin,
// decodes its first image, and writes width, height (two little-endian
// uint32) and the RGBA bitmap to stdout. src/tools/image-ops.js starts it
// (decodeInChild) for the one kind of data whose memory no header bounds,
// with a heap ceiling on the command line and a deadline: when that data
// grows past the ceiling this process ends, and nothing else does. It is
// handed the file already checked and reduced to the image the tools use, an
// allowlisted environment, and no arguments.
//
// The decode is the three calls jimp's TIFF codec makes, on the same utif2
// copy (resolved through jimp's packages), without loading the rest of jimp:
// this process starts for every such page, so what it imports is its latency.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Only as the process's own entry point: a script that imports every file
// under src/tools (the catalog scans do) must not start a decode.
const isEntry = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isEntry) await main();

async function main() {
  // The decoder prints progress notes with console.log; stdout carries the answer.
  console.log = () => {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    const here = createRequire(import.meta.url);
    const utif = createRequire(createRequire(here.resolve("jimp")).resolve("@jimp/js-tiff"))("utif2");
    const data = Buffer.concat(chunks);
    const pages = utif.decode(data);
    const page = pages[0];
    if (!page) throw new Error("No page found in TIFF");
    if (!page.t256) throw new Error("No image width found in TIFF");
    if (!page.t257) throw new Error("No image height found in TIFF");
    for (const p of pages) utif.decodeImage(data, p);
    const rgba = utif.toRGBA8(page);
    const head = Buffer.alloc(8);
    head.writeUInt32LE(Number(page.t256[0]), 0);
    head.writeUInt32LE(Number(page.t257[0]), 4);
    process.stdout.write(head);
    process.stdout.write(Buffer.from(rgba), () => process.exit(0));
  } catch (e) {
    process.stderr.write(String(e?.message || e).slice(0, 200), () => process.exit(2));
  }
}

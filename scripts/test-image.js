// Pure-CPU tests for the image kit: generate an image, then resize / convert /
// thumbnail it and verify the output decodes at the expected size and format.
import { Jimp, JimpMime } from "jimp";
import { IMAGE_TOOLS } from "../src/tools/image-kit.js";

const tool = (slug) => IMAGE_TOOLS.find((t) => t.slug === slug).handler;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Source: a 200x100 red PNG.
const src = new Jimp({ width: 200, height: 100, color: 0xff0000ff });
const srcB64 = (await src.getBuffer(JimpMime.png)).toString("base64");

// resize to width 50 → proportional height 25
let r = await tool("image-resize")({ image: srcB64, width: 50 });
let img = await Jimp.read(r.__binary);
ok(img.width === 50 && img.height === 25, `resize width=50 → 50x25 proportional (got ${img.width}x${img.height})`);
ok(r.contentType === JimpMime.png, `resize defaults to png (got ${r.contentType})`);

// resize to explicit 80x80
r = await tool("image-resize")({ image: srcB64, width: 80, height: 80 });
img = await Jimp.read(r.__binary);
ok(img.width === 80 && img.height === 80, `resize 80x80 (got ${img.width}x${img.height})`);

// convert to jpeg
r = await tool("image-convert")({ image: srcB64, format: "jpeg", quality: 70 });
ok(r.contentType === JimpMime.jpeg && r.__binary[0] === 0xff && r.__binary[1] === 0xd8, `convert to jpeg (magic ${r.__binary[0].toString(16)} ${r.__binary[1].toString(16)})`);

// thumbnail 64x64 square
r = await tool("image-thumbnail")({ image: srcB64, size: 64 });
img = await Jimp.read(r.__binary);
ok(img.width === 64 && img.height === 64, `thumbnail 64x64 square (got ${img.width}x${img.height})`);

// validation: missing image
try { await tool("image-resize")({ width: 50 }); ok(false, "missing image should throw"); }
catch (e) { ok(e.statusCode === 400, "missing image throws 400"); }
// validation: garbage base64
try { await tool("image-convert")({ image: "not!!an!!image", format: "png" }); ok(false, "garbage should throw"); }
catch (e) { ok(e.statusCode === 400, "garbage image throws 400"); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

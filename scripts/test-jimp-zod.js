// jimp on zod 4. jimp 1.6.1 (its newest release) declares zod ^3.23.8 in
// every @jimp/plugin-* and @jimp/types, where zod only checks a transform's
// option object (resize, cover, crop, rotate, flip). The root `overrides`
// entry "jimp": { "zod": "4.6.7" } resolves that subtree to the root zod 4,
// so no zod 3 copy is installed. No payment schema is involved.
//
// What this pins:
//   1. no nested zod under @jimp, every @jimp package resolves the root zod
//      4, and the lockfile holds no zod 3 copy anywhere;
//   2. every operation the image tools call gives the same output as it did
//      on zod 3: the BASELINE digests below were recorded on zod 3.25.76
//      with the same source image and parameters;
//   3. jimp's option checks accept and refuse the same values as on zod 3
//      ("throws" covers a zod refusal and a later RangeError alike; zod 4
//      refuses w: Infinity in the schema where zod 3 let it reach the
//      resizer, which then threw). The image handlers validate every value
//      before jimp sees it, so no buyer reaches these refusals.
// Offline.
//   node scripts/test-jimp-zod.js
import { fileURLToPath } from "node:url";
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
const rootZod = JSON.parse(readFileSync(join(ROOT, "node_modules/zod/package.json"), "utf8")).version;

// ---- 1. resolution ------------------------------------------------------------
ok(pkg.overrides?.jimp?.zod === rootZod, `overrides.jimp.zod matches the root zod (${pkg.overrides?.jimp?.zod} vs ${rootZod})`);
ok(Number(rootZod.split(".")[0]) >= 4, `root zod is 4.x (${rootZod})`);
const jimpDirs = readdirSync(join(ROOT, "node_modules/@jimp")).map((d) => join(ROOT, "node_modules/@jimp", d));
let nested = 0, foreign = 0;
for (const dir of jimpDirs) {
  if (existsSync(join(dir, "node_modules/zod"))) nested++;
  const declares = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies?.zod;
  if (!declares) continue;
  const resolved = createRequire(join(dir, "package.json")).resolve("zod");
  if (!resolved.startsWith(join(ROOT, "node_modules/zod/"))) foreign++;
}
ok(nested === 0, "no zod copy nested under node_modules/@jimp");
ok(foreign === 0, "every @jimp package that declares zod resolves the root zod");
const zod3 = Object.entries(lock.packages).filter(([k, v]) => k.endsWith("node_modules/zod") && Number(String(v.version).split(".")[0]) < 4).map(([k]) => k);
ok(zod3.length === 0, `package-lock.json holds no zod 3 copy (${zod3.join(", ") || "none"})`);

// ---- 2 + 3. outputs and option checks against the zod 3 baseline ---------------
const BASELINE = {
  "src.png": "32e600dbff050d70",
  "src.jpeg": "590b0dbc76e08c84",
  "src.bmp": "ff7f861737d7ba65",
  "png.resize.{\"width\":40}": "image/png e0d25d8bdf66ec19",
  "png.resize.{\"height\":33}": "image/png ab8ff243c020c7e6",
  "png.resize.{\"width\":200,\"height\":15}": "image/png 7d08d1ad88185274",
  "png.resize.{\"width\":3,\"height\":3,\"format\":\"jpeg\",\"quality\":50}": "image/jpeg e3c11326a418f03a",
  "png.convert.{\"format\":\"jpeg\"}": "image/jpeg 1fa904487edd2f1f",
  "png.convert.{\"format\":\"bmp\"}": "image/bmp 892c638ba37fab83",
  "png.convert.{\"format\":\"png\"}": "image/png 32e600dbff050d70",
  "png.convert.{\"format\":\"jpeg\",\"quality\":1}": "image/jpeg da39df6b8a935cdf",
  "png.cover.{\"width\":50,\"height\":50}": "image/png 3977af7561cb3b97",
  "png.cover.{\"width\":120,\"height\":30,\"format\":\"jpeg\"}": "image/jpeg a5850fcae6916692",
  "png.thumbnail.{}": "image/png c2452e18f90e9af0",
  "png.thumbnail.{\"size\":17}": "image/png 2d2c3ffd1caa49fb",
  "png.thumbnail.{\"size\":64,\"format\":\"bmp\"}": "image/bmp 5c231d3e7aa12a0a",
  "jpeg.resize.{\"width\":40}": "image/png 1d95caa4267ddad2",
  "jpeg.resize.{\"height\":33}": "image/png 5ae73c3160e7a0f3",
  "jpeg.resize.{\"width\":200,\"height\":15}": "image/png 45ecf8c3f24bd2b5",
  "jpeg.resize.{\"width\":3,\"height\":3,\"format\":\"jpeg\",\"quality\":50}": "image/jpeg e8eb6486b6826932",
  "jpeg.convert.{\"format\":\"jpeg\"}": "image/jpeg 49f5dc7a042a660b",
  "jpeg.convert.{\"format\":\"bmp\"}": "image/bmp 50009b51e003824f",
  "jpeg.convert.{\"format\":\"png\"}": "image/png 86189366a4ffef9a",
  "jpeg.convert.{\"format\":\"jpeg\",\"quality\":1}": "image/jpeg 3ded3503bd9f2501",
  "jpeg.cover.{\"width\":50,\"height\":50}": "image/png 5dce45e0fbf16008",
  "jpeg.cover.{\"width\":120,\"height\":30,\"format\":\"jpeg\"}": "image/jpeg 01565ae6fdb58f0a",
  "jpeg.thumbnail.{}": "image/png a3514944460a3243",
  "jpeg.thumbnail.{\"size\":17}": "image/png 17825595a0bfda76",
  "jpeg.thumbnail.{\"size\":64,\"format\":\"bmp\"}": "image/bmp da0976f44a8d36cf",
  "bmp.resize.{\"width\":40}": "image/png d6240ed597ff2dc9",
  "bmp.resize.{\"height\":33}": "image/png 3031cf7837106be5",
  "bmp.resize.{\"width\":200,\"height\":15}": "image/png 85ad3447aac479d0",
  "bmp.resize.{\"width\":3,\"height\":3,\"format\":\"jpeg\",\"quality\":50}": "image/jpeg e8eb6486b6826932",
  "bmp.convert.{\"format\":\"jpeg\"}": "image/jpeg e75e414afd852863",
  "bmp.convert.{\"format\":\"bmp\"}": "image/bmp ff7f861737d7ba65",
  "bmp.convert.{\"format\":\"png\"}": "image/png ad8b5af6a9fe463b",
  "bmp.convert.{\"format\":\"jpeg\",\"quality\":1}": "image/jpeg ea5791c22510201d",
  "bmp.cover.{\"width\":50,\"height\":50}": "image/png 8b01dc585b0cfeeb",
  "bmp.cover.{\"width\":120,\"height\":30,\"format\":\"jpeg\"}": "image/jpeg 287a1e540eb1a830",
  "bmp.thumbnail.{}": "image/png 2876abaab59adab7",
  "bmp.thumbnail.{\"size\":17}": "image/png 3387f08e1aee0658",
  "bmp.thumbnail.{\"size\":64,\"format\":\"bmp\"}": "image/bmp e441aa23f120fb57",
  "direct.crop": "20x10 3209d726457af058 78deec073695a034",
  "direct.rotate90": "61x97 84e6ea91595c8dde 23ccffb30ca354da",
  "direct.rotate180": "97x61 e204821e1976a51c 273bb5e39b0e1de8",
  "direct.rotate270": "61x97 d4047d4b23ede1b8 d2431589f5fc3226",
  "direct.flipH": "97x61 cb35f31bd98a3c82 8b0ff040b05af93f",
  "direct.flipV": "97x61 95e30e93ce6f9913 94fcb101bf57e977",
  "direct.flipHV": "97x61 e204821e1976a51c 273bb5e39b0e1de8",
  "direct.crop+rotate+flip": "40x50 0cc74b8155a8bab2 93be95864659da53",
  "direct.resizeW96": "96x60 0d3397df019561a0 ab2ae00b8df947c9",
  "direct.resizeW50": "50x31 12ab46de569191ca 06fd2cc207da90da",
  "direct.cover": "30x70 d6cb50e03f3f741a 77160f1b8e930dfb",
  "direct.coverBig": "300x70 8383399b921729a8 2f41144bddeee55e",
  "edge.resize{}": "refused",
  "edge.resize w=-1": "refused",
  "edge.resize w=0": "OK 1x1 953d4394b186d5e0",
  "edge.resize w=1.5": "OK 2x1 4888f25a9aeec6b5",
  "edge.resize w=Infinity": "threw",
  "edge.resize w=NaN": "refused",
  "edge.resize w='10'": "refused",
  "edge.resize extra key": "OK 10x6 cedcbe283317a595",
  "edge.crop neg": "threw",
  "edge.crop over": "threw",
  "edge.crop missing": "refused",
  "edge.rotate 45": "OK 114x114 c1c7bcaa6253644c",
  "edge.rotate '90'": "refused",
  "edge.rotate obj": "OK 61x97 84e6ea91595c8dde",
  "edge.flip none": "OK 97x61 df55b121ad0eca26",
  "edge.flip bad": "refused",
  "edge.cover w only": "refused",
  "edge.cover 0": "OK 0x0 e3b0c44298fc1c14",
};

const { Jimp } = await import("jimp");
const { runImageOp } = await import("../src/tools/image-ops.js");
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const got = {};

// A 97x61 gradient with partial alpha, encoded as PNG, JPEG and BMP.
const src = new Jimp({ width: 97, height: 61, color: 0x000000ff });
for (let y = 0; y < 61; y++) for (let x = 0; x < 97; x++) src.setPixelColor((((x * 7) & 255) << 24 | ((y * 11) & 255) << 16 | (((x + y) * 3) & 255) << 8 | (x % 5 ? 255 : 90)) >>> 0, x, y);
const bufs = { png: await src.getBuffer("image/png"), jpeg: await src.getBuffer("image/jpeg", { quality: 85 }), bmp: await src.getBuffer("image/bmp") };
for (const [k, b] of Object.entries(bufs)) got[`src.${k}`] = sha(b);

const OPS = [
  ["resize", { width: 40 }], ["resize", { height: 33 }], ["resize", { width: 200, height: 15 }], ["resize", { width: 3, height: 3, format: "jpeg", quality: 50 }],
  ["convert", { format: "jpeg" }], ["convert", { format: "bmp" }], ["convert", { format: "png" }], ["convert", { format: "jpeg", quality: 1 }],
  ["cover", { width: 50, height: 50 }], ["cover", { width: 120, height: 30, format: "jpeg" }],
  ["thumbnail", {}], ["thumbnail", { size: 17 }], ["thumbnail", { size: 64, format: "bmp" }],
];
for (const [k, b] of Object.entries(bufs)) for (const [op, params] of OPS) {
  const key = `${k}.${op}.${JSON.stringify(params)}`;
  try { const r = await runImageOp({ op, buffer: b, params }); got[key] = `${r.contentType} ${sha(r.__binary)}`; }
  catch (e) { got[key] = `ERR ${e.statusCode} ${e.message}`; }
}

// The image-kit handler calls (crop, rotate, flip) and the palette resize.
const DIRECT = [
  ["crop", (i) => i.crop({ x: 3, y: 4, w: 20, h: 10 })],
  ["rotate90", (i) => i.rotate(90)], ["rotate180", (i) => i.rotate(180)], ["rotate270", (i) => i.rotate(270)],
  ["flipH", (i) => i.flip({ horizontal: true, vertical: false })], ["flipV", (i) => i.flip({ horizontal: false, vertical: true })], ["flipHV", (i) => i.flip({ horizontal: true, vertical: true })],
  ["crop+rotate+flip", (i) => { i.crop({ x: 0, y: 0, w: 50, h: 40 }); i.rotate(270); i.flip({ horizontal: true, vertical: false }); }],
  ["resizeW96", (i) => i.resize({ w: 96 })], ["resizeW50", (i) => i.resize({ w: 50 })],
  ["cover", (i) => i.cover({ w: 30, h: 70 })], ["coverBig", (i) => i.cover({ w: 300, h: 70 })],
];
for (const [name, fn] of DIRECT) {
  const img = await Jimp.read(bufs.png);
  try { fn(img); got[`direct.${name}`] = `${img.width}x${img.height} ${sha(img.bitmap.data)} ${sha(await img.getBuffer("image/png"))}`; }
  catch (e) { got[`direct.${name}`] = `ERR ${e.message}`; }
}

const EDGES = [
  ["resize{}", (i) => i.resize({})], ["resize w=-1", (i) => i.resize({ w: -1 })], ["resize w=0", (i) => i.resize({ w: 0 })],
  ["resize w=1.5", (i) => i.resize({ w: 1.5 })], ["resize w=Infinity", (i) => i.resize({ w: Infinity })], ["resize w=NaN", (i) => i.resize({ w: NaN })],
  ["resize w='10'", (i) => i.resize({ w: "10" })], ["resize extra key", (i) => i.resize({ w: 10, junk: 1 })],
  ["crop neg", (i) => i.crop({ x: -2, y: 0, w: 10, h: 10 })], ["crop over", (i) => i.crop({ x: 90, y: 50, w: 40, h: 40 })],
  ["crop missing", (i) => i.crop({ x: 1 })], ["rotate 45", (i) => i.rotate(45)], ["rotate '90'", (i) => i.rotate("90")],
  ["rotate obj", (i) => i.rotate({ deg: 90 })], ["flip none", (i) => i.flip({})], ["flip bad", (i) => i.flip({ horizontal: "yes" })],
  ["cover w only", (i) => i.cover({ w: 10 })], ["cover 0", (i) => i.cover({ w: 0, h: 0 })],
];
for (const [name, fn] of EDGES) {
  const img = await Jimp.read(bufs.png);
  try { fn(img); got[`edge.${name}`] = `OK ${img.width}x${img.height} ${sha(img.bitmap.data)}`; }
  catch { got[`edge.${name}`] = "throws"; }
}

for (const [k, want] of Object.entries(BASELINE)) {
  const expect = want === "refused" || want === "threw" ? "throws" : want;
  ok(got[k] === expect, `${k}: ${expect}${got[k] === expect ? "" : ` (got ${got[k]})`}`);
}
ok(Object.keys(got).length === Object.keys(BASELINE).length, `ran every baseline case (${Object.keys(got).length})`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

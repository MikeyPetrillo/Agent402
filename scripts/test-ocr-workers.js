#!/usr/bin/env node
// image-ocr worker lifecycle and language data source.
//  1. Alternating languages keeps at most OCR_WORKER_MAX tesseract workers, and
//     an evicted worker's thread is terminated (its MessagePort handle goes away).
//  2. Language data is read from the local directory installed by
//     scripts/fetch-tessdata.js: a language missing there answers 503 without
//     any download, and nothing is written into the working directory.
//     A worker whose language data cannot be initialized answers 503 inside
//     the startup deadline instead of holding the request.
//  3. The pin table covers exactly the languages the tool accepts.
//  4. The real engine reads the published fixture into the answer's lines:
//     text, box and a two-place confidence per line (tesseract.js returns
//     lines only when asked for its page tree; ocrLines reads it and the TSV).
// Needs eng, spa, fra and deu installed (node scripts/fetch-tessdata.js tessdata
// eng spa fra deu); a missing file is a failure, not a skip.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { fileURLToPath } from "node:url";
import { mkdtempSync, readdirSync, readFileSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { TESSDATA_SHA256 } from "./fetch-tessdata.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const SOURCE_DIR = process.env.OCR_TESSDATA_DIR || fileURLToPath(new URL("../tessdata", import.meta.url));
const LANGS = ["eng", "spa", "fra", "deu"];

// A private data directory holding the four languages and nothing else, so the
// missing-language case below is real, and a private working directory to
// prove nothing is cached into it.
const dataDir = mkdtempSync(join(tmpdir(), "ocr-data-"));
const workDir = mkdtempSync(join(tmpdir(), "ocr-cwd-"));
let missing = [];
for (const l of LANGS) {
  try { copyFileSync(join(SOURCE_DIR, `${l}.traineddata.gz`), join(dataDir, `${l}.traineddata.gz`)); }
  catch { missing.push(l); }
}
ok(missing.length === 0, `language data present for ${LANGS.join(", ")} in ${SOURCE_DIR} (missing: ${missing.join(", ") || "none"}; run node scripts/fetch-tessdata.js tessdata ${LANGS.join(" ")})`);
{
  // A workflow that sweeps the catalog against its own boot (the example
  // sweeps, the corpus) must fetch the language data, or image-ocr answers 503
  // there and its value assertion silently stops running.
  const { readdirSync, readFileSync: rf } = await import("node:fs");
  const wfDir = new URL("../.github/workflows/", import.meta.url);
  for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
    const y = rf(new URL(f, wfDir), "utf8");
    if (/scripts\/(test-corpus|test-all|test-non-metered-examples)\.js/.test(y)) ok(/node scripts\/fetch-tessdata\.js tessdata\b[^\n]*\beng\b/.test(y), `${f} sweeps the catalog and fetches the eng language data`);
  }
}
if (missing.length) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

// ita is installed as a corrupt file: if the tool read its data from anywhere
// but this directory (a CDN download, a cache) the call would succeed.
writeFileSync(join(dataDir, "ita.traineddata.gz"), gzipSync(Buffer.from("not a tesseract model")));
process.env.OCR_TESSDATA_DIR = dataDir;
process.env.OCR_INIT_TIMEOUT_MS = "4000";
process.chdir(workDir);
const { OCR_TOOLS, OCR_WORKER_MAX, SUPPORTED_LANGS, ocrLines, __ocrTest } = await import("../src/tools/ocr-kit.js");
const ocr = OCR_TOOLS.find((t) => t.slug === "image-ocr").handler;

ok(JSON.stringify([...SUPPORTED_LANGS].sort()) === JSON.stringify(Object.keys(TESSDATA_SHA256).sort()), "every accepted language has a pinned data file, and no extra pins");

const p = new PNG({ width: 64, height: 32 }); p.data.fill(255);
const img = PNG.sync.write(p).toString("base64");
const ports = () => process.getActiveResourcesInfo().filter((x) => x === "MessagePort").length;

const basePorts = ports();
let worstWorkers = 0, worstPorts = 0;
for (let k = 0; k < 16; k++) {
  const lang = LANGS[k % LANGS.length];
  await ocr({ image: img, lang });
  await new Promise((r) => setTimeout(r, 50)); // let an evicted thread finish terminating
  worstWorkers = Math.max(worstWorkers, __ocrTest.workerCount());
  worstPorts = Math.max(worstPorts, ports() - basePorts);
}
ok(worstWorkers <= OCR_WORKER_MAX, `at most ${OCR_WORKER_MAX} language workers held across 16 alternating calls (worst ${worstWorkers})`);
ok(worstPorts <= OCR_WORKER_MAX, `evicted workers are terminated: worker handles stay at or under ${OCR_WORKER_MAX} (worst ${worstPorts})`);

{
  // 4. the published example, read by the real engine.
  const png = readFileSync(new URL("../assets/fixtures/sample-text.png", import.meta.url));
  const a = await ocr({ image: png.toString("base64"), lang: "eng" });
  const want = OCR_TOOLS.find((t) => t.slug === "image-ocr").discovery.output.example;
  ok(a.lineCount === 2 && a.lines.length === 2, `the fixture reads as two lines (${a.lineCount})`);
  ok(a.text === want.text, `its text is the published example's (${JSON.stringify(a.text)})`);
  ok(JSON.stringify(a.lines) === JSON.stringify(want.lines), `its lines (text, two-place confidence, box) are the published example's: ${JSON.stringify(a.lines)}`);
  ok(a.confidence === want.confidence, `its page confidence is the published example's (${a.confidence})`);
  ok(JSON.stringify(Object.keys(a)) === JSON.stringify(Object.keys(want)), `the answer's fields are the published example's (${Object.keys(a).join(", ")})`);
}
{
  // ocrLines: a line with no word clipped at 0 gets its words' mean; one with
  // a clipped word, a box two lines share, or a mean off the tree's whole
  // number keeps the tree's number.
  const line = (text, confidence, x0) => ({ text: `${text}\n`, confidence, bbox: { x0, y0: 0, x1: x0 + 10, y1: 5 } });
  const tsvLine = (x0, confs) => [`4\t1\t1\t1\t1\t0\t${x0}\t0\t10\t5\t-1\t`, ...confs.map((c, i) => `5\t1\t1\t1\t1\t${i + 1}\t${x0}\t0\t4\t5\t${c}\tw`)].join("\n");
  const data = {
    blocks: [{ paragraphs: [{ lines: [line("a", 94, 0), line("b", 34, 20), line("c", 50, 40)] }, { lines: [line("d", 70, 60), line("e", 71, 60)] }] }],
    tsv: [tsvLine(0, [94.123456, 94.556789]), tsvLine(20, [84.6, 0]), tsvLine(40, [60.1, 61]), tsvLine(60, [70.5]), tsvLine(60, [71.5])].join("\n"),
  };
  const got = ocrLines(data);
  ok(JSON.stringify(got.map((l) => l.confidence)) === JSON.stringify([94.34, 34, 50, 70, 71]), `ocrLines: words' mean, else the tree's number (${got.map((l) => l.confidence).join(", ")})`);
  ok(got[0].text === "a" && got[0].bbox.x1 === 10, "ocrLines: trailing whitespace trimmed, box kept");
  ok(ocrLines({ text: "x" }).length === 0 && ocrLines({ blocks: null }).length === 0 && ocrLines(null).length === 0, "ocrLines: no page tree reads as no lines");
}

try { await ocr({ image: img, lang: "jpn" }); ok(false, "a language without local data should be refused"); }
catch (e) { ok(e.statusCode === 503 && /not installed/.test(e.message), `a language without local data answers 503 (${e.statusCode}: ${e.message})`); }

ok(readdirSync(workDir).length === 0, `nothing written into the working directory (found: ${readdirSync(workDir).join(", ") || "none"})`);

await __ocrTest.shutdown();
await new Promise((r) => setTimeout(r, 200));
ok(ports() - basePorts === 0, "shutdown terminates every language worker");

// Last, because tesseract.js gives no handle to a worker whose startup never
// settles, so its thread outlives the test's own shutdown check.
try { await ocr({ image: img, lang: "ita" }); ok(false, "a corrupt local data file should fail the call"); }
catch (e) { ok(e.statusCode === 503 && /did not start/.test(e.message), `language data is read from the local directory: a corrupt local file fails the call with a 503 inside the startup deadline (${e.statusCode}: ${String(e.message).slice(0, 60)})`); }


rmSync(dataDir, { recursive: true, force: true });
rmSync(workDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

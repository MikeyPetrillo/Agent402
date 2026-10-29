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
// Needs eng, spa, fra and deu installed (node scripts/fetch-tessdata.js tessdata
// eng spa fra deu); a missing file is a failure, not a skip.
import { mkdtempSync, readdirSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { TESSDATA_SHA256 } from "./fetch-tessdata.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const SOURCE_DIR = process.env.OCR_TESSDATA_DIR || new URL("../tessdata", import.meta.url).pathname;
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
const { OCR_TOOLS, OCR_WORKER_MAX, SUPPORTED_LANGS, __ocrTest } = await import("../src/tools/ocr-kit.js");
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

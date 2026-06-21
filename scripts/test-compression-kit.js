// scripts/test-compression-kit.js
// Direct handler tests for src/tools/compression-kit.js. No server needed.
// Covers: happy paths, every algorithm round-trips, error contracts
// (statusCode=400 on bad input), the zip-bomb guard, and the
// "each tool answers its own example" invariant the CI suite cares about.
import { COMPRESSION_TOOLS } from "../src/tools/compression-kit.js";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    console.log("ok -", msg);
    passed++;
  } else {
    console.error("FAIL -", msg);
    failed++;
  }
}
function throws(fn, statusCode, msg) {
  try {
    fn();
    console.error("FAIL -", msg, "(expected throw, got none)");
    failed++;
  } catch (e) {
    if (statusCode && e.statusCode !== statusCode) {
      console.error("FAIL -", msg, `(expected statusCode=${statusCode}, got ${e.statusCode})`);
      failed++;
    } else {
      console.log("ok -", msg);
      passed++;
    }
  }
}

const bySlug = Object.fromEntries(COMPRESSION_TOOLS.map((t) => [t.slug, t]));

// ============================================================================
// gzip + gunzip — round-trip both text and binary.
// ============================================================================
const gzip = bySlug["gzip"];
const gunzip = bySlug["gunzip"];

const text = "the quick brown fox jumps over the lazy dog";
const compressed = gzip.handler({ input: text });
ok(compressed.algorithm === "gzip", "gzip: algorithm field present");
ok(compressed.inputBytes === Buffer.byteLength(text), "gzip: inputBytes matches");
ok(compressed.outputBytes > 0, "gzip: outputBytes > 0");
ok(typeof compressed.output === "string" && compressed.output.length > 0, "gzip: output is a string");

const round = gunzip.handler({ input: compressed.output });
ok(round.output === text, "gzip→gunzip: round-trip preserves text");
ok(round.outputBytes === compressed.inputBytes, "gunzip: outputBytes matches original");

// Compression level honored.
const lvl1 = gzip.handler({ input: text.repeat(20), level: 1 });
const lvl9 = gzip.handler({ input: text.repeat(20), level: 9 });
ok(lvl9.outputBytes <= lvl1.outputBytes, "gzip: level=9 ratio ≤ level=1 ratio");

// Binary round-trip via base64.
const binary = Buffer.from([0x00, 0xff, 0x10, 0x20, 0x7f, 0x80, 0xaa, 0x55]).toString("base64");
const compBin = gzip.handler({ input: binary, inputFormat: "base64" });
const roundBin = gunzip.handler({ input: compBin.output, outputFormat: "base64" });
ok(roundBin.output === binary, "gzip→gunzip: binary round-trip preserves bytes");

// Hex input also works.
const hexCompressed = gzip.handler({ input: "deadbeef", inputFormat: "hex" });
const hexRound = gunzip.handler({ input: hexCompressed.output, outputFormat: "hex" });
ok(hexRound.output === "deadbeef", "gzip→gunzip: hex round-trip");

// ============================================================================
// brotli round-trip.
// ============================================================================
const bro = bySlug["brotli-compress"];
const broDec = bySlug["brotli-decompress"];

const broCompressed = bro.handler({ input: text });
ok(broCompressed.algorithm === "brotli", "brotli: algorithm field present");
ok(broCompressed.outputBytes > 0, "brotli: outputBytes > 0");
const broRound = broDec.handler({ input: broCompressed.output });
ok(broRound.output === text, "brotli→brotli-decompress: round-trip preserves text");

// brotli quality honored.
const q0 = bro.handler({ input: text.repeat(10), quality: 0 });
const q11 = bro.handler({ input: text.repeat(10), quality: 11 });
ok(q11.outputBytes <= q0.outputBytes, "brotli: quality=11 ratio ≤ quality=0 ratio");

// ============================================================================
// compress-compare reports all three algorithms.
// ============================================================================
const cmp = bySlug["compress-compare"];
const cmpRes = cmp.handler({ input: text.repeat(5) });
ok(cmpRes.inputBytes === Buffer.byteLength(text.repeat(5)), "compress-compare: inputBytes correct");
ok(Array.isArray(cmpRes.results) && cmpRes.results.length === 3, "compress-compare: three results");
const algos = new Set(cmpRes.results.map((r) => r.algorithm));
ok(algos.has("gzip") && algos.has("brotli") && algos.has("deflate"), "compress-compare: all three algos present");
ok(["gzip", "brotli", "deflate"].includes(cmpRes.best), "compress-compare: best is a known algorithm");
// Best should be the smallest output (sorted asc).
ok(cmpRes.results[0].outputBytes <= cmpRes.results[1].outputBytes, "compress-compare: results sorted ascending");
ok(cmpRes.results[0].algorithm === cmpRes.best, "compress-compare: best matches first result");

// ============================================================================
// Error contracts — every failure mode returns statusCode=400, never 500.
// ============================================================================
throws(() => gzip.handler({}), 400, "gzip: missing input → 400");
throws(() => gzip.handler({ input: 42 }), 400, "gzip: non-string input → 400");
throws(() => gzip.handler({ input: "hi", level: 0 }), 400, "gzip: level=0 out of range → 400");
throws(() => gzip.handler({ input: "hi", level: 10 }), 400, "gzip: level=10 out of range → 400");
throws(() => gzip.handler({ input: "hi", inputFormat: "wat" }), 400, "gzip: bad inputFormat → 400");
throws(() => gzip.handler({ input: "not!base64!", inputFormat: "base64" }), 400, "gzip: invalid base64 → 400");
throws(() => gzip.handler({ input: "not-hex-zzz", inputFormat: "hex" }), 400, "gzip: invalid hex → 400");

throws(() => gunzip.handler({}), 400, "gunzip: missing input → 400");
throws(() => gunzip.handler({ input: Buffer.from("this is not gzipped").toString("base64") }), 400, "gunzip: non-gzip bytes → 400");

throws(() => bro.handler({}), 400, "brotli-compress: missing input → 400");
throws(() => bro.handler({ input: "hi", quality: -1 }), 400, "brotli-compress: quality=-1 → 400");
throws(() => bro.handler({ input: "hi", quality: 12 }), 400, "brotli-compress: quality=12 → 400");

throws(() => broDec.handler({}), 400, "brotli-decompress: missing input → 400");
throws(() => broDec.handler({ input: Buffer.from("not brotli").toString("base64") }), 400, "brotli-decompress: non-brotli bytes → 400");

throws(() => cmp.handler({}), 400, "compress-compare: missing input → 400");

// ============================================================================
// Zip-bomb guard — verify the 10MB cap rejects oversize inputs.
// (We don't fabricate an actual bomb; we just confirm the limit is enforced
// on the input side, which is what stops a malicious caller burning CPU.)
// ============================================================================
const oversize = "a".repeat(11 * 1024 * 1024);
throws(() => gzip.handler({ input: oversize }), 400, "gzip: oversize input rejected (>10MB)");
throws(() => bro.handler({ input: oversize }), 400, "brotli-compress: oversize input rejected (>10MB)");

// ============================================================================
// "Answers its own example" invariant — the same check CI runs against the
// full catalog. Each tool's discovery.input must be a valid call.
// ============================================================================
for (const tool of COMPRESSION_TOOLS) {
  try {
    const result = tool.handler(tool.discovery.input);
    ok(result && typeof result === "object", `${tool.slug}: example input returns an object`);
  } catch (e) {
    ok(false, `${tool.slug}: example input throws (${e.message})`);
  }
}

// ============================================================================
// Pricing consistency.
// ============================================================================
for (const tool of COMPRESSION_TOOLS) {
  ok(tool.price === "$0.001", `${tool.slug}: priced at $0.001`);
  ok(tool.category === "data", `${tool.slug}: category=data`);
}

// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

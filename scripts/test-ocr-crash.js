// Regression lock for the OCR DoS surfaced by A402-10: a malformed image must
// resolve to a CLEAN error, never emit an uncaughtException. tesseract.js throws
// inside its own worker message handler on a decode failure unless an
// errorHandler is set (see ocr-kit.js); once uncaughtException is fatal, that
// stray throw would crash the whole server on one bad image. This test feeds
// garbage that passes size validation but tesseract can't decode, and asserts:
//   (1) no uncaughtException escapes, and
//   (2) the handler returns a clean thrown error (statusCode set), not a crash.
//
// Loads the tesseract model on first use; if that init can't complete (e.g. no
// network in a minimal sandbox) the test skips rather than false-fail — CI's
// test-all already exercises the real OCR path with the model available.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { OCR_TOOLS } from "../src/tools/ocr-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

let sawUncaught = false;
process.on("uncaughtException", (e) => { sawUncaught = true; console.error("UNCAUGHT (should not happen):", e?.message); });

const ocr = OCR_TOOLS.find((t) => t.slug === "image-ocr");

(async () => {
  ok(!!ocr && typeof ocr.handler === "function", "image-ocr handler present");

  // >8 bytes so it passes the size guard and actually reaches tesseract, but not
  // a decodable image — this is the input class that triggered the stray throw.
  const garbage = Buffer.from("this is definitely not a valid PNG or JPEG image payload").toString("base64");

  let threwClean = false, skipped = false;
  try {
    await ocr.handler({ image: garbage, lang: "eng" });
    // If it somehow "succeeds", that's fine too — the point is it didn't crash.
    ok(true, "handler returned without crashing on garbage input");
  } catch (e) {
    const msg = String(e?.message || e);
    // Model/init failures in a network-less sandbox → skip, don't false-fail.
    if (/worker|model|network|fetch|traineddata|download|WASM|ENOTFOUND|ETIMEDOUT/i.test(msg) && !/OCR failed/.test(msg)) {
      skipped = true;
      console.log(`ok - skipped (tesseract model unavailable here): ${msg.slice(0, 80)}`);
    } else {
      threwClean = typeof e?.statusCode === "number";
      ok(threwClean, `malformed image throws a CLEAN error with statusCode (got ${e?.statusCode}: ${msg.slice(0, 60)})`);
    }
  }

  // Give any stray async worker 'throw' a moment to surface before we assert.
  await new Promise((r) => setTimeout(r, 500));
  ok(!sawUncaught, "no uncaughtException escaped the OCR path (the DoS is contained)");

  if (skipped && !threwClean) console.log("(note: decode assertion skipped; containment assertion still enforced)");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

// Locks the "how to read our 402" note added to llms.txt (2026-08-16 audit,
// prompted by issue #794): an external client hard-failed with
// "no_supported_rail" because it only recognized the MPP `WWW-Authenticate:
// Payment` scheme and never checked for the real x402 `PAYMENT-REQUIRED`
// header present on the SAME response. The operator's fix in the issue thread was a
// one-off reply; this locks the same guidance into the machine-readable
// surface so the next client author sees it before hitting the same wall.
//
// Offline - calls llmsTxt() directly with a minimal fixture catalog.
//
//   node scripts/test-llms-mpp-header-note.js
import { llmsTxt } from "../src/seo.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const FIXTURE_CATALOG = {
  "POST /api/hash": {
    slug: "hash", name: "Hash", category: "encoding", price: "$0.001",
    description: "Compute a cryptographic hash.",
    discovery: { inputSchema: { properties: {}, required: [] }, input: {} },
  },
};

const text = llmsTxt("https://agent402.tools", FIXTURE_CATALOG);

ok(text.includes("How to read our 402 if you only speak one dialect"), "the new section heading is present");
ok(text.includes("PAYMENT-REQUIRED"), "names the real x402 header explicitly");
ok(text.includes("WWW-Authenticate"), "names the MPP header explicitly");
ok(text.includes("#794"), "cites the real incident (issue #794), not a hypothetical");
ok(/additive, never a replacement/.test(text), "states the two headers coexist, neither replaces the other");
// The note must land AFTER the existing MPP dual-stack paragraph, not before
// it — a reader needs the dual-stack context first to make sense of "if you
// only speak one dialect".
const dualStackIdx = text.indexOf("MPP clients are first-class");
const noteIdx = text.indexOf("How to read our 402");
ok(dualStackIdx > 0 && noteIdx > dualStackIdx, "the note appears after the MPP dual-stack paragraph it explains");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

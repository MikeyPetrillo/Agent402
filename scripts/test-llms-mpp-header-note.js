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
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { llmsFullTxt } from "../src/seo.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const FIXTURE_CATALOG = {
  "POST /api/hash": {
    slug: "hash", name: "Hash", category: "encoding", price: "$0.001",
    description: "Compute a cryptographic hash.",
    discovery: { inputSchema: { properties: {}, required: [] }, input: {} },
  },
};

const text = llmsFullTxt("https://agent402.tools", FIXTURE_CATALOG);

ok(text.includes("How to read our 402 if you only speak one dialect"), "the new section heading is present");
ok(text.includes("PAYMENT-REQUIRED"), "names the real x402 header explicitly");
ok(text.includes("WWW-Authenticate"), "names the MPP header explicitly");
ok(!/#\d+/.test(text.slice(text.indexOf("How to read our 402"), text.indexOf("How to read our 402") + 1500)), "states the failure mode as mechanism, citing no incident number");
ok(/additive, never a replacement/.test(text), "states the two headers coexist, neither replaces the other");
// The note must land AFTER the existing MPP dual-stack paragraph, not before
// it — a reader needs the dual-stack context first to make sense of "if you
// only speak one dialect".
const dualStackIdx = text.indexOf("MPP clients are first-class");
const noteIdx = text.indexOf("How to read our 402");
ok(dualStackIdx > 0 && noteIdx > dualStackIdx, "the note appears after the MPP dual-stack paragraph it explains");

// With MPP on, a client the offer gate names (src/mpp-offer-gate.js) gets the
// x402 offer alone, so "both headers, always" is scoped and the opt-in header
// is named; with the gate off the sentence stands as before.
{
  const saved = { key: process.env.MPP_SECRET_KEY, gate: process.env.MPP_OFFER_WITHHOLD_USER_AGENTS };
  process.env.MPP_SECRET_KEY = "llms-mpp-header-note";
  delete process.env.MPP_OFFER_WITHHOLD_USER_AGENTS;
  const on = llmsFullTxt("https://agent402.tools", FIXTURE_CATALOG);
  const note = on.slice(on.indexOf("How to read our 402"), on.indexOf("How to read our 402") + 1500);
  ok(note.includes("X-Payment-Offers: mpp") && note.includes("python-httpx/"), "the note names the gated prefix and the opt-in header");
  ok(!/BOTH headers, always/.test(on), "the note does not say every 402 carries both headers, always");
  // The dual-stack paragraph says the 402 carries the challenges, so it names
  // the exception itself, not only the note further down.
  const pAt = on.indexOf("**MPP clients are first-class");
  const para = pAt < 0 ? "" : on.slice(pAt, on.indexOf("\n\n", pAt));
  ok(para.includes("X-Payment-Offers: mpp") && para.includes("python-httpx/") && para.includes("Accept-Payment"), "the 'MPP clients are first-class' paragraph names the gated prefix and both ways back");
  process.env.MPP_OFFER_WITHHOLD_USER_AGENTS = "off";
  const off = llmsFullTxt("https://agent402.tools", FIXTURE_CATALOG);
  ok(/BOTH headers, always/.test(off) && !off.includes("X-Payment-Offers"), "with the gate off the note says both headers, always, and names no opt-in header");
  for (const [k, v] of [["MPP_SECRET_KEY", saved.key], ["MPP_OFFER_WITHHOLD_USER_AGENTS", saved.gate]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

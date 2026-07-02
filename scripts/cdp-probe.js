// Direct facilitator reachability/auth probe — bypasses the whole x402
// handshake. Calls /supported on the CDP facilitator (and PayAI as control)
// with the real credentials and prints the RAW outcome: reachable? authed?
// rate-limited? Answers "is CDP rejecting our payments, or can our server not
// even reach/authenticate to CDP" in one shot.
//
//   CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... node scripts/cdp-probe.js
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";

function dump(label, e) {
  console.log(`  ${label}:`, e?.message || String(e));
  if (e?.cause) console.log(`    cause:`, e.cause?.message || String(e.cause), e.cause?.code || "");
  if (e?.status) console.log(`    status:`, e.status);
  if (e?.response) {
    try { console.log(`    response.status:`, e.response.status); } catch {}
  }
}

// --- CDP ---
console.log("=== CDP facilitator ===");
const id = process.env.CDP_API_KEY_ID || "";
const secret = process.env.CDP_API_KEY_SECRET || "";
console.log(`  key id set: ${Boolean(id)} (len ${id.length}); secret set: ${Boolean(secret)} (len ${secret.length})`);
try {
  const cfg = createFacilitatorConfig(id, secret);
  console.log(`  url: ${cfg.url}`);
  const client = new HTTPFacilitatorClient(cfg);
  const t0 = Date.now();
  const supported = await client.getSupported();
  console.log(`  getSupported OK in ${Date.now() - t0}ms`);
  const kinds = supported?.kinds || [];
  console.log(`  kinds: ${kinds.length}; base supported: ${kinds.some((k) => String(k.network).includes("8453"))}`);
  console.log(`  ${JSON.stringify(kinds.slice(0, 6))}`);
} catch (e) {
  console.log("  getSupported THREW:");
  dump("error", e);
}

// --- PayAI control ---
console.log("\n=== PayAI facilitator (control) ===");
try {
  const client = new HTTPFacilitatorClient({ url: process.env.PAYAI_FACILITATOR_URL || "https://facilitator.payai.network" });
  const t0 = Date.now();
  const supported = await client.getSupported();
  console.log(`  getSupported OK in ${Date.now() - t0}ms`);
  const kinds = supported?.kinds || [];
  console.log(`  kinds: ${kinds.length}; base supported: ${kinds.some((k) => String(k.network).includes("8453"))}`);
} catch (e) {
  console.log("  getSupported THREW:");
  dump("error", e);
}

// --- raw direct fetch to CDP /supported (no client, no auth) to separate
//     network reachability from auth ---
console.log("\n=== raw fetch CDP /supported (no auth) — reachability only ===");
try {
  const t0 = Date.now();
  const r = await fetch("https://api.cdp.coinbase.com/platform/v2/x402/supported", { method: "GET" });
  console.log(`  HTTP ${r.status} in ${Date.now() - t0}ms (401/403 = reachable but needs auth; that's EXPECTED and means egress is fine)`);
} catch (e) {
  console.log("  raw fetch THREW (egress/DNS problem):");
  dump("error", e);
}

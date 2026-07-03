// Rails-copy consistency lock. Two guards:
//
// 1. OFFLINE — src/rails.js (the single source of truth for "supported
//    chains" copy) must cover every mainnet rail src/payments.js can settle.
//    Add a network to payments.js without a RAILS entry and this fails, so
//    the twenty public surfaces that derive their copy from rails.js can
//    never silently advertise a stale chain list (the 2026-07-03 "website
//    doesn't mention USDG" class).
//
// 2. ONLINE (TARGET_URL set) — the key served pages must actually render
//    every rail name and every asset. This covers the prose spots that
//    embed the claim grammatically instead of importing a constant.
//
//   node scripts/test-rails.js                       # offline only
//   TARGET_URL=http://localhost:3000 node scripts/test-rails.js
import { RAILS, RAILS_AMP, RAILS_OR, RAILS_PAREN, RAILS_SHORT, RAIL_CHAIN_NAMES, RAILS_OS, RAILS_NOTE, RAILS_TICKER } from "../src/rails.js";
import { NETWORKS } from "../src/payments.js";
import { railsCoveredByLiveView } from "../src/revenue-live.js";

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

// --- 1. rails.js ↔ payments.js -------------------------------------------
const TESTNETS = new Set(["base-sepolia", "solana-devnet"]);
const settleable = Object.entries(NETWORKS).filter(([name]) => !TESTNETS.has(name));
const railCaip2 = new Set(RAILS.map((r) => r.caip2));
for (const [name, caip2] of settleable) {
  ok(railCaip2.has(caip2), `payments.js network "${name}" (${caip2}) has a RAILS entry — copy layer knows about it`);
}
const paymentsCaip2 = new Set(Object.values(NETWORKS));
for (const r of RAILS) {
  ok(paymentsCaip2.has(r.caip2), `RAILS "${r.name}" (${r.caip2}) is settleable in payments.js — copy doesn't advertise a dead rail`);
}

// --- derived strings mention every rail ----------------------------------
const assets = [...new Set(RAILS.map((r) => r.asset))];
for (const [label, str] of [["RAILS_AMP", RAILS_AMP], ["RAILS_OR", RAILS_OR], ["RAILS_PAREN", RAILS_PAREN], ["RAILS_NOTE", RAILS_NOTE]]) {
  for (const r of RAILS) ok(str.includes(r.name), `${label} names ${r.name}`);
  for (const a of assets) ok(str.includes(a), `${label} names ${a}`);
}
// RAILS_OS is a JSON-LD operatingSystem string — platforms, not assets: it
// must name every chain, and any non-USDC asset (the surprising one).
for (const r of RAILS) ok(RAILS_OS.includes(r.name), `RAILS_OS names ${r.name}`);
for (const r of RAILS.filter((x) => x.asset !== "USDC")) ok(RAILS_OS.includes(r.asset), `RAILS_OS marks ${r.name} as ${r.asset}`);
ok(RAILS_SHORT.includes("USDG") && RAILS_SHORT.includes("Robinhood"), "RAILS_SHORT carries the non-USDC rail");
ok(RAIL_CHAIN_NAMES.length === RAILS.length, "RAIL_CHAIN_NAMES covers every rail");
ok(railsCoveredByLiveView(), "/revenue live view has a read-config for every rail — new rails can't be invisible there");

// --- 2. live pages render the rails (opt-in via TARGET_URL) ---------------
const TARGET = process.env.TARGET_URL;
if (TARGET) {
  const PAGES = ["/", "/pricing", "/tools", "/docs", "/faq"];
  for (const p of PAGES) {
    const res = await fetch(`${TARGET}${p}`);
    const html = await res.text();
    ok(res.status === 200, `${p} responds 200`);
    for (const r of RAILS) ok(html.includes(r.name), `${p} mentions ${r.name}`);
    for (const a of assets) ok(html.includes(a), `${p} mentions ${a}`);
    ok(html.includes(RAILS_TICKER), `${p} topbar strip carries the full rail ticker`);
  }
  const manifest = await (await fetch(`${TARGET}/.well-known/x402`)).json();
  for (const r of RAILS) ok((manifest.ecosystem?.chains || []).includes(r.name), `manifest chains include ${r.name}`);
} else {
  console.log("(TARGET_URL unset — live-page checks skipped)");
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

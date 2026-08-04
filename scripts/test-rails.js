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

// The daily revenue-digest guard used to live here. It was removed with the
// workflow (2026-08-04): the digest kept its OWN copy of the rail list, which
// is what the guard existed to police - no duplicate list, nothing to drift.
// The digest itself was retired because /revenue and /api/revenue already
// serve every rail live in ~0.2s, nobody had engaged with the issue it wrote
// in 13 months, and it was the only surface publishing buyer wallet addresses
// to the public internet - re-publishing them daily.

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

// 3. CONFIGURED vs OFFERED must be reportable.
//
// A rail nobody can settle is dropped from the offer so the other chains keep
// earning (see scripts/test-supported-guard.js for that behaviour). What was
// missing is the DIFFERENCE: on 2026-08-01 the offer silently served 11 of 12
// configured chains and the gap went unnoticed for hours while paid revenue was
// $0, because it lived only in a boot log. railStatus() makes it queryable.
{
  const { railStatus } = await import("../src/payments.js");
  const rows = railStatus();
  ok(Array.isArray(rows), "railStatus() is callable before any payment mount and returns an array");
  for (const r of rows) {
    ok(typeof r.network === "string" && r.network.length > 0, `rail row names its network (${r.network})`);
    ok(typeof r.offered === "boolean", `${r.network}: offered is a boolean, never undefined`);
    ok(r.offered ? r.reason === null : typeof r.reason === "string",
      `${r.network}: an un-offered rail explains itself; an offered one carries no reason`);
  }
}

// 4. A network failure must NAME ITSELF.
//
// undici flattens every network-level failure to the bare string "fetch
// failed" and hangs the real reason on err.cause. Verified: a DNS failure and
// a refused connection produce byte-identical messages; only the cause tells
// them apart. summarizeFacilitatorError used to end at msg.slice(0,240),
// dropping it one line before logging.
//
// That is why a Monad settle failure looked like an unknowable blip and got
// written off as "transient". It was never unknowable - the field that named
// it was being discarded. A cause we throw away is not a cause we lack.
{
  const { summarizeFacilitatorError } = await import("../src/payments.js");
  const withCause = (props) => Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("inner"), props) });

  const dns = summarizeFacilitatorError(withCause({ code: "ENOTFOUND", syscall: "getaddrinfo" }));
  const refused = summarizeFacilitatorError(withCause({ code: "ECONNREFUSED", syscall: "connect", address: "1.2.3.4", port: 443 }));
  ok(/ENOTFOUND/.test(dns), `a DNS failure names itself (${dns})`);
  ok(/ECONNREFUSED/.test(refused) && /1\.2\.3\.4/.test(refused), `a refused connection names host and reason (${refused})`);
  ok(dns !== refused, "two different network failures no longer produce identical output");

  // Dual-stack hosts (the Monad facilitator is A+AAAA behind Cloudflare) fail
  // via AggregateError, whose wrapper carries no code at all.
  const agg = Object.assign(new Error("fetch failed"), {
    cause: new AggregateError([
      Object.assign(new Error("a"), { code: "ENETUNREACH", address: "2606:4700::1", port: 443 }),
      Object.assign(new Error("b"), { code: "ECONNRESET", address: "104.21.87.156", port: 443 }),
    ]),
  });
  const aggOut = summarizeFacilitatorError(agg);
  ok(/ENETUNREACH/.test(aggOut) && /ECONNRESET/.test(aggOut),
    `a dual-stack failure reports EVERY address tried, so IPv6-vs-IPv4 is distinguishable (${aggOut})`);

  // A facilitator that answers with a structured error must still summarize as
  // before - this must not regress the HTTP-error path.
  const http = summarizeFacilitatorError(new Error('Facilitator failed (402): {"errorMessage":"insufficient_funds"}'));
  ok(/insufficient_funds/.test(http), `a structured facilitator error still summarizes (${http})`);
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

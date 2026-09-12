#!/usr/bin/env node
// Delivery-failure memory: a seller whose PAID calls fail stops being ranked,
// and stops being labelled callable.
//
// The gap this closes, measured 2026-09-11. Our index ranked one origin FIRST
// for its task and its public row said `routerDispatchEligible: true` and
// `executeViaCallableNow: true`. A paid probe from the burner answered HTTP
// 500 after 120 seconds with no Payment-Receipt, and a buyer had reported
// exactly that through the wish board eleven days earlier. Nothing in the
// dispatch verdict could see it: the verdict is built from crawl readiness and
// SETTLEMENT EVIDENCE, which is history, and a seller's history does not
// change when its backend starts failing. So it kept the top ranking.
//
// Two halves, both pinned here: the memo itself (recorded from the paid leg,
// cleared by a delivered 200, forgotten on a TTL) and the label (a chain named
// in it is not eligible whatever its settlement count says).
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

const {
  payX402, noteSellerDeliveryFailure, clearSellerDeliveryFailure,
  sellerDeliveryFailingRecently, __resetSellerDeliveryFailuresForTest,
  sellerRefusedRecently, __resetSellerRefusalsForTest, _spentThisWindow,
} = await import("../src/x402-buyer.js");
const { dispatchEligibility, DISPATCH_REASONS, dispatchLegend } = await import("../src/dispatch-eligibility.js");

// --- 1. the memo primitive ---------------------------------------------------
{
  __resetSellerDeliveryFailuresForTest();
  eq(sellerDeliveryFailingRecently("https://seller.example", "base"), null, "an unknown seller is not failing - absence is never a verdict");
  noteSellerDeliveryFailure("https://seller.example", "base", { status: 500, ms: 120_256 });
  const hit = sellerDeliveryFailingRecently("https://seller.example", "base");
  ok(hit && hit.status === 500 && hit.ms === 120256, "the status and how long it took are both kept: a 500 in 120 s and a 500 in 40 ms are different failures");
  eq(sellerDeliveryFailingRecently("https://seller.example", "solana"), null, "the memo is per CHAIN - the same origin on another rail is untouched");
  eq(sellerDeliveryFailingRecently("HTTPS://Seller.Example/", "base")?.status, 500, "the key is normalised (case, trailing slash), so one seller is one memo");

  // A delivered call is proof the seller works NOW: it beats the memo at once,
  // rather than making every buyer wait out a TTL on stale evidence.
  clearSellerDeliveryFailure("https://seller.example", "base");
  eq(sellerDeliveryFailingRecently("https://seller.example", "base"), null, "a success clears the memo immediately");

  noteSellerDeliveryFailure("https://seller.example", "base", { status: null, ms: null });
  ok(sellerDeliveryFailingRecently("https://seller.example", "base"), "a timeout with no status is still a failure (status null, not a missing memo)");
  eq(sellerDeliveryFailingRecently("https://seller.example", "base", Date.now() + 25 * 3600 * 1000), null, "and it is forgotten after the TTL (a day by default) with no redeploy");

  noteSellerDeliveryFailure("", "base", { status: 500 });
  noteSellerDeliveryFailure("https://x.example", "", { status: 500 });
  eq(sellerDeliveryFailingRecently("", "base"), null, "an unknown origin records nothing rather than a memo that matches everything");
  __resetSellerDeliveryFailuresForTest();
  for (let i = 0; i < 520; i++) noteSellerDeliveryFailure(`https://s${i}.example`, "base", { status: 500 });
  ok(!sellerDeliveryFailingRecently("https://s0.example", "base") && sellerDeliveryFailingRecently("https://s519.example", "base"), "the map is size-bounded: the oldest entries are dropped, never unbounded growth from a hostile origin list");
}

// --- 2. the label: a failing chain is not eligible, whatever its history ------
{
  const proven = { routable: true, networks: ["eip155:8453"], settled: 5_000, payers: 40, spendChains: ["base"], minSettled: 50, minPayers: 3 };
  ok(dispatchEligibility(proven).eligible === true, "control: a seller far past the settlement floor is eligible");
  const failing = dispatchEligibility({ ...proven, deliveryFailing: { base: { at: "2026-09-11T01:00:00.000Z", status: 500, ms: 120256 } } });
  eq(failing.eligible, false, "the SAME seller, with 5,000 settled calls and 40 payers, is NOT eligible once its last paid call failed to deliver");
  eq(failing.reason, "delivery_failing", "and the reason says so, rather than hiding behind settlement_required");
  // THE VERDICT IS PUBLIC, THE EVIDENCE IS NOT. Publishing "they answered HTTP
  // 500 after 120 seconds" on a page about a named third party is a specific
  // adverse claim, and every other figure we publish is a count, a gate
  // verdict, or something the seller advertises about itself. The detail reads
  // back through /__operator/router-delivery.json instead.
  ok(!("lastFailure" in failing.chains.base), "the public verdict does NOT echo what the seller answered");
  ok(!/120256|2026-09-11T01|"status"|"ms"|lastFailure/.test(JSON.stringify(failing)), "no status, latency or timestamp of the failure survives anywhere in the public verdict");
  eq(failing.chains.base.reason, "delivery_failing", "...only the verdict, which is a statement about what WE do");
  ok(DISPATCH_REASONS.delivery_failing && /deliver/i.test(DISPATCH_REASONS.delivery_failing), "the reason is documented in the public vocabulary, not a bare string");
  ok(/delivery_failing/.test(JSON.stringify(dispatchLegend())), "the legend explains the verdict");
  ok(/deliberately NOT published/.test(JSON.stringify(dispatchLegend())), "...and states plainly that the underlying observation is withheld, so a seller reading the legend knows the evidence exists and can ask for it");

  // Every other chain resolves proven-ness at pay time, which would otherwise
  // report eligible for a seller we have already proven does not deliver.
  const svm = { routable: true, networks: ["solana"], settled: 0, spendChains: ["solana"] };
  eq(dispatchEligibility(svm).chains.solana.eligible, true, "control: a Solana row is eligible (proven-ness is read at pay time)");
  eq(dispatchEligibility({ ...svm, deliveryFailing: { solana: { at: "x", status: 503, ms: 900 } } }).reason, "delivery_failing",
     "a pay-time chain is refused the same way - the check runs before the pay-time verdict, not after it");

  // Per chain, so a seller broken on one rail keeps the other.
  const both = { routable: true, networks: ["eip155:8453", "solana"], settled: 5_000, payers: 40, spendChains: ["base", "solana"], minSettled: 50, minPayers: 3 };
  const one = dispatchEligibility({ ...both, deliveryFailing: { base: { at: "x", status: 500, ms: 1 } } });
  eq(one.eligible, true, "a seller failing on Base but fine on Solana is still dispatchable");
  eq(one.chains.base.reason, "delivery_failing", "...on the chain that works, and refused on the one that does not");
  eq(one.chains.solana.eligible, true, "the working chain is untouched");

  // Precedence: the earliest unfixed thing is still named first.
  eq(dispatchEligibility({ ...proven, routable: false, deliveryFailing: { base: { at: "x" } } }).reason, "crawl_failed",
     "a seller we cannot even crawl reads crawl_failed - delivery_failing never masks an earlier blocker");
  eq(dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 0, spendChains: ["base"], deliveryFailing: { base: { at: "x" } } }).reason, "delivery_failing",
     "but it OUTRANKS settlement_required: history cannot see an outage, and this can");
  eq(dispatchEligibility({ ...proven, deliveryFailing: {} }).eligible, true, "an empty map changes nothing");
  eq(dispatchEligibility({ ...proven, deliveryFailing: null }).eligible, true, "and null is the ordinary case");
}

// --- 3. the paid leg records it, and a delivered call clears it ---------------
// The whole memo is worthless if nothing writes to it, so this drives payX402
// against a stub seller that settles the payment and then fails.
{
  process.env.X402_UPSTREAM_BUYER_KEY = "0x" + randomBytes(32).toString("hex");
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const accept = { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "1000", payTo: "0x" + "ee".repeat(20), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  const hdr = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [accept] })).toString("base64");
  const origFetch = globalThis.fetch;
  /** @param paidResponse what the seller answers once the credential is presented */
  const sellerThat = (paidResponse) => async (url, init) => {
    const credential = init?.headers?.["PAYMENT-SIGNATURE"] || init?.headers?.["payment-signature"] || init?.headers?.["X-PAYMENT"];
    if (!credential) return { status: 402, headers: { get: (h) => (h.toLowerCase() === "payment-required" ? hdr : null) }, json: async () => ({}), text: async () => "{}" };
    return paidResponse();
  };
  const hdrs = (map = {}) => ({ get: (h) => map[String(h).toLowerCase()] ?? null });
  const buy = (origin) => payX402(`${origin}/x`, { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", notDebited: async () => ({ debited: true, observed: 1 }) }).then((r) => r, (e) => e);

  __resetSellerDeliveryFailuresForTest();
  __resetSellerRefusalsForTest();

  // (a) 500 after payment, no receipt - the exact shape the paid probe measured.
  globalThis.fetch = sellerThat(() => ({ status: 500, headers: hdrs({ "content-type": "text/plain; charset=UTF-8" }), text: async () => "Internal Server Error", json: async () => ({}) }));
  const failed = await buy("https://broken.example");
  ok(failed instanceof Error && failed.statusCode === 502, "control: a 500 after payment is still a 502 to the buyer, uncommitted-flagged as before");
  const memo = sellerDeliveryFailingRecently("https://broken.example", "base");
  ok(memo && memo.status === 500, "the paid leg RECORDED the delivery failure - without this line the memo is decorative");
  ok(typeof memo.ms === "number" && memo.ms >= 0, "with how long the buyer waited for it");
  eq(sellerRefusedRecently("https://broken.example", "base"), null, "and it is NOT filed as a refusal: a refusal means nobody was charged, and this seller took the payment");

  // (b) a 5xx that DID settle (receipt present) is the seller's transient blip
  //     on an otherwise working path - still no delivery, still memoized. The
  //     distinction that matters is the receipt, not the status.
  __resetSellerDeliveryFailuresForTest();
  const receipt = Buffer.from(JSON.stringify({ success: true, transaction: "0xabc", network: "base" })).toString("base64");
  globalThis.fetch = sellerThat(() => ({ status: 502, headers: hdrs({ "payment-response": receipt }), text: async () => "bad gateway", json: async () => ({}) }));
  await buy("https://receipted.example");
  eq(sellerDeliveryFailingRecently("https://receipted.example", "base"), null, "a 5xx carrying a settle receipt is NOT memoized: the seller's payment path worked and the evidence says so");

  // (c) a refusal (402) is not a delivery failure.
  __resetSellerDeliveryFailuresForTest();
  globalThis.fetch = sellerThat(() => ({ status: 402, headers: hdrs({ "content-type": "application/json" }), clone: () => ({ text: async () => "{}" }), text: async () => JSON.stringify({ error: "payment_verification_failed" }), json: async () => ({}) }));
  await buy("https://refuser.example");
  eq(sellerDeliveryFailingRecently("https://refuser.example", "base"), null, "a 402 on the paid retry is a refusal, and refusals keep their own memo with their own (shorter) life");

  // (d) a delivered 200 clears a standing memo.
  __resetSellerDeliveryFailuresForTest();
  noteSellerDeliveryFailure("https://recovered.example", "base", { status: 500, ms: 120000 });
  globalThis.fetch = sellerThat(() => ({ status: 200, headers: hdrs({ "content-type": "application/json" }), text: async () => JSON.stringify({ ok: true }), json: async () => ({ ok: true }) }));
  const served = await buy("https://recovered.example");
  ok(served && served.result && served.result.ok === true, "control: the delivered answer reaches the buyer");
  eq(sellerDeliveryFailingRecently("https://recovered.example", "base"), null, "a seller that delivers is forgiven on the spot - no TTL wait, no redeploy");

  globalThis.fetch = origFetch;
  __resetSellerDeliveryFailuresForTest();
  __resetSellerRefusalsForTest();
  ok(typeof _spentThisWindow() === "bigint", "the spend window is intact after the stub buys");
}

// --- 4. the consult sites, pinned FROM SOURCE --------------------------------
// A memo nothing reads is worse than no memo: it looks like a control. Both
// readers are asserted here because neither is reachable from an offline test.
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const fn = server.slice(server.indexOf("async function resolveExternalSeller"), server.indexOf("async function resolveExternalSeller") + 12000);
  // The literal statement, not just the call: a guard whose result is discarded
  // (or short-circuited away) reads identically to one that works.
  ok(fn.includes("const failing = sellerDeliveryFailingRecently(r.seller, chain);"), "the resolver consults the memo for the candidate and chain it is about to pay");
  const after = fn.slice(fn.indexOf("const failing = sellerDeliveryFailingRecently(r.seller, chain);"), fn.indexOf("const failing = sellerDeliveryFailingRecently(r.seller, chain);") + 600);
  ok(/^\s*if \(failing\) \{/m.test(after) && after.includes("continue; }"), "...and a hit SKIPS the candidate - the verdict is acted on, not logged");
  ok(fn.indexOf("const failing = sellerDeliveryFailingRecently(r.seller, chain);") < fn.indexOf("await assertPublicUrl(r.url)"),
     "...BEFORE the live probe, so a failing seller costs no round trip at all");
  ok(/deliveryFailing: local \? null : deliveryFailingByChain\(origin\)/.test(server),
     "and every public row is labelled from the same memo, so the label and the routing decision cannot drift");
  ok(/function deliveryFailingByChain[\s\S]{0,600}spendChainsConfigured\(\)/.test(server),
     "the label covers every chain this host can actually spend on, not just Base");
  ok(/__operator\/router-delivery\.json/.test(server) && /operatorAuthed\(req\)/.test(server.slice(server.indexOf("__operator/router-delivery.json"), server.indexOf("__operator/router-delivery.json") + 400)),
     "the failure detail reads back through an OPERATOR-AUTHED route, so it exists where it is useful and nowhere it is a public accusation");
  ok(!/lastFailure/.test(readFileSync(new URL("../src/dispatch-eligibility.js", import.meta.url), "utf8")),
     "and the shared verdict function no longer emits it at all, so no surface can reintroduce it by accident");
  const buyer = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8");
  ok(/paid\.status >= 500 && !\(paid\.headers\.get\("payment-response"\)/.test(buyer), "the recording rule is 5xx AND no receipt, read from the response itself");
  ok(buyer.indexOf("noteSellerDeliveryFailure(sellerOrigin, chain, { status: paid.status") < buyer.indexOf("const evmAuth = chain === \"base\""),
     "recorded BEFORE the Base/Solana chain-truth checks, so a Tempo or Algorand seller that fails after payment is recorded too");
}

console.log(`test-seller-delivery-memory: ${n} assertions OK`);

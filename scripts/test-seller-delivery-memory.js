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
  sellerDeliveryMemoEntries, DELIVERY_FAIL_STRIKES_REQUIRED, isCallerInputStatus,
} = await import("../src/x402-buyer.js");
const { dispatchEligibility, DISPATCH_REASONS, dispatchLegend } = await import("../src/dispatch-eligibility.js");

// --- 1. the memo primitive ---------------------------------------------------
{
  __resetSellerDeliveryFailuresForTest();
  const fail = (o, c, x) => noteSellerDeliveryFailure(o, c, x);
  const seen = (o, c, now) => sellerDeliveryFailingRecently(o, c, now);

  eq(seen("https://s.example", "base"), null, "an unknown seller is not failing - absence is never a verdict");

  // TWO STRIKES. One 5xx is weather: this repo's own probe-classify doctrine
  // calls 502/503/504 upstream and never fatal, and our own deploys produce
  // exactly that shape several times a day.
  fail("https://s.example", "base", { status: 500, ms: 120256 });
  eq(seen("https://s.example", "base"), null, "ONE failure changes no routing decision - it is recorded so the second can see it, and nothing more");
  fail("https://s.example", "base", { status: 500, ms: 40 });
  const hit = seen("https://s.example", "base");
  ok(hit && hit.strikes === 2, "the SECOND failure inside the window makes it actionable");
  ok(hit.status === 500 && hit.ms === 40, "the newest observation is kept");
  ok(hit.firstAt <= hit.at, "and when the pattern started, so an operator can see how long it has been going");

  eq(seen("https://s.example", "solana"), null, "the memo is per CHAIN - the same origin on another rail is untouched");
  eq(seen("HTTPS://S.Example/", "base")?.strikes, 2, "the key is normalised (case, trailing slash), so one seller is one memo");

  clearSellerDeliveryFailure("https://s.example", "base");
  eq(seen("https://s.example", "base"), null, "a clear forgets it, strikes and all");

  // TTL, read at CALL TIME so the kill switch does not need a restart, and
  // malformed falls back to the DEFAULT rather than to permanent.
  fail("https://ttl.example", "base", { status: 500 }); fail("https://ttl.example", "base", { status: 500 });
  ok(seen("https://ttl.example", "base"), "actionable now");
  eq(seen("https://ttl.example", "base", Date.now() + 25 * 3600 * 1000), null, "and forgotten after the default TTL of a day");

  // A fresh origin: the expiry read above DELETED the ttl.example entry, which
  // is correct behaviour and would otherwise make the env cases below prove
  // nothing.
  fail("https://env.example", "base", { status: 500 }); fail("https://env.example", "base", { status: 500 });
  const prevEnv = process.env.SOR_SELLER_DELIVERY_FAIL_TTL_MS;
  process.env.SOR_SELLER_DELIVERY_FAIL_TTL_MS = "0";
  eq(seen("https://env.example", "base"), null, "TTL 0 DISARMS the memo entirely - the kill switch works without a redeploy, because the value is read at call time");
  process.env.SOR_SELLER_DELIVERY_FAIL_TTL_MS = "1d";
  ok(seen("https://env.example", "base"), "a MALFORMED value falls back to the default TTL, never to NaN - `now - at > NaN` is false forever, which would have made every memo permanent, and a typo must not select the most dangerous mode");
  process.env.SOR_SELLER_DELIVERY_FAIL_TTL_MS = "-5";
  ok(seen("https://env.example", "base"), "...and so does a negative");
  process.env.SOR_SELLER_DELIVERY_FAIL_TTL_MS = "off";
  eq(seen("https://env.example", "base"), null, "`off` disarms too, for an operator who reaches for a word instead of a zero");
  if (prevEnv === undefined) delete process.env.SOR_SELLER_DELIVERY_FAIL_TTL_MS; else process.env.SOR_SELLER_DELIVERY_FAIL_TTL_MS = prevEnv;

  fail("", "base", { status: 500 });
  eq(seen("", "base"), null, "an unknown origin records nothing rather than a memo that matches everything");

  // EVICTION IS LEAST-RECENTLY-FAILED. Map.set on an existing key keeps its
  // original slot, so the plain set this started as evicted the MOST broken
  // seller first while 499 one-off failures sat safely behind it. A test with
  // only distinct keys cannot see that, which is why this one refreshes.
  __resetSellerDeliveryFailuresForTest();
  noteSellerDeliveryFailure("https://worst.example", "base", { status: 500 });
  for (let i = 0; i < 400; i++) noteSellerDeliveryFailure(`https://s${i}.example`, "base", { status: 500 });
  noteSellerDeliveryFailure("https://worst.example", "base", { status: 500 }); // keeps failing -> moves to the tail
  for (let i = 400; i < 520; i++) noteSellerDeliveryFailure(`https://s${i}.example`, "base", { status: 500 });
  ok(sellerDeliveryFailingRecently("https://worst.example", "base")?.strikes === 2,
     "the seller that KEEPS failing survives eviction: a repeat strike re-inserts at the tail, so eviction is least-recently-failed and not anti-correlated with how broken a seller is");
  eq(sellerDeliveryFailingRecently("https://s0.example", "base"), null, "and the oldest untouched entries are the ones dropped");
  __resetSellerDeliveryFailuresForTest();
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

// --- 3. the paid leg records it, and ONLY for the router ---------------------
// The memo decides where our money goes, and payX402 is not router-private: a
// $0.10 public tool reaches the same function with a url, method and body the
// CALLER chose. The opt-in is the security control, so it is tested from both
// sides.
{
  process.env.X402_UPSTREAM_BUYER_KEY = "0x" + randomBytes(32).toString("hex");
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const accept = { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "1000", payTo: "0x" + "ee".repeat(20), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  const hdr = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [accept] })).toString("base64");
  const origFetch = globalThis.fetch;
  const sellerThat = (paidResponse) => async (url, init) => {
    const cred = init?.headers?.["PAYMENT-SIGNATURE"] || init?.headers?.["payment-signature"] || init?.headers?.["X-PAYMENT"];
    if (!cred) return { status: 402, headers: { get: (h) => (h.toLowerCase() === "payment-required" ? hdr : null) }, json: async () => ({}), text: async () => "{}" };
    return paidResponse();
  };
  const hdrs = (map = {}) => ({ get: (h) => map[String(h).toLowerCase()] ?? null });
  const receipt = Buffer.from(JSON.stringify({ success: true, transaction: "0xabc", network: "base" })).toString("base64");
  // memoizeDelivery mirrors what server.js passes: true only for the router.
  const buy = (origin, { asRouter = true } = {}) => payX402(`${origin}/x`, {
    maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base",
    notDebited: async () => ({ debited: true, observed: 1 }), memoizeDelivery: asRouter,
  }).then((r) => r, (e) => e);

  __resetSellerDeliveryFailuresForTest(); __resetSellerRefusalsForTest();

  // (a) the router's own paid call, 500 with no receipt: recorded, and
  //     actionable only on the SECOND one.
  globalThis.fetch = sellerThat(() => ({ status: 500, headers: hdrs({ "content-type": "text/plain" }), text: async () => "Internal Server Error", json: async () => ({}) }));
  const failed = await buy("https://broken.example");
  ok(failed instanceof Error && failed.statusCode === 502, "control: a 500 after payment is still a 502 to the buyer");
  eq(sellerDeliveryFailingRecently("https://broken.example", "base"), null, "one strike is not yet a verdict");
  await buy("https://broken.example");
  const memo = sellerDeliveryFailingRecently("https://broken.example", "base");
  ok(memo && memo.strikes === 2 && memo.status === 500, "the paid leg RECORDED both strikes - without those lines the memo is decorative");
  eq(sellerRefusedRecently("https://broken.example", "base"), null, "and it is NOT filed as a refusal: a refusal means nobody was charged, and this seller took the payment");

  // (b) THE SAME FAILURE through a caller-parameterised tool writes NOTHING.
  //     This is the whole security control: seller-payability ($0.10) hands
  //     payX402 a url and body the buyer chose, so an unguarded write was a
  //     paid 24-hour routing ban against any origin on the internet.
  __resetSellerDeliveryFailuresForTest();
  await buy("https://victim.example", { asRouter: false });
  await buy("https://victim.example", { asRouter: false });
  eq(sellerDeliveryFailingRecently("https://victim.example", "base"), null,
     "a diagnostic call CANNOT memoize a seller, however many times it fails - memoizeDelivery defaults to false and only the router opts in");
  eq(sellerDeliveryMemoEntries().length, 0, "...and writes no row at all, so it cannot flush the map either");

  // (b2) THE DEFAULT ITSELF. Every case above passes the flag explicitly, so
  //      none of them can see the default flip from false to true - and the
  //      default IS the control: any caller other than the router reaches
  //      payX402 with no such option and must write nothing. Called with the
  //      bare option set the other callers use.
  __resetSellerDeliveryFailuresForTest();
  globalThis.fetch = sellerThat(() => ({ status: 500, headers: hdrs({ "content-type": "text/plain" }), text: async () => "nope", json: async () => ({}) }));
  const bare = { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", notDebited: async () => ({ debited: true, observed: 1 }) };
  await payX402("https://default.example/x", bare).catch(() => {});
  await payX402("https://default.example/x", bare).catch(() => {});
  eq(sellerDeliveryMemoEntries().length, 0,
     "a caller that passes NO memoizeDelivery option writes nothing at all - the default is false, and that default is the security control rather than a convenience");

  // (c) a 5xx carrying a settle receipt is not a delivery failure.
  __resetSellerDeliveryFailuresForTest();
  globalThis.fetch = sellerThat(() => ({ status: 502, headers: hdrs({ "payment-response": receipt }), text: async () => "bad gateway", json: async () => ({}) }));
  await buy("https://receipted.example"); await buy("https://receipted.example");
  eq(sellerDeliveryFailingRecently("https://receipted.example", "base"), null, "a 5xx carrying a settle receipt is NOT memoized: the seller's payment path worked and the evidence says so");

  // (d) a 402 refusal the chain proves was uncharged RETRACTS any strike.
  __resetSellerDeliveryFailuresForTest();
  noteSellerDeliveryFailure("https://refuser.example", "base", { status: 500 });
  noteSellerDeliveryFailure("https://refuser.example", "base", { status: 500 });
  ok(sellerDeliveryFailingRecently("https://refuser.example", "base"), "seeded as failing");
  // The seller's payment layer refusing: its offer comes back with the 402.
  globalThis.fetch = sellerThat(() => ({ status: 402, headers: hdrs({ "content-type": "application/json", "payment-required": hdr }), clone: () => ({ text: async () => "{}" }), text: async () => JSON.stringify({ error: "payment_verification_failed" }), json: async () => ({}) }));
  const refuse = () => payX402("https://refuser.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", memoizeDelivery: true, notDebited: async () => ({ debited: false, observed: 1, expired: true }) }).catch(() => {});
  await refuse();
  eq(sellerDeliveryFailingRecently("https://refuser.example", "base"), null,
     "a refusal the CHAIN proves was uncharged retracts the delivery memo: nobody paid, so it is a refusal and carries the refusal's shorter penalty, not both");
  await refuse();
  ok(sellerRefusedRecently("https://refuser.example", "base"), "...and is filed as the refusal it is (benching the route on its second strike)");

  // (e) only a SETTLED 200 clears. A bare 200 proves the route answers; it does
  //     not prove the seller takes payment and delivers, and the weaker rule
  //     made the memo purchasable through a route the seller knows works.
  __resetSellerDeliveryFailuresForTest();
  noteSellerDeliveryFailure("https://half.example", "base", { status: 500 });
  noteSellerDeliveryFailure("https://half.example", "base", { status: 500 });
  globalThis.fetch = sellerThat(() => ({ status: 200, headers: hdrs({ "content-type": "application/json" }), text: async () => JSON.stringify({ ok: true }), json: async () => ({ ok: true }) }));
  await buy("https://half.example");
  ok(sellerDeliveryFailingRecently("https://half.example", "base"), "a 200 with NO settle receipt does not clear the memo");
  __resetSellerDeliveryFailuresForTest();
  noteSellerDeliveryFailure("https://good.example", "base", { status: 500 });
  noteSellerDeliveryFailure("https://good.example", "base", { status: 500 });
  globalThis.fetch = sellerThat(() => ({ status: 200, headers: hdrs({ "content-type": "application/json", "payment-response": receipt }), text: async () => JSON.stringify({ ok: true }), json: async () => ({ ok: true }) }));
  const served = await buy("https://good.example");
  ok(served && served.result && served.result.ok === true, "control: the delivered answer reaches the buyer");
  eq(sellerDeliveryFailingRecently("https://good.example", "base"), null, "a 200 that SETTLED clears it on the spot - no TTL wait, no redeploy");

  // (f) A 4xx AFTER A CHARGE (2026-09-28). The memo saw only a 5xx, so a seller
  //     that took the payment and answered 400 wrote nothing. On Base the
  //     chain answers exactly (the nonce we signed was consumed).
  __resetSellerDeliveryFailuresForTest();
  globalThis.fetch = sellerThat(() => ({ status: 404, headers: hdrs({ "content-type": "application/json" }), text: async () => JSON.stringify({ error: "no route" }), json: async () => ({}) }));
  const f1 = await buy("https://took-it.example");
  ok(f1 instanceof Error && f1.committed === true, "control: a 404 after a proven debit stays a committed 502 (the money left)");
  await buy("https://took-it.example");
  const took = sellerDeliveryFailingRecently("https://took-it.example", "base");
  ok(took && took.strikes === 2 && took.status === 404, "two 404s after a proven debit make the seller actionable - no buyer input selects the indexed route");
  // (f2) THE ATTACK (2026-09-28 review): an upfront-settling seller answers a
  //      malformed body 400/413/415/422 after the charge, and route-execute
  //      forwards the caller's params as that body. Two bad bodies, proven
  //      debit AND the seller's own receipt, must not bench it.
  for (const st of [400, 413, 415, 422]) {
    __resetSellerDeliveryFailuresForTest();
    globalThis.fetch = sellerThat(() => ({ status: st, headers: hdrs({ "content-type": "application/json", "payment-response": receipt }), text: async () => JSON.stringify({ error: "bad input" }), json: async () => ({}) }));
    const a = await buy("https://honest.example"); await buy("https://honest.example");
    ok(a instanceof Error && a.committed === true, `control: a charged ${st} is still a committed 502`);
    eq(sellerDeliveryMemoEntries().length, 0, `two charged ${st}s on a buyer-written body do NOT bench the seller`);
  }
  eq(isCallerInputStatus(404) || isCallerInputStatus(402) || isCallerInputStatus(500), false, "404, a charged 402 and every 5xx stay the seller's fault");
  // (g) the SAME 400 with no debit is the seller answering the request our
  //     caller wrote: nothing recorded.
  __resetSellerDeliveryFailuresForTest();
  const undebited = () => payX402("https://said-no.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", memoizeDelivery: true, notDebited: async () => ({ debited: false, observed: 1, expired: true }) }).catch(() => {});
  await undebited(); await undebited();
  eq(sellerDeliveryMemoEntries().length, 0, "control: a 400 the chain proves was uncharged records nothing (an honest seller refusing a bad request is not failing)");
  // (h) a 403 carrying the seller's own success receipt, chain unreadable:
  //     the seller says it took the payment. One strike per call, whichever
  //     source said so first.
  __resetSellerDeliveryFailuresForTest();
  globalThis.fetch = sellerThat(() => ({ status: 403, headers: hdrs({ "content-type": "application/json", "payment-response": receipt }), text: async () => "{}", json: async () => ({}) }));
  await payX402("https://self-declared.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", memoizeDelivery: true, notDebited: async () => { throw new Error("rpc down"); } }).catch(() => {});
  eq(sellerDeliveryMemoEntries().find((e) => e.origin === "https://self-declared.example")?.strikes, 1, "a 4xx with a success receipt is a strike even when the chain cannot be read");
  await buy("https://both.example");
  eq(sellerDeliveryMemoEntries().find((e) => e.origin === "https://both.example")?.strikes, 1, "a receipt AND a consumed nonce on one call are ONE strike, not two");
  await buy("https://both.example", { asRouter: false }); await buy("https://nobody.example", { asRouter: false });
  eq(sellerDeliveryMemoEntries().find((e) => e.origin === "https://both.example")?.strikes, 1, "and a caller that did not opt in adds nothing");
  ok(!sellerDeliveryMemoEntries().some((e) => e.origin === "https://nobody.example"), "...anywhere");

  globalThis.fetch = origFetch;
  __resetSellerDeliveryFailuresForTest(); __resetSellerRefusalsForTest();
}

// --- 4. the consult sites, pinned FROM SOURCE --------------------------------
// A memo nothing reads is worse than no memo: it looks like a control. Both
// readers are asserted here because neither is reachable from an offline test.
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  // Slice to the function's REAL end, not a byte count. This used to take the
  // first 12000 characters, and the live probe sat at ~11900 of a function that
  // has since grown past 24000 - so adding a comment block to the resolver put
  // the probe outside the window, indexOf returned -1, and the ordering check
  // failed while the ordering itself was untouched. A pin measured in bytes
  // expires on the next edit.
  const fnStart = server.indexOf("async function resolveExternalSeller");
  const fnEnd = server.indexOf("async function diagnoseExternalSeller", fnStart);
  ok(fnStart >= 0 && fnEnd > fnStart, "the resolver and the function that follows it are both still present (the slice has real bounds)");
  const fn = server.slice(fnStart, fnEnd);
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
  // The ONE writer, pinned from source: any second call site that forgets the
  // flag is inert, but one that ADDS it is a new write primitive.
  ok(/payExternal: \(url, opts\) =>[\s\S]{0,160}memoizeDelivery: true/.test(server),
     "route-execute's payExternal is the only caller that opts into writing the memo");
  eq((server.match(/memoizeDelivery: true/g) || []).length, 1,
     "...and it is the ONLY place in the server that passes it - a second one would be a second way to ban a seller");
  ok(/pay: async \(url, opts\) =>[\s\S]{0,120}payX402\(url, opts\)/.test(server),
     "seller-payability still passes its options through UNCHANGED, so it inherits the false default and cannot write");
  const buyer = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8");
  ok(/memoizeDelivery && paid\.status >= 500 && !\(paid\.headers\.get\("payment-response"\)/.test(buyer),
     "the recording rule is opt-in AND 5xx AND no receipt, read from the response itself");
  ok(!/noteSellerDeliveryFailure\(sellerOrigin, chain, \{ status: null/.test(buyer),
     "a TIMEOUT is never recorded: route-execute forwards the caller's params as the seller's request body, so a caller can hand a seller a URL that never answers, and our own slow egress produces the identical error");
  ok(/memoizeDelivery && tx\) \{ clearSellerDeliveryFailure\(sellerOrigin, chain\);/.test(buyer),
     "and the CLEAR needs a settle receipt, so the memo cannot be bought off through a route the seller knows works");
  ok(/deliveryFailures\.delete\(key\);\n  if \(deliveryFailures\.size >= DELIVERY_FAIL_MAX\)/.test(buyer),
     "eviction deletes before it sets, so a repeat strike moves to the tail and the most-broken seller is not the first one evicted");
  ok(/if \(evmCheckable && verdict && verdict\.debited === true\) strikeChargedFailure\(/.test(buyer),
     "a debit strikes only on the EXACT chain read (the signed nonce): a Solana debit is our wallet moving in a window, which a concurrent buy can produce");
  ok(buyer.indexOf("noteSellerDeliveryFailure(sellerOrigin, chain, { status: paid.status") < buyer.indexOf("if (chainCheckable) {"),
     "recorded BEFORE the Base/Solana chain-truth checks, so a Tempo or Algorand seller that fails after payment is recorded too");
}

console.log(`test-seller-delivery-memory: ${n} assertions OK`);

#!/usr/bin/env node
// The router's proven-ness must come from money we watched move, not from a
// registry's membership list.
//
//   node scripts/test-settlement-proof.js
//
// WHY: SOR_MIN_SETTLED_TX exists so we never spend a buyer's money on an
// unproven seller. Its evidence came only from the Bazaar-derived leaderboard,
// which quietly turned the question "has this seller settled?" into "is this
// seller in a registry we crawl?". A seller registering nowhere scored 0 no
// matter how much it settled — and the #2 merchant on Base by settlement count
// is exactly that seller. The gate said "unproven" where the truth was
// "unlooked", which is the same error as calling an empty scan a clean one.
//
// These assertions pin the join and, just as importantly, the honesty of the
// gap measurement: a scan that returned nothing must never be reported as a
// blind spot of size zero.
import { provenByChain, unattributedMerchants, merchantsByAddress, baseNetworkPayTo, advertisedPayToEvidence, sharedPayToClaims, payToFromLive402, provenPayToMatches } from "../src/settlement-proof.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const BASE = "eip155:8453";
const A = "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa";
const B = "0xBbbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb";
const OURS = "0xCcccCCccCCccCCccCCccCCccCCccCCccCCccCCcc";
const seller = (origin, payTo) => ({ origin, payToByNetwork: payTo ? { [BASE]: payTo } : {} });
const merchant = (m, payments, payers = 3, volumeUsd = 1) => ({ merchant: m, payments, payers, volumeUsd });

// --- the join: registry membership is irrelevant --------------------------
{
  // `unlisted` appears in NO registry — it is only in our crawl. Before this
  // module it scored 0 and could never be routed to.
  const sellers = [seller("https://unlisted.example", A), seller("https://listed.example", B)];
  const proven = provenByChain({ sellers, merchants: [merchant(A, 198_543), merchant(B, 91)] });
  ok(proven.get("https://unlisted.example")?.settled === 198543,
    "an origin in no registry is proven by its own on-chain settlements");
  ok(proven.get("https://unlisted.example")?.source === "chain", "and the evidence is labelled as chain-derived");
  ok(proven.get("https://listed.example")?.settled === 91, "a second origin joins independently");
}

// --- case handling: EVM folds, everything else must NOT --------------------
{
  // The advertised payTo and the on-chain merchant row routinely differ in
  // checksum case. EVM addresses are case-insensitive so they must still join.
  const proven = provenByChain({
    sellers: [seller("https://mixed.example", A.toUpperCase())],
    merchants: [merchant(A.toLowerCase(), 500)],
  });
  ok(proven.get("https://mixed.example")?.settled === 500, "EVM addresses join case-insensitively");

  // base58/Stellar are case-SENSITIVE; folding them merges distinct wallets
  // (same rule as src/payer.js). Non-EVM rows must be ignored, never folded.
  const svm = merchantsByAddress([{ merchant: "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg", payments: 999 }]);
  ok(svm.size === 0, "a non-EVM merchant address is skipped, never case-folded into the EVM map");
  ok(baseNetworkPayTo(seller("https://x.example", "not-an-address")) === null, "a malformed payTo yields no join key");
}

// --- no payTo, no evidence -------------------------------------------------
{
  const proven = provenByChain({ sellers: [seller("https://nopayto.example", null)], merchants: [merchant(A, 900)] });
  ok(proven.size === 0, "an origin advertising no Base payTo is never credited with someone else's settlements");
}

// --- the gap measurement ---------------------------------------------------
{
  const sellers = [seller("https://known.example", A)];
  const merchants = [merchant(A, 1000), merchant(B, 700), merchant(OURS, 400)];
  const gap = unattributedMerchants({ sellers, merchants, ourAddresses: [OURS], minPayments: 50 });
  ok(gap.unattributedCount === 1, `only the unknown merchant is unattributed (got ${gap.unattributedCount})`);
  ok(gap.unattributed[0].merchant === B.toLowerCase(), "and it is the one matching no crawled origin");
  ok(!gap.unattributed.some((r) => r.merchant === OURS.toLowerCase()), "our own treasury is not a discovery gap");
  ok(gap.unattributedShareOfPayments === Number((700 / 2100).toFixed(4)),
    `the share of settlement activity we cannot route to is reported (got ${gap.unattributedShareOfPayments})`);

  const quiet = unattributedMerchants({ sellers, merchants: [merchant(B, 10)], minPayments: 50 });
  ok(quiet.unattributedCount === 0, "a merchant below the threshold is not counted as a gap");
  // Attribution is wider than routability: an origin we know (crawled but
  // down, or Bazaar-listed) that advertises B is a different finding from
  // "no idea who this is", and is reported as such.
  const known = new Map([[B.toLowerCase(), new Set(["https://listed-but-down.example"])]]);
  const gap2 = unattributedMerchants({ sellers, merchants, ourAddresses: [OURS], minPayments: 50, knownPayToOrigins: known });
  ok(gap2.unattributedCount === 0 && gap2.attributedUnroutableCount === 1 && gap2.attributedUnroutable[0].origins[0] === "https://listed-but-down.example",
    `a merchant whose address a known origin advertises is attributed (unroutable), not a blind spot (got unattributed=${gap2.unattributedCount} unroutable=${gap2.attributedUnroutableCount})`);
  ok(gap2.originsWithKnownPayTo === 3, `known payTos = routable + attributed + ours (got ${gap2.originsWithKnownPayTo})`);
}

// --- THE HONESTY INVARIANT -------------------------------------------------
// An empty scan and a scan showing nothing unattributed are different facts.
// Reporting "0 unattributed" for a scan that never ran is precisely the vacuous
// green this codebase keeps having to re-learn.
{
  ok(unattributedMerchants({ sellers: [], merchants: [] }) === null,
    "no merchant data returns null — an unknown blind spot is never reported as zero");
  ok(unattributedMerchants({ sellers: [], merchants: null }) === null, "a missing scan is also null, not zero");
  const real = unattributedMerchants({ sellers: [], merchants: [merchant(A, 60)], minPayments: 50 });
  ok(real && real.unattributedCount === 1, "...but a scan WITH data still reports a real gap");
}

// --- degenerate inputs must not throw --------------------------------------
{
  ok(provenByChain({}).size === 0, "no inputs yields an empty proof map");
  ok(provenByChain({ sellers: null, merchants: null }).size === 0, "null inputs are handled");
  ok(merchantsByAddress(undefined).size === 0, "undefined merchants handled");
}

// --- a SHARED address proves nothing about any one origin -------------------
// A settlement count is evidence an ADDRESS received money, not that a given
// origin delivered the service. Measured on our own index: 858 of 2,008
// payTo-bearing origins shared an address, and ONE address was claimed by 144
// origins - each of which would otherwise inherit the whole platform's history
// and clear the spend gate on it.
{
  const sellers = [seller("https://a.test", A), seller("https://b.test", A), seller("https://solo.test", B)];
  const merchants = [merchant(A, 198_543), merchant(B, 120)];
  const proven = provenByChain({ sellers, merchants });
  ok(!proven.has("https://a.test") && !proven.has("https://b.test"),
    "neither origin sharing an address gets chain proof — the count is unattributable");
  ok(proven.get("https://solo.test")?.settled === 120,
    "a sole claimant still earns its own evidence");
  ok(proven.size === 1, `only the attributable origin is credited (got ${proven.size})`);

  // Dividing would invent an attribution we cannot make; the exclusion must be
  // visible rather than silent.
  const shared = sharedPayToClaims({ sellers });
  ok(shared.length === 1 && shared[0].claimedBy === 2,
    "the withheld address is reportable, so the exclusion is not silent");
  ok(shared[0].origins.length === 2, "and names the origins claiming it");
}

// --- trust earned by one address must be spent at that address --------------
{
  const hdr = Buffer.from(JSON.stringify({ accepts: [{ network: BASE, payTo: A }] })).toString("base64");
  ok(payToFromLive402({ header: hdr }) === A, "reads the payTo from an x402 v2 header quote");
  ok(payToFromLive402({ body: JSON.stringify({ accepts: [{ network: BASE, payTo: B }] }) }) === B,
    "falls back to a body quote for sellers that do not use the header");
  ok(payToFromLive402({ header: "!!!", body: "nope" }) === null,
    "an unreadable quote yields null — never a guessed address");

  ok(provenPayToMatches({ provenPayTo: A, livePayTo: A.toUpperCase() }).verdict === "match",
    "checksum case does not create a false mismatch");
  ok(provenPayToMatches({ provenPayTo: A, livePayTo: B }).verdict === "mismatch",
    "earning trust on one address and billing at another is a MISMATCH");
  ok(provenPayToMatches({ provenPayTo: null, livePayTo: A }).verdict === "unknown",
    "no proven address on record is UNKNOWN, not a pass");
  ok(provenPayToMatches({ provenPayTo: A, livePayTo: null }).verdict === "unknown",
    "an unreadable live quote is UNKNOWN, not a pass — and the router only refuses on a positive mismatch");
}

// --- advertised payTo vs observed receipts ---------------------------------
// A seller publishes a payTo; that is a claim, not a receipt. One live seller
// advertised one address while every settlement we traced went to another.
{
  const M = [merchant(A, 900)];
  const seen = advertisedPayToEvidence({ seller: seller("https://a.example", A), merchants: M });
  ok(seen.checked === true && seen.observedAtAdvertisedAddress === true && seen.settlementsObserved === 900,
    "an advertised address we have observed receiving money is reported as observed");

  const unseen = advertisedPayToEvidence({ seller: seller("https://b.example", B), merchants: M });
  ok(unseen.checked === true && unseen.observedAtAdvertisedAddress === false,
    "an advertised address with no observed receipts is reported as unobserved");
  ok(/not proof of anything by itself/.test(unseen.note),
    "...and says so WITHOUT calling it fraud — absence of evidence has innocent explanations");

  // The honesty invariant again: an empty scan must never read as a clean bill.
  const noScan = advertisedPayToEvidence({ seller: seller("https://a.example", A), merchants: [] });
  ok(noScan.checked === false && noScan.observedAtAdvertisedAddress === undefined,
    "no merchant scan reports checked:false, never a clean bill");
  const noAddr = advertisedPayToEvidence({ seller: seller("https://c.example", null), merchants: M });
  ok(noAddr.checked === false, "a seller advertising no payTo is not judged either");
}

// --- THE SHAPE INVARIANT: drive the REAL production accessor ---------------
//
// Everything above builds sellers by hand. That is exactly how this shipped
// broken: routableSellerSummaries() did not carry payToByNetwork, so
// provenByChain returned an empty Map in production forever while these
// assertions passed green against a shape nothing emits. A unit test over a
// fixture cannot notice that its fixture is fiction.
//
// So this block imports the real accessor, warm-starts the real crawl cache,
// and asserts the join works on whatever THAT returns.
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "a402-join-"));
  const cacheFile = join(dir, "cache.json");
  const ADDR = "0xDdddDDddDDddDDddDDddDDddDDddDDddDDddDDdd";
  writeFileSync(cacheFile, JSON.stringify({
    entries: [["https://unlisted.example", {
      origin: "https://unlisted.example", fetchedAt: Date.now(), health: 1,
      tools: [{ slug: "t", name: "t", price: 0.002, method: "GET", url: "https://unlisted.example/api/t",
        networks: [BASE], payToByNetwork: { [BASE]: ADDR } }],
    }]],
  }));
  const idx = await import("../src/x402-index.js");
  idx.loadPersistedIndexCache(cacheFile);
  const realSellers = idx.routableSellerSummaries();

  ok(realSellers.length > 0, "the real accessor returns the warm-started seller");
  ok(realSellers.every((r) => r.payToByNetwork && typeof r.payToByNetwork === "object"),
    "routableSellerSummaries() carries payToByNetwork — the field the join depends on");
  const realProven = provenByChain({ sellers: realSellers, merchants: [merchant(ADDR, 12_345)] });
  ok(realProven.get("https://unlisted.example")?.settled === 12345,
    `the join produces evidence from the REAL accessor, not just a fixture (got ${realProven.get("https://unlisted.example")?.settled})`);
  const realGap = unattributedMerchants({ sellers: realSellers, merchants: [merchant(ADDR, 12_345)], minPayments: 50 });
  ok(realGap.originsWithKnownPayTo >= 1,
    `the gap metric sees the seller's payTo through the real accessor (got ${realGap.originsWithKnownPayTo})`);
  rmSync(dir, { recursive: true, force: true });
}

// --- the one link in the chain no behavioural test can reach -----------------
//
// resolveExternalSeller lives inside server.js and is not exported, so the
// hand-off from the resolver to the payer cannot be driven from here the way
// route-execute's can (that one IS covered, by injection, in
// test-route-execute.js). A source scan is a weaker instrument than a
// behavioural test and is used ONLY because the stronger one is unavailable:
// it proves the two ends still reference each other, not that they work.
//
// Without it, deleting `provenPayTo` from the resolver's return breaks the
// binding in production while every suite stays green - the payer would receive
// undefined, read it as UNKNOWN, and refuse nothing.
{
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  // An unproven Base candidate (2026-09-30) binds to the address its own
  // live 402 named; every other candidate still binds to the proven one.
  ok(/provenPayTo:\s*\(r\.unproven && chain === "base" && r\.chainProvenPayTo\) \|\| provenPayToByOrigin\?\.get\(norm\(r\.seller\)\)/.test(server),
    "resolveExternalSeller returns provenPayTo, so the spend has an address to bind against");
  const buyer = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8");
  // `payable.payTo` is the whole point (the accept being signed, never
  // accepts[0]); anything after it is allowed, because the call gained an
  // address FAMILY when the Algorand rail started using this binding too
  // (2026-09-18) and a pin that forbids a second argument would have to be
  // rewritten for every rail rather than guarding the one thing it is for.
  ok(/provenPayToMatches\(\{\s*provenPayTo,\s*livePayTo:\s*payable\.payTo\s*[,}]/.test(buyer),
    "payX402 binds against `payable` - the accept it signs - and not accepts[0]");
  ok(buyer.indexOf("provenPayToMatches") < buyer.indexOf("const spendToken = reserveSpend"),
    "the binding runs BEFORE any spend is held or signed, so a mismatch costs nothing");
}

// The ALGORAND family of the same helper (2026-09-18). EVM addresses are hex
// and fold; an Algorand address is uppercase base32 with a checksum, so a
// lowercased one is not that address and must never be folded into a match -
// the base58/strkey rule from src/payer.js, one chain over.
//
// These live here because this file owns the helper. They are a SECOND home
// for the rule, not its only one: test-algorand-router.js pins the same
// mutation through the resolver. The commit that added this block claimed the
// mutation "passed the whole suite", which was wrong - it passed THIS file,
// which was the only one its author re-ran. Two suites kill it, and the
// correction is recorded here because a false claim about coverage is worse
// than the duplication it was offered to justify.
{
  const ALGO_A = "A".repeat(58);
  const ALGO_B = "B".repeat(58);
  ok(provenPayToMatches({ provenPayTo: ALGO_A, livePayTo: ALGO_A, family: "algorand" }).verdict === "match",
    "algorand: the same advertised and live address is a match");
  ok(provenPayToMatches({ provenPayTo: ALGO_A, livePayTo: ALGO_B, family: "algorand" }).verdict === "mismatch",
    "algorand: a different live address is a mismatch, which is what refuses the seller");
  ok(provenPayToMatches({ provenPayTo: ALGO_A, livePayTo: ALGO_A.toLowerCase(), family: "algorand" }).verdict !== "match",
    "algorand: a lowercased address is NOT folded into a match");
  ok(provenPayToMatches({ provenPayTo: ALGO_A, livePayTo: null, family: "algorand" }).verdict === "unknown",
    "algorand: an unreadable live payTo is unknown, and unknown never blocks");
  ok(provenPayToMatches({ provenPayTo: "0x" + "a".repeat(40), livePayTo: "0x" + "a".repeat(40), family: "algorand" }).verdict === "unknown",
    "algorand: an EVM address in the algorand family is not an address at all");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

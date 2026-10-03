#!/usr/bin/env node
// A seller's own word on where it is paid outranks a registry's record of
// where an earlier payment went (2026-10-03).
//
// Reported by a seller: their /.well-known/x402 names one EVM payTo, NEW, on
// every network, and our index published OLD (a wallet they had left) as their
// Base payTo, because one Coinbase Bazaar row still recorded a payment to OLD.
// The seller-level payTo was "first seen per network wins" over a tool list
// whose Bazaar rows come first, and the manifest merge filled the origin's own
// address only where a row held none. The router label then took OLD as the
// seller's live payTo and refused the history at NEW as evidence_payto_mismatch.
// A re-registration that read the live 402 fixed it until the next crawl
// rebuilt the Bazaar row and kept its address.
//
// Offline: the real crawl pipeline through the __setCrawlFetchForTest seam,
// with the registry rows set through __testSetBazaarTools.
process.env.X402_INDEX_CRAWL = "off";
const {
  sellerDetail, sellerPayToByNetwork, payToSourceOf, bazaarItemToTool, mergeOpenapiIntoBazaar,
  mergeManifestIntoTools, normaliseManifestTools, carryForwardLearnedQuotes, sharesPayTo,
  allPayTosByNetwork, allPayToOrigins, __setCrawlFetchForTest, __testResetSubmitted, __resetRobotsCacheForTest,
  __crawlSellerForTest, __testSeedCache, __testSetBazaarTools,
} = await import("../src/x402-index.js");
const { evidencePayToVerdict } = await import("../src/dispatch-eligibility.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const BASE = "eip155:8453", POLY = "eip155:137";
const NEW = "0xF7Eb4b12D673dF433d76B2DBD9CA41Db3fE1836E";
const OLD = "0x1FfD0FE3D4E0e4bA6337231b9a81B6672aED9744";
const REG_POLY = "0x" + "b2".repeat(20);
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const O = "https://gateway.example.invalid";

const accept = (network, payTo) => ({ scheme: "exact", network, amount: "1000", asset: USDC, payTo, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } });
// The Bazaar's record of /metadata: a payment settled to OLD on Base, and one
// to REG_POLY on Polygon (a network the seller's own documents name nothing on).
const bazaarRows = () => [
  bazaarItemToTool({ resource: `${O}/metadata`, method: "POST", accepts: [accept(BASE, OLD), accept(POLY, REG_POLY)] }, O),
];
// The seller's manifest: a service-wide payment block naming NEW on Base.
const manifest = {
  name: "Gateway",
  payment: { protocol: "x402", network: BASE, networks: [BASE], asset: "USDC", priceUsd: 0.001, payTo: NEW },
  tools: [
    { name: "metadata", method: "POST", route: "/metadata", priceUsd: 0.001, description: "Page metadata." },
    { name: "read", method: "POST", route: "/read", priceUsd: 0.001, description: "Readable text." },
  ],
};

// ── The pure pieces ─────────────────────────────────────────────────────────
{
  const b = bazaarRows()[0];
  ok(payToSourceOf(b, BASE) === "registry", "a Bazaar row's payTo reads as the registry's");
  const m = normaliseManifestTools(manifest, O);
  ok(m.length === 2 && m.every((t) => t.payToByNetwork?.[BASE] === NEW), "control: the manifest rows carry NEW from the service-wide block");
  ok(payToSourceOf(m[0], BASE) === "origin", "a manifest row's payTo reads as the origin's");
  // Seller level, Bazaar rows first (indexSnapshot's order) and last.
  ok(sellerPayToByNetwork([b, ...m])[BASE] === NEW, "seller level: the origin's own Base payTo wins over a registry row listed first");
  ok(sellerPayToByNetwork([...m, b])[BASE] === NEW, "seller level: and listed last");
  ok(sellerPayToByNetwork([b, ...m])[POLY] === REG_POLY, "seller level: a registry-only network is still filled");
  ok(allPayTosByNetwork([b, ...m])[BASE].includes(OLD), "the old wallet stays listed in payTosByNetwork as history");

  // The manifest merge onto the Bazaar row.
  const merged = mergeManifestIntoTools(m, mergeOpenapiIntoBazaar([], bazaarRows()));
  const meta = merged.find((t) => t.route === "/metadata");
  ok(meta?.payToByNetwork?.[BASE] === NEW, "manifest merge: the origin's address replaces a registry-only one on the same network");
  ok(payToSourceOf(meta, BASE) === "origin", "manifest merge: stamped as the origin's");
  ok(meta?.payToByNetwork?.[POLY] === REG_POLY && payToSourceOf(meta, POLY) === "registry", "manifest merge: a network the manifest does not name keeps the registry's address");

  // An address the origin's OpenAPI gave the row is NOT replaced by the manifest.
  const fromOpenapi = { ...bazaarRows()[0], payToByNetwork: { [BASE]: "0x" + "c3".repeat(20) }, payToSourceByNetwork: { [BASE]: "origin" } };
  const kept = mergeManifestIntoTools(m, [fromOpenapi]).find((t) => t.route === "/metadata");
  ok(kept?.payToByNetwork?.[BASE] === "0x" + "c3".repeat(20), "manifest merge: an address the origin itself gave the row is left alone");

  // The OpenAPI merge: the operation's own payTo outranks the registry's.
  const op = { method: "POST", route: "/metadata", name: "metadata", payToByNetwork: { [BASE]: NEW } };
  const om = mergeOpenapiIntoBazaar([op], bazaarRows()).find((t) => t.route === "/metadata");
  ok(om?.payToByNetwork?.[BASE] === NEW && payToSourceOf(om, BASE) === "origin", "OpenAPI merge: the operation's payTo replaces the registry's");
  ok(om?.payToByNetwork?.[POLY] === REG_POLY && payToSourceOf(om, POLY) === "registry", "OpenAPI merge: the registry still fills the network the operation does not name");

  // Carry-forward: a remembered LIVE address outranks a registry address this
  // crawl rebuilt; a remembered registry address changes nothing.
  const rebuilt = () => mergeOpenapiIntoBazaar([], bazaarRows());
  const liveRead = { ...bazaarRows()[0], networks: [BASE], networksVerifiedAt: Date.now(), networksVerifiedMethod: "POST", payToByNetwork: { [BASE]: NEW }, payToSourceByNetwork: { [BASE]: "live" } };
  const cf = carryForwardLearnedQuotes(rebuilt(), { tools: [liveRead] }).find((t) => t.route === "/metadata");
  ok(cf?.payToByNetwork?.[BASE] === NEW && payToSourceOf(cf, BASE) === "live", "carry-forward: the live address read last crawl beats the rebuilt registry row");
  ok(cf?.payToByNetwork?.[POLY] === REG_POLY, "carry-forward: the registry-only network is kept");
  const legacy = { ...liveRead, payToSourceByNetwork: undefined };
  const cl = carryForwardLearnedQuotes(rebuilt(), { tools: [legacy] }).find((t) => t.route === "/metadata");
  ok(cl?.payToByNetwork?.[BASE] === OLD, "control: a remembered address with no origin source does not displace the current one (the rule is by source, not by order)");
  const ownNow = mergeManifestIntoTools(normaliseManifestTools(manifest, O), rebuilt());
  const co = carryForwardLearnedQuotes(ownNow, { tools: [{ ...liveRead, payToByNetwork: { [BASE]: "0x" + "d4".repeat(20) } }] }).find((t) => t.route === "/metadata");
  ok(co?.payToByNetwork?.[BASE] === NEW, "carry-forward: the origin's own document read this crawl still wins over a remembered address");
}

// ── The crawl, twice ────────────────────────────────────────────────────────
const served = new Map();
__setCrawlFetchForTest(async (url) => {
  const hit = served.get(url);
  if (!hit) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422 });
  return { html: typeof hit === "string" ? hit : JSON.stringify(hit), finalUrl: url, validators: null };
});
served.set(`${O}/robots.txt`, "User-agent: *\nAllow: /\n");
served.set(`${O}/.well-known/x402`, manifest);
__testResetSubmitted();
__resetRobotsCacheForTest();
__testSetBazaarTools(O, bazaarRows());

await __crawlSellerForTest(O);
let d = sellerDetail(O);
ok(d && !d.error, "the seller crawls from its manifest");
ok(d?.payToByNetwork?.[BASE] === NEW, "crawl 1: the published Base payTo is the origin's own (NEW), not the registry's (OLD)");
ok(d?.payToByNetwork?.[POLY] === REG_POLY, "crawl 1: a registry-only network is still filled");
ok(d?.payTosByNetwork?.[BASE]?.includes(NEW), "crawl 1: payTosByNetwork lists the origin's own wallet");
// The old wallet is still scanned as this origin's: the Base leaderboard's
// wallet list reads the raw registry rows too, so the history measured at OLD
// is still evidence, bound to OLD.
ok(allPayToOrigins(BASE).get(OLD.toLowerCase())?.has(O) && allPayToOrigins(BASE).get(NEW.toLowerCase())?.has(O), "crawl 1: both wallets are still scanned for this origin's settlement evidence");

await __crawlSellerForTest(O);
d = sellerDetail(O);
ok(d?.payToByNetwork?.[BASE] === NEW, "crawl 2: the old wallet does not come back on a re-crawl");

// A seller whose manifest names NO payTo: only the live read knew NEW. The
// previous crawl's row carries it (stamped live); the re-crawl rebuilds the
// Bazaar row with OLD, and the carry-forward must keep NEW.
{
  const P = "https://bare.example.invalid";
  served.set(`${P}/robots.txt`, "User-agent: *\nAllow: /\n");
  served.set(`${P}/.well-known/x402`, { name: "Bare", tools: [{ name: "metadata", method: "POST", route: "/metadata", description: "Page metadata." }] });
  const reg = [bazaarItemToTool({ resource: `${P}/metadata`, method: "POST", accepts: [accept(BASE, OLD)] }, P)];
  __testSetBazaarTools(P, reg);
  __testSeedCache([[P, { manifest: { name: "Bare" }, error: null, history: [1], fetchedAt: Date.now(), tools: [
    { ...reg[0], networks: [BASE], networksVerifiedAt: Date.now(), networksVerifiedMethod: "POST", payToByNetwork: { [BASE]: NEW }, payToSourceByNetwork: { [BASE]: "live" } },
  ] }]]);
  await __crawlSellerForTest(P);
  ok(sellerDetail(P)?.payToByNetwork?.[BASE] === NEW, "re-crawl: a live-read address survives the rebuilt registry row");
  __testSetBazaarTools(P, null);
}

// ── Common control (sharesPayTo) reads the origin's own address ─────────────
{
  __testSeedCache([
    ["https://claimant.example.invalid", { error: null, history: [1], tools: [bazaarRows()[0], ...normaliseManifestTools(manifest, O)] }],
    ["https://old-owner.example.invalid", { error: null, history: [1], tools: [{ route: "/x", payToByNetwork: { [BASE]: OLD } }] }],
  ]);
  ok(sharesPayTo("https://claimant.example.invalid", "https://old-owner.example.invalid") === null,
    "sharesPayTo: a wallet only a registry row records for the claimant is not its payTo");
}

// ── What the label then asks of the evidence (not loosened) ────────────────
{
  const evidence = { byWallet: new Map([[NEW.toLowerCase(), { settled: 60, payers: 4 }], [OLD.toLowerCase(), { settled: 5, payers: 3 }]]) };
  ok(evidencePayToVerdict({ evidence, livePayTo: d.payToByNetwork[BASE] }).verdict === "evidence_payto_match", "with history at NEW, the corrected payTo binds to it");
  ok(evidencePayToVerdict({ evidence, livePayTo: OLD }).verdict === "evidence_payto_mismatch", "control: the old address is the mismatch the seller saw");
  const onlyOld = { byWallet: new Map([[OLD.toLowerCase(), { settled: 60, payers: 4 }]]) };
  ok(evidencePayToVerdict({ evidence: onlyOld, livePayTo: d.payToByNetwork[BASE] }).verdict === "evidence_payto_mismatch", "history measured only at the old wallet does not clear the new one");
}

__testSetBazaarTools(O, null);
__testResetSubmitted();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

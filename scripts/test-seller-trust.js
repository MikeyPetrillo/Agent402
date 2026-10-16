#!/usr/bin/env node
// Offline unit tests for the seller-trust tool. No network: the crawler cache
// and settlement counts are injected.
//
// The invariants worth pinning are all HONESTY invariants — this tool reports on
// third parties, so every way it could overstate or understate evidence is a
// defect:
//   * an unknown origin is "no evidence", never a bad verdict
//   * advertised chains are never reported as proof of settlement
//   * the router gate reported here must match the router's real constants
//   * settled counts are a floor, and the caveats saying so must ship
//   * our own host is labelled self, not "untrustworthy"
//
//   node scripts/test-seller-trust.js
import { strict as assert } from "node:assert";
import { buildSellerTrustTool, assessSeller } from "../src/tools/seller-trust.js";
import { dispatchEligibility } from "../src/dispatch-eligibility.js";
import { priceUsdOf } from "../src/price-usd.js";

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}\n      ${e.message}`); }
};

const PROVEN = {
  origin: "https://proven.example",
  displayName: "Proven Seller",
  homepage: "https://proven.example",
  toolCount: 3,
  fetchedAt: 1785000000000,
  error: null,
  health: 1,
  routable: true,
  tools: [
    { method: "POST", route: "/a", slug: "a", name: "A", price: 0.002, paid: true, networks: ["eip155:8453"] },
    { method: "POST", route: "/b", slug: "b", name: "B", price: 0.04, paid: true, networks: ["eip155:8453"] },
    { method: "GET", route: "/free", slug: "free", name: "Free", price: null, paid: false },
  ],
};
const SOLANA_ONLY = { ...PROVEN, origin: "https://svm.example", tools: [{ route: "/x", slug: "x", price: 0.002, paid: true, networks: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"] }] };
const PRICEY = { ...PROVEN, origin: "https://pricey.example", tools: [{ route: "/x", slug: "x", price: 0.5, paid: true, networks: ["eip155:8453"] }] };

// Per-route verdicts from the REAL dispatchEligibility, built the way the
// server's sellerToolVerdicts builds them (row-level: price and template
// known). The server wiring itself is proven by test-seller-trust-lanes.js.
const verdictsVia = (settled, { payers, unprovenMaxUsd = 0.01 } = {}) => (detail) => (detail.tools || []).map((t) => {
  const p = priceUsdOf(t.price);
  const v = dispatchEligibility({
    routable: detail.routable !== false,
    networks: Array.isArray(t.networks) && t.networks.length ? t.networks : (detail.networks || []),
    settled: settled[detail.origin] || 0, payers: payers?.[detail.origin],
    priceUsd: p != null && p > 0 ? p : null, urlTemplate: /[{}]/.test(String(t.route || "")),
    spendChains: ["base"], minSettled: 50, minPayers: 3, unprovenMaxUsd,
  });
  return { ...t, routerDispatchEligible: v.eligible, routerDispatchReason: v.reason, routerDispatchByChain: v.chains };
});
const build = (details, settled, extra = {}) => buildSellerTrustTool({
  getSellerDetail: (host) => details.find((d) => d.origin.replace("https://", "") === host) || null,
  getSettledCalls: (origin) => settled[origin] || 0,
  getToolVerdicts: verdictsVia(settled, extra),
  getUnprovenMaxUsd: () => extra.unprovenMaxUsd ?? 0.01,
  sorThreshold: 50,
  sorCap: 0.005,
  settlementNetwork: "eip155:8453",
  ...extra,
});

// --- unknown origin: absence of evidence, never a bad verdict ----------------
check("an unindexed origin returns listed:false with a stated reason", () => {
  const t = build([], {});
  const r = t.handler({ origin: "nobody.example" });
  assert.equal(r.listed, false);
  assert.match(r.reason, /never crawled|no evidence/i, "must say we hold no evidence");
  assert.ok(r.howToList, "must tell an honest seller how to get listed");
  assert.ok(!("healthScore" in r), "must not invent a health score for an origin we never saw");
});

check("an unindexed origin is not described as untrustworthy", () => {
  const t = build([], {});
  const r = JSON.stringify(t.handler({ origin: "nobody.example" }));
  assert.ok(!/scam|fraud|untrust|unsafe|malicious/i.test(r), `verdict language leaked: ${r}`);
});

// --- the gate must mirror the router's real behaviour ------------------------
check("a proven in-cap Base seller is routable", () => {
  const t = build([PROVEN], { "https://proven.example": 120 });
  const r = t.handler({ origin: "proven.example" });
  assert.equal(r.routableByOurRouter, true, JSON.stringify(r.blockers));
  assert.equal(r.settledCallsObserved, 120);
  assert.deepEqual(r.blockers, []);
});

check("under the settlement threshold is not proven, says so numerically, and is routable through the unproven lane", () => {
  const t = build([PROVEN], { "https://proven.example": 49 });
  const r = t.handler({ origin: "proven.example" });
  assert.equal(r.routableAsProven, false);
  assert.equal(r.routerGate.meetsSettlementThreshold, false);
  assert.equal(r.routerGate.settlementThreshold, 50);
  assert.ok(r.provenBlockers.some((b) => /50 settled/.test(b)), `expected a numeric blocker, got ${r.provenBlockers}`);
  assert.ok(r.lanes.proven.blockers.some((b) => /50 settled/.test(b)));
  // the $0.002 route is below the floor with nothing else wrong: unproven lane
  assert.equal(r.lanes.unproven.eligible, true);
  assert.equal(r.routableByOurRouter, true);
  assert.equal(r.routableVia, "unproven");
});

check("a proven seller with too few distinct payers is not proven: the router's verdict, not only the count", () => {
  const t = build([PROVEN], { "https://proven.example": 120 }, { payers: { "https://proven.example": 1 } });
  const r = t.handler({ origin: "proven.example" });
  assert.equal(r.routerGate.meetsSettlementThreshold, true, "the bare count clears");
  assert.equal(r.routableAsProven, false, "but the router's breadth rule refuses it as proven");
  assert.ok(r.lanes.proven.blockers.some((b) => /settlement_required/.test(b)), JSON.stringify(r.lanes.proven.blockers));
});

check("advertising a chain is never treated as proof of settling on it", () => {
  const t = build([SOLANA_ONLY], { "https://svm.example": 5000 });
  const r = t.handler({ origin: "svm.example" });
  assert.equal(r.routableByOurRouter, false, "a Solana-only seller must not be Base-routable on advertised chains alone");
  assert.equal(r.lanes.unproven.eligible, false, "the unproven lane is Base only");
  assert.equal(r.routerGate.advertisesSettlementNetwork, false);
  assert.ok(r.caveats.some((c) => /not proof/i.test(c)), "the advertised-vs-settles caveat must ship");
});

check("a seller priced above the router cap is refused with the cap named", () => {
  const t = build([PRICEY], { "https://pricey.example": 999 });
  const r = t.handler({ origin: "pricey.example" });
  assert.equal(r.routerGate.hasToolWithinRouterCap, false);
  assert.equal(r.routerGate.routerUnderlyingCapUsd, 0.005);
  assert.equal(r.routerGate.cheapestPaidToolUsd, 0.5);
});

// --- counts are a floor, and the response must say so -----------------------
check("settled counts are labelled a floor, not a total", () => {
  const t = build([PROVEN], { "https://proven.example": 120 });
  const r = t.handler({ origin: "proven.example" });
  assert.ok(r.caveats.some((c) => /floor, not a total/i.test(c)), "the floor caveat must ship");
  assert.ok(r.caveats.some((c) => /no liveness probe/i.test(c)), "must disclose there is no call-time probe");
});

// --- free tools never inflate the paid picture ------------------------------
check("free resources are excluded from paid counts and price range", () => {
  const t = build([PROVEN], { "https://proven.example": 60 });
  const r = t.handler({ origin: "proven.example" });
  assert.equal(r.paidToolCount, 2, "the free resource must not count as paid");
  assert.deepEqual(r.priceRangeUsd, { min: 0.002, max: 0.04 });
});

// --- self ---------------------------------------------------------------------
check("our own host is labelled self rather than reading as a bad seller", () => {
  const t = build([{ ...PROVEN, origin: "https://agent402.tools" }], {}, { selfHost: "agent402.tools" });
  const r = t.handler({ origin: "agent402.tools" });
  assert.equal(r.self, true);
  assert.match(r.note, /never routes to itself/i);
  assert.ok(r.blockers.some((b) => /local catalog/.test(b)), "self blocker must explain, not accuse");
});

// --- input handling ----------------------------------------------------------
check("a full URL and a bare host resolve identically", () => {
  const t = build([PROVEN], { "https://proven.example": 60 });
  const a = t.handler({ origin: "https://proven.example/some/path" });
  const b = t.handler({ origin: "proven.example" });
  assert.equal(a.origin, b.origin);
  assert.equal(a.routableByOurRouter, b.routableByOurRouter);
});

check("missing or non-host input is a 400, never a guess", () => {
  const t = build([PROVEN], {});
  for (const bad of [undefined, "", "   ", "localhost", "not-a-host"]) {
    let code = null;
    try { t.handler({ origin: bad }); } catch (e) { code = e.statusCode; }
    assert.equal(code, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
});

check("the tool answers its own declared example", () => {
  const t = build([{ ...PROVEN, origin: "https://agent402.tools" }], {}, { selfHost: "agent402.tools" });
  const r = t.handler(t.discovery.example);
  assert.ok(r && typeof r === "object" && r.origin, "example input must produce a real answer");
});

// --- assessSeller purity -----------------------------------------------------
check("assessSeller is pure and tolerates a detail with no tools", () => {
  const a = assessSeller({ origin: "https://x.example", detail: { tools: [] }, settledCalls: 0, sorThreshold: 50, sorCap: 0.005, requireNetwork: "eip155:8453" });
  assert.deepEqual(a.advertisedNetworks, []);
  assert.equal(a.priceRangeUsd, null);
  assert.equal(a.routableByOurRouter, false);
});

// --- health is NOT paywall liveness -----------------------------------------
// Crawl health only says the manifest parsed. A seller whose every paid route
// 500s scores a perfect 1.0 on it — one live seller sat at health 1 in our
// index while every paid route returned a facilitator error. The tool must
// report paywall liveness SEPARATELY so a reader cannot mistake one for the
// other.
const DEAD_PAYWALL = {
  origin: "https://dead.example", displayName: "Dead", health: 1, toolCount: 3,
  fetchedAt: Date.now(), error: null,
  paywall: { ok: false, status: 500, url: "https://dead.example/api/x", at: Date.now() },
  tools: [{ price: 0.002, paid: true, networks: ["eip155:8453"] }],
};

check("a broken paywall is reported separately from a perfect health score", () => {
  const t = build([DEAD_PAYWALL], { "https://dead.example": 999 });
  const r = t.handler({ origin: "dead.example" });
  assert.equal(r.healthScore, 1, "health stays 1 — that is precisely the trap");
  assert.ok(r.paywall, "paywall liveness must be present");
  assert.equal(r.paywall.ok, false);
  assert.equal(r.paywall.status, 500);
  assert.ok(
    r.caveats.some((c) => /healthScore measures whether the manifest parsed/.test(c)),
    "caveats must state what healthScore does and does not mean"
  );
});

check("an unprobed paywall is null — absence, never a pass", () => {
  const t = build([{ ...DEAD_PAYWALL, paywall: null }], { "https://dead.example": 999 });
  assert.equal(t.handler({ origin: "dead.example" }).paywall, null);
});

check("the advertised payTo carries its own on-chain evidence", () => {
  const t = build([DEAD_PAYWALL], { "https://dead.example": 999 }, {
    getPayToEvidence: () => ({
      advertisedPayTo: "0x" + "a".repeat(40), checked: true,
      settlementsObserved: 0, observedAtAdvertisedAddress: false, note: "n",
    }),
  });
  const r = t.handler({ origin: "dead.example" });
  assert.ok(r.advertisedPayTo, "must surface the advertised-address evidence");
  assert.equal(r.advertisedPayTo.observedAtAdvertisedAddress, false);
});

check("without a payTo-evidence source the field is omitted, not faked", () => {
  const t = build([DEAD_PAYWALL], { "https://dead.example": 999 });
  assert.ok(!("advertisedPayTo" in t.handler({ origin: "dead.example" })));
});

// --- both lanes on REAL row shapes ---------------------------------------------
// Rows built by the crawler's own manifest reader (dollar LABELS, "$0.005") and
// read back through sellerDetail, as the server hands them to the tool.
{
  process.env.X402_INDEX_CRAWL = "off";
  const x = await import("../src/x402-index.js");
  const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const PAYTO = "0x9fb365E4E9385E2a39FeBAd70368267e6f571d9A";
  const seed = (origin, prices) => {
    const accepts = [{ scheme: "exact", network: "eip155:8453", payTo: PAYTO, amount: "5000", asset: BASE_USDC, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }];
    const rows = x.normaliseManifestTools({ x402Version: 2, accepts, resources: prices.map((p, i) => ({ resource: `${origin}/api/r${i}`, method: "POST", price: p, name: `R${i}`, accepts })) }, origin)
      .map((r) => ({ ...r, networks: ["eip155:8453"] }));
    return [origin, { tools: rows, manifest: { name: origin }, fetchedAt: Date.now(), error: null, history: [1], originResponded: true }];
  };
  const NEW = "https://example.com", PRICEY2 = "https://example.org", PROVEN2 = "https://example.net";
  x.__testResetSubmitted();
  x.__testSeedCache([seed(NEW, ["$0.005"]), seed(PRICEY2, ["$0.02"]), seed(PROVEN2, ["$0.005"])]);
  const realBuild = (settled, extra = {}) => buildSellerTrustTool({
    getSellerDetail: (host) => x.sellerDetail(host),
    getSettledCalls: (origin) => settled[origin] || 0,
    getToolVerdicts: verdictsVia(settled, extra),
    getUnprovenMaxUsd: () => extra.unprovenMaxUsd ?? 0.01,
    sorThreshold: 50, sorCap: 0.005, settlementNetwork: "eip155:8453",
  });

  check("real rows: the crawler stores label prices", () => {
    const d = x.sellerDetail("example.com");
    assert.ok(d && d.tools.length === 1 && d.tools[0].price === "$0.005", JSON.stringify(d?.tools?.map((t) => t.price)));
  });

  check("real rows: a seller below the floor with a $0.005 route is not proven but routable through the unproven lane", () => {
    const r = realBuild({ [NEW]: 3 }).handler({ origin: "example.com" });
    assert.equal(r.lanes.proven.eligible, false);
    assert.equal(r.routableAsProven, false);
    assert.equal(r.lanes.unproven.eligible, true, JSON.stringify(r.lanes.unproven));
    assert.equal(r.lanes.unproven.maxUsd, 0.01);
    assert.equal(r.lanes.unproven.toolCount, 1);
    assert.equal(r.lanes.unproven.cheapestUsd, 0.005);
    assert.match(r.lanes.unproven.note, /after every proven seller for the task, only at the wallet its own live 402 names/);
    assert.match(r.lanes.unproven.note, /flagged unproven on the buyer's receipt/);
    assert.equal(r.routableByOurRouter, true);
    assert.equal(r.routableVia, "unproven");
    assert.deepEqual(r.blockers, []);
  });

  check("real rows: a $0.02-only seller below the floor is routable through neither lane, and the ceiling is named", () => {
    const r = realBuild({ [PRICEY2]: 3 }).handler({ origin: "example.org" });
    assert.equal(r.lanes.proven.eligible, false);
    assert.equal(r.lanes.unproven.eligible, false);
    assert.equal(r.routableByOurRouter, false);
    assert.equal(r.routableVia, null);
    assert.match(r.lanes.unproven.reason, /above the \$0\.01 unproven ceiling/);
    assert.ok(r.blockers.some((b) => /^unproven lane: /.test(b)), JSON.stringify(r.blockers));
  });

  check("real rows: with the unproven ceiling switched off the lane is ineligible and says why", () => {
    const r = realBuild({ [NEW]: 3 }, { unprovenMaxUsd: 0 }).handler({ origin: "example.com" });
    assert.equal(r.lanes.unproven.eligible, false);
    assert.equal(r.lanes.unproven.maxUsd, 0);
    assert.match(r.lanes.unproven.reason, /switched off/);
    assert.equal(r.routableByOurRouter, false);
  });

  check("real rows: a proven seller is routable as proven, and the unproven lane says it does not apply", () => {
    const r = realBuild({ [PROVEN2]: 120 }, { payers: { [PROVEN2]: 10 } }).handler({ origin: "example.net" });
    assert.equal(r.lanes.proven.eligible, true, JSON.stringify(r.lanes.proven));
    assert.equal(r.routableAsProven, true);
    assert.equal(r.routableByOurRouter, true);
    assert.equal(r.routableVia, "proven");
    assert.equal(r.lanes.unproven.eligible, false);
    assert.match(r.lanes.unproven.reason, /proven seller/);
    assert.deepEqual(r.blockers, []);
  });
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Every reader of a crawled row's price reads the row as the crawler stores it.
//
// The manifest, OpenAPI and llms.txt readers keep the seller's dollar LABEL
// ("$0.01"); a live 402 stores a number. A reader that did Number(t.price)
// read every label as NaN, so a manifest-priced route counted as unpriced:
// the paid seller tools reported paidToolCount 0, a null price range and a
// false "no paid resource under the router's cap" blocker, and inside the
// index the same misreading made every labelled row a probe candidate on
// every crawl, hid it from the stale-quote, drift and weekly network checks,
// and let a free observation or a carried quote overwrite a price the seller
// stated this crawl.
//
// The rows here are built by the crawler's own readers (normaliseManifestTools,
// normaliseOpenapiTools, normaliseLlmsTxtTools) and read back through
// sellerDetail, plus one row captured verbatim (keys and value types) from a
// live /api/index?seller= answer with the origin replaced. No fixture types a
// numeric price where the crawler would store a label.
//
//   node scripts/test-price-label-readers.js
process.env.X402_INDEX_CRAWL = "off";
const x = await import("../src/x402-index.js");
const { priceUsdOf, isPricedAboveZero, priceToMicroUsd } = await import("../src/price-usd.js");
const { assessSeller } = await import("../src/tools/seller-trust.js");
const { composeSellerDossier } = await import("../src/tools/seller-dossier.js");
const { remoteToolRow } = await import("../src/decide/tool-rows.js");

let n = 0;
const failures = [];
const ok = (c, m) => { n++; if (!c) { failures.push(m); console.error(`FAIL - ${m}`); } };

const ORIGIN = "https://example.com"; // resolves: the SSRF guard checks the host before the (stubbed) fetch
const HOST = "example.com";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYTO = "0x9fb365E4E9385E2a39FeBAd70368267e6f571d9A";

// ------------------------------------------------------------ the one parser
ok(priceUsdOf("$0.01") === 0.01 && priceUsdOf(0.01) === 0.01 && priceUsdOf({ usd: 0.01 }) === 0.01 && priceUsdOf({ amountMinor: 1, currency: "USD" }) === 0.01,
  "a label, a number and a supported object give the same USD figure");
ok(priceUsdOf("0.003 USDC") === 0.003 && priceUsdOf("$0 USD") === 0, "currency words are read, a stated zero stays zero");
ok(priceUsdOf("$free (since 2026-09-02)") === null && priceUsdOf("call us") === null && priceUsdOf(null) === null && priceUsdOf("") === null && priceUsdOf([]) === null,
  "an unreadable value is null, never 0 (free) and never a date welded into a number");
ok(isPricedAboveZero("$0.005") && !isPricedAboveZero("$0") && !isPricedAboveZero("$free") && !isPricedAboveZero(null), "isPricedAboveZero: positive figures only");
ok(x.priceToMicroUsd === priceToMicroUsd, "the index re-exports the same parser, not a second copy");

// ------------------------------------------------- rows from the crawler itself
const accepts = [{ scheme: "exact", network: "eip155:8453", payTo: PAYTO, amount: "10000", asset: BASE_USDC, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }];
const manifestRows = x.normaliseManifestTools({
  x402Version: 2, accepts,
  resources: [
    { resource: `${ORIGIN}/api/a`, method: "POST", price: "$0.01", name: "A", accepts },
    { resource: `${ORIGIN}/api/b`, method: "GET", price: "0.005", name: "B", accepts },
  ],
}, ORIGIN);
ok(manifestRows.length === 2 && manifestRows.every((r) => typeof r.price === "string" && r.price.startsWith("$")),
  `the manifest reader stores dollar labels (got ${JSON.stringify(manifestRows.map((r) => r.price))})`);
const openapiRows = x.normaliseOpenapiTools({ openapi: "3.0.0", paths: { "/x402/c": { post: { summary: "C", "x-price": "$0.25" } } } }, ORIGIN);
ok(openapiRows.length === 1 && openapiRows[0].price === "$0.25" && openapiRows[0].originDeclaredPrice === 0.25,
  "the OpenAPI reader stores the label too (and a numeric originDeclaredPrice)");
const llmsRows = x.normaliseLlmsTxtTools("# Seller\n- [Thing](https://example.com/api/thing): does a thing ($0.02 per call)\n", ORIGIN);
ok(llmsRows.length === 1 && llmsRows[0].price === "$0.02" && llmsRows[0].originDeclaredPrice == null,
  "the llms.txt reader stores a label and stamps no declaration");

// A row as /api/index?seller= served it: price is a label, priceKnown true.
const CAPTURED_ROW = {
  method: "POST", route: "/x402/url-to-json", slug: "urlToJson", name: "Extract structured data", description: "Fetch a page and return JSON.",
  tags: ["web"], price: "$0.01", priceKnown: true, paid: true, networks: ["eip155:8453"], declared: true,
};

// ------------------------------------------------ the paid seller tools
const allRows = [...manifestRows, ...openapiRows].map((r) => ({ ...r, networks: ["eip155:8453"] }));
x.__testResetSubmitted();
x.__testSeedCache([[ORIGIN, { tools: allRows, manifest: { name: "Example" }, fetchedAt: Date.now(), error: null, history: [1], originResponded: true }]]);
const detail = x.sellerDetail(HOST);
ok(detail && detail.tools.length === 3 && detail.tools.every((t) => typeof t.price === "string"), "sellerDetail serves the labels as stored");

const trust = assessSeller({ origin: ORIGIN, detail, settledCalls: 100, sorThreshold: 50, sorCap: 0.005, requireNetwork: "eip155:8453" });
ok(trust.paidToolCount === 3, `seller-trust counts label-priced tools as paid (got ${trust.paidToolCount})`);
ok(trust.priceRangeUsd && trust.priceRangeUsd.min === 0.005 && trust.priceRangeUsd.max === 0.25, `seller-trust reports the price range (got ${JSON.stringify(trust.priceRangeUsd)})`);
ok(trust.gate.cheapestPaidToolUsd === 0.005 && trust.gate.hasToolWithinRouterCap === true, "the cheapest label-priced tool is within the cap");
ok(!trust.blockers.some((b) => /no paid resource/.test(b)) && trust.routableByOurRouter === true, `no false cap blocker (got ${JSON.stringify(trust.blockers)})`);

const capturedTrust = assessSeller({ origin: ORIGIN, detail: { origin: ORIGIN, tools: [CAPTURED_ROW, { ...CAPTURED_ROW, route: "/x402/b", price: "$0.005" }] }, settledCalls: 0, sorThreshold: 50, sorCap: 0.005, requireNetwork: "eip155:8453" });
ok(capturedTrust.paidToolCount === 2 && capturedTrust.priceRangeUsd?.min === 0.005 && capturedTrust.priceRangeUsd?.max === 0.01, "the captured /api/index row shape reads as priced");
ok(capturedTrust.blockers.length === 1 && /settled calls/.test(capturedTrust.blockers[0]), "only the real blocker (settlement count) is reported");

const unreadable = assessSeller({ origin: ORIGIN, detail: { origin: ORIGIN, tools: [{ ...CAPTURED_ROW, price: "$free (since 2026-09-02)" }, { ...CAPTURED_ROW, price: null }] }, settledCalls: 100, sorThreshold: 50, sorCap: 0.005, requireNetwork: "eip155:8453" });
ok(unreadable.paidToolCount === 0 && unreadable.priceRangeUsd === null, "an unreadable price is not a paid tool and adds nothing to the range");

const dossier = composeSellerDossier({
  host: HOST, detail, entry: x.sellerEntry(HOST), dispatch: null,
  helpers: { quoteIsStale: x.quoteIsStale, priceDisagreesWithOrigin: x.priceDisagreesWithOrigin, networksNeedLiveVerify: x.networksNeedLiveVerify },
  thresholds: { sorThreshold: 50, sorPayers: 3, sorCap: 0.005 },
});
ok(dossier.catalog.paidToolCount === 3, `seller-dossier counts label-priced tools (got ${dossier.catalog.paidToolCount})`);
ok(dossier.catalog.priceRangeUsd?.min === 0.005 && dossier.catalog.priceRangeUsd?.max === 0.25, `seller-dossier price range (got ${JSON.stringify(dossier.catalog.priceRangeUsd)})`);
ok(dossier.catalog.priceProvenance.unpriced === 0, `no label-priced route is counted unpriced (got ${dossier.catalog.priceProvenance.unpriced})`);
const rowA = dossier.catalog.tools.find((t) => t.route === "/api/a");
ok(rowA.priceUsd === 0.01 && rowA.price.source === "manifest" && rowA.price.originDeclaredUsd === 0.01, `the per-route price reads the label (got ${JSON.stringify({ priceUsd: rowA.priceUsd, source: rowA.price.source })})`);
ok(!dossier.flags.some((f) => /no priced route is indexed/.test(f)), "no false 'nothing priced' flag");
ok(!dossier.flags.some((f) => /cheapest priced route .* is above/.test(f)), "the cheapest label price (0.005) is not reported above the cap");
const tightCap = composeSellerDossier({ host: HOST, detail, entry: x.sellerEntry(HOST), dispatch: null, helpers: {}, thresholds: { sorThreshold: 50, sorPayers: 3, sorCap: 0.001 } });
ok(tightCap.flags.some((f) => /cheapest priced route \(\$0\.005\) is above the router's \$0\.001/.test(f)), `under a tighter cap the cheapest label price is named (got ${JSON.stringify(tightCap.flags.filter((f) => /cheapest|priced/.test(f)))})`);

// ------------------------------------------------ the index's own readers
const DAY = 24 * 3_600_000;
// quoteIsStale: a live-402 row whose probe matched the label keeps the label.
ok(x.quoteIsStale({ ...manifestRows[0], quoteSource: "live-402", quoteObservedAt: Date.now() - 8 * DAY }) === true,
  "quoteIsStale: an eight-day-old learned quote held as a label is stale");
// networksNeedLiveVerify: a manifest-priced, manifest-networked row with no read.
ok(x.networksNeedLiveVerify({ ...manifestRows[0], networks: ["eip155:8453"] }) === true,
  "networksNeedLiveVerify: a label-priced row with chains and no live read is due its first read");
// priceDisagreesWithOrigin: a held label 10x the declaration.
ok(x.priceDisagreesWithOrigin({ price: "$0.10", originDeclaredPrice: 0.01 }) === true, "priceDisagreesWithOrigin reads a held label against the declaration");
ok(x.priceDisagreesWithOrigin({ price: "$0.01", originDeclaredPrice: 0.01 }) === false, "...and agreement is agreement");
// quoteProbeCapFor: a catalog fully priced in labels gets the polite cap, not the new-catalog burst.
const labelled = Array.from({ length: 30 }, (_, i) => ({ route: `/r${i}`, price: "$0.01" }));
const unpricedCat = Array.from({ length: 30 }, (_, i) => ({ route: `/r${i}`, price: null }));
ok(x.quoteProbeCapFor(labelled) < x.quoteProbeCapFor(unpricedCat), `quoteProbeCapFor: a label-priced catalog is not 'unpriced' (got ${x.quoteProbeCapFor(labelled)} vs ${x.quoteProbeCapFor(unpricedCat)})`);

// carryForwardLearnedQuotes
{
  // A price the seller stated THIS crawl (llms.txt label) is not overwritten by a remembered quote.
  const now = [{ ...llmsRows[0] }];
  x.carryForwardLearnedQuotes(now, { tools: [{ route: "/api/thing", method: "GET", price: 0.05, quoteSource: "live-402", quoteObservedAt: Date.now() - 3_600_000 }] });
  ok(now[0].price === "$0.02" && !now[0].quoteCarriedForward, `carry-forward fills a gap only: a label stated this crawl stands (got ${now[0].price})`);
  // A remembered quote held as a label fills a row that stated no price.
  const gap = [{ route: "/api/a", method: "POST", price: null }];
  x.carryForwardLearnedQuotes(gap, { tools: [{ ...manifestRows[0], quoteSource: "live-402", quoteObservedAt: Date.now() - 3_600_000 }] });
  ok(gap[0].price === "$0.01" && gap[0].quoteCarriedForward === true, `a learned quote held as a label is carried into a gap (got ${gap[0].price})`);
  // An observed-free mark does not make a row free whose price the seller states this crawl.
  const stated = [{ ...llmsRows[0] }];
  x.carryForwardLearnedQuotes(stated, { tools: [{ route: "/api/thing", method: "GET", price: null, paid: false, quoteSource: "live-200", freeObservedAt: Date.now() - 3_600_000, quoteObservedAt: Date.now() - 3_600_000 }] });
  ok(stated[0].paid !== false && stated[0].price === "$0.02", `a free observation does not override a label stated this crawl (got paid ${stated[0].paid})`);
}

// enrichLiveQuotes, against a stubbed fetch
const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ ...accepts[0], amount: "10000" }] })).toString("base64");
const seen = [];
const stub = (rules) => async (url, init = {}) => {
  const u = new URL(String(url)); const m = String(init.method || "GET").toUpperCase();
  seen.push(`${m} ${u.pathname}`);
  const status = rules[`${m} ${u.pathname}`] ?? 404;
  const headers = new Headers(status === 402 ? { "payment-required": header, "content-type": "application/json" } : { "content-type": "application/json" });
  return new Response(status === 402 ? "{}" : JSON.stringify({ ok: true, data: [1, 2, 3] }), { status, headers });
};
const origLog = console.log; console.log = () => {};
const origFetch = globalThis.fetch;
try {
  // 1. A manifest-priced row with chains and its own fresh read is NOT re-probed by the automatic crawl.
  globalThis.fetch = stub({ "POST /api/a": 402 });
  seen.length = 0;
  const fresh = [{ ...manifestRows[0], seller: ORIGIN, networks: ["eip155:8453"], networksVerifiedAt: Date.now() - 3_600_000, networksVerifiedMethod: "POST" }];
  await x.enrichLiveQuotes(fresh, ORIGIN);
  ok(!seen.length, `the automatic crawl leaves a label-priced, freshly verified row alone (probed: ${JSON.stringify(seen)})`);
  // control: the same row with no read IS probed (its first network verification)
  seen.length = 0;
  const unread = [{ ...manifestRows[0], seller: ORIGIN, networks: ["eip155:8453"] }];
  await x.enrichLiveQuotes(unread, ORIGIN);
  ok(seen.includes("POST /api/a"), "control: the same row without a read is probed once");

  // 2. Re-registration re-asks a label-priced row whose price is not the origin's declaration (llms.txt label).
  globalThis.fetch = stub({ "GET /api/thing": 402 });
  seen.length = 0;
  // No verification stamp: the re-registration's verified-read clause would
  // re-ask a stamped row on its own, and this case is about the price clause.
  const llmsFresh = [{ ...llmsRows[0], networks: ["eip155:8453"], quoteSource: "live-402", quoteObservedAt: Date.now() - 3_600_000 }];
  await x.enrichLiveQuotes(llmsFresh.map((r) => ({ ...r })), ORIGIN);
  ok(!seen.length, "control: the automatic crawl leaves a fresh learned label alone");
  await x.enrichLiveQuotes(llmsFresh, ORIGIN, { ignoreBudget: true });
  ok(seen.includes("GET /api/thing"), "an explicit re-registration re-asks a label price that is not the origin's own declaration");

  // 3. Re-registration re-asks a label that differs (under 2x) from the origin's declaration.
  // Each scenario below uses its own route, so one probe's outcome (backoff,
  // learned price) never decides whether the next scenario probes.
  globalThis.fetch = stub({ "POST /api/drift-auto": 402, "POST /api/drift-rereg": 402 });
  seen.length = 0;
  const drift = [{ ...manifestRows[0], route: "/api/drift-auto", seller: ORIGIN, price: "$0.015", originDeclaredPrice: 0.01, networks: ["eip155:8453"] }];
  drift[0].networksVerifiedAt = Date.now() - 3_600_000; drift[0].networksVerifiedMethod = "POST";
  await x.enrichLiveQuotes(drift, ORIGIN, { ignoreBudget: false });
  ok(!seen.length, "control: the automatic crawl does not chase a 1.5x gap");
  // The re-registration clause also re-asks every verified read, so the drift
  // clause is isolated on a live-402 row with no stamp (networksNeedLiveVerify
  // returns early for it, and a fresh quote is not stale).
  seen.length = 0;
  const drift2 = [{ ...drift[0], route: "/api/drift-rereg", quoteSource: "live-402", quoteObservedAt: Date.now() - 3_600_000 }];
  delete drift2[0].networksVerifiedAt; delete drift2[0].networksVerifiedMethod;
  await x.enrichLiveQuotes(drift2, ORIGIN, { ignoreBudget: true });
  ok(seen.includes("POST /api/drift-rereg"), "an explicit re-registration re-asks a label that differs from the declaration");

  // 4. A GET 200 retires a learned price held as a label (no declaration), instead of stamping it observed-free with the price still on it.
  globalThis.fetch = stub({ "GET /api/thing": 200 });
  seen.length = 0;
  const retire = [{ ...llmsRows[0], networks: ["eip155:8453"], quoteSource: "live-402", quoteObservedAt: Date.now() - 3_600_000, networksVerifiedAt: Date.now() - 3_600_000, networksVerifiedMethod: "GET" }];
  await x.enrichLiveQuotes(retire, ORIGIN, { ignoreBudget: true });
  ok(retire[0].price === null && retire[0].paid === false && retire[0].quoteSource === "live-200" && retire[0].quoteRetiredAt > 0,
    `a GET 200 retires a label-held learned price (got price ${retire[0].price}, retiredAt ${retire[0].quoteRetiredAt})`);
} finally {
  globalThis.fetch = origFetch; console.log = origLog;
}

// ------------------------------------------------ the decide rows
{
  const row = remoteToolRow({ seller: ORIGIN, route: "/api/a", method: "POST", name: "A", price: "0.003 USDC", networks: ["eip155:8453"] });
  ok(row && row.priceUsd === 0.003, `a decide row reads a label with a currency word (got ${row && row.priceUsd})`);
  ok(remoteToolRow({ seller: ORIGIN, route: "/api/a", method: "POST", name: "A", price: "$free (since 2026-09-02)" }) === null, "an unreadable price is not a recommendation");
}

if (failures.length) { console.error(`test-price-label-readers: ${failures.length} of ${n} checks FAILED`); process.exit(1); }
console.log(`test-price-label-readers: ${n} checks passed`);
process.exit(0);

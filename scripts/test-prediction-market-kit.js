// scripts/test-prediction-market-kit.js
// Offline tests for src/tools/prediction-market-kit.js. No keys, no network
// by default. Live calls are opt-in via PREDICTION_LIVE_TEST=1.
//
// Pattern matches scripts/test-dex-kit.js:
//   • Catalog envelope + input validation always runs (no key, no network).
//   • Pure-CPU helpers (asNumber, parseJsonArray, shape*) covered with vectors.
//   • Live calls are opt-in (Polymarket Gamma + CLOB + Kalshi all keyless,
//     but live tests share the rate-limit pool so CI doesn't burn them).

import { PREDICTION_MARKET_TOOLS, __test } from "../src/tools/prediction-market-kit.js";

import { readFileSync } from "node:fs";
const { asNumber, parseJsonArray, shapeMarket, shapeKalshiMarket, polyList } = __test;

const h = (slug) => PREDICTION_MARKET_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
ok(PREDICTION_MARKET_TOOLS.length === 6, `6 tools exported (got ${PREDICTION_MARKET_TOOLS.length})`);

const expectedSlugs = ["polymarket-search", "polymarket-market", "polymarket-orderbook", "polymarket-price-history", "kalshi-markets", "kalshi-event"];
for (const slug of expectedSlugs) {
  ok(!!PREDICTION_MARKET_TOOLS.find((t) => t.slug === slug), `slug present: ${slug}`);
}

for (const t of PREDICTION_MARKET_TOOLS) {
  ok(typeof t.slug === "string" && t.slug.length > 0, `${t.slug}: has slug`);
  ok(t.route?.startsWith("POST /api/"), `${t.slug}: POST /api/ route`);
  ok(t.category === "crypto", `${t.slug}: category=crypto`);
  ok(typeof t.price === "string" && /^\$\d/.test(t.price), `${t.slug}: priced (${t.price})`);
  ok(typeof t.handler === "function", `${t.slug}: has handler`);
  const d = t.discovery;
  ok(d && d.input && d.inputSchema && d.output?.example, `${t.slug}: full discovery envelope`);
  ok(d.bodyType === "json", `${t.slug}: bodyType=json`);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
ok(asNumber("0.45") === 0.45, "asNumber: '0.45' → 0.45");
ok(asNumber(0.6) === 0.6, "asNumber: 0.6 → 0.6");
ok(asNumber(null) === null, "asNumber: null → null");
ok(asNumber("not-a-number") === null, "asNumber: bad string → null");
ok(asNumber(undefined, 42) === 42, "asNumber: fallback honored");

ok(JSON.stringify(parseJsonArray('["a","b"]')) === '["a","b"]', "parseJsonArray: JSON string → array");
ok(JSON.stringify(parseJsonArray(["a", "b"])) === '["a","b"]', "parseJsonArray: already-array → passthrough");
ok(JSON.stringify(parseJsonArray("not json")) === "[]", "parseJsonArray: bad string → []");
ok(JSON.stringify(parseJsonArray(null)) === "[]", "parseJsonArray: null → []");

// Polymarket shape — the Gamma API quirk is that outcomes/prices/tokenIds
// arrive as JSON-encoded strings inside the payload. shapeMarket parses them.
const raw = {
  id: "12345",
  slug: "test-market",
  question: "Will X happen?",
  description: "Resolves YES if X.",
  endDate: "2026-12-31T23:59:00Z",
  active: true,
  closed: false,
  archived: false,
  volume: "98765.43",
  liquidity: "12345.67",
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.62","0.38"]',
  clobTokenIds: '["7290","8390"]',
  events: [{ slug: "test-event" }],
};
const shaped = shapeMarket(raw);
ok(shaped.id === "12345", "shapeMarket: id passthrough");
ok(shaped.volume === 98765.43, "shapeMarket: volume parsed to number");
ok(shaped.liquidity === 12345.67, "shapeMarket: liquidity parsed to number");
ok(JSON.stringify(shaped.outcomes) === '["Yes","No"]', "shapeMarket: outcomes JSON-string → array");
ok(JSON.stringify(shaped.prices) === "[0.62,0.38]", "shapeMarket: prices JSON-string → number array");
ok(JSON.stringify(shaped.clobTokenIds) === '["7290","8390"]', "shapeMarket: clobTokenIds parsed");
ok(shaped.eventSlug === "test-event", "shapeMarket: eventSlug from events[0]");
ok(shaped.venue === "polymarket", "shapeMarket: venue tag");
ok(shaped.venueUrl === "https://polymarket.com/market/test-market", "shapeMarket: venueUrl built from slug");

// Kalshi shape
const kraw = {
  ticker: "TEST-25",
  event_ticker: "TEST",
  title: "Test market",
  subtitle: "Subtitle",
  status: "open",
  open_time: "2026-01-01T00:00:00Z",
  close_time: "2026-12-31T23:59:00Z",
  expiration_time: "2027-01-01T00:00:00Z",
  yes_bid: 45,
  yes_ask: 47,
  no_bid: 53,
  no_ask: 55,
  last_price: 46,
  volume: 12345,
  open_interest: 5678,
};
const kshaped = shapeKalshiMarket(kraw);
ok(kshaped.ticker === "TEST-25", "shapeKalshiMarket: ticker passthrough");
ok(kshaped.eventTicker === "TEST", "shapeKalshiMarket: event_ticker → eventTicker camelCase");
ok(kshaped.yesBid === 45, "shapeKalshiMarket: yes_bid → yesBid");
ok(kshaped.venue === "kalshi", "shapeKalshiMarket: venue tag");
ok(kshaped.venueUrl === "https://kalshi.com/markets/test-25", "shapeKalshiMarket: venueUrl lowercased");

// Kalshi removed the integer-cents fields (verified live 2026-08-28): the
// current API sends STRING DOLLARS and fixed-point volume. Both paid Kalshi
// tools were returning 200 with every one of these null. The shaper reads the
// new names, keeps the buyer-facing values in CENTS, and publishes the dollar
// figures alongside; the legacy fallback above must keep working so a rollback
// on their side cannot break us a second time.
const knew = {
  ticker: "NEW-26", event_ticker: "NEW", title: "t", status: "active",
  yes_bid_dollars: "0.4700", yes_ask_dollars: "0.4900",
  no_bid_dollars: "0.5100", no_ask_dollars: "0.5300",
  last_price_dollars: "0.4800", volume_fp: "12345.00",
  open_interest_fp: "5678.00", liquidity_dollars: "910.5000",
};
const kn = shapeKalshiMarket(knew);
ok(kn.yesBid === 47 && kn.yesAsk === 49 && kn.noBid === 51 && kn.noAsk === 53 && kn.lastPrice === 48,
  `dollar strings become cents (yesBid ${kn.yesBid}, lastPrice ${kn.lastPrice})`);
ok(kn.yesBidUsd === 0.47 && kn.lastPriceUsd === 0.48, "the dollar values ride alongside under their own names");
ok(kn.volume === 12345 && kn.openInterest === 5678 && kn.liquidityUsd === 910.5, "volume, open interest and liquidity come from the fixed-point fields");
ok(![kn.yesBid, kn.yesAsk, kn.noBid, kn.noAsk, kn.lastPrice, kn.volume, kn.openInterest].includes(null),
  "no field is null on a market the API describes fully (the failure this fixes was 200 with every value null)");
const kzero = shapeKalshiMarket({ ticker: "Z-26", yes_bid_dollars: "0.0000", volume_fp: "0.00" });
ok(kzero.yesBid === 0 && kzero.volume === 0, "a genuinely untraded market reads 0, never null");
const kmissing = shapeKalshiMarket({ ticker: "M-26" });
ok(kmissing.yesBid === null && kmissing.volume === null, "an absent field is still null, never a fabricated 0");

// Polymarket's gamma list endpoints are past their own sunset (deprecation and
// sunset: Fri, 01 May 2026 in HTTP HEADERS ONLY, nothing in their docs). We
// call `/markets/keyset`, which returns an OBJECT with a markets array, and we
// still accept the legacy bare array so a rollback cannot empty these tools.
ok(polyList({ markets: [{ id: "1" }], next_cursor: "x" }).length === 1, "polyList reads the keyset object shape");
ok(polyList([{ id: "1" }, { id: "2" }]).length === 2, "polyList still reads the legacy bare array");
ok(polyList(null).length === 0 && polyList({}).length === 0 && polyList("nope").length === 0, "polyList never throws on an unexpected payload");
{
  const src = readFileSync(new URL("../src/tools/prediction-market-kit.js", import.meta.url), "utf8");
  ok(!/POLY_GAMMA\}\/markets\?/.test(src), "no list call still points at the deprecated /markets endpoint");
  ok((src.match(/markets\/keyset/g) || []).length >= 3, "every list call site uses /markets/keyset");
}

// ----------------------------------------------------------------------------
// Input validation — all 6 tools
// ----------------------------------------------------------------------------
async function throws(promise, status, label) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status) { pass++; console.log(`ok - ${label} → ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}, got ${e.statusCode} (${e.message})`); }
  }
}

// polymarket-search
await throws(h("polymarket-search")({}), 400, "polymarket-search: missing query");
await throws(h("polymarket-search")({ query: "" }), 400, "polymarket-search: empty query");
await throws(h("polymarket-search")({ query: "   " }), 400, "polymarket-search: whitespace query");
await throws(h("polymarket-search")({ query: 123 }), 400, "polymarket-search: non-string query");

// polymarket-market
await throws(h("polymarket-market")({}), 400, "polymarket-market: missing both slug+id");
await throws(h("polymarket-market")({ slug: "", id: "" }), 400, "polymarket-market: empty slug+id");

// polymarket-orderbook
await throws(h("polymarket-orderbook")({}), 400, "polymarket-orderbook: missing tokenId");
await throws(h("polymarket-orderbook")({ tokenId: "" }), 400, "polymarket-orderbook: empty tokenId");
await throws(h("polymarket-orderbook")({ tokenId: "0xabc" }), 400, "polymarket-orderbook: non-decimal tokenId");
await throws(h("polymarket-orderbook")({ tokenId: "not-a-number" }), 400, "polymarket-orderbook: word tokenId");

// polymarket-price-history
await throws(h("polymarket-price-history")({}), 400, "polymarket-price-history: missing tokenId");
await throws(h("polymarket-price-history")({ tokenId: "abc" }), 400, "polymarket-price-history: bad tokenId");

// kalshi-markets
await throws(h("kalshi-markets")({ status: "invalid-status" }), 400, "kalshi-markets: bad status");

// kalshi-event
await throws(h("kalshi-event")({}), 400, "kalshi-event: missing eventTicker");
await throws(h("kalshi-event")({ eventTicker: "" }), 400, "kalshi-event: empty eventTicker");
await throws(h("kalshi-event")({ eventTicker: "   " }), 400, "kalshi-event: whitespace eventTicker");

// ----------------------------------------------------------------------------
// Live tests (opt-in)
// ----------------------------------------------------------------------------
if (process.env.PREDICTION_LIVE_TEST === "1") {
  console.log("\n--- live tests ---");
  try {
    const search = await h("polymarket-search")({ query: "election", limit: 3 });
    ok(typeof search.count === "number", `live polymarket-search: count returned (${search.count})`);
    ok(Array.isArray(search.markets), `live polymarket-search: markets array (len=${search.markets.length})`);
    if (search.markets.length) {
      const first = search.markets[0];
      ok(typeof first.question === "string", `live polymarket-search: first.question is string`);
      ok(Array.isArray(first.clobTokenIds), `live polymarket-search: clobTokenIds array`);
      // Try orderbook on the first market's first token
      if (first.clobTokenIds[0]) {
        const ob = await h("polymarket-orderbook")({ tokenId: first.clobTokenIds[0], depth: 3 });
        ok(typeof ob.tokenId === "string", `live polymarket-orderbook: tokenId returned`);
        ok(Array.isArray(ob.bids) && Array.isArray(ob.asks), `live polymarket-orderbook: bids+asks arrays`);
      }
    }

    const km = await h("kalshi-markets")({ status: "open", limit: 3 });
    ok(typeof km.count === "number", `live kalshi-markets: count returned (${km.count})`);
    ok(Array.isArray(km.markets), `live kalshi-markets: markets array`);
  } catch (e) {
    console.error(`LIVE ERR: ${e.message}`);
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

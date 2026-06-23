// scripts/test-price-feed-kit.js
// Offline tests for src/tools/price-feed-kit.js. Upstreams are keyless public
// APIs (Pyth Hermes, CoinGecko public, DeFiLlama) — live calls are opt-in via
// PRICE_FEED_LIVE_TEST=1 to keep CI off the public quotas.

import { PRICE_FEED_TOOLS } from "../src/tools/price-feed-kit.js";

const h = (slug) => PRICE_FEED_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

// Catalog envelope
ok(PRICE_FEED_TOOLS.length === 3, `3 tools exported (got ${PRICE_FEED_TOOLS.length})`);
for (const t of PRICE_FEED_TOOLS) {
  ok(t.route?.startsWith("POST /api/"), `${t.slug}: POST /api/ route`);
  ok(t.category === "crypto", `${t.slug}: category=crypto`);
  ok(typeof t.price === "string" && /^\$\d/.test(t.price), `${t.slug}: priced`);
  ok(t.discovery?.input && t.discovery?.inputSchema && t.discovery?.output?.example, `${t.slug}: full discovery envelope`);
}

async function throws(promise, status, label) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status) { pass++; console.log(`ok - ${label} → ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}, got ${e.statusCode} (${e.message})`); }
  }
}

// price-pyth
await throws(h("price-pyth")({}), 400, "price-pyth: missing ids");
await throws(h("price-pyth")({ ids: [] }), 400, "price-pyth: empty ids");
await throws(h("price-pyth")({ ids: ["NOT_A_FEED"] }), 400, "price-pyth: bad alias + bad hex");
await throws(h("price-pyth")({ ids: [42] }), 400, "price-pyth: non-string id");
await throws(h("price-pyth")({ ids: Array.from({ length: 21 }, () => "BTCUSD") }), 400, "price-pyth: >20 ids");

// price-coingecko
await throws(h("price-coingecko")({}), 400, "price-coingecko: missing ids");
await throws(h("price-coingecko")({ ids: [] }), 400, "price-coingecko: empty ids");
await throws(h("price-coingecko")({ ids: [""] }), 400, "price-coingecko: empty string id");
await throws(h("price-coingecko")({ ids: ["has spaces"] }), 400, "price-coingecko: invalid slug chars");
await throws(h("price-coingecko")({ ids: Array.from({ length: 26 }, () => "bitcoin") }), 400, "price-coingecko: >25 ids");

// defi-tvl
await throws(h("defi-tvl")({}), 400, "defi-tvl: missing protocol");
await throws(h("defi-tvl")({ protocol: "" }), 400, "defi-tvl: empty protocol");
await throws(h("defi-tvl")({ protocol: "Bad Slug!" }), 400, "defi-tvl: invalid slug chars");

// Live opt-in
async function live(slug, args, check, label) {
  try {
    const r = await h(slug)(args);
    if (check(r)) { liveOk++; console.log(`ok - LIVE ${label}: ${JSON.stringify(r).slice(0, 140)}`); }
    else { fail++; console.error(`ASSERT FAIL - LIVE ${label}: shape ${JSON.stringify(r).slice(0, 240)}`); }
  } catch (e) {
    liveErr++;
    console.warn(`warn - LIVE ${label}: upstream ${e.statusCode || "?"} ${e.message} — tolerated`);
  }
}

if (process.env.PRICE_FEED_LIVE_TEST === "1") {
  await live("price-pyth", { ids: ["BTCUSD", "ETHUSD"] },
    (r) => r.count === 2 && r.feeds.every((f) => typeof f.id === "string"),
    "price-pyth BTCUSD+ETHUSD");
  await live("price-coingecko", { ids: ["bitcoin", "ethereum"] },
    (r) => r.count === 2 && r.prices.every((p) => p.id === "bitcoin" || p.id === "ethereum"),
    "price-coingecko bitcoin+ethereum");
  await live("defi-tvl", { protocol: "aave" },
    (r) => r.protocol === "aave" && typeof r.tvlUsd === "number" && r.tvlUsd > 0,
    "defi-tvl aave");
}

console.log(`\n${pass} passed, ${fail} failed, live: ${liveOk} ok / ${liveErr} err`);
if (fail) process.exit(1);

// scripts/test-price-feed-kit.js
// Offline tests for src/tools/price-feed-kit.js. Upstreams are keyless public
// APIs (Pyth Hermes, CoinGecko public, DeFiLlama) — live calls are opt-in via
// PRICE_FEED_LIVE_TEST=1 to keep CI off the public quotas.

import { PRICE_FEED_TOOLS } from "../src/tools/price-feed-kit.js";

const h = (slug) => PRICE_FEED_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

// Catalog envelope
ok(PRICE_FEED_TOOLS.length === 2, `2 tools exported, price-pyth retired 2026-08-26 (got ${PRICE_FEED_TOOLS.length})`);
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

// price-pyth was retired 2026-08-26 (Hermes went key-only; zero external sales).

// price-coingecko
await throws(h("price-coingecko")({}), 400, "price-coingecko: missing ids");
await throws(h("price-coingecko")({ ids: [] }), 400, "price-coingecko: empty ids");
await throws(h("price-coingecko")({ ids: [""] }), 400, "price-coingecko: empty string id");
await throws(h("price-coingecko")({ ids: ["has spaces"] }), 400, "price-coingecko: invalid slug chars");
await throws(h("price-coingecko")({ ids: Array.from({ length: 26 }, () => "bitcoin") }), 400, "price-coingecko: >25 ids");
await throws(h("price-coingecko")({ ids: " , " }), 400, "price-coingecko: blank comma string");

// A comma string is accepted like an array, and every row carries CoinGecko's
// own last_updated_at as ISO (stubbed upstream, no network).
{
  const realFetch = globalThis.fetch;
  let asked = "";
  globalThis.fetch = async (url) => {
    asked = String(url);
    return new Response(JSON.stringify({ solana: { usd: 114.7, last_updated_at: 1790261400 }, cardano: { usd: 0.24, last_updated_at: 1790261410 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const r = await h("price-coingecko")({ ids: "solana, cardano" });
    ok(r.count === 2 && r.prices[0].id === "solana" && r.prices[1].id === "cardano", "price-coingecko: comma string ids accepted in order");
    ok(asked.includes("ids=solana,cardano") && asked.includes("include_last_updated_at=true"), "price-coingecko: asks for last_updated_at");
    ok(r.prices[0].lastUpdated === new Date(1790261400 * 1000).toISOString(), "price-coingecko: lastUpdated is ISO from last_updated_at");
    const one = await h("price-coingecko")({ ids: "solana" });
    ok(one.count === 1 && one.prices[0].price === 114.7, "price-coingecko: single id as a string");
  } finally { globalThis.fetch = realFetch; }
}

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
  await live("price-coingecko", { ids: ["bitcoin", "ethereum"] },
    (r) => r.count === 2 && r.prices.every((p) => p.id === "bitcoin" || p.id === "ethereum"),
    "price-coingecko bitcoin+ethereum");
  await live("defi-tvl", { protocol: "aave" },
    (r) => r.protocol === "aave" && typeof r.tvlUsd === "number" && r.tvlUsd > 0,
    "defi-tvl aave");
}

console.log(`\n${pass} passed, ${fail} failed, live: ${liveOk} ok / ${liveErr} err`);
if (fail) process.exit(1);

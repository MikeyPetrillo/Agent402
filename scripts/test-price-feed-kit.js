// scripts/test-price-feed-kit.js
// Offline tests for src/tools/price-feed-kit.js. Upstreams are keyless public
// APIs (CoinGecko public) — live calls are opt-in via
// PRICE_FEED_LIVE_TEST=1 to keep CI off the public quotas.

import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { PRICE_FEED_TOOLS, clearPriceFeedCache } from "../src/tools/price-feed-kit.js";
import { resetPriceCheck, CHECK_SOURCE } from "../src/tools/crypto-kit.js";
import { __hlShared } from "../src/tools/hyperliquid-shared.js";
import { resetCgRateLimit } from "../src/tools/crypto-markets-kit.js";

const h = (slug) => PRICE_FEED_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };

// Catalog envelope
ok(PRICE_FEED_TOOLS.length === 1, `1 tool exported (price-pyth retired 2026-08-26, defi-tvl 2026-11-16; got ${PRICE_FEED_TOOLS.length})`);
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
    if (String(url).includes("/simple/price")) asked = String(url);
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

// The answer is the computed one crypto-price serves: every priced row says
// whether its timestamp is stale and, in USD, how far the price sits from the
// second source; `check` names that source or says why no check ran.
{
  const realFetch = globalThis.fetch;
  const nowS = Math.floor(Date.now() / 1000);
  let hlStatus = 200;
  const hosts = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    hosts.push(u.hostname);
    if (u.hostname === "api.hyperliquid.xyz") {
      return new Response(JSON.stringify([
        { universe: [{ name: "BTC" }, { name: "ETH" }, { name: "SOL", isDelisted: true }] },
        [{ oraclePx: "60000" }, { oraclePx: "2000" }, { oraclePx: "100" }],
      ]), { status: hlStatus, headers: { "content-type": "application/json" } });
    }
    const vs = u.searchParams.get("vs_currencies");
    const all = { bitcoin: { [vs]: 60030, last_updated_at: nowS - 5 }, ethereum: { [vs]: 1990, last_updated_at: nowS - 3600 }, solana: { [vs]: 101, last_updated_at: nowS - 5 }, "jupiter-exchange-solana": { [vs]: 1, last_updated_at: nowS - 5 } };
    const body = Object.fromEntries(u.searchParams.get("ids").split(",").filter((id) => all[id]).map((id) => [id, all[id]]));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const fresh = () => { hosts.length = 0; clearPriceFeedCache(); resetPriceCheck(); __hlShared.clear(); resetCgRateLimit(); };
  const hlReads = () => hosts.filter((x) => x === "api.hyperliquid.xyz").length;
  try {
    fresh();
    const r = await h("price-coingecko")({ ids: ["bitcoin", "ethereum", "solana", "not-a-coin-zz"] });
    const [btc, eth, sol, miss] = r.prices;
    ok(r.check === CHECK_SOURCE && r.check === "hyperliquid-oracle", `price-coingecko: check names the second source (${r.check})`);
    ok(btc.divergencePct === 0.05 && eth.divergencePct === -0.5, `price-coingecko: divergencePct is the gap to the second source, in percent (${btc.divergencePct}, ${eth.divergencePct})`);
    ok(btc.stale === false && eth.stale === true, "price-coingecko: stale reads the upstream timestamp against the 10 minute bound");
    ok(sol.divergencePct === null && sol.stale === false, "price-coingecko: a delisted reference market gives null, never a number");
    ok(miss.price === null && miss.stale === null && miss.divergencePct === null && r.unknown?.[0] === "not-a-coin-zz", "price-coingecko: an unknown id keeps its null row, check fields null");
    ok(r.count === 4 && btc.id === "bitcoin" && btc.price === 60030 && typeof btc.lastUpdated === "string" && "change24h" in btc, "price-coingecko: the row keeps id, price, change24h and lastUpdated");
    ok(hosts[0] !== "api.hyperliquid.xyz" && hlReads() === 1, "price-coingecko: one reference read, after the price read");
    fresh();
    const eur = await h("price-coingecko")({ ids: ["bitcoin"], vsCurrency: "eur" });
    ok(eur.check === "usd-only" && eur.prices[0].divergencePct === null && eur.prices[0].stale === false && hlReads() === 0, "price-coingecko: a non-USD answer says usd-only and reads no reference");
    fresh();
    const nr = await h("price-coingecko")({ ids: ["jupiter-exchange-solana"] });
    ok(nr.check === "no-reference" && nr.prices[0].divergencePct === null && hlReads() === 0, "price-coingecko: no mapped coin, no reference read");
    fresh(); hlStatus = 500;
    const un = await h("price-coingecko")({ ids: ["bitcoin"] });
    ok(un.check === "unavailable" && un.prices[0].price === 60030 && un.prices[0].divergencePct === null, "price-coingecko: a failed check still answers the price, check unavailable");
    fresh(); hlStatus = 200;
    await throws(h("price-coingecko")({ ids: ["not-a-coin-zz"] }), 404, "price-coingecko: every id unknown");
    ok(hlReads() === 0, "price-coingecko: a refused answer spends no reference read");
    const ex = PRICE_FEED_TOOLS[0].discovery.output.example;
    ok(ex.check === "hyperliquid-oracle" && ex.prices.every((p) => typeof p.stale === "boolean" && typeof p.divergencePct === "number"), "price-coingecko: the published example shows the check fields");
    ok(/stale/.test(PRICE_FEED_TOOLS[0].description) && /divergencePct/.test(PRICE_FEED_TOOLS[0].description), "price-coingecko: the description names the check fields");
  } finally { globalThis.fetch = realFetch; resetPriceCheck(); __hlShared.clear(); }
}

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
}

console.log(`\n${pass} passed, ${fail} failed, live: ${liveOk} ok / ${liveErr} err`);
if (fail) process.exit(1);

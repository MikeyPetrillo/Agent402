// Crypto-kit tests — same shape as test-finance-kit.js: strict on validation
// (offline, deterministic) and tolerant of upstream errors on live calls.
// CoinGecko's public API is rate-limited (~30 req/min per IP) and occasionally
// throttles CI runners; the lenient block treats any upstream non-200 as a
// warning rather than a failure, so a flaky CI minute doesn't break the build.
//
// Assertions break the build if our validation/parsing changes. Live calls only
// break the build if EVERY one fails — that would mean our integration broke.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { CRYPTO_TOOLS, clearCryptoCache, resetPriceCheck, CHECK_READ_MS, CHECK_SOURCE, STALE_AFTER_SECONDS, SCREEN_UNIVERSE, referencePriceOf } from "../src/tools/crypto-kit.js";
import { resetCgRateLimit } from "../src/tools/crypto-markets-kit.js";
import { __hlShared } from "../src/tools/hyperliquid-shared.js";
import { COINGECKO_CREDIT, HYPERLIQUID_ATTRIBUTION } from "../src/data-attribution.js";

const h = (slug) => CRYPTO_TOOLS.find((t) => t.slug === slug).handler;
let assertFail = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) console.log(`ok - ${m}`); else { assertFail++; console.error(`ASSERT FAIL - ${m}`); } };

// --- deterministic validation (no network) ---
for (const [slug, args, label] of [
  ["crypto-price", {}, "crypto-price rejects missing coins"],
  ["crypto-price", { coins: "" }, "crypto-price rejects empty coins"],
  ["crypto-price", { coins: "BTC,ETH", currency: "U$D" }, "crypto-price rejects invalid currency"],
  ["crypto-price", { coins: Array(26).fill("BTC").join(",") }, "crypto-price rejects >25 coins"],
  ["crypto-price", { coins: "BTC ETH" }, "crypto-price rejects symbol with space"],
  ["crypto-market", { limit: 0 }, "crypto-market rejects limit 0"],
  ["crypto-market", { limit: 101 }, "crypto-market rejects limit 101"],
  ["crypto-market", { limit: "ten" }, "crypto-market rejects non-numeric limit"],
  ["crypto-history", {}, "crypto-history rejects missing coin"],
  ["crypto-history", { coin: "BTC", days: "week" }, "crypto-history rejects non-numeric days"],
  ["crypto-history", { coin: "BTC", days: "0" }, "crypto-history rejects days 0"],
  ["crypto-history", { coin: "B@D" }, "crypto-history rejects coin with invalid char"],
  ["stablecoin-peg", { coins: "USDT USDC" }, "stablecoin-peg rejects coins with space"],
  ["stablecoin-peg", { coins: Array(16).fill("USDT").join(",") }, "stablecoin-peg rejects >15 coins"],
]) {
  try { await h(slug)(args); ok(false, label); }
  catch (e) { ok(e.statusCode === 400, label + ` (got ${e.statusCode})`); }
}

// --- offline: the computed fields (fetch stubbed, no network) ---
// crypto-price's second-source check, crypto-market's computed columns and
// screen, crypto-history's summary. Every cache and the check's back-off are
// cleared on the way out, so the live block below reads the real upstreams.
{
  const realFetch = globalThis.fetch;
  const calls = [];
  let cg = null, hl = null;
  const res = (status, body) => ({
    ok: status >= 200 && status < 300, status, headers: { get: () => null },
    json: async () => JSON.parse(typeof body === "string" ? body : JSON.stringify(body)),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    calls.push({ host: u.hostname, path: u.pathname, params: u.searchParams, body: init?.body });
    return u.hostname === "api.hyperliquid.xyz" ? hl(init) : cg(u);
  };
  const fresh = () => { calls.length = 0; clearCryptoCache(); resetPriceCheck(); __hlShared.clear(); resetCgRateLimit(); };
  const hlCalls = () => calls.filter((c) => c.host === "api.hyperliquid.xyz").length;
  const nowSec = () => Math.floor(Date.now() / 1000);
  const universe = [{ name: "BTC" }, { name: "ETH" }, { name: "SOL", isDelisted: true }, { name: "kPEPE" }];
  const ctxs = [{ oraclePx: "60000" }, { oraclePx: "2000" }, { oraclePx: "150" }, { oraclePx: "0.004" }];
  const hlOk = () => res(200, [{ universe }, ctxs]);
  const priceRows = (u) => {
    const vs = u.searchParams.get("vs_currencies");
    const rows = {
      bitcoin: { [vs]: 60030, last_updated_at: nowSec() - 60 },
      ethereum: { [vs]: 1990, last_updated_at: nowSec() - STALE_AFTER_SECONDS - 60 },
      solana: { [vs]: 151, last_updated_at: nowSec() - 30 },
      pepe: { [vs]: 0.0000041, last_updated_at: nowSec() - 30 },
      tether: { [vs]: 1.0002, last_updated_at: nowSec() - 30 },
      "jupiter-exchange-solana": { [vs]: 0.5, last_updated_at: nowSec() - 30 },
    };
    return res(200, Object.fromEntries(String(u.searchParams.get("ids")).split(",").filter((id) => rows[id]).map((id) => [id, rows[id]])));
  };
  const price = h("crypto-price");
  try {
    // 1. Checked against the oracle price, stale read from the upstream timestamp.
    fresh(); cg = priceRows; hl = hlOk;
    const r = await price({ coins: "BTC,ETH,SOL,PEPE,USDT", currency: "usd" });
    ok(r.check === CHECK_SOURCE && r.check === "hyperliquid-oracle", `crypto-price: check names the second source (${r.check})`);
    ok(r.credit === `${COINGECKO_CREDIT} ${HYPERLIQUID_ATTRIBUTION}`, `crypto-price: a checked answer credits CoinGecko, then Hyperliquid (${r.credit})`);
    ok(r.coins.bitcoin.divergencePct === 0.05 && r.coins.ethereum.divergencePct === -0.5, `crypto-price: divergencePct is the gap to the oracle price, in percent (${r.coins.bitcoin.divergencePct}, ${r.coins.ethereum.divergencePct})`);
    ok(r.coins.pepe.divergencePct === 2.5, `crypto-price: a k-prefixed perp is quoted per 1,000 units (${r.coins.pepe.divergencePct})`);
    ok(r.coins.solana.divergencePct === null && r.coins.tether.divergencePct === null, "crypto-price: a delisted perp, or none, gives null, never a number");
    ok(r.coins.bitcoin.stale === false && r.coins.ethereum.stale === true, `crypto-price: stale past ${STALE_AFTER_SECONDS} s of upstream age`);
    ok(r.coins.bitcoin.price === 60030 && r.count === 5, "crypto-price: the price answer is unchanged by the check");
    ok(calls[0].host !== "api.hyperliquid.xyz" && hlCalls() === 1 && JSON.parse(calls.at(-1).body).type === "metaAndAssetCtxs", "crypto-price: one reference read, after the price read");
    // 2. The shared document is reused inside its window.
    clearCryptoCache(); calls.length = 0;
    await price({ coins: "BTC", currency: "usd" });
    ok(hlCalls() === 0, "crypto-price: a second call inside the shared window reads no reference again");
    // 3. Not USD: no check, no read.
    fresh(); cg = priceRows; hl = hlOk;
    const eur = await price({ coins: "BTC", currency: "eur" });
    ok(eur.check === "usd-only" && eur.coins.bitcoin.divergencePct === null && eur.coins.bitcoin.stale === false && hlCalls() === 0, "crypto-price: a non-USD answer says usd-only and reads no reference");
    ok(eur.credit === COINGECKO_CREDIT, "crypto-price: an answer with no check read credits CoinGecko alone");
    // 4. No coin the symbol map knows: no read.
    fresh(); cg = priceRows; hl = hlOk;
    const nr = await price({ coins: "jupiter-exchange-solana" });
    ok(nr.check === "no-reference" && nr.coins["jupiter-exchange-solana"].divergencePct === null && hlCalls() === 0, "crypto-price: no mapped coin, no reference read");
    ok(referencePriceOf(new Map([["BTC", 1]]), "constructor") === null && referencePriceOf(new Map([["BTC", 1]]), "bitcoin") === 1, "crypto-price: an id named like an object property maps to no reference");
    // 5. A failed reference leaves the answer whole, then backs off.
    fresh(); cg = priceRows; hl = () => res(500, "boom");
    const un = await price({ coins: "BTC" });
    ok(un.check === "unavailable" && un.coins.bitcoin.price === 60030 && un.coins.bitcoin.divergencePct === null, "crypto-price: an upstream failure of the check answers the price with check unavailable");
    ok(un.credit === COINGECKO_CREDIT, "crypto-price: a check that did not answer is not credited");
    clearCryptoCache(); calls.length = 0;
    await price({ coins: "BTC" });
    ok(hlCalls() === 0, "crypto-price: inside the back-off the check is not tried again");
    resetPriceCheck(); clearCryptoCache(); calls.length = 0; hl = hlOk;
    ok((await price({ coins: "BTC" })).check === CHECK_SOURCE && hlCalls() === 1, "crypto-price: after the back-off the check reads again");
    // 6. A body of the wrong shape is refused and never shared with the other kits.
    fresh(); cg = priceRows; hl = () => res(200, { bitcoin: { usd: 1 } });
    const ws = await price({ coins: "BTC" });
    ok(ws.check === "unavailable" && __hlShared.size() === 0, "crypto-price: a reference body of the wrong shape is not kept in the shared cache");
    // 7. A reference that never answers is cut at the check's own cap.
    fresh(); cg = priceRows;
    hl = (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    const t0 = Date.now();
    const slow = await price({ coins: "BTC" });
    const took = Date.now() - t0;
    ok(slow.check === "unavailable" && took < CHECK_READ_MS + 1_000, `crypto-price: a hung reference costs at most the check's cap (${took} ms)`);

    // crypto-market: computed columns on a plain call; a screen reads the universe once.
    const mk = (id, rank, price, cap, vol, ch24, ch7, ath) => ({ id, symbol: id, name: id, market_cap_rank: rank, current_price: price, market_cap: cap, total_volume: vol, price_change_percentage_24h_in_currency: ch24, price_change_percentage_7d_in_currency: ch7, circulating_supply: 1, ath, ath_date: "2024-01-01T00:00:00Z" });
    const universeRows = [
      mk("a", 1, 90, 4e9, 4e8, 5, 1, 100),
      mk("b", 2, 50, 3e9, 3e7, 8, -2, 200),
      mk("c", 3, 10, 2e9, 6e8, -1, 3, 10),
      mk("d", 4, 1, 5e8, 1e8, 10, 9, 2),
      mk("e", 5, 5, 1.5e9, 1e7, null, null, 5),
    ];
    const marketPage = (u) => res(200, universeRows.slice(0, Number(u.searchParams.get("per_page"))));
    const market = h("crypto-market");
    fresh(); cg = marketPage;
    const plain = await market({ limit: 2 });
    ok(plain.count === 2 && plain.coins[0].turnoverPct === 10 && plain.coins[0].athDrawdownPct === -10 && plain.coins[1].athDrawdownPct === -75, `crypto-market: turnoverPct and athDrawdownPct computed per coin (${plain.coins[0].turnoverPct}, ${plain.coins[0].athDrawdownPct})`);
    ok(calls[0].params.get("per_page") === "2" && !("matched" in plain) && !("screen" in plain), "crypto-market: a plain call reads only the top limit and carries no screen fields");
    fresh(); cg = marketPage;
    const scr = await market({ limit: "2", minMarketCap: "1e9", sort: "change24h_desc" });
    ok(calls[0].params.get("per_page") === String(SCREEN_UNIVERSE), `crypto-market: a screen reads the top ${SCREEN_UNIVERSE} once`);
    ok(scr.coins.map((c) => c.id).join() === "b,a" && scr.count === 2, `crypto-market: screened then sorted, cut to limit (${scr.coins.map((c) => c.id).join()})`);
    ok(scr.matched === 4 && scr.returned === 2 && scr.complete === false && scr.truncated === true, "crypto-market: matched, returned, complete and truncated say the list was cut");
    ok(scr.scanned === 5 && scr.scanCap === SCREEN_UNIVERSE && scr.scanCoversAll === false && /not in this answer/.test(scr.scanNote), "crypto-market: the scan fields say coins below the universe were not read");
    ok(scr.screen.sort === "change24h_desc" && scr.screen.filters.minMarketCap === 1e9, "crypto-market: the screen applied is echoed");
    const band = await market({ minChange24hPct: "0", maxChange24hPct: "8", minTurnoverPct: "1", limit: 10 });
    ok(band.coins.map((c) => c.id).join() === "a,b" && band.complete === true && band.truncated === false, `crypto-market: change band and turnover floor (${band.coins.map((c) => c.id).join()})`);
    const nearAth = await market({ maxBelowAthPct: "15" });
    ok(nearAth.coins.map((c) => c.id).join() === "a,c,e", `crypto-market: maxBelowAthPct keeps coins within that distance of the high (${nearAth.coins.map((c) => c.id).join()})`);
    fresh(); cg = marketPage;
    for (const [args, label] of [
      [{ sort: "bogus" }, "unknown sort"], [{ minMarketCap: "-1" }, "negative floor"], [{ minVolume24h: "lots" }, "non-numeric floor"],
      [{ minChange24hPct: 5, maxChange24hPct: 1 }, "inverted change band"], [{ maxBelowAthPct: 101 }, "maxBelowAthPct over 100"],
    ]) {
      try { await market(args); ok(false, `crypto-market: ${label} is refused`); }
      catch (e) { ok(e.statusCode === 400, `crypto-market: ${label} is a 400 (got ${e.statusCode})`); }
    }
    ok(calls.length === 0, "crypto-market: a refused screen reads nothing");

    // crypto-history answers statistics computed from the series, never the series.
    fresh();
    const H = 3_600_000, t = 1_790_000_000_000;
    cg = () => res(200, { prices: [[t, 100], [t + H, 120], [t + 2 * H, 90], [t + 3 * H, 130]], market_caps: [[t, 1000], [t + H, 1200], [t + 2 * H, 900], [t + 3 * H, 1300]], total_volumes: [[t, 10], [t + H, 20], [t + 2 * H, 30], [t + 3 * H, 40]] });
    const hist = await h("crypto-history")({ coin: "bitcoin", days: "1" });
    const rets = [Math.log(1.2), Math.log(0.75), Math.log(130 / 90)];
    const mean = rets.reduce((a, b) => a + b, 0) / 3;
    const vol = +(Math.sqrt(rets.reduce((a, x) => a + (x - mean) ** 2, 0) / 2) * Math.sqrt(8760) * 100).toFixed(4);
    const s = hist.summary;
    ok(s.changePct === 30 && s.fromHighPct === 0 && s.fromLowPct === 44.4444 && !["first", "last", "high", "low"].some((k) => k in s), "crypto-history: summary changePct and the last observation against the window's high and low, with no value of the series");
    ok(s.maxDrawdownPct === -25 && s.volatilityPct === vol, `crypto-history: max drawdown and hourly volatility annualized over 365 days (${s.maxDrawdownPct}, ${s.volatilityPct} vs ${vol})`);
    ok(!("bars" in hist) && hist.count === 4 && hist.window.observations === 4 && hist.window.spacing === "1h" && hist.drawdown.peakAt === new Date(t + H).toISOString() && hist.drawdown.recoveredAt === new Date(t + 3 * H).toISOString(), "crypto-history: no series in the answer; the window and the drawdown name times only");
    ok(hist.activity.marketCapChangePct === 30 && hist.activity.volumeChangePct === 300 && hist.steps.count === 3 && /not investment advice/.test(hist.method) && /withdrawn \(raw source series\)/.test(hist.withdrawn), "crypto-history: activity and steps are computed; the answer carries its method and what was withdrawn");

    // stablecoin-peg: deviations, shares and bands computed here; no source
    // figure per coin (price, 24h high and low, market cap) on any surface,
    // so it declares no resale trim and the public answer is the one resold.
    fresh();
    const pegRow = (id, symbol, name, p, hi, lo, cap) => ({ id, symbol, name, current_price: p, high_24h: hi, low_24h: lo, market_cap: cap });
    cg = (u) => res(200, u.pathname.endsWith("/coins/markets") ? [pegRow("tether", "usdt", "Tether", 0.9989, 0.9994, 0.9985, 1.5e11), pegRow("usd-coin", "usdc", "USDC", 1.0001, 1.0003, 0.9999, 5e10)] : []);
    const pegDef = CRYPTO_TOOLS.find((t) => t.slug === "stablecoin-peg");
    const pub = await pegDef.handler({});
    const { method, ...pubRest } = pub;
    const expected = { peg: "USD $1.00", count: 2, coins: [
      { id: "tether", symbol: "USDT", name: "Tether", deviationBps: -11, maxDeviation24hBps: 15, capRank: 1, marketCapSharePct: 75, status: "on-peg" },
      { id: "usd-coin", symbol: "USDC", name: "USDC", deviationBps: 1, maxDeviation24hBps: 3, capRank: 2, marketCapSharePct: 25, status: "on-peg" },
    ], credit: COINGECKO_CREDIT };
    ok(JSON.stringify(pubRest) === JSON.stringify(expected), `stablecoin-peg: deviations, place by cap and cap share, never the source's figures (${JSON.stringify(pubRest).slice(0, 200)})`);
    ok(typeof method === "string" && /marketCapSharePct/.test(method), "stablecoin-peg: the answer states its formulas");
    const RAW = ["price", "high24h", "low24h", "marketCap"];
    ok(typeof pegDef.refAnswer !== "function" && pub.coins.every((c) => RAW.every((k) => !Object.hasOwn(c, k))) && pegDef.discovery.output.example.coins.every((c) => RAW.every((k) => !Object.hasOwn(c, k))), "stablecoin-peg: no resale trim, and neither the answer nor the published example carries price, 24h high and low, or market cap");
  } finally {
    globalThis.fetch = realFetch;
    fresh();
  }
}

// --- live calls (tolerant of CoinGecko rate-limit / transient breakage) ---
async function live(slug, args, check, label) {
  try {
    const r = await h(slug)(args);
    // Every CoinGecko answer carries the source credit with its link; a price
    // answer whose check read Hyperliquid credits it after.
    const credited = r?.credit === (r?.check === "hyperliquid-oracle" ? `${COINGECKO_CREDIT} ${HYPERLIQUID_ATTRIBUTION}` : COINGECKO_CREDIT);
    if (!credited) { assertFail++; console.error(`ASSERT FAIL - ${label}: credit ${JSON.stringify(r?.credit)}`); }
    if (check(r)) { liveOk++; console.log(`ok - ${label}: ${JSON.stringify(r).slice(0, 140)}`); }
    else { assertFail++; console.error(`ASSERT FAIL - ${label}: unexpected shape ${JSON.stringify(r).slice(0, 240)}`); }
  } catch (e) {
    liveErr++;
    console.warn(`warn - ${label}: upstream error (${e.statusCode || "?"}) ${e.message} — tolerated`);
  }
}

// Batched price call — exercises symbol resolution (BTC→bitcoin, ETH→ethereum)
// and the simple/price response flattening. Bitcoin always reports >$1k in USD;
// the assertion uses a wide lower bound to ride out any black-swan repricing.
await live("crypto-price", { coins: "BTC,ETH", currency: "usd" },
  (r) => r.currency === "usd" && r.coins?.bitcoin?.price > 1000 && r.coins?.ethereum?.price > 100 && typeof r.coins.bitcoin.change24hPct === "number" &&
    typeof r.coins.bitcoin.stale === "boolean" &&
    // The second source may be down; when it answered, the two prices agree within a few percent.
    (r.check === "unavailable" ? r.coins.bitcoin.divergencePct === null : r.check === "hyperliquid-oracle" && Math.abs(r.coins.bitcoin.divergencePct) < 5),
  "crypto-price BTC,ETH usd");

// Top-10 market — exercises /coins/markets and the 24h/7d change projection.
// Bitcoin should always be rank 1 (or close — assert <= 5 as a safety margin
// in case CoinGecko's ranking briefly flickers during a major rotation).
await live("crypto-market", { limit: 10, currency: "usd" },
  (r) => r.currency === "usd" && r.count === 10 && Array.isArray(r.coins) && r.coins[0].id === "bitcoin" && r.coins[0].rank === 1 &&
    typeof r.coins[0].turnoverPct === "number" && r.coins[0].athDrawdownPct <= 0,
  "crypto-market top 10 usd");

// 7-day BTC history: exercises symbol→id resolution and the statistics
// computed over the prices/caps/volumes series. CoinGecko returns ~168 hourly points for 7d; assert >24 to ride
// out any sparse-data hiccup.
await live("crypto-history", { coin: "BTC", days: 7, currency: "usd" },
  (r) => r.coin === "bitcoin" && r.currency === "usd" && !("bars" in r) && r.count > 24 && r.window?.observations > 24 &&
    typeof r.summary?.volatilityPct === "number" && r.summary.maxDrawdownPct <= 0 && typeof r.summary.fromHighPct === "number" && typeof r.daily?.upDaySharePct === "number",
  "crypto-history BTC 7d");

// Trending — exercises /search/trending; should always return non-empty
// (CoinGecko's algorithm always has *something* trending in the last 24h).
await live("crypto-trending", {},
  (r) => r.count > 0 && Array.isArray(r.coins) && r.coins.every((c) => c.id && c.symbol),
  "crypto-trending");

// Global market — exercises /global parsing and dominance projection.
// Total market cap always > $100B and < $100T; BTC dominance always > 20% and
// < 80% in any plausible market regime.
await live("crypto-global", { currency: "usd" },
  (r) => r.currency === "usd" && r.totalMarketCap > 1e11 && r.totalMarketCap < 1e14 && r.btcDominancePct > 20 && r.btcDominancePct < 80,
  "crypto-global usd");

// Stablecoin peg — default set covers the top USD stables. In any plausible
// market USDT and USDC sit within ±2% of $1; assert the deviation math and
// the status enum rather than exact prices.
await live("stablecoin-peg", {},
  (r) => r.count >= 5 && r.coins.some((c) => c.id === "tether") && r.coins.some((c) => c.id === "usd-coin") &&
    r.coins.every((c) => !("price" in c) && typeof c.deviationBps === "number" &&
      ["on-peg", "stressed", "depegged", "unknown"].includes(c.status)) &&
    r.coins.filter((c) => ["tether", "usd-coin"].includes(c.id)).every((c) => Math.abs(c.deviationBps) < 200),
  "stablecoin-peg default set");

console.log(`\nvalidation asserts failed: ${assertFail} | live ok: ${liveOk} | live upstream-errors (tolerated): ${liveErr}`);
if (assertFail > 0 || liveOk === 0) { console.error("crypto-kit: FAILED"); process.exit(1); }
console.log("crypto-kit: OK");

// Crypto-kit tests — same shape as test-finance-kit.js: strict on validation
// (offline, deterministic) and tolerant of upstream errors on live calls.
// CoinGecko's public API is rate-limited (~30 req/min per IP) and occasionally
// throttles CI runners; the lenient block treats any upstream non-200 as a
// warning rather than a failure, so a flaky CI minute doesn't break the build.
//
// Assertions break the build if our validation/parsing changes. Live calls only
// break the build if EVERY one fails — that would mean our integration broke.
import { CRYPTO_TOOLS } from "../src/tools/crypto-kit.js";

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
]) {
  try { await h(slug)(args); ok(false, label); }
  catch (e) { ok(e.statusCode === 400, label + ` (got ${e.statusCode})`); }
}

// --- live calls (tolerant of CoinGecko rate-limit / transient breakage) ---
async function live(slug, args, check, label) {
  try {
    const r = await h(slug)(args);
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
  (r) => r.currency === "usd" && r.coins?.bitcoin?.price > 1000 && r.coins?.ethereum?.price > 100 && typeof r.coins.bitcoin.change24hPct === "number",
  "crypto-price BTC,ETH usd");

// Top-10 market — exercises /coins/markets and the 24h/7d change projection.
// Bitcoin should always be rank 1 (or close — assert <= 5 as a safety margin
// in case CoinGecko's ranking briefly flickers during a major rotation).
await live("crypto-market", { limit: 10, currency: "usd" },
  (r) => r.currency === "usd" && r.count === 10 && Array.isArray(r.coins) && r.coins[0].id === "bitcoin" && r.coins[0].rank === 1,
  "crypto-market top 10 usd");

// 7-day BTC history — exercises symbol→id resolution + the prices/caps/volumes
// triple-zip. CoinGecko returns ~168 hourly points for 7d; assert >24 to ride
// out any sparse-data hiccup.
await live("crypto-history", { coin: "BTC", days: 7, currency: "usd" },
  (r) => r.coin === "bitcoin" && r.currency === "usd" && Array.isArray(r.bars) && r.bars.length > 24 && r.bars.every((b) => typeof b.price === "number"),
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

console.log(`\nvalidation asserts failed: ${assertFail} | live ok: ${liveOk} | live upstream-errors (tolerated): ${liveErr}`);
if (assertFail > 0 || liveOk === 0) { console.error("crypto-kit: FAILED"); process.exit(1); }
console.log("crypto-kit: OK");

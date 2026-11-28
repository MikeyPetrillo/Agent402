// The price-history tools answer statistics computed from a source's series
// and never the series (src/tools/lookback-stats.js; crypto-history,
// coin-history, coin-ohlc, coin-market-chart-range, token-price-history).
//
//   1. NO SOURCE VALUE IN AN ANSWER. Each handler is driven with a stubbed
//      upstream whose every price, market cap, volume and candle value is a
//      marked number; none of them may appear anywhere in the answer's JSON
//      (as a number, as text, or as its integer part), nor in an error.
//   2. EACH FIGURE IS THE FORMULA. On small fixed series every computed
//      figure equals a value worked out by hand (the arithmetic is beside it).
//   3. THE ANSWER HOLDS WHAT IS PUBLISHED. Every field of a tool's published
//      example, and every block it declares beside it, is in the answer with
//      data; one upstream read per call, as before.
//   4. CREDIT AND DISCLAIMER. The description and the answer carry the
//      source's required credit (where the source asks one) and "not
//      investment advice"; the description names what was withdrawn.
//   5. NO NEW RAW PASS-THROUGH. Every tool that reads the market-data source
//      or the indexed chain provider is marked computed or is on a list of
//      pass-throughs that may only shrink.
//
// Offline: fetch is stubbed. Runs inside a copy of the tree too (the mutation
// controls run it there).
//
//   node scripts/test-lookback-stats.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CRYPTO_TOOLS } from "../src/tools/crypto-kit.js";
import { CRYPTO_MARKETS_TOOLS, clearCryptoMarketsCache, resetCgRateLimit } from "../src/tools/crypto-markets-kit.js";
import { ALCHEMY_DATA_TOOLS } from "../src/tools/alchemy-data-kit.js";
import { COINGECKO_CREDIT } from "../src/data-attribution.js";
import * as R from "../src/resale-terms.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DAY = 86_400_000, HOUR = 3_600_000;
const SLUGS = ["crypto-history", "coin-history", "coin-ohlc", "coin-market-chart-range", "token-price-history"];
const ALL = [...CRYPTO_TOOLS, ...CRYPTO_MARKETS_TOOLS, ...ALCHEMY_DATA_TOOLS];
const tool = (slug) => ALL.find((t) => t.slug === slug);
const L = await import("../src/tools/lookback-stats.js").catch(() => null);
ok(!!L, "the look-back statistics module is present");

// ---------------------------------------------------------------- upstream stub
// Marked values: no figure computed from them equals one, and each has a
// five-digit integer part no percent or count in an answer holds.
const MARKS = [31337.4242, 27182.8182, 16180.3398, 14142.1356, 17320.5081, 22360.6797, 26457.5131, 28284.2712, 33166.2479, 36055.5127];
const CAP = (k) => 61_803_398_875.4242 + k * 1_414_213_562.3731;
const VOL = (k) => 27_182_818_284.5905 + k * 1_732_050_807.5689;
// A candle's four values, each marked: open, high, low, close.
const CANDLE = (k) => [MARKS[k] + 111.1111, MARKS[k] + 999.9999, MARKS[k] - 777.7777, MARKS[k] + 333.3333];
let series = { start: 0, step: DAY, n: MARKS.length };
const timesOf = () => Array.from({ length: series.n }, (_, k) => series.start + k * series.step);
const allMarks = () => {
  const out = [];
  for (let k = 0; k < MARKS.length; k++) out.push(MARKS[k], CAP(k), VOL(k), ...CANDLE(k));
  return out;
};
const calls = [];
let empty = false;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  calls.push(u);
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  const ts = empty ? [] : timesOf();
  if (/alchemy\.com$/.test(u.hostname)) {
    return json(200, { currency: "usd", data: ts.map((t, k) => ({ value: String(MARKS[k]), timestamp: new Date(t).toISOString() })) });
  }
  if (/\/ohlc$/.test(u.pathname)) return json(200, ts.map((t, k) => [t, ...CANDLE(k)]));
  if (/\/market_chart(\/range)?$/.test(u.pathname)) return json(200, { prices: ts.map((t, k) => [t, MARKS[k]]), market_caps: ts.map((t, k) => [t, CAP(k)]), total_volumes: ts.map((t, k) => [t, VOL(k)]) });
  // The source's dated snapshot (what coin-history once passed through), marked too.
  if (/\/history$/.test(u.pathname)) return json(200, { id: "bitcoin", symbol: "btc", name: "Bitcoin", market_data: { current_price: { usd: MARKS[0], eur: MARKS[1] }, market_cap: { usd: CAP(0) }, total_volume: { usd: VOL(0) } } });
  return json(404, { error: "not found" });
};
process.env.ALCHEMY_API_KEY = "offline-test-key";
const run = async (slug, input) => { resetCgRateLimit(); clearCryptoMarketsCache(); calls.length = 0; return tool(slug).handler(input); };

/** Every marked value an answer (or an error text) carries, however written. */
function marksIn(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const found = [];
  for (const m of allMarks()) {
    const whole = String(Math.trunc(m));
    if (text.includes(String(m)) || text.includes(whole)) found.push(m);
  }
  const walk = (v) => {
    if (typeof v === "number") { for (const m of allMarks()) if (Math.abs(v - m) < 1e-6 * Math.abs(m)) found.push(m); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  if (typeof value !== "string") walk(value);
  return [...new Set(found)];
}
const keysAt = (v, path = "", acc = []) => { if (Array.isArray(v)) v.forEach((x) => keysAt(x, `${path}[]`, acc)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { const at = path ? `${path}.${k}` : k; acc.push([k, at]); keysAt(x, at, acc); } return acc; };
const DENY = new Set(R.RAW_SOURCE_FIELDS || [...(R.RAW_MARKET_FIELDS || []), "bars", "points", "candles", "prices", "allCurrencies", "first", "last", "high", "low", "open", "close", "volume", "value"]);

// CONTROL: the reader finds a marked value as a number, as text and nested.
ok(marksIn({ a: [{ price: MARKS[3] }] }).length === 1 && marksIn(`was ${MARKS[2]}`).length === 1 && marksIn({ cap: CAP(4) }).length === 1 && marksIn({ pct: 12.3456, at: "2026-08-15T00:00:00.000Z", n: 10 }).length === 0, "CONTROL: a marked value is found as a number, in text and nested; a percent, a time and a count are not");

// ---------------------------------------------------------------- 1 and 3
const today = Math.floor(Date.now() / DAY) * DAY;
const tenDaysAgo = new Date(today - 9 * DAY).toISOString().slice(0, 10);
const INPUTS = {
  "crypto-history": { coin: "BTC", days: "30", currency: "usd" },
  "coin-history": { coin: "bitcoin", date: tenDaysAgo, currency: "usd" },
  "coin-ohlc": { coin: "bitcoin", days: 30, currency: "usd" },
  "coin-market-chart-range": { coin: "ethereum", lookback: "2w" },
  "token-price-history": { symbol: "ETH", interval: "1d", days: 30 },
};
series = { start: today - 9 * DAY, step: DAY, n: MARKS.length };
const answers = {};
for (const slug of SLUGS) {
  let a = null, err = null;
  try { a = await run(slug, INPUTS[slug]); } catch (e) { err = e; }
  answers[slug] = a;
  ok(a && typeof a === "object", `${slug}: answers its series (${err ? `${err.statusCode} ${err.message}` : "200"})`);
  if (!a) continue;
  const found = marksIn(a);
  ok(found.length === 0, `${slug}: [1] no value of the source's series is in the answer (${found.length ? `found ${found.join(", ")}` : "none of the marked prices, caps, volumes or candle values"})`);
  const rawKeys = keysAt(a).filter(([k]) => DENY.has(k)).map(([, p]) => p);
  ok(rawKeys.length === 0, `${slug}: [1] no field of the answer is named for a source figure or series (${rawKeys.join(", ") || "none"})`);
  ok(calls.length === 1, `${slug}: [3] one upstream read per call, as before (${calls.length})`);
  // The published example and the declared blocks are all in the answer, with data.
  const d = tool(slug).discovery.output;
  const exKeys = Object.keys(d.example || {}), optKeys = Object.keys(d.optional || {});
  const missing = [...exKeys, ...optKeys].filter((k) => !(k in a));
  ok(exKeys.length > 3 && optKeys.length >= 6 && missing.length === 0, `${slug}: [3] every published field and declared block is in the answer (${missing.join(", ") || `${exKeys.length} sample fields, ${optKeys.length} blocks`})`);
  const stats = a.summary || a;
  const hollow = ["changePct", "volatilityPct", "maxDrawdownPct", "fromHighPct", "fromLowPct"].filter((k) => !Number.isFinite(stats[k]));
  ok(hollow.length === 0 && a.window?.observations === MARKS.length && a.drawdown?.peakAt && a.steps?.best?.at && a.trend?.direction && a.daily?.bestDay?.date && a.extremes?.highAt, `${slug}: [3] the figures hold data, not nulls (${hollow.join(", ") || "summary, window, drawdown, steps, trend, daily and extremes"})`);
  const exDeny = keysAt(d.example).filter(([k]) => DENY.has(k)).map(([, p]) => p);
  ok(exDeny.length === 0 && marksIn(d.example).length === 0, `${slug}: [1] the published sample names no source figure or series (${exDeny.join(", ") || "none"})`);
  // 4: credit and disclaimer, in the answer and the description.
  const desc = tool(slug).description;
  const cg = tool(slug).attribution === "coingecko";
  ok(/not investment advice/i.test(a.method || "") && /not investment advice/i.test(desc), `${slug}: [4] the answer's method and the description say "not investment advice"`);
  ok(cg ? a.credit === COINGECKO_CREDIT && desc.endsWith(COINGECKO_CREDIT) && /Powered by CoinGecko \(https:\/\/www\.coingecko\.com\/en\/api\)/.test(a.credit) : a.source === "alchemy" && !("credit" in a), `${slug}: [4] ${cg ? "the answer and the description carry the source's credit as it asks" : "the answer names its source (its terms ask no credit line)"}`);
  ok(/withdrawn \(raw source (series|data)\)/.test(desc) && /not a price feed/.test(desc) && typeof a.withdrawn === "string" && /withdrawn \(raw source (series|data)\)/.test(a.withdrawn), `${slug}: [4] the description and the answer's withdrawn note name what is no longer returned`);
  ok(typeof a.method === "string" && /changePct is the last observation over the first/.test(a.method) && /computed here from the source's series, which is not returned/.test(a.method), `${slug}: the answer states each formula in method`);
  ok(tool(slug).resale === R.RESALE_COMPUTED, `${slug}: [5] marked computed`);
}
ok(answers["coin-ohlc"]?.candleStats && Number.isFinite(answers["coin-ohlc"].candleStats.atrPct), "coin-ohlc: the candle block holds data");
ok(answers["crypto-history"]?.activity && Number.isFinite(answers["crypto-history"].activity.turnoverMeanPct) && Number.isFinite(answers["coin-history"]?.activity?.marketCapChangePct), "the market-cap and volume block holds changes and ratios");

// Errors carry no value either: a date the source holds nothing for, an empty window.
{
  series = { start: today - 5 * DAY, step: DAY, n: 6 };
  let e1 = null; try { await run("coin-history", { coin: "bitcoin", date: tenDaysAgo }); } catch (e) { e1 = e; }
  ok(e1?.statusCode === 422 && marksIn(String(e1.message)).length === 0, `coin-history: a date before the first observation is the free 422, with no value in it (${e1?.statusCode})`);
  empty = true;
  let e2 = null; try { await run("token-price-history", { symbol: "ETH" }); } catch (e) { e2 = e; }
  ok(e2?.statusCode === 404 && marksIn(String(e2.message)).length === 0, `token-price-history: an empty window is still the 404 (${e2?.statusCode})`);
  const none = await run("coin-market-chart-range", { coin: "ethereum", lookback: "3d" });
  ok(none.count === 0 && none.summary.changePct === null && none.summary.volatilityPct === null && none.drawdown === null && none.daily === null, "coin-market-chart-range: an empty window answers nulls, never a made-up 0");
  empty = false;
}

// ---------------------------------------------------------------- 2: by hand
if (L) {
  // Five daily observations: 100, 120, 90, 130, 117.
  const t5 = (step) => [0, 1, 2, 3, 4].map((k) => Date.UTC(2026, 7, 10) + k * step);
  const V = [100, 120, 90, 130, 117];
  const day = (k) => new Date(Date.UTC(2026, 7, 10) + k * DAY).toISOString();
  const s = L.lookbackStats(t5(DAY), V);
  // changePct: 117 / 100 - 1 = 17%.
  ok(s.summary.changePct === 17, `changePct is last over first minus 1 (${s.summary.changePct})`);
  // Log returns ln(1.2), ln(0.75), ln(13/9), ln(0.9): mean 0.0392509, sample
  // deviation 0.2922110; times sqrt(365) = 558.2685%; times sqrt(4) = 58.4422%.
  ok(s.summary.volatilityPct === 558.2685 && s.steps.realizedVolatilityPct === 58.4422, `volatility is the sample deviation of log returns, annualized over 365 days and scaled to the window (${s.summary.volatilityPct}, ${s.steps.realizedVolatilityPct})`);
  ok(L.lookbackStats(t5(HOUR), V).summary.volatilityPct === 2734.9458, "hourly observations annualize over 8,760 hours");
  // Largest fall: 120 to 90 is -25% (130 to 117 is -10%); the 130 recovers it.
  ok(s.summary.maxDrawdownPct === -25 && s.drawdown.peakAt === day(1) && s.drawdown.troughAt === day(2) && s.drawdown.recoveredAt === day(3), `max drawdown with its peak, trough and recovery times (${s.summary.maxDrawdownPct}, ${JSON.stringify(s.drawdown)})`);
  // Steps: +20, -25, +44.4444, -10: two of four above zero.
  ok(s.steps.count === 4 && s.steps.upSharePct === 50 && s.steps.best.returnPct === 44.4444 && s.steps.best.at === day(3) && s.steps.worst.returnPct === -25 && s.steps.worst.at === day(2), `best and worst step and the share above zero (${JSON.stringify(s.steps)})`);
  // High 130 (day 3), low 90 (day 2): 117/130 - 1 = -10%, 117/90 - 1 = 30%.
  ok(s.summary.fromHighPct === -10 && s.summary.fromLowPct === 30 && s.extremes.highAt === day(3) && s.extremes.lowAt === day(2), `the last observation against the window's high and low (${s.summary.fromHighPct}, ${s.summary.fromLowPct})`);
  // Least squares of ln(value) on days 0..4: slope 0.039406, e^slope - 1 = 4.0192% a day, r2 0.1753.
  ok(s.trend.slopePctPerDay === 4.0192 && s.trend.r2 === 0.1753 && s.trend.direction === "up", `trend slope and fit (${JSON.stringify(s.trend)})`);
  // Daily block: each observation is its day's close.
  const d = L.dailyStats(t5(DAY), V);
  ok(d.days === 5 && d.bestDay.date === "2026-08-13" && d.bestDay.returnPct === 44.4444 && d.worstDay.date === "2026-08-12" && d.worstDay.returnPct === -25 && d.upDaySharePct === 50, `best and worst day and the share of up days (${JSON.stringify(d)})`);
  // Two observations in one UTC day count as one day (the later is its close).
  ok(L.dailyStats([0, HOUR, DAY, 2 * DAY].map((x) => Date.UTC(2026, 7, 10) + x), [50, 100, 110, 99]).bestDay.returnPct === 10 && L.dailyStats(t5(HOUR), V) === null, "a day's close is its last observation; under three days the daily block is null");
  // Activity: caps 1000 -> 1170 = +17%; volumes 10..50: 50/10 - 1 = 400%, 50/mean(30) - 1 = 66.6667%;
  // turnover mean of 10/1000, 20/1200, 30/900, 40/1300, 50/1170 = 2.6701%.
  const act = L.activityStats([1000, 1200, 900, 1300, 1170], [10, 20, 30, 40, 50]);
  ok(act.marketCapChangePct === 17 && act.volumeChangePct === 400 && act.volumeVsWindowMeanPct === 66.6667 && act.turnoverMeanPct === 2.6701, `market-cap and volume changes and mean turnover (${JSON.stringify(act)})`);
  // Candles [open, high, low, close]: 100/110/95/105, 105/120/100/115, 115/116/90/98.
  const rows = [[0, 100, 110, 95, 105], [1, 105, 120, 100, 115], [2, 115, 116, 90, 98]].map(([k, ...c]) => [Date.UTC(2026, 7, 10) + k * DAY, ...c]);
  const c = L.candleShape(rows);
  // Up candles 2 of 3; bodies 5/15, 10/20, 17/26 -> 49.5726%; upper wicks 5/15, 5/20, 1/26 -> 20.7265%;
  // lower wicks 5/15, 5/20, 8/26 -> 29.7009%; true ranges 20/105 and 26/115 -> 20.8282%.
  ok(c.upSharePct === 66.6667 && c.bodyPct === 49.5726 && c.upperWickPct === 20.7265 && c.lowerWickPct === 29.7009 && c.atrPct === 20.8282, `candle shares, wicks and average true range (${JSON.stringify(c)})`);
  ok(+(c.bodyPct + c.upperWickPct + c.lowerWickPct).toFixed(3) === 100, "a candle's body and wicks add up to its range");
  // The candle tool: closes 105, 115, 98 from a first open of 100 -> -2%; fall 115 -> 98 = -14.7826%;
  // extremes are the candles' own high 120 and low 90: 98/120 - 1 = -18.3333%, 98/90 - 1 = 8.8889%.
  const o = L.lookbackStats(rows.map((r) => r[0]), rows.map((r) => r[4]), { first: 100, highs: rows.map((r) => r[2]), lows: rows.map((r) => r[3]) });
  ok(o.summary.changePct === -2 && o.summary.maxDrawdownPct === -14.7826 && o.summary.fromHighPct === -18.3333 && o.summary.fromLowPct === 8.8889, `candle closes against the candles' own extremes (${JSON.stringify(o.summary)})`);
  // Too short to say: nulls.
  const one = L.lookbackStats([0], [5]);
  ok(one.summary.volatilityPct === null && one.summary.maxDrawdownPct === null && one.drawdown === null && one.steps === null && one.trend === null, "one observation gives no volatility, drawdown, steps or trend");
  ok(L.lookbackStats([0, HOUR, 2 * HOUR, 3 * HOUR], [100, null, 0, 50]).summary.maxDrawdownPct === -50 && L.candleShape([[0, 1, 2]]) === null && L.activityStats(null, null) === null, "missing and non-positive values are skipped; no candle or activity block from nothing");
  // The tools return these same figures (the handler is the formula, not a copy of it).
  series = { start: Date.UTC(2026, 7, 10), step: DAY, n: 5 };
  const keep = MARKS.slice(0, 5);
  V.forEach((v, k) => { MARKS[k] = v; });
  const realNow = Date.now;
  Date.now = () => Date.UTC(2026, 7, 14, 12);
  try {
    const ch = await run("crypto-history", { coin: "BTC", days: "7" });
    ok(JSON.stringify(ch.summary) === JSON.stringify(s.summary) && JSON.stringify(ch.drawdown) === JSON.stringify(s.drawdown) && ch.count === 5 && ch.window.spacing === "1d" && ch.window.days === 4, "crypto-history answers the hand-computed figures for the same series");
    const since = await run("coin-history", { coin: "bitcoin", date: "2026-08-10" });
    ok(since.summary.changePct === 17 && since.date === "2026-08-10" && since.id === "bitcoin" && since.window.from === day(0), `coin-history: the return since the date is the last observation over the date's (${since.summary.changePct})`);
    // The read carries the caller's currency, and a second currency is a read of its own.
    const rangeReads = () => calls.filter((u) => /\/market_chart\/range$/.test(u.pathname)).map((u) => u.searchParams.get("vs_currency"));
    const usdReads = rangeReads();
    const eur = await tool("coin-history").handler({ coin: "bitcoin", date: "2026-08-10", currency: "EUR" });
    const afterEur = rangeReads();
    const usdAgain = await tool("coin-history").handler({ coin: "bitcoin", date: "2026-08-10" });
    ok(usdReads.join() === "usd" && since.currency === "usd" && afterEur.join() === "usd,eur" && eur.currency === "eur" && eur.cached === false && rangeReads().join() === "usd,eur" && usdAgain.cached === true && usdAgain.currency === "usd",
      `coin-history: the upstream read carries the caller's vs_currency and a second currency makes its own read (reads ${rangeReads().join(",")}; eur cached ${eur.cached}, usd again cached ${usdAgain.cached})`);
    const tp = await run("token-price-history", { symbol: "ETH", interval: "1d", days: 7 });
    ok(tp.changePct === 17 && tp.volatilityPct === 558.2685 && tp.maxDrawdownPct === -25 && tp.fromHighPct === -10 && tp.count === 5 && !("summary" in tp), "token-price-history answers the same figures at the top level, where changePct always was");
  } finally { Date.now = realNow; keep.forEach((v, k) => { MARKS[k] = v; }); }
}

// ---------------------------------------------------------------- 5: the class
{
  // Raw pass-throughs of the market-data source, barred from resale through a
  // third party. THIS LIST MAY ONLY SHRINK: a tool leaves it when its answer
  // becomes a computation, and no tool joins it.
  const MARKET_PASS_THROUGH = Object.freeze([
    "crypto-price", "price-coingecko", "crypto-market", "crypto-trending", "crypto-global", "global-defi", "coin-price-by-contract", "coin-profile",
    "coin-categories", "coin-search", "exchanges", "exchange-tickers", "exchange-rates", "rwa-list", "rwa-markets", "rwa-asset", "rwa-issuers", "rwa-issuer",
  ]);
  // Indexed chain reads (transfers, balances, allowances, receipts): chain
  // state, not a price series. THIS LIST MAY ONLY SHRINK too.
  const CHAIN_READ_PASS_THROUGH = Object.freeze(["asset-transfers", "token-balances", "token-allowance", "tx-receipt", "block-receipts", "wallet-transfers-multichain"]);
  const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
  const files = [];
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const f = join(dir, e.name); if (e.isDirectory()) { if (e.name !== "generated") walk(f); } else if (/\.js$/.test(e.name)) files.push(f); } };
  walk(srcRoot);
  const naming = files.filter((f) => /coingecko-endpoint\.js|attribute\([^)]*"coingecko"\)|attribution: "coingecko"/.test(readFileSync(f, "utf8")));
  const cg = new Map();
  for (const f of naming) {
    const mod = await import(f);
    for (const v of Object.values(mod)) for (const t of Array.isArray(v) ? v : [v]) if (t && typeof t === "object" && typeof t.slug === "string" && typeof t.handler === "function" && t.attribution === "coingecko") cg.set(t.slug, t);
  }
  const classOf = (t, passThrough) => (t.resale === R.RESALE_COMPUTED ? "computed" : passThrough.includes(t.slug) ? "listed" : "undeclared");
  const undeclared = [...cg.values()].filter((t) => classOf(t, MARKET_PASS_THROUGH) === "undeclared").map((t) => t.slug);
  ok(cg.size >= 30 && undeclared.length === 0, `[5] every tool on the market-data source is computed or a listed pass-through (${cg.size} tools; neither: ${undeclared.join(", ") || "none"})`);
  const stale = MARKET_PASS_THROUGH.filter((s) => !cg.has(s) || cg.get(s).resale !== R.RESALE_BARRED);
  ok(MARKET_PASS_THROUGH.length === 18 && stale.length === 0, `[5] the pass-through list holds only live tools still barred from resale, and has not grown (${MARKET_PASS_THROUGH.length}; to remove: ${stale.join(", ") || "none"})`);
  ok(SLUGS.slice(0, 4).every((s) => cg.get(s)?.resale === R.RESALE_COMPUTED && cg.get(s)?.resaleClearedBy === R.MARKET_DATA_CLEARANCE && !MARKET_PASS_THROUGH.includes(s)), "[5] the four history tools on the market-data source are computed and off the pass-through list");
  const chainUndeclared = ALCHEMY_DATA_TOOLS.filter((t) => classOf(t, CHAIN_READ_PASS_THROUGH) === "undeclared").map((t) => t.slug);
  const chainStale = CHAIN_READ_PASS_THROUGH.filter((s) => !ALCHEMY_DATA_TOOLS.some((t) => t.slug === s));
  ok(CHAIN_READ_PASS_THROUGH.length === 6 && chainUndeclared.length === 0 && chainStale.length === 0, `[5] every tool of the indexed chain provider is computed or a listed chain read (${ALCHEMY_DATA_TOOLS.length} tools; neither: ${chainUndeclared.join(", ") || "none"})`);
  // No listed chain read reaches the provider's price endpoint; the one tool that does is computed.
  const kitText = readFileSync(join(srcRoot, "tools", "alchemy-data-kit.js"), "utf8");
  const priceReaders = [...kitText.matchAll(/slug: "([a-z0-9-]+)"[\s\S]*?(?=\n  \{\n|\n\];)/g)].filter((m) => /pricesApi\(/.test(m[0])).map((m) => m[1]);
  ok(priceReaders.length === 1 && priceReaders[0] === "token-price-history" && tool("token-price-history").resale === R.RESALE_COMPUTED && tool("token-price-history").resaleCleared !== true, `[5] the only tool on the provider's price endpoint is computed, with no clearance for third-party resale (${priceReaders.join(", ")})`);
  // CONTROL: a new raw tool on either source is "undeclared".
  ok(classOf({ slug: "new-raw-series", resale: R.RESALE_BARRED }, MARKET_PASS_THROUGH) === "undeclared" && classOf({ slug: "new-chain-tool" }, CHAIN_READ_PASS_THROUGH) === "undeclared" && classOf({ slug: "x", resale: R.RESALE_COMPUTED }, []) === "computed", "CONTROL: a new pass-through on either source is read as undeclared");
  ok(Array.isArray(R.COMPUTED_SERIES_SLUGS) && SLUGS.every((s) => R.COMPUTED_SERIES_SLUGS.includes(s)) && SLUGS.every((s) => Object.hasOwn(R.WITHDRAWN_SOURCE_FIELDS || {}, s)), "[5] the five tools are the computed series tools, each with its withdrawn fields named");
}

console.log(`\ntest-lookback-stats: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

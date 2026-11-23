// scripts/test-crypto-signals-kit.js
// Offline tests for src/tools/crypto-signals-kit.js. No network: globalThis.fetch
// is replaced with a router that answers the upstream (Hyperliquid info)
// from fixtures, so the test pins
//   - the catalog envelope (2 tools, prices, discovery),
//   - input validation (400s) before any egress,
//   - indicator math against hand-computed fixtures (SMA, EMA, RSI, MACD,
//     Bollinger, ATR, VWAP) and the summary/notes assembly,
//   - market pulse arithmetic (breadth, median, volume-weighted change,
//     totals, minVolumeUsd filter, funding extremes),
//   - upstream 5xx -> 502, 429 -> 503, a deadline -> 503 naming the step, and the
//     "unknown coin" shape Hyperliquid really returns (500 "null") -> 422.
// Live coverage is the catalog's answers-its-own-example sweep (test-all.js).

import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import {
  CRYPTO_SIGNALS_TOOLS, sma, ema, rsi, macd, bollinger, atr, vwap,
  computeIndicators, marketPulse, __test,
} from "../src/tools/crypto-signals-kit.js";

const h = (slug) => CRYPTO_SIGNALS_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(a - b) <= eps;
async function throws(promise, status, label, msgRe) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status && (!msgRe || msgRe.test(e.message))) { pass++; console.log(`ok - ${label} -> ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}${msgRe ? ` /${msgRe.source}/` : ""}, got ${e.statusCode} (${e.message})`); }
  }
}

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------
const NOW = Date.now();
const rfc = (msAgo) => new Date(NOW - msAgo).toUTCString();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const H = 3_600_000;

const META = { universe: [{ name: "BTC", szDecimals: 5 }, { name: "ETH", szDecimals: 4 }, { name: "kPEPE", szDecimals: 0 }, { name: "OLD", szDecimals: 1, isDelisted: true }] };
const CTXS = [
  { funding: "0.0000125", openInterest: "36000", prevDayPx: "76968.0", dayNtlVlm: "4679441788.67", markPx: "77267.0" },
  { funding: "-0.00005", openInterest: "754447", prevDayPx: "2380.3", dayNtlVlm: "3396726206.45", markPx: "2429.3" },
  { funding: "0.0003", openInterest: "1000000000", prevDayPx: "0.004", dayNtlVlm: "500000", markPx: "0.00404" },
  { funding: "0", openInterest: "0", prevDayPx: "1", dayNtlVlm: "0", markPx: "1" },
];
// 60 hourly candles: a gentle ramp with a wobble so every indicator has data.
const CANDLES = Array.from({ length: 60 }, (_, k) => {
  const base = 100 + k * 0.5 + (k % 5) * 0.3;
  return { t: NOW - (60 - k) * H, T: NOW - (59 - k) * H - 1, s: "BTC", i: "1h", o: String(base - 0.2), c: String(base), h: String(base + 0.5), l: String(base - 0.6), v: String(10 + (k % 3)), n: 100 };
});

// ----------------------------------------------------------------------------
// Fetch router
// ----------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let mode = "ok";
const calls = [];
const res = (status, body) => ({ status, ok: status < 400, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, method: opts.method || "GET", body: opts.body || null });
  ok(opts.signal instanceof AbortSignal, `egress carries an AbortSignal (${u.slice(0, 40)})`);
  ok(String(opts.headers?.["User-Agent"] || "").includes("Agent402"), "egress carries the Agent402 User-Agent");
  if (mode === "timeout") { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; }
  if (mode === "http500") return res(500, "Internal Error");
  if (mode === "http429") return res(429, "slow down");
  if (u === __test.HL_INFO) {
    const body = JSON.parse(opts.body);
    if (mode === "hl-unknown-500") return res(500, "null");
    switch (body.type) {
      case "meta": return res(200, META);
      case "metaAndAssetCtxs": return res(200, [META, CTXS]);
      case "candleSnapshot": return res(200, CANDLES);
      default: return res(422, "Failed to deserialize the JSON body into the target type");
    }
  }
  throw new Error(`unexpected egress in test: ${u}`);
};

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
ok(CRYPTO_SIGNALS_TOOLS.length === 2, "2 tools exported");
ok(!CRYPTO_SIGNALS_TOOLS.some((t) => t.slug === "crypto-news"), "crypto-news is retired (src/retired-tools.js), not served");
const want = { "crypto-indicators": "$0.002", "crypto-market-pulse": "$0.004" };
for (const t of CRYPTO_SIGNALS_TOOLS) {
  ok(want[t.slug] === t.price, `${t.slug} priced ${t.price}`);
  ok(t.category === "crypto" && /^POST \/api\//.test(t.route), `${t.slug} route/category`);
  ok(t.discovery?.bodyType === "json" && t.discovery.input && t.discovery.inputSchema?.properties && t.discovery.output?.example, `${t.slug} discovery complete`);
  ok(typeof t.handler === "function" && Array.isArray(t.tags) && t.tags.length >= 4, `${t.slug} handler + tags`);
  ok(!/—/.test(t.description), `${t.slug} description has no em dash`);
}

// ----------------------------------------------------------------------------
// Indicator math (hand-computed)
// ----------------------------------------------------------------------------
{
  const s = sma([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
  ok(s[1] === null && s[2] === 2 && s[9] === 9, "SMA(3): null before window, 2 at idx2, 9 at the end");
  const e = ema([1, 2, 3, 4, 5], 3);
  ok(e[1] === null && e[2] === 2 && e[3] === 3 && e[4] === 4, `EMA(3) SMA-seeded: [_,_,2,3,4] got ${JSON.stringify(e)}`);
  ok(ema([1, 2], 3).every((v) => v === null), "EMA with too few values is all null");
  const r = rsi([10, 11, 10, 12], 2);
  ok(r[1] === null && near(r[2], 50) && near(r[3], 83.333333, 1e-5), `RSI(2) Wilder: [_,_,50,83.33] got ${JSON.stringify(r)}`);
  const up = rsi(Array.from({ length: 20 }, (_, k) => k + 1), 14);
  ok(near(up[19], 100), "RSI of a monotone rise = 100");
  const down = rsi(Array.from({ length: 20 }, (_, k) => 20 - k), 14);
  ok(near(down[19], 0), "RSI of a monotone fall = 0");
  ok(rsi([1, 2, 3], 14).every((v) => v === null), "RSI with too few values is all null");
  const m = macd([1, 2, 3, 4, 5, 6], 2, 3, 2);
  ok(near(m.line[5], 0.5) && near(m.signal[5], 0.5) && near(m.hist[5], 0) && m.line[1] === null && m.signal[2] === null, `MACD(2,3,2) on a ramp: line 0.5, signal 0.5, hist 0 (got ${m.line[5]}, ${m.signal[5]}, ${m.hist[5]})`);
  const flat = macd(new Array(40).fill(50), 12, 26, 9);
  ok(near(flat.line[39], 0) && near(flat.signal[39], 0) && near(flat.hist[39], 0) && flat.signal[32] === null && flat.signal[33] !== null, "MACD(12,26,9) on a flat series is 0 and its signal starts at idx 33 (34 candles)");
  const b = bollinger([1, 2, 3, 4, 5], 3, 2);
  ok(near(b.middle[4], 4) && near(b.upper[4], 4 + 2 * Math.sqrt(2 / 3)) && near(b.lower[4], 4 - 2 * Math.sqrt(2 / 3)) && b.upper[1] === null, `Bollinger(3,2) population sd: mid 4, upper ${b.upper[4]}`);
  const a = atr([{ h: 10, l: 8, c: 9 }, { h: 11, l: 9, c: 10 }, { h: 12, l: 9, c: 11 }, { h: 12, l: 10, c: 11 }], 2);
  ok(a[0] === null && a[1] === null && near(a[2], 2.5) && near(a[3], 2.25), `ATR(2) Wilder: [_,_,2.5,2.25] got ${JSON.stringify(a)}`);
  const v = vwap([{ h: 10, l: 8, c: 9, v: 1 }, { h: 12, l: 10, c: 11, v: 3 }]);
  ok(near(v[0], 9) && near(v[1], 10.5), `VWAP cumulative: [9, 10.5] got ${JSON.stringify(v)}`);
  ok(vwap([{ h: 1, l: 1, c: 1, v: 0 }])[0] === null, "VWAP with zero volume is null, not NaN");

  // Assembly on the 60-candle fixture: every indicator present, values agree
  // with the primitives, summary derived from the same arrays.
  const candles = CANDLES.map((c) => ({ t: c.t, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) }));
  const closes = candles.map((c) => c.c);
  const out = computeIndicators(candles, new Set(["rsi", "macd", "ema", "sma", "bollinger", "atr", "vwap"]), 5);
  ok(out.candles === 60 && out.window.from === new Date(candles[0].t).toISOString() && out.lastClose === closes[59], "assembly: candles/window/lastClose");
  ok(near(out.indicators.rsi.value, rsi(closes, 14)[59], 1e-4) && out.indicators.rsi.series.length === 5, "assembly: rsi value + 5 series points");
  ok(near(out.indicators.macd.histogram, macd(closes)[`hist`][59], 1e-6) && out.indicators.macd.series[4].macd != null, "assembly: macd hist matches primitive");
  ok(near(out.indicators.ema.ema20, ema(closes, 20)[59], 1e-6) && near(out.indicators.ema.ema50, ema(closes, 50)[59], 1e-6) && out.indicators.ema.ema200 === null, "assembly: ema20/50 present, ema200 null on 60 candles");
  ok(out.notes && out.notes.some((n) => /ema200 needs at least 200/.test(n)), "assembly: notes explain the missing ema200");
  ok(near(out.indicators.sma.sma20, sma(closes, 20)[59], 1e-6) && near(out.indicators.sma.sma50, sma(closes, 50)[59], 1e-6), "assembly: sma20/50");
  const bb = bollinger(closes, 20, 2);
  ok(near(out.indicators.bollinger.upper, bb.upper[59], 1e-6) && near(out.indicators.bollinger.percentB, (closes[59] - bb.lower[59]) / (bb.upper[59] - bb.lower[59]), 1e-3), "assembly: bollinger upper + %B");
  ok(near(out.indicators.atr.value, atr(candles, 14)[59], 1e-6) && out.indicators.atr.pctOfClose > 0, "assembly: atr + pct of close");
  ok(near(out.indicators.vwap.value, vwap(candles)[59], 1e-6), "assembly: vwap");
  ok(out.summary.trend === (closes[59] > ema(closes, 50)[59] ? "above" : "below"), `assembly: trend vs EMA50 (${out.summary.trend})`);
  ok(["oversold", "neutral", "overbought"].includes(out.summary.rsiZone), "assembly: rsiZone");
  const hs = macd(closes).hist;
  const expectCross = hs[58] <= 0 && hs[59] > 0 ? "bullish" : hs[58] >= 0 && hs[59] < 0 ? "bearish" : "none";
  ok(out.summary.macdCross === expectCross && out.summary.macdHistogram === (hs[59] > 0 ? "positive" : hs[59] < 0 ? "negative" : "flat"), `assembly: macdCross/histogram from the last two bars (${out.summary.macdCross}, ${out.summary.macdHistogram})`);
  ok(/EMA50/.test(out.summary.text) && /RSI/.test(out.summary.text) && /MACD/.test(out.summary.text), "assembly: summary text is the fixed template");
  const sub = computeIndicators(candles, new Set(["rsi"]), 3);
  ok(Object.keys(sub.indicators).join() === "rsi" && sub.indicators.rsi.series.length === 3 && sub.summary.trend !== "unknown", "assembly: indicator subset still yields a full summary");
  const tiny = computeIndicators(candles.slice(0, 10), new Set(["rsi", "macd", "ema"]), 3);
  ok(tiny.indicators.rsi.value === null && tiny.indicators.macd.value === null && tiny.summary.trend === "unknown" && tiny.summary.macdCross === "unknown" && tiny.notes.length >= 3, "assembly: too few candles -> nulls + notes + unknown summary, never NaN");
  // Cross: a V-shaped series crosses from negative to positive histogram at
  // some bar; cut the window right there and the summary must say bullish,
  // one bar earlier it must say none, and the mirror image must say bearish.
  const vShape = Array.from({ length: 80 }, (_, k) => (k < 40 ? 100 - k : 60 + (k - 40) * 1.5));
  const vh = macd(vShape).hist;
  const flip = vh.findIndex((v, k) => k > 0 && vh[k - 1] != null && vh[k - 1] <= 0 && v > 0);
  ok(flip > 0, `V-shape fixture has a bullish histogram flip (idx ${flip})`);
  const mk = (arr) => arr.map((c, k) => ({ t: NOW - (arr.length - k) * H, o: c, h: c + 1, l: c - 1, c, v: 1 }));
  ok(computeIndicators(mk(vShape.slice(0, flip + 1)), new Set(["macd"]), 3).summary.macdCross === "bullish", "assembly: histogram sign flip on the last bar reads as bullish cross");
  ok(computeIndicators(mk(vShape.slice(0, flip)), new Set(["macd"]), 3).summary.macdCross === "none", "assembly: one bar before the flip reads as no cross");
  const mirror = vShape.map((c) => 200 - c);
  const mh = macd(mirror).hist;
  const mflip = mh.findIndex((v, k) => k > 0 && mh[k - 1] != null && mh[k - 1] >= 0 && v < 0);
  ok(mflip > 0 && computeIndicators(mk(mirror.slice(0, mflip + 1)), new Set(["macd"]), 3).summary.macdCross === "bearish", "assembly: mirrored flip reads as bearish cross");
}

// ----------------------------------------------------------------------------
// crypto-indicators handler
// ----------------------------------------------------------------------------
{
  __test.resetCaches();
  calls.length = 0;
  await throws(h("crypto-indicators")({}), 400, "missing coin -> 400");
  await throws(h("crypto-indicators")({ coin: "BTC", interval: "7m" }), 400, "bad interval -> 400");
  await throws(h("crypto-indicators")({ coin: "BTC", limit: 501 }), 400, "limit 501 -> 400");
  await throws(h("crypto-indicators")({ coin: "BTC", points: 101 }), 400, "points 101 -> 400");
  await throws(h("crypto-indicators")({ coin: "BTC", indicators: ["rsi", "stoch"] }), 400, "unknown indicator -> 400", /valid:/);
  await throws(h("crypto-indicators")({ coin: "B T C" }), 400, "coin with spaces -> 400");
  ok(calls.length === 0, "indicator validation 400s happen before any egress");
  const r = await h("crypto-indicators")({ coin: "btc", interval: "1h", limit: 60, points: 4, indicators: "rsi,macd,vwap" });
  ok(r.source === "hyperliquid" && r.coin === "BTC" && r.interval === "1h" && r.candles === 60, "indicators: coin resolved case-insensitively, 60 candles");
  ok(Object.keys(r.indicators).sort().join() === "macd,rsi,vwap" && r.indicators.rsi.series.length === 4, "indicators: CSV subset honoured, 4 points");
  ok(r.summary && r.summary.trend !== "unknown" && typeof r.fetchedAt === "string", "indicators: summary + fetchedAt");
  ok(r.ohlcv === undefined, "indicators: no OHLCV rows unless asked");
  await throws(h("crypto-indicators")({ coin: "BTC", ohlcv: 101 }), 400, "ohlcv 101 -> 400");
  const callsBefore = calls.length;
  const ro = await h("crypto-indicators")({ coin: "BTC", interval: "1h", limit: 60, points: 1, ohlcv: 3 });
  const lastBar = ro.ohlcv?.[2];
  ok(Array.isArray(ro.ohlcv) && ro.ohlcv.length === 3 && lastBar.close === ro.lastClose && ["open", "high", "low", "close", "volume"].every((k) => typeof lastBar[k] === "number") && !Number.isNaN(Date.parse(lastBar.t)),
    `indicators: ohlcv returns the last 3 bars, newest last, closing at lastClose (${JSON.stringify(lastBar)})`);
  ok(calls.filter((c) => c.body && JSON.parse(c.body).type === "candleSnapshot").length === calls.slice(0, callsBefore).filter((c) => c.body && JSON.parse(c.body).type === "candleSnapshot").length + 1, "indicators: ohlcv rides the same single candle read");
  const snap = calls.find((c) => c.body && JSON.parse(c.body).type === "candleSnapshot");
  const req = JSON.parse(snap.body).req;
  ok(req.coin === "BTC" && req.interval === "1h" && req.endTime - req.startTime === 60 * H, "indicators: candleSnapshot window = limit x interval");
  await throws(h("crypto-indicators")({ coin: "ZZZZ" }), 422, "unknown coin (not in meta) -> 422", /Unknown perp market/);
  mode = "hl-unknown-500";
  __test.resetCaches();
  await throws(h("crypto-indicators")({ coin: "BTC" }), 422, "HL 500 \"null\" -> 422, not 502");
  mode = "http500"; __test.resetCaches();
  await throws(h("crypto-indicators")({ coin: "BTC" }), 502, "HL 500 -> 502");
  mode = "http429"; __test.resetCaches();
  await throws(h("crypto-indicators")({ coin: "BTC" }), 503, "HL 429 -> 503");
  mode = "timeout"; __test.resetCaches();
  await throws(h("crypto-indicators")({ coin: "BTC" }), 503, "HL deadline -> 503 naming the upstream and the step");
  mode = "ok"; __test.resetCaches();
}

// ----------------------------------------------------------------------------
// market pulse
// ----------------------------------------------------------------------------
{
  const rows = [
    { coin: "BTC", markPx: 100, change24hPct: 1, fundingHourly: 0.00001, fundingAprPct: 8.76, openInterestUsd: 1000, volume24hUsd: 5000 },
    { coin: "ETH", markPx: 10, change24hPct: -2, fundingHourly: -0.00002, fundingAprPct: -17.52, openInterestUsd: 500, volume24hUsd: 3000 },
    { coin: "SOL", markPx: 5, change24hPct: 4, fundingHourly: 0.00005, fundingAprPct: 43.8, openInterestUsd: 200, volume24hUsd: 2000 },
    { coin: "DOGE", markPx: 0.1, change24hPct: 0, fundingHourly: 0, fundingAprPct: 0, openInterestUsd: 100, volume24hUsd: 1000 },
    { coin: "TINY", markPx: 1, change24hPct: 50, fundingHourly: 0.001, fundingAprPct: 876, openInterestUsd: 10, volume24hUsd: 10 },
    { coin: "NOPX", markPx: null, change24hPct: null, fundingHourly: null, fundingAprPct: null, openInterestUsd: null, volume24hUsd: 0 },
  ];
  const p = marketPulse(rows, { limit: 2, minVolumeUsd: 500 });
  ok(p.markets.listed === 5 && p.markets.counted === 4 && p.markets.minVolumeUsd === 500, `pulse: listed/counted (${p.markets.listed}/${p.markets.counted})`);
  ok(p.breadth.advancers === 2 && p.breadth.decliners === 1 && p.breadth.unchanged === 1 && p.breadth.advancersPct === 50, "pulse: breadth counts exclude the illiquid market");
  ok(p.breadth.meanChange24hPct === 0.75 && p.breadth.medianChange24hPct === 0.5, `pulse: mean 0.75 / median 0.5 (${p.breadth.meanChange24hPct}/${p.breadth.medianChange24hPct})`);
  ok(near(p.breadth.volumeWeightedChange24hPct, (1 * 5000 - 2 * 3000 + 4 * 2000 + 0) / 11000, 1e-4), "pulse: volume-weighted change");
  ok(p.totals.openInterestUsd === 1810 && p.totals.volume24hUsd === 11010 && near(p.totals.top5VolumeSharePct, 100, 1e-6), "pulse: totals over ALL priced markets");
  ok(p.funding.positive === 2 && p.funding.negative === 1 && p.funding.zero === 1, "pulse: funding breadth");
  ok(p.majors.BTC.markPx === 100 && p.majors.ETH.change24hPct === -2, "pulse: majors");
  ok(p.topByVolume.map((r) => r.coin).join() === "BTC,ETH", "pulse: topByVolume limit 2");
  ok(p.topGainers.map((r) => r.coin).join() === "SOL,BTC" && p.topLosers.map((r) => r.coin).join() === "ETH,DOGE", `pulse: gainers/losers exclude TINY (${p.topGainers.map((r) => r.coin)})`);
  ok(p.highestFunding[0].coin === "SOL" && p.lowestFunding[0].coin === "ETH" && p.highestFunding[0].fundingHourly === 0.00005, "pulse: funding extremes");
  const all = marketPulse(rows, { limit: 20, minVolumeUsd: 0 });
  ok(all.markets.counted === 5 && all.topGainers[0].coin === "TINY", "pulse: minVolumeUsd 0 admits every priced market");

  await throws(h("crypto-market-pulse")({ limit: 21 }), 400, "pulse limit 21 -> 400");
  await throws(h("crypto-market-pulse")({ minVolumeUsd: -1 }), 400, "pulse negative minVolumeUsd -> 400");
  const live = await h("crypto-market-pulse")({ limit: 5 });
  ok(live.source === "hyperliquid" && live.markets.listed === 3 && live.breadth.advancers === 2 && live.breadth.decliners === 0, `pulse handler on fixture (listed ${live.markets.listed}, counted ${live.markets.counted})`);
  ok(live.majors.BTC.markPx === 77267 && live.topByVolume[0].coin === "BTC" && typeof live.fetchedAt === "string", "pulse handler: majors + leaders + fetchedAt");
  // Each new upstream state drops the shared 5 s document cache first; a
  // stored success would otherwise (correctly) answer for the outage.
  mode = "http500"; __test.resetCaches();
  await throws(h("crypto-market-pulse")({}), 502, "pulse HL 500 -> 502");
  mode = "timeout"; __test.resetCaches();
  await throws(h("crypto-market-pulse")({}), 503, "pulse HL deadline -> 503");
  mode = "ok";
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

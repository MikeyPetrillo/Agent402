// Finance-kit tests: strict and offline on validation and on the pure
// consolidation step, tolerant of upstream errors on the live calls.
//
// Live calls are gated on DATABENTO_API_KEY and are therefore SKIPPED in CI,
// which holds no key on purpose: a Databento query is billed by the bytes it
// returns, and a sweep that buys market data on every push is the CI-spend
// leak we have now had three times (Brave, E2B, CoinGecko). Without a key the
// suite instead asserts the honest 503 - the tools must say they are not
// configured, never blame the caller's input.
//
// The consolidation assertions are the ones that matter most. DBEQ.BASIC is
// three venues, not the consolidated tape, so a bar per venue has to be folded
// into one: extremes across venues, volume SUMMED and labelled partial, and
// open/close taken from the venue that actually traded the most. Getting that
// wrong produces a confident-looking quote built on one thin venue.
import { FINANCE_TOOLS, stockAnalysis } from "../src/tools/finance-kit.js";
import { consolidate, databentoEnabled } from "../src/tools/databento.js";

const h = (slug) => FINANCE_TOOLS.find((t) => t.slug === slug).handler;
let assertFail = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) console.log(`ok - ${m}`); else { assertFail++; console.error(`ASSERT FAIL - ${m}`); } };

// --- the kit is exactly the two licensed tools ---
{
  const slugs = FINANCE_TOOLS.map((t) => t.slug).sort();
  ok(JSON.stringify(slugs) === JSON.stringify(["stock-history", "stock-quote"]),
    `finance-kit serves only the licensed tools (got ${slugs.join(", ")})`);
  ok(FINANCE_TOOLS.every((t) => /Databento/.test(t.description) && /venueVolume/.test(t.description)),
    "each description names the source and the venue-partial volume");
  ok(!/yahoo/i.test(JSON.stringify(FINANCE_TOOLS)), "no surface of this kit still names the unlicensed provider");
  ok(FINANCE_TOOLS.every((t) => {
    const keys = Object.keys(t.discovery.output.example);
    return keys.includes("source") && keys.includes("venues") && keys.includes("note");
  }), "every published example carries the source, the venues and the caveat");
}

// --- deterministic validation (no network, no key needed) ---
for (const [slug, args, label] of [
  ["stock-quote", {}, "stock-quote rejects missing symbol"],
  ["stock-quote", { symbol: "" }, "stock-quote rejects empty symbol"],
  ["stock-quote", { symbol: "BAD SYMBOL!" }, "stock-quote rejects symbol with spaces/punctuation"],
  ["stock-quote", { symbol: "A".repeat(17) }, "stock-quote rejects 17-char symbol"],
  ["stock-history", {}, "stock-history rejects missing symbol"],
  ["stock-history", { symbol: "AAPL", days: 0 }, "stock-history rejects days 0"],
  ["stock-history", { symbol: "AAPL", days: 9999 }, "stock-history rejects an over-wide window"],
  ["stock-history", { symbol: "AAPL", days: 251 }, "stock-history rejects one session past the advertised maximum"],
  ["stock-history", { symbol: "AAPL", days: 1.5 }, "stock-history rejects a fractional days"],
  ["stock-history", { symbol: "AAPL", indicators: ["rsi", "vwap"] }, "stock-history rejects vwap (three-venue volume) and unknown indicators"],
  ["stock-history", { symbol: "AAPL", indicators: true, points: 0 }, "stock-history rejects points 0"],
]) {
  try { await h(slug)(args); ok(false, label); }
  catch (e) { ok(e.statusCode === 400, label + ` (got ${e.statusCode})`); }
}

// --- stockAnalysis(): indicators over daily bars (pure, offline) ---
{
  const bars = Array.from({ length: 60 }, (_, k) => {
    const c = 100 + k * 0.5 + (k % 3);
    return { day: new Date(Date.UTC(2026, 5, 1 + k)).toISOString().slice(0, 10), open: c - 0.3, high: c + 1, low: c - 1, close: c, venueVolume: 1000 + k };
  });
  const a = stockAnalysis(bars, new Set(["rsi", "macd", "ema", "sma", "bollinger", "atr"]), 3);
  ok(a.sessions === 60 && a.lastClose === bars.at(-1).close, `analysis reads the returned bars (${a.sessions} sessions, lastClose ${a.lastClose})`);
  ok(typeof a.indicators.rsi.value === "number" && a.indicators.rsi.series.length === 3 && typeof a.indicators.macd.histogram === "number", "RSI and MACD computed with the requested series points");
  ok(a.indicators.ema.ema200 === null && (a.notes || []).some((n) => /ema200/.test(n)), "EMA200 on 60 sessions is null and says why");
  ok(a.summary.trend === "above" && /EMA50/.test(a.summary.text), `a rising series reads above EMA50 (${a.summary.text})`);
  ok(!("vwap" in a.indicators) && /not investment advice/.test(a.disclaimer), "no VWAP, and the disclaimer rides with it");
}

// --- consolidate(): the three-venue fold (pure, offline) ---
{
  // ts_event is nanoseconds since the epoch, inside the record header.
  const ns = String(Date.UTC(2026, 8, 18) * 1e6);
  const rows = [
    // A thin venue that happens to print the session's extremes.
    { hd: { ts_event: ns }, open: 100_000000000, high: 111_000000000, low: 90_000000000, close: 101_000000000, volume: 10 },
    // The venue that actually traded: its open/close are the honest ones.
    { hd: { ts_event: ns }, open: 104_000000000, high: 106_000000000, low: 103_000000000, close: 105_000000000, volume: 900 },
    { hd: { ts_event: ns }, open: 104_500000000, high: 105_000000000, low: 102_000000000, close: 104_000000000, volume: 90 },
  ];
  const bars = consolidate(rows);
  ok(bars.length === 1, `consolidate folds one session's venue bars into one bar (got ${bars.length})`);
  const b = bars[0];
  ok(b.high === 111 && b.low === 90, `high/low are the extremes across venues (got ${b.high}/${b.low})`);
  ok(b.close === 105 && b.open === 104, `open/close come from the highest-volume venue, not the extreme one (got ${b.open}/${b.close})`);
  ok(b.venueVolume === 1000, `venue volume SUMS the venues (got ${b.venueVolume})`);
  ok(!("volume" in b), "the summed figure is never called `volume`: it is three venues, not the tape");
  ok(/^\d{4}-\d{2}-\d{2}$/.test(b.day), `each bar carries a plain session date (got ${b.day})`);
}
{
  // Two sessions stay two bars, newest last.
  const bars = consolidate([
    { hd: { ts_event: String(Date.UTC(2026, 8, 18) * 1e6) }, open: 3e9, high: 4e9, low: 3e9, close: 4e9, volume: 7 },
    { hd: { ts_event: String(Date.UTC(2026, 8, 17) * 1e6) }, open: 1e9, high: 2e9, low: 1e9, close: 2e9, volume: 5 },
  ]);
  ok(bars.length === 2 && bars[0].day < bars[1].day, "sessions stay separate and ascend by date whatever order they arrive in");
  ok(consolidate([]).length === 0, "an empty response consolidates to no bars, never a fabricated one");
}

// --- live calls, only with a key ---
async function live(slug, args, check, label) {
  try {
    const r = await h(slug)(args);
    if (check(r)) { liveOk++; console.log(`ok - ${label}: ${JSON.stringify(r).slice(0, 160)}`); }
    else { assertFail++; console.error(`ASSERT FAIL - ${label}: unexpected shape ${JSON.stringify(r).slice(0, 240)}`); }
  } catch (e) {
    liveErr++;
    console.warn(`warn - ${label}: upstream error (${e.statusCode || "?"}) ${e.message} - tolerated`);
  }
}

if (!databentoEnabled()) {
  // No key: prove the refusal is OURS and says so. A 4xx here would be the
  // tool blaming a perfectly good ticker for our own missing configuration.
  for (const [slug, args] of [["stock-quote", { symbol: "AAPL" }], ["stock-history", { symbol: "AAPL", days: 5 }]]) {
    try { await h(slug)(args); ok(false, `${slug} 503s with no key`); }
    catch (e) {
      ok(e.statusCode === 503 && /not configured/i.test(e.message),
        `${slug} 503s "not configured" with no key (got ${e.statusCode}: ${e.message})`);
    }
  }
  console.log("\nlive calls skipped: DATABENTO_API_KEY unset (CI holds no market-data key by design)");
  console.log(`validation asserts failed: ${assertFail}`);
  if (assertFail > 0) { console.error("finance-kit: FAILED"); process.exit(1); }
  console.log("finance-kit: OK");
} else {
  await live("stock-quote", { symbol: "AAPL" },
    (r) => r.symbol === "AAPL" && r.currency === "USD" && typeof r.price === "number" && r.price > 0 &&
      typeof r.venueVolume === "number" && typeof r.note === "string" && /venue/i.test(r.note),
    "stock-quote AAPL");

  // An unknown ticker is the caller's input, so it must be a 4xx naming the
  // cause, never an upstream 502 that reads as our outage.
  try { await h("stock-quote")({ symbol: "ZZZZQQ" }); ok(false, "stock-quote 4xxs an unknown symbol"); }
  catch (e) { ok(e.statusCode >= 400 && e.statusCode < 500, `stock-quote 4xxs an unknown symbol (got ${e.statusCode})`); }

  // Asks for exactly 30 SESSIONS. Calendar slack has to cover weekends and
  // holidays or a 30-session ask quietly returns 29 - which is what it did
  // before the slack was scaled.
  await live("stock-history", { symbol: "AAPL", days: 30 },
    (r) => r.symbol === "AAPL" && Array.isArray(r.bars) && r.bars.length === 30 && r.days === 30 &&
      r.bars.every((b) => typeof b.close === "number" && /^\d{4}-\d{2}-\d{2}$/.test(b.day)),
    "stock-history AAPL 30d");

  // The advertised maximum must be one a buyer can actually spend. The
  // upstream cost guard is separate from the input check, so a generous
  // documented limit can sit on top of a query that is always refused -
  // which is exactly what 365 did, refused from about 90 sessions up.
  const maxDays = Number(/1 to (\d+)/.exec(
    FINANCE_TOOLS.find((t) => t.slug === "stock-history").discovery.inputSchema.properties.days.description)[1]);
  await live("stock-history", { symbol: "AAPL", days: maxDays },
    (r) => r.days === maxDays && r.bars.length === maxDays,
    `stock-history serves its own advertised maximum (${maxDays} sessions)`);

  console.log(`\nvalidation asserts failed: ${assertFail} | live ok: ${liveOk} | live upstream-errors (tolerated): ${liveErr}`);
  if (assertFail > 0 || liveOk === 0) { console.error("finance-kit: FAILED"); process.exit(1); }
  console.log("finance-kit: OK");
}

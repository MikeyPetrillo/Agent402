// Offline unit tests for the demand-radar seller-intelligence tool
// (src/tools/x402-kit.js computeDemandRadar) — signal classification,
// near-threshold math, noise flagging, sorts, filters, empty-aggregate
// resilience, and the wallet-only (pay-per-call) registration in pow.js.
// No network, no boot: feeds synthetic getWishesAggregate-shaped aggregates.
import { computeDemandRadar } from "../src/tools/x402-kit.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// Synthetic builders matching the getWishesAggregate row/envelope shape.
const cl = (text, count, sources = {}, over = {}) => ({
  text,
  count,
  sources: { api: 0, mcp: 0, "find-miss": 0, ...sources },
  firstSeen: "2026-07-01T00:00:00.000Z",
  lastSeen: "2026-07-10T00:00:00.000Z",
  issueOpened: false,
  ...over,
});
const agg = (clusters, over = {}) => ({
  distinctClusters: clusters.length,
  totalWishes: clusters.reduce((s, c) => s + (c.count || 0), 0),
  threshold: 5,
  clusters,
  ...over,
});

// --- signalType classification (the seller-facing differentiator) -------------
{
  const out = computeDemandRadar(agg([
    cl("convert heic to jpg", 5, { "find-miss": 5 }),
    cl("reverse geocode an address", 4, { api: 3, mcp: 1 }),
    cl("parse ics calendar file", 4, { api: 1, mcp: 1, "find-miss": 2 }),
  ]), { limit: 50 });
  const byText = (t) => out.radar.find((r) => r.text === t);
  ok(byText("convert heic to jpg").signalType === "discoverability", "find-miss-dominated cluster → discoverability");
  ok(byText("reverse geocode an address").signalType === "explicit-request", "api/mcp-dominated cluster → explicit-request");
  ok(byText("parse ics calendar file").signalType === "mixed", "50/50 find-miss vs explicit → mixed");
  // Dominance boundary: exactly 2/3 find-miss counts as dominated.
  const edge = computeDemandRadar(agg([cl("edge", 3, { api: 1, "find-miss": 2 })]), {});
  ok(edge.radar[0].signalType === "discoverability", "exactly 2/3 find-miss share → discoverability (boundary inclusive)");
  const edge2 = computeDemandRadar(agg([cl("edge2", 3, { api: 2, "find-miss": 1 })]), {});
  ok(edge2.radar[0].signalType === "explicit-request", "exactly 2/3 explicit share → explicit-request");
  const zero = computeDemandRadar(agg([cl("zero", 1, {})]), {});
  ok(zero.radar[0].signalType === "mixed", "no per-source signals at all → mixed (no divide-by-zero)");
}

// --- nearThreshold + gapToThreshold math (threshold=5, band=2) -----------------
{
  const out = computeDemandRadar(agg([
    cl("hot", 4, { api: 4 }),
    cl("edge-of-band", 3, { api: 3 }),
    cl("cold", 2, { api: 2 }),
    cl("crossed", 6, { api: 6 }),
  ]), { limit: 50 });
  const byText = (t) => out.radar.find((r) => r.text === t);
  ok(byText("hot").nearThreshold === true && byText("hot").gapToThreshold === 1, "count 4 vs threshold 5 → nearThreshold true, gap 1");
  ok(byText("edge-of-band").nearThreshold === true && byText("edge-of-band").gapToThreshold === 2, "count 3 (threshold-2) → still nearThreshold (band inclusive)");
  ok(byText("cold").nearThreshold === false && byText("cold").gapToThreshold === 3, "count 2 vs threshold 5 → not nearThreshold, gap 3");
  ok(byText("crossed").nearThreshold === true && byText("crossed").gapToThreshold === 0, "count past threshold → nearThreshold true, gap clamps to 0");
  ok(out.buildThreshold === 5, "envelope carries buildThreshold from the aggregate");
}

// --- noise flagging (flagged, never dropped) -----------------------------------
{
  const out = computeDemandRadar(agg([
    cl("test", 3, { api: 3 }),
    cl("probe-test 1752449000", 2, { api: 2 }),
    cl("stock quote launch check", 2, { api: 2 }),
    cl("stock quotes for agents", 4, { api: 4 }),
    cl("testing sms delivery", 2, { api: 2 }),
  ]), { limit: 50 });
  const byText = (t) => out.radar.find((r) => r.text === t);
  ok(byText("test").noise === true, 'exact "test" cluster → noise:true');
  ok(byText("probe-test 1752449000").noise === true, '"probe-test" marker → noise:true');
  ok(byText("stock quote launch check").noise === true, '"launch check" marker → noise:true');
  ok(byText("stock quotes for agents").noise === false, "real demand text → noise:false");
  ok(byText("testing sms delivery").noise === false, 'word merely containing "test" is NOT flagged (exact-match only)');
  ok(out.radar.length === 5 && out.matchedClusters === 5, "noisy clusters are flagged but never dropped");
}

// --- sort modes ------------------------------------------------------------------
{
  const rows = [
    cl("big-old", 9, { api: 9 }, { lastSeen: "2026-07-02T00:00:00.000Z" }),
    cl("small-fresh", 2, { api: 2 }, { lastSeen: "2026-07-13T00:00:00.000Z" }),
    cl("mid", 5, { api: 5 }, { lastSeen: "2026-07-08T00:00:00.000Z" }),
  ];
  const byCount = computeDemandRadar(agg(rows), {});
  ok(byCount.sort === "count", "default sort is count");
  ok(byCount.radar.map((r) => r.text).join(",") === "big-old,mid,small-fresh", "sort=count ranks by count desc");
  const byRecent = computeDemandRadar(agg(rows), { sort: "recent" });
  ok(byRecent.radar.map((r) => r.text).join(",") === "small-fresh,mid,big-old", "sort=recent ranks by lastSeen desc");
  ok(computeDemandRadar(agg(rows), { sort: "bogus" }).sort === "count", "unknown sort falls back to count (echoed)");
  // count ties break by recency (deterministic ordering)
  const tied = computeDemandRadar(agg([
    cl("older-tie", 3, { api: 3 }, { lastSeen: "2026-07-05T00:00:00.000Z" }),
    cl("newer-tie", 3, { api: 3 }, { lastSeen: "2026-07-12T00:00:00.000Z" }),
  ]), {});
  ok(tied.radar[0].text === "newer-tie", "count tie breaks by lastSeen desc");
}

// --- minCount filter + limit ------------------------------------------------------
{
  const rows = Array.from({ length: 60 }, (_, i) => cl(`need-${String(i).padStart(2, "0")}`, 60 - i, { api: 60 - i }));
  ok(computeDemandRadar(agg(rows), {}).radar.length === 10, "default limit is 10");
  ok(computeDemandRadar(agg(rows), { limit: 999 }).radar.length === 50, "limit caps at 50");
  ok(computeDemandRadar(agg(rows), { limit: "3" }).radar.length === 3, "string limit (GET query) parses");
  const filtered = computeDemandRadar(agg([
    cl("popular", 6, { api: 6 }),
    cl("one-off", 1, { api: 1 }),
  ]), { minCount: 2 });
  ok(filtered.radar.length === 1 && filtered.radar[0].text === "popular", "minCount=2 filters single-signal clusters");
  ok(filtered.matchedClusters === 1, "matchedClusters reflects the minCount filter");
  ok(filtered.minCount === 2, "minCount is echoed in the envelope");
  ok(computeDemandRadar(agg([cl("x", 1, { api: 1 })]), { minCount: "2" }).radar.length === 0, "string minCount (GET query) parses");
}

// --- qualification read-through (2026-09-06: a buyer bought the radar beside the free
// beacon, which said "1 qualified cluster", and could not tell which row it was) ----
{
  const rows = [
    cl("q", 6, { api: 3, mcp: 3 }, { callers: 3, qualified: true, firstSeen: "2026-07-01T00:00:00.000Z", lastSeen: "2026-07-02T12:00:00.000Z" }),
    cl("one-caller", 9, { api: 9 }, { callers: 1, qualified: false }),
    cl("legacy", 4, { api: 4 }),
  ];
  const out = computeDemandRadar(agg(rows, { qualifyMinCallers: 3, qualifyMinSpanHours: 24 }), {});
  const q = out.radar.find((r) => r.text === "q"), one = out.radar.find((r) => r.text === "one-caller"), legacy = out.radar.find((r) => r.text === "legacy");
  ok(q.callers === 3 && q.qualified === true, "a qualified cluster reads callers + qualified:true");
  ok(q.spanHours === 36, "spanHours is first-to-last in hours (36h)");
  ok(one.callers === 1 && one.qualified === false, "a one-caller cluster is NOT qualified whatever its count (9 signals)");
  ok(legacy.callers === 0 && legacy.qualified === false && legacy.spanHours === 216, "a row with no caller data reads callers 0, qualified false (never guessed true)");
  ok(out.qualifiedClusters === 1, "envelope qualifiedClusters matches the beacon's count (1)");
  ok(out.qualifyMinCallers === 3 && out.qualifyMinSpanHours === 24 && out.qualifiedOnly === false, "envelope echoes the bar + the qualifiedOnly flag");
  const only = computeDemandRadar(agg(rows), { qualifiedOnly: "true" });
  ok(only.radar.length === 1 && only.radar[0].text === "q" && only.qualifiedOnly === true && only.matchedClusters === 1, "qualifiedOnly (GET string) keeps only the qualified row");
  ok(computeDemandRadar(agg(rows), { qualifiedOnly: true, minCount: 7 }).radar.length === 0, "qualifiedOnly composes with minCount");
  ok(computeDemandRadar(agg(rows), { qualifiedOnly: "yes" }).radar.length === 3, "a non-boolean qualifiedOnly is off, never a silent filter");
  ok(computeDemandRadar(agg([cl("bad", 2, { api: 2 }, { firstSeen: "junk", lastSeen: null })]), {}).radar[0].spanHours === null, "unparseable timestamps give spanHours null, not NaN");
}

// --- empty / missing aggregate: clean envelope, never throws ----------------------
{
  const empty = computeDemandRadar(agg([]), {});
  ok(empty.totalWishes === 0 && empty.distinctClusters === 0, "empty aggregate → totalWishes 0, distinctClusters 0");
  ok(Array.isArray(empty.radar) && empty.radar.length === 0 && empty.matchedClusters === 0, "empty aggregate → radar:[]");
  ok(empty.buildThreshold === 5 && typeof empty.generatedAt === "string", "empty envelope keeps buildThreshold + generatedAt");
  const nullOut = computeDemandRadar(null, {});
  ok(nullOut.totalWishes === 0 && nullOut.radar.length === 0 && nullOut.buildThreshold === 0, "null aggregate → clean empty envelope (no throw)");
  const junk = computeDemandRadar({ clusters: [{}, null, { text: "ok", count: "3", sources: null }] }, {});
  ok(junk.radar.length >= 1 && junk.radar.every((r) => Number.isFinite(r.count)), "malformed cluster rows coerce cleanly (no NaN counts)");
}

// --- wallet-only registration (the whole point: pay-per-call, never PoW-farmable) --
{
  ok(WALLET_ONLY_SLUGS.has("demand-radar"), "demand-radar is in WALLET_ONLY_SLUGS (wallet-only, not compute-payable)");
  ok(WALLET_ONLY_SLUGS.has("x402-trending"), "sibling paid-intelligence layer x402-trending still wallet-only (sanity)");
}

// --- the handler must ask for the DETAILED aggregate, and a board it cannot
// see must REFUSE. The paid radar was empty for six weeks (2026-07-21 to
// 2026-09-06, 193 settlements) because the handler read the beacon envelope,
// which carries counts and no cluster rows. This block used to sit AFTER the
// process.exit() below and therefore never ran once - its source pin still
// named `limit: 500` long after the handler moved to the whole board, and a
// guard that cannot execute is a certificate for nothing. It asserts the
// refusal now, not the hollow envelope it used to reproduce.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/tools/x402-kit.js", import.meta.url), "utf8");
  ok(/computeDemandRadar\(getWishesAggregate\(\{ limit: [0-9_]+, detailed: true \}\), i\)/.test(src), "demand-radar handler reads the detailed aggregate (cluster rows), not the public beacon");
  let threw = null;
  try { computeDemandRadar({ distinctClusters: 1055, totalWishes: 4010, threshold: 5, qualifiedClusters: 1 }, { minCount: 1 }); }
  catch (e) { threw = e; }
  ok(threw && threw.statusCode === 502, `a beacon-only aggregate (1055 clusters, no rows) REFUSES 502 instead of selling the hollow envelope (got ${threw ? threw.statusCode : "a 200"})`);
  ok(threw && /not charged/.test(threw.message) && /1055/.test(threw.message), "the refusal says nobody was charged and names what the board claimed");
  // ...and the honest empties still answer 200: a genuinely empty board, and a
  // filter the CALLER chose that matched nothing.
  ok(computeDemandRadar({ distinctClusters: 0, totalWishes: 0, threshold: 5, clusters: [] }, {}).matchedClusters === 0, "a genuinely empty board still answers (0 clusters, 0 rows)");
  const filtered = computeDemandRadar(agg([cl("only", 1, { api: 1 })]), { minCount: 9 });
  ok(filtered.matchedClusters === 0 && filtered.distinctClusters === 1, "a caller's own minCount filtering everything out is an answer, not a refusal");
  const qOnly = computeDemandRadar(agg([cl("only", 1, { api: 1 })]), { qualifiedOnly: true });
  ok(qOnly.matchedClusters === 0, "qualifiedOnly matching nothing is an answer, not a refusal");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

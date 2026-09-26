// Offline unit tests for the agent wish loop (src/wish.js): capture demand
// for tools we don't have instead of losing it on a one-shot buyer's exit.
// Pure module tests — no server boot, no network. Each logical section gets
// its own throwaway JSONL file via __testSetFilePath so rate-limit buckets
// and cluster state never leak between sections.
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordWish, getWishesAggregate, WISH_THRESHOLD,
  clusterQualifies, QUALIFY_MIN_SPAN_MS, QUALIFY_MIN_CALLERS, WISH_SERVED_MIN_SCORE, callerHash, annotateServed, annotateServedAsync,
  __testSetFilePath, __testSetLineCap, __testState, __testReset, WISH_STALE_DAYS,
} from "../src/wish.js";

process.env.WISH_CALLER_SALT = "test-salt-never-prod";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const throws = (fn) => { try { fn(); return false; } catch (e) { return e; } };

const tmpFiles = [];
function freshFile(tag) {
  const p = join(tmpdir(), `wish-test-${process.pid}-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  tmpFiles.push(p);
  __testSetFilePath(p);
  return p;
}

// --- basics ---
{
  freshFile("basic");
  const r = recordWish({ need: "convert stl files to obj", source: "api", ip: "10.0.0.1" });
  ok(r.recorded === true, `new need → recorded (got ${JSON.stringify(r)})`);
  ok(getWishesAggregate({ detailed: true }).clusters[0].count === 1, "the cluster holds one signal (read from the token-gated board, not the response)");
}

// --- validation: 400s ---
{
  freshFile("validation");
  const e1 = throws(() => recordWish({ source: "api", ip: "10.0.0.2" }));
  ok(e1 && e1.statusCode === 400, `missing 'need' throws 400 (got ${e1 && e1.statusCode})`);
  const e2 = throws(() => recordWish({ need: "x", context: 42, source: "api", ip: "10.0.0.2" }));
  ok(e2 && e2.statusCode === 400, `non-string 'context' throws 400 (got ${e2 && e2.statusCode})`);
  const e3 = throws(() => recordWish({ need: "   ", source: "api", ip: "10.0.0.2" }));
  ok(e3 && e3.statusCode === 400, `whitespace-only 'need' throws 400 (got ${e3 && e3.statusCode})`);
}

// --- caps: need capped at 500, context capped at 300, silently truncated (not rejected) ---
{
  const file = freshFile("caps");
  recordWish({ need: "n".repeat(600), context: "c".repeat(400), source: "api", ip: "10.0.0.3" });
  const line = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0]);
  ok(line.need.length === 500, `need is capped at 500 chars (got ${line.need.length})`);
  ok(line.context.length === 300, `context is capped at 300 chars (got ${line.context.length})`);
}

// --- dedup / clustering: normalization collapses case + whitespace variants ---
{
  freshFile("dedup");
  recordWish({ need: "  Convert   STL to OBJ ", source: "api", ip: "10.0.0.4" });
  recordWish({ need: "convert stl to obj", source: "mcp", ip: "10.0.0.5" });
  const agg = getWishesAggregate({ detailed: true });
  ok(agg.clusters[0].count === 2, `case/whitespace variants collapse into one cluster (got count=${agg.clusters[0].count})`);
  ok(agg.distinctClusters === 1, `dedup: exactly one distinct cluster (got ${agg.distinctClusters})`);
  ok(agg.clusters[0].sources.api === 1 && agg.clusters[0].sources.mcp === 1, `sources breakdown attributes each call correctly (got ${JSON.stringify(agg.clusters[0].sources)})`);
}

// --- rate limit: 10/IP/hour, find-miss exempt ---
{
  freshFile("ratelimit-ip");
  const ip = "10.0.1.1";
  let allOk = true;
  for (let i = 0; i < 10; i++) {
    const r = recordWish({ need: `need number ${i}`, source: "api", ip });
    if (!r.recorded) allOk = false;
  }
  ok(allOk, "10 wishes/IP/hour: first 10 calls all succeed");
  const e = throws(() => recordWish({ need: "need number 11", source: "api", ip }));
  ok(e && e.statusCode === 429, `11th wish from same IP within the hour throws 429 (got ${e && e.statusCode})`);
  const fm = recordWish({ need: "need number 12", source: "find-miss", ip });
  ok(fm.recorded === true, "find-miss source is exempt from the per-IP rate limit even after it's exhausted");
}

// --- rate limit: 100/day global, applies across distinct IPs ---
{
  freshFile("ratelimit-global");
  for (let i = 0; i < 100; i++) {
    recordWish({ need: `global need ${i}`, source: "api", ip: `10.0.2.${i}` });
  }
  const e = throws(() => recordWish({ need: "global need 101", source: "api", ip: "10.0.2.101" }));
  ok(e && e.statusCode === 429, `101st wish (new IP) throws 429 once the 100/day global cap is hit (got ${e && e.statusCode})`);
}

// --- auto-issue threshold: loud log once, not repeated ---
{
  freshFile("threshold");
  const originalWarn = console.warn;
  const logs = [];
  console.warn = (...args) => logs.push(args.join(" "));
  try {
    for (let i = 0; i < WISH_THRESHOLD; i++) {
      recordWish({ need: "add a currency converter for gold", source: "api", ip: `10.0.3.${i}` });
    }
  } finally {
    console.warn = originalWarn;
  }
  const hits = logs.filter((l) => l.includes("[wish-threshold]"));
  ok(hits.length === 1, `threshold log fires exactly once at count=${WISH_THRESHOLD} (got ${hits.length} logs: ${JSON.stringify(logs)})`);
  const agg = getWishesAggregate({ detailed: true });
  const row = agg.clusters.find((c) => c.text.includes("currency converter"));
  ok(row && row.issueOpened === true, `cluster carries issueOpened:true after crossing the threshold (got ${JSON.stringify(row)})`);
}

// --- qualification gate: raw count is necessary but not sufficient ---
// clusterQualifies is the exact predicate the wish-issues workflow selects on.
// Tested directly with synthetic clusters so timestamps are controllable.
{
  const T = 1_700_000_000_000;
  const src = (o) => ({ api: 0, mcp: 0, "find-miss": 0, ...o });
  const callers = (n) => new Set(Array.from({ length: n }, (_, i) => `c${i}`));
  // Below threshold never qualifies, regardless of shape.
  ok(!clusterQualifies({ count: WISH_THRESHOLD - 1, sources: src({ api: 2, mcp: 2 }), firstSeen: T, lastSeen: T + QUALIFY_MIN_SPAN_MS }),
    "below count threshold never qualifies");
  // Single-source short burst (the synthora spam shape) does NOT qualify.
  ok(!clusterQualifies({ count: 103, sources: src({ api: 103 }), firstSeen: T, lastSeen: T + 5 * 3_600_000 }),
    "single-source burst (103 hits, 5h) does not qualify");
  ok(!clusterQualifies({ count: 18, sources: src({ "find-miss": 18 }), firstSeen: T, lastSeen: T + 5 * 3_600_000 }),
    "single-source find-miss burst does not qualify");
  // Corroboration across two sources qualifies at threshold.
  ok(clusterQualifies({ count: WISH_THRESHOLD, sources: src({ api: 3, mcp: 2 }), firstSeen: T, lastSeen: T + 60_000, callers: callers(3) }),
    "two distinct sources qualifies even in a short window");
  // Distinct callers are required as well: the 2026-08-27 sweep was one
  // machine re-running ~30 queries for two days, clearing the span bar alone.
  ok(!clusterQualifies({ count: 60, sources: src({ "find-miss": 60 }), firstSeen: T, lastSeen: T + 2 * QUALIFY_MIN_SPAN_MS, callers: callers(1) }),
    "one caller sustained for two days does NOT qualify (the scripted find sweep shape)");
  ok(!clusterQualifies({ count: WISH_THRESHOLD, sources: src({ api: 3, mcp: 2 }), firstSeen: T, lastSeen: T + 60_000, callers: callers(QUALIFY_MIN_CALLERS - 1) }),
    "two sources but fewer than QUALIFY_MIN_CALLERS distinct callers does not qualify");
  ok(!clusterQualifies({ count: WISH_THRESHOLD, sources: src({ api: 5 }), firstSeen: T, lastSeen: T + QUALIFY_MIN_SPAN_MS }),
    "a legacy cluster with no caller data does not qualify until fresh signals arrive");
  // Sustained single-source demand over the span window qualifies.
  ok(clusterQualifies({ count: WISH_THRESHOLD, sources: src({ api: 5 }), firstSeen: T, lastSeen: T + QUALIFY_MIN_SPAN_MS, callers: callers(3) }),
    "single source sustained past the span window qualifies (with three callers)");
  ok(!clusterQualifies({ count: WISH_THRESHOLD, sources: src({ api: 5 }), firstSeen: T, lastSeen: T + QUALIFY_MIN_SPAN_MS - 1, callers: callers(3) }),
    "single source just under the span window does not qualify");
}


// --- find-miss dedupe per caller per day + served floor ---------------------
{
  freshFile("find-miss-dedupe");
  const a = recordWish({ need: "translate english to spanish", source: "find-miss", ip: "203.0.113.9" });
  const b = recordWish({ need: "translate english to spanish", source: "find-miss", ip: "203.0.113.9" });
  const c = recordWish({ need: "translate english to spanish", source: "find-miss", ip: "198.51.100.4" });
  ok(a.recorded === true && b.recorded === false && /duplicate/.test(b.reason) && c.recorded === true,
    "the same caller re-running the same query the same day records ONE find-miss; a different caller records another");
  const row = getWishesAggregate({ detailed: true }).clusters[0];
  ok(row.count === 2 && row.callers === 2, `the cluster counts 2 signals from 2 callers, not 3 (got count=${row.count} callers=${row.callers})`);
  const h1 = callerHash("203.0.113.9", Date.UTC(2026, 7, 27, 1)), h2 = callerHash("203.0.113.9", Date.UTC(2026, 7, 28, 1));
  ok(h1 !== h2 && h1.length === 12 && !/203/.test(h1), "callerHash is day-scoped, short, and carries no address bytes");
  // Keyed: a different secret yields a different fingerprint, and no secret
  // yields none at all (no unkeyed hash ever reaches the file).
  const saved = process.env.WISH_CALLER_SALT;
  process.env.WISH_CALLER_SALT = "another-secret";
  const h3 = callerHash("203.0.113.9", Date.UTC(2026, 7, 27, 1));
  process.env.WISH_CALLER_SALT = ""; process.env.POW_SECRET = "";
  const h4 = callerHash("203.0.113.9", Date.UTC(2026, 7, 27, 1));
  process.env.WISH_CALLER_SALT = saved;
  ok(h3 !== h1 && h4 === null, "callerHash is keyed by the secret (different secret, different hash; no secret, null)");
  process.env.WISH_CALLER_SALT = ""; process.env.POW_SECRET = "";
  const anon = recordWish({ need: "translate english to spanish", source: "find-miss", ip: "192.0.2.77" });
  process.env.WISH_CALLER_SALT = saved;
  ok(anon.recorded === true && getWishesAggregate({ detailed: true }).clusters[0].callers === 2, "with no secret a find-miss still records but credits no caller (count grows, callers do not)");
  // An explicit wish from the same caller is a different source and still counts.
  const d = recordWish({ need: "translate english to spanish", source: "api", ip: "203.0.113.9" });
  ok(d.recorded === true && getWishesAggregate({ detailed: true }).clusters[0].count === 4, "an explicit api wish from that caller still records (dedupe is find-miss only)");
  // The floor still decides whether a match is worth REPORTING; it no longer
  // decides whether the catalog "serves" the wish. That verdict is gone: the
  // resolver scores name similarity, not whether a tool answers a need, and on
  // the live board it marked fx-historical (foreign exchange) as serving
  // "historical technical evidence website" and image-dominant-color as
  // serving a url-metadata request at a score of 98.3.
  const rows = [{ text: "todo task manager" }, { text: "extract tables from pdf" }];
  annotateServed(rows, (t) => (t.startsWith("todo") ? { slug: "fund-report", score: 5 } : { slug: "pdf-extract-pages", score: 75 }), WISH_SERVED_MIN_SCORE);
  ok(!rows[0].closestMatch, `a score-5 match is below WISH_SERVED_MIN_SCORE (${WISH_SERVED_MIN_SCORE}) and is not reported at all`);
  ok(rows[1].closestMatch?.slug === "pdf-extract-pages" && rows[1].closestMatch.score === 75, "a strong match is reported with its score so the reader can judge it");
  ok(!rows[0].served && !rows[1].served, "no cluster is marked served: the annotation reports evidence, never a verdict");
}

// --- qualification, end-to-end through recordWish + getWishesAggregate ---
{
  // A single-source burst to the threshold in one sitting: recorded and
  // counted, but the aggregate marks it unqualified so the workflow skips it.
  freshFile("qualify-burst");
  for (let i = 0; i < WISH_THRESHOLD; i++) {
    recordWish({ need: "synthora mesh 962 m2m services", source: "api", ip: `10.0.9.${i}` });
  }
  let agg = getWishesAggregate({ detailed: true });
  let row = agg.clusters.find((c) => c.text.includes("synthora"));
  ok(row && row.count >= WISH_THRESHOLD && row.qualified === false,
    `single-source burst is recorded but unqualified (got ${JSON.stringify(row)})`);
  ok(agg.qualifyMinSpanHours === QUALIFY_MIN_SPAN_MS / 3_600_000, "aggregate advertises the span window in hours");

  // The same count spread across two surfaces qualifies.
  freshFile("qualify-multisource");
  recordWish({ need: "real gap tool", source: "api", ip: "10.0.10.1" });
  recordWish({ need: "real gap tool", source: "api", ip: "10.0.10.2" });
  recordWish({ need: "real gap tool", source: "mcp", ip: "10.0.10.3" });
  recordWish({ need: "real gap tool", source: "find-miss", ip: "10.0.10.4" });
  recordWish({ need: "real gap tool", source: "find-miss", ip: "10.0.10.5" });
  agg = getWishesAggregate({ detailed: true });
  row = agg.clusters.find((c) => c.text.includes("real gap tool"));
  ok(row && row.count === WISH_THRESHOLD && row.qualified === true,
    `multi-source demand at threshold qualifies (got ${JSON.stringify(row)})`);
}

// --- file-line cap: accept + count clusters, stop appending raw lines, never crash ---
{
  freshFile("filecap");
  __testSetLineCap(3);
  try {
    for (let i = 0; i < 5; i++) {
      const r = recordWish({ need: `capped need ${i}`, source: "api", ip: `10.0.4.${i}` });
      ok(r.recorded === true, `recordWish never throws once the file cap is hit (call ${i})`);
    }
  } finally {
    __testSetLineCap(); // restore default for later sections
  }
  const state = __testState();
  ok(state.lineCount === 3 && state.capReached === true, `file cap stops raw appends at 3 lines (got lineCount=${state.lineCount}, capReached=${state.capReached})`);
  const agg = getWishesAggregate({ detailed: true });
  ok(agg.distinctClusters === 5, `clusters still tracked in memory past the file cap (got ${agg.distinctClusters})`);
}

// --- /api/wishes aggregate: shape + no raw context + esc'd text ---
{
  freshFile("aggregate-shape");
  recordWish({ need: "<script>alert(1)</script> pdf splitter", context: "super secret internal detail", source: "api", ip: "10.0.5.1" });
  const agg = getWishesAggregate({ detailed: true });
  const row = agg.clusters[0];
  const keys = Object.keys(row).sort();
  ok(JSON.stringify(keys) === JSON.stringify(["callers", "count", "firstSeen", "issueOpened", "lastSeen", "qualified", "sources", "text"]), `aggregate row has exactly the documented keys, no raw context (got ${keys.join(",")})`);
  ok(row.callers === 1 && !/10\.0\.5\.1/.test(JSON.stringify(agg)), "callers is a COUNT of day-scoped hashes; the address itself never reaches the board");
  ok(!("context" in row), "aggregate row never carries a raw context field");
  ok(row.text.includes("&lt;script&gt;") && !row.text.includes("<script>"), `aggregate text is esc()'d (got ${row.text})`);
  ok(typeof row.firstSeen === "string" && typeof row.lastSeen === "string" && !Number.isNaN(Date.parse(row.firstSeen)), "firstSeen/lastSeen are ISO timestamps");
}

// cleanup: best-effort remove every scratch file this run created.
for (const f of tmpFiles) {
  try { if (existsSync(f)) unlinkSync(f); } catch { /* best-effort */ }
}

// ---- served-overlay: a cluster the catalog can now answer is not demand ----
{
  const clusters = [
    { text: "minia2a", count: 25, qualified: true },
    { text: "quantum teleport tool", count: 7, qualified: true },
    { text: "broken&amp;query", count: 5 },
  ];
  const scores = { "minia2a": { slug: "a2a-card-fetch", score: 3 }, "quantum teleport tool": { slug: "hash", score: 1 } };
  const out = annotateServed(clusters, (t) => scores[t] || null, 3);
  ok(out[0].closestMatch?.slug === "a2a-card-fetch", "a match at or above the floor is reported");
  ok(!out[1].closestMatch, "a match below the floor is not reported");
  ok(!out[2].closestMatch, "no match leaves the cluster untouched");
  const throwing = annotateServed([{ text: "x" }], () => { throw new Error("boom"); }, 3);
  ok(throwing.length === 1 && !throwing[0].closestMatch, "a throwing scoreFn never breaks annotation");

  // The regression this fixes, stated as the live cases that exposed it. Each
  // of these scored well ABOVE the floor and was rendered to the operator as
  // "served - not outstanding demand", which deleted a real demand signal.
  // Reporting the score instead is what lets a reader tell 109 from 47.
  const wrong = [
    [{ text: "historical technical evidence website" }, { slug: "fx-historical", score: 47 }],
    [{ text: "index url metadata api at example" }, { slug: "image-dominant-color", score: 98 }],
    [{ text: "idempotency replay protection" }, { slug: "skill-brand-protection", score: 45 }],
  ];
  for (const [row, top] of wrong) {
    annotateServed([row], () => top, WISH_SERVED_MIN_SCORE);
    ok(!row.served, `"${row.text.slice(0, 28)}" is never claimed as served by ${top.slug}`);
    ok(row.closestMatch?.score === top.score, "its score is carried so a reader can judge the match");
  }

  // A high score must not become a verdict by another name: nothing in the
  // annotation may set `served`, at any score.
  const strong = [{ text: "convert us gallons to liters" }];
  annotateServed(strong, () => ({ slug: "unit-convert", score: 109 }), WISH_SERVED_MIN_SCORE);
  ok(!strong[0].served && strong[0].closestMatch.score === 109,
    "even an obviously correct match is reported as evidence rather than asserted as served");
}


// --- find-miss volume bound: floodable board, without breaking search --------
// find-miss is exempt from the explicit-wish 429 on purpose (a legitimate
// /api/find miss must not fail the caller's search), but it was also exempt from
// any VOLUME bound, so one rotating client could fill the 20k cluster cap in
// ~34 hours and every genuinely new demand signal after that is dropped.
{
  __testReset();
  const IP = "203.0.113.9";
  let recorded = 0, skipped = 0, threw = 0;
  for (let i = 0; i < 80; i++) {
    try {
      const r = recordWish({ need: `novel unmatched capability number ${i}`, source: "find-miss", ip: IP });
      if (r.recorded) recorded++; else skipped++;
    } catch { threw++; }
  }
  ok(threw === 0, "a find-miss flood NEVER throws - a search must not fail because the board is busy");
  ok(recorded > 0 && recorded <= 60, `find-miss recording is bounded per IP per hour (recorded ${recorded} of 80)`);
  ok(skipped >= 20, `over-limit misses are dropped rather than recorded (skipped ${skipped})`);

  // A different IP still gets its own allowance: the bound is per source, not global.
  const other = recordWish({ need: "a different clients unmatched need", source: "find-miss", ip: "198.51.100.4" });
  ok(other.recorded === true, "the bound is per IP - a second client is unaffected");

  // And it must not consume the EXPLICIT wish allowance, which is a separate bucket.
  const explicit = recordWish({ need: "an explicit request typed by an agent", source: "api", ip: IP });
  ok(explicit.recorded === true, "a find-miss flood does not consume the explicit-wish allowance");
}


// --- confidentiality: what the public may learn about the demand board -------
//
// THIS BLOCK NEVER RAN. It sat below `process.exit()`, so it was unreachable,
// and it called a `__resetWishes` that does not exist with a positional
// signature recordWish has never had - it would have thrown on its first line
// if it had ever executed. The regression guard for the 2026-07-21 lockdown
// was, in effect, a comment. Moved above the summary and rewritten against the
// real API.
{
  freshFile("confidentiality");
  for (let i = 0; i < 6; i++) {
    recordWish({ need: `secret sauce tool ${i % 2}`, source: "find-miss", ip: `10.0.9.${i}` });
  }
  const pub = getWishesAggregate(); // default detailed:false
  ok(pub.clusters === undefined, "public aggregate exposes NO per-cluster array");
  ok(typeof pub.qualifiedClusters === "number", "public aggregate exposes qualified COUNT (beacon)");
  ok(typeof pub.totalWishes === "number" && typeof pub.distinctClusters === "number", "public aggregate keeps headline totals");
  ok(!JSON.stringify(pub).includes("secret sauce"), "public aggregate leaks no wish text");
  const det = getWishesAggregate({ detailed: true });
  ok(Array.isArray(det.clusters) && det.clusters.length > 0, "detailed aggregate still returns the itemized board");

  // The WRITE path must not answer what the read path refuses to answer. The
  // response is an acknowledgement: no count, no text, nothing that says how
  // hot the cluster is. Asserted on a cluster with a known non-trivial count,
  // so a leak would have something to leak.
  const hot = recordWish({ need: "secret sauce tool 0", source: "api", ip: "10.0.9.99" });
  ok(hot.recorded === true, "an explicit wish on an existing cluster is still recorded");
  const raw = JSON.stringify(hot);
  ok(!/\d/.test(raw), `the write response carries no number at all (got ${raw})`);
  ok(hot.cluster === undefined, "the write response exposes no cluster object");
  ok(getWishesAggregate({ detailed: true }).clusters.some((c) => c.count >= 4),
    "…while the token-gated board still knows the real count (so the assertion above had something to hide)");
}


// --- the board is an instrument, not an archive ------------------------------
// 199 of 200 rows on the live board were pre-fingerprint and could never
// qualify, 98 of them one scripted sweep seventeen days old. They sat at the
// TOP on accumulated hits, which is where the eye goes.
//
// The old rows are written to the journal with old timestamps and the module
// is rebuilt from it, so this drives the real load path rather than reaching
// into memory.
{
  const f = join(tmpdir(), `wish-stale-${process.pid}-${Date.now()}.jsonl`);
  tmpFiles.push(f);
  const old = Date.now() - (WISH_STALE_DAYS + 5) * 86_400_000;
  const lines = [];
  for (let i = 0; i < 8; i++) lines.push(JSON.stringify({ need: "ancient heavy demand", source: "api", ts: old, caller: `c${i}` }));
  lines.push(JSON.stringify({ need: "asked for today", source: "find-miss", ts: Date.now(), caller: "fresh1" }));
  writeFileSync(f, lines.join("\n") + "\n");
  __testSetFilePath(f);

  const board = getWishesAggregate({ detailed: true });
  const texts = board.clusters.map((r) => r.text);
  ok(texts.includes("asked for today"), "a cluster asked for today is on the board");
  ok(!texts.includes("ancient heavy demand"), "a cluster nobody has asked for inside the window is HIDDEN, however many hits it accumulated");
  ok(board.staleHidden === 1, "the number of hidden rows is STATED, so the omission is visible rather than a silent trim");
  ok(board.staleDays === WISH_STALE_DAYS, "the window is published with the board");
  ok(board.distinctClusters === 2 && board.liveClusters === 1, "the total still counts everything - hiding is a view, never a deletion");
  ok(board.totalWishes === 9, "and every signal is still counted, including the hidden cluster's");
  ok(getWishesAggregate({ detailed: false }).distinctClusters === 2, "the public beacon's totals are unchanged by the view filter");
}

// The operator board annotates up to 500 clusters, one catalog search each.
// The async form must give the same annotations and hand the loop back
// between clusters instead of holding it for the whole board.
{
  const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } };
  const scoreFn = (t) => { busy(2); return { slug: `tool-${t.length}`, score: t.length % 2 ? 60 : 1 }; };
  const mk = () => Array.from({ length: 60 }, (_, i) => ({ text: "wish ".repeat(1 + (i % 7)).trim() }));
  const syncRows = annotateServed(mk(), scoreFn, 45);
  let worst = 0, last = performance.now(), live = true;
  const tick = () => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; if (live) setImmediate(tick); };
  setImmediate(tick);
  const t0 = performance.now();
  const asyncRows = await annotateServedAsync(mk(), scoreFn, 45);
  const total = performance.now() - t0;
  // The gap since the ticker last ran counts too: a loop that never yields
  // starves the ticker entirely, and without this it would score 0 ms.
  worst = Math.max(worst, performance.now() - last);
  live = false;
  ok(JSON.stringify(asyncRows) === JSON.stringify(syncRows), "the async annotator writes exactly what the sync one does");
  ok(total > 100 && worst < 40, `the async annotator yields while it works (longest hold ${worst.toFixed(1)} ms over ${total.toFixed(0)} ms)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

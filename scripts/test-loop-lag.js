// The lag monitor must MEASURE a real block and stay cheap enough to leave on.
//
// It exists because a CONNECT timeout is a timer firing: a blocked event loop is
// indistinguishable from an unreachable upstream from inside the process, and on
// 2026-08-30 seven CDP verifies failed that way while CDP answered from outside
// in 15-37 ms. We had instrumented BOOT only, so a stall hours into a container
// was invisible. These pin that it actually catches one.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { strict as assert } from "node:assert";
import { startLoopLagMonitor, loopLagStatus, resetLoopLag } from "../src/loop-lag.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const blockFor = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* deliberate */ } };

resetLoopLag();
ok(loopLagStatus().watching === false, "not watching before it is started");

const lines = [];
const stop = startLoopLagMonitor({ tickMs: 50, warnMs: 200, log: (m) => lines.push(m) });
ok(loopLagStatus().watching === true, "watching once started");

await sleep(200);
const quiet = loopLagStatus();
ok(quiet.stalls === 0, `an idle loop records no stall (worst ${quiet.worstMs}ms)`);

blockFor(600);            // the thing a connect timeout would blame on the network
await sleep(150);
const after = loopLagStatus();
ok(after.stalls >= 1, `a 600ms block is recorded as a stall (${after.stalls})`);
ok(after.worstMs >= 400, `and the measured lag is of the right order (${after.worstMs}ms)`);
ok(after.lastStallAt !== null, "the stall carries a timestamp, so it can be matched to a failed payment");
ok(lines.some((l) => /event loop blocked \d+ms/.test(l)), "it logs the number, not just that something happened");
ok(lines.some((l) => /connect timeouts/.test(l)), "and says why that matters, for whoever reads the log next");
// The collector's share of the worst block is read with it: a pause inside
// the block counts, one outside it does not.
{
  const { noteGcEntry } = await import("../src/loop-lag.js");
  // The runtime's own pauses inside the spin are already counted; ours add to them.
  const base = loopLagStatus().worstGcMs;
  ok(base >= 0 && base <= after.worstMs, `the collector share is part of the block (${base}ms of ${after.worstMs}ms)`);
  const at = Date.parse(after.worstAt);
  noteGcEntry(at - 300, 150, 4);
  noteGcEntry(at - 60_000, 900, 4);
  const withGc = loopLagStatus();
  ok(withGc.worstGcMs === Math.min(after.worstMs, base + 150) && withGc.worstMs === after.worstMs, `a pause inside the worst block adds to its collector share, one outside it does not (${base} -> ${withGc.worstGcMs}ms of ${withGc.worstMs}ms)`);
}

// Many short pauses inside one window all count, and later pauses never evict
// them (a 256-entry ring did: a CI spin's scavenges filled it, 160 read 159).
{
  const { noteGcEntry, gcDuring } = await import("../src/loop-lag.js");
  const w0 = Date.now() - 5_000;
  for (let i = 0; i < 300; i++) noteGcEntry(w0 + i * 2, 1, 1);
  const full = gcDuring(w0, w0 + 1_000);
  noteGcEntry(Date.now(), 1, 1); noteGcEntry(Date.now(), 1, 1);
  const later = gcDuring(w0, w0 + 1_000);
  ok(full.count === 300 && full.ms === 300 && later.ms === 300, `300 pauses in one window are all counted, and later pauses evict none (${full.ms} -> ${later.ms}ms)`);
}

resetLoopLag();
ok(loopLagStatus().worstMs === 0 && loopLagStatus().worstGcMs === 0 && loopLagStatus().stalls === 0, "reset clears the high-water mark and its collector share");

stop();
ok(loopLagStatus().watching === false, "stops cleanly");

// Cheap enough to leave on forever: one unref'd interval, no per-tick allocation.
const src = await (await import("node:fs/promises")).readFile(new URL("../src/loop-lag.js", import.meta.url), "utf8");
ok(/unref\(\)/.test(src), "the timer is unref'd, so a diagnostic never holds the process open");
ok((src.match(/setInterval/g) || []).length === 1, "exactly one timer");

// GC attribution: a stall line says how much of the block was collection, so a
// freeze reads as "our code" or "the collector" without a profiler.
{
  const { noteGcEntry, gcDuring, gcPhrase } = await import("../src/loop-lag.js");
  const t0 = 1_000_000_000_000;
  noteGcEntry(t0 + 100, 1500, 4);   // a major pause inside the window
  noteGcEntry(t0 + 1700, 40, 1);    // a minor one inside it
  noteGcEntry(t0 - 10_000, 900, 4); // long before the stall: not counted
  const g = gcDuring(t0, t0 + 2000);
  ok(g.ms === 1540 && g.majorMs === 1500 && g.count === 2, `GC inside the stall window is summed, major split out (${JSON.stringify(g)})`);
  const edge = gcDuring(t0 + 1000, t0 + 1200);
  ok(edge.ms === 200, `a pause straddling the window counts only its overlap (${edge.ms})`);
  ok(/gc: 1540ms over 2 pauses \(major 1500ms\)/.test(gcPhrase(2000, t0 + 2000 - 50 + 50)), `the phrase names the GC share (${gcPhrase(2000, t0 + 2000)})`);
  ok(gcPhrase(500, t0 + 50_000) === " gc: none", "a window with no pause says so instead of staying silent");
  ok(/gc=\$\{Math\.round\(gcMinute\.ms\)\}ms/.test(src) && /gcPhrase\(late, now\)/.test(src), "the minute line and the stall line both carry it");
}

// TURNS NAMED: a stall inside a contained() callback (a crawl slice, the
// route-index shadow build) names the turn and how long its synchronous part
// ran, on the [loop-lag] line and in the stall ring; a timed span inside a
// turn (the crawl's manifest passes, the shadow finish) is named the same way.
{
  const { contained } = await import("../src/contained-turn.js");
  const { turnsDuring, timeSpan, noteTurn, TURN_NOTE_MS, _resetTurnsForTest } = await import("../src/active-jobs.js");
  const { recentStalls } = await import("../src/loop-lag.js");
  _resetTurnsForTest();
  resetLoopLag();
  const turnLines = [];
  const stop2 = startLoopLagMonitor({ tickMs: 50, warnMs: 200, log: (m) => turnLines.push(m) });
  await sleep(120);
  setTimeout(contained("index-crawl-cycle", () => { timeSpan("crawl-manifest-passes seller.example", () => blockFor(300)); blockFor(150); }), 0);
  await sleep(400);
  stop2();
  const line = turnLines.find((l) => /event loop blocked/.test(l)) || "";
  const m = / turns: (.*)$/.exec(line);
  ok(!!m, `the stall line carries a turns: field (${line})`);
  const named = m ? m[1].split(", ") : [];
  const turnMs = Number(/^index-crawl-cycle (\d+)ms$/.exec(named.find((x) => x.startsWith("index-crawl-cycle ")) || "")?.[1]);
  const spanMs = Number(/^crawl-manifest-passes seller\.example (\d+)ms$/.exec(named.find((x) => x.startsWith("crawl-manifest-passes ")) || "")?.[1]);
  ok(turnMs >= 400 && turnMs < 2000, `it names the contained turn with its synchronous time (${turnMs}ms)`);
  ok(spanMs >= 280 && spanMs < turnMs, `and the span inside it with its own (${spanMs}ms)`);
  ok(named[0]?.startsWith("index-crawl-cycle "), "longest first");
  ok(recentStalls()[0]?.turns?.some((t) => t.startsWith("index-crawl-cycle ")), "the stall ring keeps the turns too");
  // Short turns are not kept; old ones fall outside a later window.
  _resetTurnsForTest();
  noteTurn("tiny", Date.now(), TURN_NOTE_MS - 1);
  noteTurn("old", Date.now() - 60_000, 500);
  ok(turnsDuring(Date.now() - 1000, Date.now()).length === 0, "a turn under TURN_NOTE_MS or outside the window is not named");
  // A turn's throw is still contained, and still timed.
  _resetTurnsForTest();
  const at0 = Date.now();
  contained("thrower", () => { blockFor(40); throw new Error("x"); })();
  ok(turnsDuring(at0 - 10, Date.now()).some((t) => t.startsWith("thrower ")), "a turn that throws is timed as well");
  // A full collection's marking is named: its steps run inside whichever turn
  // allocates and no gc entry reports them, so a block inside the window from
  // the marking's start to the pause that ends it says `gc-marking`.
  {
    const { noteGcEntry, markingDuring } = await import("../src/loop-lag.js");
    const t = Date.now() + 500_000; // clear of every entry noted above
    ok(markingDuring(t, t + 400) === false, "control: with no marking started a window names no marking");
    noteGcEntry(t + 100, 0, 8);
    ok(markingDuring(t + 150, t + 600) === true && markingDuring(t, t + 120) === true, "a window after a full collection's marking started, with no pause ending it yet, names the marking");
    ok(markingDuring(t, t + 90) === false, "a window that ended before the marking started does not");
    noteGcEntry(t + 700, 40, 4);
    ok(markingDuring(t + 650, t + 720) === true && markingDuring(t + 741, t + 900) === false, "the marking ends at the pause that closes it: a later window names none");
    noteGcEntry(t + 800, 5, 1);
    ok(markingDuring(t + 790, t + 900) === false, "a young collection is not marking");
    const lag = await (await import("node:fs/promises")).readFile(new URL("../src/loop-lag.js", import.meta.url), "utf8");
    ok(/if \(markingDuring\(now - late - 50, now\)\) turns = \[\.\.\.turns, "gc-marking"\];/.test(lag), "the stall line and the stall ring carry gc-marking among the turns");
  }
  // Three named turns and the marking: the ring keeps all four, the marking included.
  {
    const { recordStall, recentStalls, noteGcEntry } = await import("../src/loop-lag.js");
    const row = recordStall({ ms: 300, turns: ["a 90ms", "b 80ms", "c 70ms", "gc-marking"] });
    ok(row.turns.length === 4 && row.turns[3] === "gc-marking" && recentStalls()[0].turns.includes("gc-marking"), `a stall with three named turns and the marking keeps the marking (${row.turns.join(", ")})`);
    // Through the monitor: three turns of our own inside a stall while a full collection marks.
    _resetTurnsForTest();
    resetLoopLag();
    const marked = [];
    const stop3 = startLoopLagMonitor({ tickMs: 50, warnMs: 200, log: (m) => marked.push(m) });
    await sleep(120);
    setTimeout(() => {
      noteGcEntry(Date.now(), 0, 8); // a full collection's marking starts, no pause ends it yet
      contained("turn-one", () => blockFor(90))(); contained("turn-two", () => blockFor(80))(); contained("turn-three", () => blockFor(70))();
    }, 0);
    await sleep(400);
    stop3();
    noteGcEntry(Date.now(), 1, 4); // and ends, so later windows name no marking
    const ring = recentStalls()[0]?.turns || [];
    ok(["turn-one ", "turn-two ", "turn-three "].every((n) => ring.some((t) => t.startsWith(n))) && ring.includes("gc-marking"), `through the monitor the ring keeps the three turns and the marking (${ring.join(", ")})`);
  }
  // The index wires the two spans the crawl stalls pointed at.
  const idx = await (await import("node:fs/promises")).readFile(new URL("../src/x402-index.js", import.meta.url), "utf8");
  // Each pass takes a crawl-lane turn of its own and is timed as a span named
  // with the seller's host (scripts/test-crawl-cycle-turns.js bounds the turns).
  // A pass over a long list runs as lane steps instead (stepsPass): its whole
  // form is the same manifestPass, and a long slice of its steps is recorded
  // under the walk's name.
  const passStart = idx.indexOf("const passSpan = `crawl-manifest-passes ${hostOfOriginForSpan(originUrl)}`;");
  const passEnd = idx.indexOf("const x402Listed = x402ListedRoutes(manifestRows);");
  const passes = passStart > 0 && passEnd > passStart ? idx.slice(passStart, passEnd) : "";
  ok(/const manifestPass = async \(fn\) => \{ await crawlLaneTurn\(\); return laneSpan\(passSpan, fn\); \};/.test(passes) && passes.includes("manifestPass(() => mergeManifestIntoTools("), "the crawl's manifest passes are timed as spans named with the seller's host");
  ok(/const stepsPass = \(name, rows, steps, whole\) => \(rows > FALLBACK_PASS_TURN_ROWS\s*\? crawlWalkLaned\(name, \{ origin: originUrl, doc: `\$\{rows\}-rows` \}, steps\(\)\)\s*: manifestPass\(whole\)\);/.test(passes)
    && /await stepsPass\("stamp", tools\.length,\s*\(\) => stampDeclaredSteps\([^\n]*\),\s*\(\) => stampDeclared\(/.test(passes)
    && /await stepsPass\("carry", tools\.length,\s*\(\) => carryForwardLearnedQuotesSteps\(tools, prev\),\s*\(\) => carryForwardLearnedQuotes\(tools, prev\)\);/.test(passes),
    "the stamp and carry passes run whole as such a span, or over a long list as lane steps");
  ok(/noteTurn\(`crawl-walk \$\{name\}`, Date\.now\(\) - d, d\);/.test(idx.slice(idx.indexOf("async function crawlWalkLaned("), idx.indexOf("const laneSpan = "))), "a long slice of a laned walk is recorded under the walk's name");
  ok(/finally \{\s*noteTurn\("route-index-shadow-finish", finishAt, performance\.now\(\) - finishT0\);/.test(idx), "the shadow build's unsliced finish is timed as its own span");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

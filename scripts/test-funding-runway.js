#!/usr/bin/env node
// The funding runway's early word (src/funding-runway.js).
//
// A trail whose fitted spend crosses the alarm line within FUNDING_RUNWAY_DAYS
// reads "low-soon"; a flat or rising trail reads "ok"; too few readings or too
// short a span reads "unknown" (neither healthy nor an alarm); a latest reading
// under the line reads "low". The word holds: in at the look-ahead, out only
// past the clear margin, so a wallet at the mark does not flap; one buy alone
// projects nothing; a top-up starts a new stretch and hides no spend. The
// low-water readers feed the trail from the
// read they already make (the Base wallet, a non-Base EVM chain, the Stellar
// facilitator: the caller path, not a planted call), a reader on every request
// keeps one reading per sample interval, the trail survives a new process
// through the store, and the word rides the operator view only. Offline.
//
//   node scripts/test-funding-runway.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.log(`FAIL - ${m}`); } };

delete process.env.FUNDING_RUNWAY_DAYS;
const R = await import("../src/funding-runway.js");
const { projectRunway, noteFundingReading, fundingRunwayStatus, runwayDays, worstRunwayWord, __resetFundingRunwayForTest, flushFundingRunway, RUNWAY_SAMPLE_MS, RUNWAY_CLEAR_FACTOR } = R;

const H = 3600_000;
const now = Date.UTC(2026, 10, 27, 12);
// One reading an hour for `hours`, from `start` changing by `perHour`.
const trail = (hours, start, perHour) => Array.from({ length: hours + 1 }, (_, i) => [now - (hours - i) * H, start + perHour * i]);

// Spend that reaches the line inside the window ahead.
{
  // 24 h falling 0.25 an hour (6 a day); latest 10, line 2: (10 - 2) / 6 = 1.3 days.
  const r = projectRunway(trail(24, 16, -0.25), 2, { now, days: 3 });
  ok(r.status === "low-soon", `a trail that crosses the line within 3 days reads low-soon (${r.status}, ${r.daysLeft} days)`);
  ok(Math.abs(r.spendPerDay - 6) < 0.01 && Math.abs(r.daysLeft - 1.3) < 0.05, `the fitted spend and the days left are the trail's (${r.spendPerDay}/day, ${r.daysLeft})`);
  const far = projectRunway(trail(24, 106, -0.25), 2, { now, days: 3 });
  ok(far.status === "ok" && far.daysLeft > 3, `the same spend with the line further off than 3 days reads ok (${far.daysLeft} days)`);
  ok(projectRunway(trail(24, 106, -0.25), 2, { now, days: 30 }).status === "low-soon", "a longer look ahead turns the same trail low-soon");
  // Noise around a falling line still reads the fall.
  const noisy = trail(24, 16, -0.25).map(([t, v], i) => [t, v + (i % 2 ? 0.3 : -0.3)]);
  ok(projectRunway(noisy, 2, { now, days: 3 }).status === "low-soon", "a noisy falling trail still reads low-soon");
}
// Flat or rising is healthy.
{
  const flat = projectRunway(trail(24, 5, 0), 2, { now, days: 3 });
  ok(flat.status === "ok" && flat.daysLeft === null && flat.spendPerDay === 0, `a flat trail reads ok with no days left figure (${flat.status})`);
  ok(projectRunway(trail(24, 5, 0.1), 2, { now, days: 3 }).status === "ok", "a rising trail reads ok");
  // A dip and a top-up inside the window: rising overall.
  const topped = [...trail(12, 4, -0.1).map(([t, v]) => [t - 12 * H, v]), ...trail(11, 20, -0.01)];
  ok(projectRunway(topped, 2, { now, days: 3 }).status === "ok", "a trail topped up inside the window reads ok");
}
// Too little to fit.
{
  ok(projectRunway([], 2, { now }).status === "unknown", "no readings reads unknown");
  const three = trail(24, 16, -0.25).filter((_, i) => i % 8 === 0).slice(0, 3);
  ok(projectRunway(three, 2, { now }).status === "unknown", `three readings read unknown, not ok and not low-soon (${projectRunway(three, 2, { now }).status})`);
  const short = Array.from({ length: 10 }, (_, i) => [now - (9 - i) * 30 * 60_000, 16 - i]);
  ok(projectRunway(short, 2, { now }).status === "unknown", "ten readings over four and a half hours read unknown (span too short)");
  ok(projectRunway(trail(24, 16, -0.25), NaN, { now }).status === "unknown", "no line reads unknown");
  const old = trail(24, 16, -0.25).map(([t, v]) => [t - 48 * H, v]);
  ok(projectRunway(old, 2, { now }).status === "unknown", "readings older than the window are not fitted");
}
// Already under the line: the alarm's word.
ok(projectRunway(trail(24, 7, -0.25), 2, { now }).status === "low", "a latest reading under the line reads low");
ok(worstRunwayWord(["ok", "unknown", "low-soon"]) === "low-soon" && worstRunwayWord(["ok", "unknown"]) === "unknown" && worstRunwayWord(["ok"]) === "ok" && worstRunwayWord([]) === "off", "the whole reads the worst word");

// FUNDING_RUNWAY_DAYS.
ok(runwayDays({}) === 3 && runwayDays({ FUNDING_RUNWAY_DAYS: "7" }) === 7 && runwayDays({ FUNDING_RUNWAY_DAYS: "-1" }) === 3 && runwayDays({ FUNDING_RUNWAY_DAYS: "x" }) === 3, "FUNDING_RUNWAY_DAYS defaults to 3 and ignores a bad value");

// The trail: one kept reading per sample interval, figures on the status.
{
  __resetFundingRunwayForTest();
  for (let i = 0; i <= 24; i++) {
    noteFundingReading("w", 16 - 0.25 * i, 2, { now: now - (24 - i) * H });
    noteFundingReading("w", 999, 2, { now: now - (24 - i) * H + 60_000 }); // inside the interval: dropped
  }
  const s = await fundingRunwayStatus({ now, days: 3 });
  ok(s.status === "low-soon" && s.wallets.w.readings === 25, `readings inside the sample interval are dropped and the trail reads low-soon (${s.wallets.w?.readings} readings)`);
  ok(s.warningOnly === true && s.days === 3, "the status says it is a warning only and how far it looks");
  ok(RUNWAY_SAMPLE_MS >= 60_000, "the sample interval is at least a minute");
  noteFundingReading("bad", NaN, 2, { now });
  noteFundingReading("", 5, 2, { now });
  ok(!("bad" in (await fundingRunwayStatus({ now })).wallets), "a reading that is not a number is not kept");
}

// The trail outlives the process through the store.
{
  let stored = null;
  const fake = {
    backend: "pg",
    async read() { return { ok: true, exists: stored != null, body: stored }; },
    async update(mutate) { const next = mutate(stored); stored = next; return { ok: true, body: next }; },
  };
  __resetFundingRunwayForTest({ doc: fake });
  for (let i = 0; i <= 24; i++) noteFundingReading("kept", 16 - 0.25 * i, 2, { now: now - (24 - i) * H });
  await flushFundingRunway();
  ok(stored?.wallets?.kept?.samples?.length === 25, `the store holds the trail (${stored?.wallets?.kept?.samples?.length})`);
  __resetFundingRunwayForTest({ doc: fake }); // a new process, same store
  const s = await fundingRunwayStatus({ now, days: 3 });
  ok(s.wallets.kept?.status === "low-soon" && s.wallets.kept.readings === 25, `a new process reads the stored trail (${s.wallets.kept?.status})`);
  const hung = { backend: "pg", read: () => new Promise(() => {}), update: () => new Promise(() => {}) };
  __resetFundingRunwayForTest({ doc: hung });
  const keep = setInterval(() => {}, 1000); // the bound's timer is unref'd; hold the process while it runs
  const t0 = Date.now();
  noteFundingReading("h", 5, 2, { now });
  const hs = await fundingRunwayStatus({ now });
  clearInterval(keep);
  ok(Date.now() - t0 < 4000 && hs.wallets.h?.status === "unknown", "a store that never answers holds neither the reader nor the status past its bound");
}

// The word holds near the mark. A wallet spending 1 a day over a line of 6,
// topped back up every 12 hours so its runway stays near 3 days, each reading
// off by up to 0.05, one reading per 30 minutes for 4 days: through the
// readers' own path (note, then status) the word changes at most once.
{
  const t0 = Date.UTC(2026, 10, 20);
  const walk = async (balanceAt, readings, seed) => {
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    __resetFundingRunwayForTest();
    let flips = 0, prev = null, last = null; const seen = new Set();
    for (let i = 0; i < readings; i++) {
      const t = t0 + i * H / 2;
      noteFundingReading("w", balanceAt(i) + (rnd() - 0.5) * 0.1, 6, { now: t });
      const w = (await fundingRunwayStatus({ now: t, days: 3 })).wallets.w.status;
      if (prev && prev !== "unknown" && w !== prev) flips++;
      prev = w; last = w; seen.add(w);
    }
    await flushFundingRunway();
    return { flips, last, seen };
  };
  const sawtooth = (top) => (i) => top - ((i % 24) / 48);
  let worst = 0, total = 0, runs = 0;
  const ends = { at: new Set(), under: new Set(), over: new Set() };
  for (const seed of [9, 5, 77, 1234, 3]) {
    for (const [name, top] of [["at", 9.5], ["over", 10], ["under", 9]]) {
      const r = await walk(sawtooth(top), 192, seed);
      worst = Math.max(worst, r.flips); total += r.flips; runs++;
      ends[name].add(r.last);
      if (name === "over") for (const w of r.seen) ends.over.add(w);
    }
  }
  ok(worst <= 1, `a wallet held near the mark changes word at most once in 4 days (most changes in one run: ${worst}; ${total} over ${runs} runs)`);
  ok([...ends.under].join() === "low-soon", `a wallet held at 2.5 days of runway settles on low-soon (${[...ends.under].join()})`);
  ok(!ends.over.has("low-soon"), `a wallet held at 3.5 to 4 days of runway never reads low-soon (${[...ends.over].join()})`);
  // A drain with no top-up crosses the mark once and stays until the line.
  const drain = await walk((i) => 12 - i / 48, 280, 9);
  ok(drain.flips === 1 && drain.last === "low-soon" && drain.seen.has("ok"), `a steady drain turns low-soon once and holds it (${drain.flips} changes, ends ${drain.last})`);
}
// One buy alone is not a trend.
{
  __resetFundingRunwayForTest();
  // Flat at 10 for 22 hours, one buy of 1.5 two hours ago, line 6, then nothing more.
  const at = (i) => now - (48 - i) * H / 2;
  for (let i = 0; i < 48; i++) noteFundingReading("one", i < 44 ? 10 : 8.5, 6, { now: at(i) });
  const first = (await fundingRunwayStatus({ now, days: 3 })).wallets.one;
  let soonHours = first.status === "low-soon" ? 0.5 : 0;
  for (let i = 1; i <= 60; i++) {
    noteFundingReading("one", 8.5, 6, { now: now + i * H / 2 });
    if ((await fundingRunwayStatus({ now: now + i * H / 2, days: 3 })).wallets.one.status === "low-soon") soonHours += 0.5;
  }
  await flushFundingRunway(); // queued writes end before the next block swaps the store
  ok(first.status === "ok" && soonHours === 0, `one isolated buy on a flat trail never reads low-soon (${first.status} at the buy, low-soon for ${soonHours} h after)`);
  // Control: the same amount spent as a trend (a buy every 4 hours) does.
  const steps = Array.from({ length: 49 }, (_, i) => [now - (48 - i) * H / 2, 10 - 0.25 * Math.floor(i / 8)]);
  const st = projectRunway(steps, 6, { now, days: 3 });
  ok(st.status === "low-soon" && st.spendPerDay > 1, `control: the same spend spread across the window reads low-soon (${st.status}, ${st.spendPerDay}/day)`);
  // A steady drain is seen as early as before: one reading an hour, 6 hours of span.
  let firstFit = null;
  for (let n = 2; n <= 12 && firstFit == null; n++) {
    const r = projectRunway(Array.from({ length: n }, (_, i) => [now - (n - 1 - i) * H, 10 + 0.25 * (n - 1 - i)]), 2, { now, days: 3 });
    if (r.status !== "unknown") firstFit = { n, status: r.status };
  }
  ok(firstFit && firstFit.status === "low-soon" && firstFit.n <= 8, `a steady drain reads low-soon within a reading of the seven it took before (${firstFit?.n} readings, ${firstFit?.status})`);
}
// In at the look-ahead, out only past the margin.
{
  ok(RUNWAY_CLEAR_FACTOR >= 1.25, `the clear margin is well past the look-ahead (${RUNWAY_CLEAR_FACTOR}x)`);
  // 6 a day; latest 23, line 2: 3.5 days. Latest 32: 5 days.
  const near = trail(24, 29, -0.25), clear = trail(24, 38, -0.25);
  const fresh = projectRunway(near, 2, { now, days: 3 }), held = projectRunway(near, 2, { now, days: 3, wasSoon: true });
  ok(fresh.status === "ok" && held.status === "low-soon" && held.daysLeft === 3.5, `between the look-ahead and the margin a wallet keeps the word it had (fresh ${fresh.status}, held ${held.status}, ${held.daysLeft} days)`);
  ok(projectRunway(clear, 2, { now, days: 3, wasSoon: true }).status === "ok", "past the margin a held low-soon clears");
  // The held word lives with the trail: status after status, and in a new process.
  let stored = null;
  const fake = { backend: "pg", async read() { return { ok: true, body: stored }; }, async update(m) { stored = m(stored); return { ok: true, body: stored }; } };
  __resetFundingRunwayForTest({ doc: fake });
  for (let i = 0; i <= 24; i++) noteFundingReading("h", 16 - 0.25 * i, 2, { now: now - (24 - i) * H }); // 1.3 days: low-soon
  // Topped up to 3.5 days of runway (not past the margin), the drain goes on.
  for (let i = 1; i <= 12; i++) noteFundingReading("h", 26 - 0.25 * i, 2, { now: now + i * H });
  await flushFundingRunway();
  const t1 = now + 12 * H;
  const s1 = await fundingRunwayStatus({ now: t1, days: 3 });
  ok(s1.wallets.h.status === "low-soon" && s1.wallets.h.daysLeft > 3 && s1.clearDays === 3 * RUNWAY_CLEAR_FACTOR, `a top-up short of the margin leaves low-soon held (${s1.wallets.h.status}, ${s1.wallets.h.daysLeft} days, clears past ${s1.clearDays})`);
  ok(stored.wallets.h.soon === true, "the held word is stored with the trail");
  __resetFundingRunwayForTest({ doc: fake });
  const s2 = await fundingRunwayStatus({ now: t1, days: 3 });
  ok(s2.wallets.h.status === "low-soon", `a new process holds the same word (${s2.wallets.h.status})`);
  noteFundingReading("h", 60, 2, { now: t1 + H }); // a top-up past the margin
  const s3 = await fundingRunwayStatus({ now: t1 + H, days: 3 });
  await flushFundingRunway();
  ok(s3.wallets.h.status === "ok" && s3.wallets.h.daysLeft > 4.5 && stored.wallets.h.soon === false, `a top-up past the margin clears it at that reading (${s3.wallets.h.status}, ${s3.wallets.h.daysLeft} days)`);
}
// A top-up starts a new stretch: it does not hide the spend around it.
{
  // 4 a day throughout; 20 added six hours ago.
  const at = (i) => now - (47 - i) * H / 2;
  const big = Array.from({ length: 48 }, (_, i) => [at(i), (i < 36 ? 8 : 28) - 4 * (i / 48)]);
  const r = projectRunway(big, 6, { now, days: 3 });
  ok(Math.abs(r.spendPerDay - 4) < 0.05 && r.daysLeft === 4.5 && r.status === "ok", `a top-up inside the window leaves the fitted spend as it was (${r.spendPerDay}/day, ${r.daysLeft} days, ${r.status})`);
  const small = Array.from({ length: 48 }, (_, i) => [at(i), (i < 36 ? 16 : 20) - 4 * (i / 48)]);
  const q = projectRunway(small, 6, { now, days: 3 });
  ok(q.status === "low-soon" && q.daysLeft < 3, `a top-up that buys under 3 days at that spend reads low-soon (${q.status}, ${q.daysLeft} days)`);
}

// A wallet nobody reads any more leaves the report and the stored document:
// its "unknown" must not hold the whole word after the window, nor come back
// from the store in a new process.
{
  let stored = null;
  const fake = {
    backend: "pg",
    async read() { return { ok: true, exists: stored != null, body: stored }; },
    async update(mutate) { const next = mutate(stored); stored = next; return { ok: true, body: next }; },
  };
  __resetFundingRunwayForTest({ doc: fake });
  for (let i = 0; i <= 24; i++) {
    noteFundingReading("base", 40, 6, { now: now - (24 - i) * H });
    noteFundingReading("evm:retired", 40, 2, { now: now - (24 - i) * H });
  }
  noteFundingReading("once", 9, 2, { now }); // read once, then never again
  await flushFundingRunway();
  const before = await fundingRunwayStatus({ now });
  ok(before.wallets["evm:retired"]?.status === "ok" && before.wallets.once?.status === "unknown" && before.status === "unknown", `control: while they are read, every wallet is on the report (${Object.keys(before.wallets).join(", ")})`);
  const later = now + 30 * H; // only "base" is still read
  for (let i = 0; i <= 24; i++) noteFundingReading("base", 40, 6, { now: later - (24 - i) * H });
  await flushFundingRunway();
  const a = await fundingRunwayStatus({ now: later });
  ok(!("evm:retired" in a.wallets) && !("once" in a.wallets), `a wallet with no reading inside the window is off the report (${Object.keys(a.wallets).join(", ")})`);
  ok(a.wallets.base?.status === "ok" && a.status === "ok", `the wallets still read report as before and the whole word returns to ok (${a.status})`);
  ok(stored && !("evm:retired" in stored.wallets) && !("once" in stored.wallets) && stored.wallets.base?.samples?.length > 0, `the stored document drops it on the next write (${Object.keys(stored?.wallets || {}).join(", ")})`);
  // A new process over a document that still holds one (written by a build
  // before the rule, or by a replica that stopped reading it).
  stored = { v: 1, wallets: { ...stored.wallets, "evm:retired": { line: 2, unit: "USD", samples: [[now - 2 * H, 40], [now - H, 40]] }, empty: { line: 2, unit: "USD", samples: [] } } };
  __resetFundingRunwayForTest({ doc: fake });
  const b = await fundingRunwayStatus({ now: later });
  await flushFundingRunway();
  ok(!("evm:retired" in b.wallets) && !("empty" in b.wallets) && b.wallets.base?.status === "ok" && b.status === "ok", `a new process does not load it back (${b.status}; ${Object.keys(b.wallets).join(", ")})`);
  ok(!("evm:retired" in stored.wallets) && !("empty" in stored.wallets) && "base" in stored.wallets, `the load deletes it from the stored document (${Object.keys(stored.wallets).join(", ")})`);
  // A wallet read again after a gap starts a fresh trail.
  noteFundingReading("evm:retired", 40, 2, { now: later + H });
  ok((await fundingRunwayStatus({ now: later + H })).wallets["evm:retired"]?.readings === 1, "a wallet read again is back on the report with a fresh trail");
}

// The caller path: the low-water readers feed the trail from their own read.
{
  __resetFundingRunwayForTest();
  process.env.X402_UPSTREAM_BUYER_KEY = "0x" + randomBytes(32).toString("hex");
  const U = await import("../src/upstream-buyer-status.js");
  U.__resetBuyerTrendForTest();
  U.__setBuyerBalanceReaderForTest(async () => 40);
  const base = await U.upstreamBuyerStatus();
  ok(base.status === "ok" && !("fundingRunway" in base), "the Base word is unchanged by the runway");
  let s = await fundingRunwayStatus();
  ok(s.wallets.base?.readings === 1, `the Base low-water read leaves one reading on the trail (${s.wallets.base?.readings})`);
  U.__resetEvmChainStatusForTest();
  await U.evmBuyerChainStatus("polygon", { readBalance: async () => 12 });
  s = await fundingRunwayStatus();
  ok(s.wallets["evm:polygon"]?.readings === 1, "a non-Base chain's low-water read leaves one reading on the trail");
  const { stellarFacilitatorStatus } = await import("../src/stellar-facilitator-status.js");
  process.env.STELLAR_FACILITATOR_URL = "http://127.0.0.1:1";
  const fetchImpl = async () => ({ ok: true, json: async () => ({ signerAddress: "GABC", xlmBalance: 40, low: false }) });
  const st = await stellarFacilitatorStatus({ fetchImpl });
  s = await fundingRunwayStatus();
  ok(st.status === "ok" && s.wallets["stellar-facilitator"]?.unit === "XLM", "the Stellar facilitator's read leaves a reading in XLM");
  const nullBal = async () => ({ ok: true, json: async () => ({ signerAddress: "GABC", xlmBalance: null, low: null }) });
  __resetFundingRunwayForTest();
  await stellarFacilitatorStatus({ fetchImpl: nullBal });
  ok(!("stellar-facilitator" in (await fundingRunwayStatus()).wallets), "an unreadable facilitator balance is not kept as zero");
  delete process.env.STELLAR_FACILITATOR_URL;
}

// Every low-water reader hands its figure over, and the word is operator only.
{
  const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  for (const [f, key] of [["upstream-buyer-status.js", "\"base\""], ["upstream-buyer-status.js", "`evm:${chain}`"], ["tempo-buyer.js", "\"tempo\""], ["x402-buyer.js", "\"algorand\""], ["solana-buyer.js", "\"solana\""], ["mpp-subscriptions.js", "\"subscription-sponsor\""], ["stellar-facilitator-status.js", "\"stellar-facilitator\""]]) {
    ok(src(f).includes(`noteFundingReading(${key}`), `${f} hands its ${key} reading to the runway`);
  }
  const server = src("server.js");
  ok(/\.\.\.\(full \? \{ fundingRunway: await fundingRunwayStatus\(\)/.test(server) && (server.match(/fundingRunway:/g) || []).length === 1, "/api/gateway-status carries fundingRunway on the operator view only");
  ok(!/fetch\(|rpc\(/.test(src("funding-runway.js")), "the runway makes no chain read of its own");
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

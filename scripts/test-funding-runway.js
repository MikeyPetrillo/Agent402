#!/usr/bin/env node
// The funding runway's early word (src/funding-runway.js).
//
// A trail whose fitted spend crosses the alarm line within FUNDING_RUNWAY_DAYS
// reads "low-soon"; a flat or rising trail reads "ok"; too few readings or too
// short a span reads "unknown" (neither healthy nor an alarm); a latest reading
// under the line reads "low". The low-water readers feed the trail from the
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
const { projectRunway, noteFundingReading, fundingRunwayStatus, runwayDays, worstRunwayWord, __resetFundingRunwayForTest, flushFundingRunway, RUNWAY_SAMPLE_MS } = R;

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

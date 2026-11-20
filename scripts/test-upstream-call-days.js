#!/usr/bin/env node
// Per-caller call counts by UTC day for the on-chain data provider
// (src/upstream-call-days.js), and the fetch hook that feeds them
// (src/egress-meter.js). Offline: the document is a file of this suite's own.
//
//   * a call is counted under the label its module set, else under the first
//     file of ours on the stack; a host that keeps no caller counts is not
//   * counts survive a deploy: a new process's counts add to the stored day
//   * the report is today and the seven days before it, older days dropped
//   * a failed store write keeps the counts for the next flush
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const dir = mkdtempSync(join(tmpdir(), "upstream-call-days-"));
const FILE = join(dir, "upstream-call-days.json");
process.env.UPSTREAM_CALL_DAYS_FILE = FILE;
process.env.UPSTREAM_CALL_DAYS_FLUSH_MS = "3600000"; // the suite flushes by hand

const D = await import("../src/upstream-call-days.js");
// A fixed day in the past, so the hook section's real clock never shares a day with it.
const T0 = Date.parse("2026-03-10T12:00:00Z");
const DAY = 86_400_000;

// ---- counting and the label scope ------------------------------------------
{
  for (let i = 0; i < 5; i++) D.noteUpstreamCall("alchemy", "solana-history:activity-refresh", T0);
  for (let i = 0; i < 2; i++) D.noteUpstreamCall("alchemy", "tools/wallet-kit.js", T0);
  ok(D.noteUpstreamCall("brave", "x.js", T0) === false, "an upstream that keeps no caller counts is not counted");
  ok(D.egressCallerLabel() === null && D.egressCaller("a", () => D.egressCaller("b", () => D.egressCallerLabel())) === "b" && D.egressCallerLabel() === null, "a label covers its own synchronous scope and is restored after it, nested or not");
  let thrown = false; try { D.egressCaller("x", () => { throw new Error("boom"); }); } catch { thrown = true; }
  ok(thrown && D.egressCallerLabel() === null, "a throw inside the scope restores the label");
  const r = await D.upstreamCallDaysReport("alchemy", { days: 7, now: T0 });
  ok(r.days.length === 8 && r.days[0].day === "2026-03-10" && r.days[0].calls === 7 && r.days[0].callers["solana-history:activity-refresh"] === 5 && r.days[0].callers["tools/wallet-kit.js"] === 2,
    `the report is today and the seven days before it, with a count per caller (${JSON.stringify(r.days[0])})`);
  ok(r.days.slice(1).every((d) => d.calls === 0), "a day with no calls reads zero");
}

// ---- a deploy: the stored day is added to, never replaced -------------------
{
  const f = await D.flushUpstreamCallDays({ now: T0 });
  ok(f.ok && f.flushed, "a flush writes the document");
  const stored = JSON.parse(readFileSync(FILE, "utf8"));
  ok(stored.days["2026-03-10"].alchemy.total === 7 && !/https?:|0x[0-9a-f]{40}/i.test(JSON.stringify(stored)), "the document holds counts and labels only");
  D.__resetUpstreamCallDaysForTest();                 // the new process: nothing in memory
  const fresh = await D.upstreamCallDaysReport("alchemy", { days: 7, now: T0 });
  ok(fresh.days[0].calls === 7 && fresh.stored === true, `a new process reads the day's calls made before the deploy (${fresh.days[0].calls})`);
  for (let i = 0; i < 4; i++) D.noteUpstreamCall("alchemy", "solana-history:activity-refresh", T0);
  D.noteUpstreamCall("alchemy", "solana-history:leaderboard", T0);
  const mid = await D.upstreamCallDaysReport("alchemy", { days: 7, now: T0 + 60_000 });
  ok(mid.days[0].calls === 12 && mid.days[0].callers["solana-history:activity-refresh"] === 9, `its own calls not yet written are added to the stored day (${mid.days[0].calls})`);
  await D.flushUpstreamCallDays({ now: T0 });
  const after = JSON.parse(readFileSync(FILE, "utf8")).days["2026-03-10"].alchemy;
  ok(after.total === 12 && after.callers["solana-history:activity-refresh"] === 9 && after.callers["solana-history:leaderboard"] === 1, `the day's count across the deploy is 12 (${after.total})`);
}

// ---- history: seven days and today, older days dropped ----------------------
{
  D.__resetUpstreamCallDaysForTest();
  for (let d = 1; d <= 10; d++) D.noteUpstreamCall("alchemy", "x.js", T0 - d * DAY);
  await D.flushUpstreamCallDays({ now: T0 });
  const days = Object.keys(JSON.parse(readFileSync(FILE, "utf8")).days).sort();
  ok(days.length === D.KEEP_DAYS && days[0] === "2026-03-03" && days.at(-1) === "2026-03-10", `the document keeps today and the seven days before it (${days[0]} to ${days.at(-1)})`);
  D.__resetUpstreamCallDaysForTest();
  const r = await D.upstreamCallDaysReport("alchemy", { days: 7, now: T0 });
  ok(r.days.map((x) => x.calls).join(",") === "12,1,1,1,1,1,1,1", `the report lists each day's calls, newest first (${r.days.map((x) => x.calls).join(",")})`);
}

// ---- many callers fold into "other", totals exact ---------------------------
{
  D.__resetUpstreamCallDaysForTest();
  const day = T0 + 3 * DAY;
  for (let i = 0; i < 60; i++) for (let n = 0; n <= i % 3; n++) D.noteUpstreamCall("alchemy", `m${i}.js`, day);
  const r = await D.upstreamCallDaysReport("alchemy", { days: 0, now: day });
  const sum = Object.values(r.days[0].callers).reduce((a, b) => a + b, 0);
  ok(Object.keys(r.days[0].callers).length === D.MAX_CALLERS && r.days[0].callers.other > 0 && sum === r.days[0].calls, `past ${D.MAX_CALLERS} callers the smallest fold into "other" and the sum stays the total (${sum})`);
}

// ---- a failed write keeps the counts ----------------------------------------
{
  D.__resetUpstreamCallDaysForTest();
  process.env.UPSTREAM_CALL_DAYS_FILE = join(dir, "no-such-dir", "deeper", "x.json");
  writeFileSync(join(dir, "no-such-dir"), "a file where the directory would be");
  D.noteUpstreamCall("alchemy", "x.js", T0);
  const f = await D.flushUpstreamCallDays({ now: T0 });
  const r = await D.upstreamCallDaysReport("alchemy", { days: 0, now: T0 });
  ok(f.ok === false ? r.days[0].calls === 1 : r.days[0].calls >= 1, `a write that does not land keeps the count for the next flush (${JSON.stringify(f)}, ${r.days[0].calls})`);
  process.env.UPSTREAM_CALL_DAYS_FILE = FILE;
  D.__resetUpstreamCallDaysForTest();
}

// ---- the fetch hook: label, stack, and hosts it leaves alone ----------------
{
  const srv = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end("{}"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  // The hook reads the host of the URL; the call itself lands on the stub.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => realFetch(String(input).replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${port}`), init);
  const { installEgressMeter } = await import("../src/egress-meter.js");
  const caps = await import("../src/upstream-hard-caps.js");
  installEgressMeter();
  const today = Date.now();
  await D.egressCaller("solana-history:leaderboard", () => fetch("https://solana-mainnet.g.alchemy.com/v2/k"));
  // An unlabelled call made by one of our own modules.
  const { rpcCall } = await import("../src/revenue-live.js");
  await rpcCall(["https://base-mainnet.g.alchemy.com/v2/k"], "eth_blockNumber", [], 2000).catch(() => {});
  await fetch("https://example.org/");
  const r = await D.upstreamCallDaysReport("alchemy", { days: 0, now: today });
  const callers = r.days[0].callers;
  ok(r.days[0].calls === 2 && callers["solana-history:leaderboard"] === 1, `a labelled call is counted under its label (${JSON.stringify(callers)})`);
  const other = Object.keys(callers).find((k) => k !== "solana-history:leaderboard");
  ok(other === "revenue-live.js" && callers[other] === 1, `an unlabelled call is counted under the module that made it, never under the meter itself (${other})`);
  ok(caps.hardCapStatus().upstreams.alchemy.usedToday === 2, "control: the hard ceiling counted the same two calls");
  ok(!JSON.stringify(r).includes("/v2/k") && !JSON.stringify(r).includes("example.org"), "no path, key or uncounted host is kept");
  globalThis.fetch = realFetch;
  await new Promise((r2) => { srv.closeAllConnections?.(); srv.close(() => r2()); });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// One pace for every request to the SEC's hosts (src/tools/sec-rate.js).
//
//   node scripts/test-sec-rate.js          (offline: the SEC host is a stand-in)
//
// Proves, with the real EDGAR handlers over a stand-in for the SEC's hosts:
//   - thirty calls made at once all succeed, and in no rolling second do more
//     than eight requests start (each one counted when the stand-in gets it);
//   - a read whose place the pace can reach is never refused before its
//     deadline, and one it cannot reach is answered the 503 (Retry-After,
//     "ours", uncharged wording) at once instead of waiting for it;
//   - turns are fair across callers: one caller's burst does not hold another
//     caller's read, a caller that left frees its places, and a run already
//     paid for is never refused by the pace;
//   - spaced arrivals (a fake clock) never exceed eight starts a second;
//   - the wait ends at the run's ceiling (a 504, and nothing starts after it),
//     on the caller's signal and inside the handler budget;
//   - the line is bounded, and the pace is divided across replicas;
// and, by reading the source, that no file under src/ reaches an SEC host
// except through the pace.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stubGuardResolver } from "./lib/guard-resolver-stub.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createSecPace, secPaced, secPaceStatus, secStartsPerSecond, secBusyError, isSecHost, SEC_HOSTS, SEC_STARTS_PER_SECOND_TOTAL, SEC_MAX_WAIT_MS, SEC_READ_RESERVE_MS, SEC_WINDOW_MS, _resetSecPaceForTests } = await import("../src/tools/sec-rate.js");
const { withRunCeiling } = await import("../src/run-ceiling.js");
const { underBudget } = await import("../src/upstream-deadline.js");
const { runAsRouteCall, runAsStep } = await import("../src/not-charged.js");
const { EDGAR_TOOLS, fetchXmlText } = await import("../src/tools/edgar-kit.js");
const { fetchDocText } = await import("../src/tools/filing-watch-kit.js");
const { rangeBytes } = await import("../src/tools/edgar-13f-datasets.js");
const { scanInfoTableForIssuer } = await import("../src/tools/ticker-pack-kit.js");

const SEC_WINDOW_MS_QUARTER = Math.round(SEC_WINDOW_MS / 4);
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The most starts inside any rolling `windowMs` (a window opens at each start). */
const mostPerWindow = (times, windowMs = 1000) => {
  const t = [...times].sort((a, b) => a - b);
  let most = 0;
  for (let i = 0, j = 0; i < t.length; i++) { while (t[i] - t[j] >= windowMs) j++; most = Math.max(most, i - j + 1); }
  return most;
};
ok(mostPerWindow([0, 1, 2, 999, 1000, 1001]) === 4 && mostPerWindow([0, 100, 200], 50) === 1, "the window counter counts a rolling window");

// ---- the stand-in for the SEC's hosts ----
const starts = []; // { at, host, path }
const realFetch = globalThis.fetch;
const submissions = (cik) => ({ cik, name: `Company ${cik}`, filings: { recent: { form: ["10-K", "8-K"], filingDate: ["2026-01-02", "2026-02-03"], reportDate: ["2025-12-31", ""], accessionNumber: ["0000000001-26-000001", "0000000001-26-000002"], primaryDocument: ["a.htm", "b.htm"], primaryDocDescription: ["10-K", "8-K"], isXBRL: [1, 0] }, files: [] } });
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url ?? String(input));
  if (!isSecHost(u)) throw new Error(`unexpected egress in an offline suite: ${u.host}`);
  starts.push({ at: performance.now(), host: u.host, path: u.pathname });
  await sleep(15);
  if (init.signal?.aborted) throw init.signal.reason;
  const headers = { "content-type": "application/json" };
  if (u.pathname.endsWith("company_tickers.json")) return new Response(JSON.stringify({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } }), { status: 200, headers });
  if (u.pathname.startsWith("/submissions/")) return new Response(JSON.stringify(submissions(u.pathname.replace(/\D/g, ""))), { status: 200, headers });
  if (init.headers?.Range) return new Response(new Uint8Array(4), { status: 206, headers: { "content-range": "bytes 0-3/100" } });
  return new Response("<doc>ok</doc>", { status: 200, headers: { "content-type": "text/xml" } });
};
const restoreResolver = stubGuardResolver((host, family) => (family === 4 ? ["93.184.216.34"] : []));

// ---- thirty calls at once, through the real handlers ----
{
  _resetSecPaceForTests();
  starts.length = 0;
  const filings = EDGAR_TOOLS.find((t) => t.slug === "edgar-filings").handler;
  const t0 = performance.now();
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => runAsRouteCall(() => filings({ cik: String(1000 + i), limit: 2 }))));
  const took = performance.now() - t0;
  const good = results.filter((r) => r.status === "fulfilled" && r.value?.filings?.length === 2).length;
  const refused = results.filter((r) => r.status === "rejected");
  const most = mostPerWindow(starts.map((s) => s.at));
  ok(good === 30 && refused.length === 0, `thirty calls made at once all succeed (${good} answered, ${refused.length} refused${refused[0] ? `: ${refused[0].reason?.statusCode} ${String(refused[0].reason?.message).slice(0, 80)}` : ""})`);
  ok(starts.length === 30 && most <= SEC_STARTS_PER_SECOND_TOTAL && most >= 2, `their thirty requests start at most eight to a rolling second (most ${most}, over ${Math.round(took)} ms)`);
  ok(took >= 2800 && took < SEC_MAX_WAIT_MS, `the calls waited their turn instead of being refused (${Math.round(took)} ms for thirty)`);
  ok(secPaceStatus().refused === 0 && secPaceStatus().waiting === 0, "the pace refused nothing and nobody is left waiting");
}

// ---- every kind of SEC read shares the one pace ----
{
  _resetSecPaceForTests();
  starts.length = 0;
  const filings = EDGAR_TOOLS.find((t) => t.slug === "edgar-filings").handler;
  const jobs = [];
  for (let i = 0; i < 6; i++) {
    jobs.push(filings({ cik: String(2000 + i), limit: 1 }));
    jobs.push(fetchXmlText(`https://www.sec.gov/Archives/edgar/data/1/${i}/form4.xml`));
    jobs.push(fetchDocText(`https://www.sec.gov/Archives/edgar/data/1/${i}/doc.htm`));
    jobs.push(rangeBytes(`https://www.sec.gov/files/structureddata/data/form-13f-data-sets/x${i}.zip`, 0, 3));
    jobs.push(scanInfoTableForIssuer(`https://www.sec.gov/Archives/edgar/data/1/${i}/infotable.xml`, { want: "example corp", cusip6: null }));
  }
  const settled = await Promise.allSettled(jobs);
  const most = mostPerWindow(starts.map((s) => s.at));
  ok(settled.every((r) => r.status === "fulfilled") && starts.length === 30, `JSON, XML, document, range and information-table reads all answer (${settled.filter((r) => r.status === "fulfilled").length} of 30${settled.find((r) => r.status === "rejected") ? `; ${String(settled.find((r) => r.status === "rejected").reason?.message).slice(0, 90)}` : ""})`);
  ok(most <= SEC_STARTS_PER_SECOND_TOTAL && new Set(starts.map((s) => s.host)).size >= 2, `across hosts and kits, at most eight starts to a rolling second (most ${most}; hosts ${[...new Set(starts.map((s) => s.host))].join(", ")})`);
}

// ---- a place the pace cannot reach is refused at once; a reachable one never before its deadline ----
{
  const pace = createSecPace({ perSecond: 4, maxWaitMs: 400, queueMax: 64 });
  const t0 = performance.now();
  const outcomes = await Promise.all(Array.from({ length: 12 }, () => runAsRouteCall(() => pace.paced(async () => "read")).then((v) => ({ v, at: performance.now() - t0 }), (e) => ({ e, at: performance.now() - t0 }))));
  const served = outcomes.filter((o) => o.v === "read"), refused = outcomes.filter((o) => o.e);
  ok(served.length === 4 && refused.length === 8, `with four places and a 400 ms wait, four of twelve are served and eight are not (${served.length} served, ${refused.length} refused)`);
  ok(refused.every((o) => o.at < 50), `the eight no place can reach inside the wait are answered in under 50 ms, not after it (latest ${Math.round(Math.max(...refused.map((o) => o.at)))} ms)`);
  const e = refused[0].e;
  ok(e.statusCode === 503 && e.retryAfter > 0 && e.attribution === "ours" && e.secBusy === true && /EDGAR is busy/.test(e.message) && /Nothing was read\. Nothing was charged\./.test(e.message), `the refusal is a 503 with Retry-After, ours, uncharged (${e.statusCode} ${e.message})`);
  ok(pace.status().waiting === 0 && pace.status().refused === 8, "a refused read leaves the line");
  // A step prints no charge claim.
  const inStep = await runAsStep(async () => secBusyError());
  ok(!/Nothing was charged/.test(inStep.message) && /Nothing was read\./.test(inStep.message), "inside a step the refusal makes no charge claim");
  // CONTROL: the same twelve with the default wait are all served.
  const roomy = createSecPace({ perSecond: 4 });
  const all = await Promise.allSettled(Array.from({ length: 12 }, () => roomy.paced(async () => "read")));
  ok(all.every((r) => r.status === "fulfilled") && roomy.status().refused === 0, "CONTROL: with the default wait all twelve are served");
  // A place the pace CAN reach is never refused early: with a wait that covers
  // the next window, the reads behind the first four wait and are served.
  const reach = createSecPace({ perSecond: 4, windowMs: 300, maxWaitMs: 400 });
  const r0 = performance.now();
  const got = await Promise.all(Array.from({ length: 8 }, () => reach.paced(async () => performance.now() - r0).then((at) => ({ at }), (err) => ({ err }))));
  ok(got.every((o) => o.at != null) && got.filter((o) => o.at >= 290).length === 4 && reach.status().refused === 0, `a place the next window reaches waits for it and is served (${got.map((o) => (o.err ? "refused" : Math.round(o.at))).join(", ")})`);
  // ...and one that was reachable when it joined, then stood behind another
  // caller's read, is answered at its deadline and not a moment before.
  let who = ["payer:0xY"];
  const tight = createSecPace({ perSecond: 2, windowMs: 300, maxWaitMs: 400, callerOf: () => who });
  await Promise.all([tight.paced(async () => 1), tight.paced(async () => 1)]); // the window is full
  const q0 = performance.now();
  const stamp = (p) => p.then(() => ({ at: performance.now() - q0 }), (err) => ({ err, at: performance.now() - q0 }));
  const y1 = stamp(tight.paced(async () => 1)), y2 = stamp(tight.paced(async () => 1));
  who = ["payer:0xZ"];
  const z1 = stamp(tight.paced(async () => 1));
  const [a, b, c] = await Promise.all([y1, y2, z1]);
  ok(!a.err && !c.err && b.err?.secBusy === true && b.at >= 395 && b.at < 700, `a read that could be reached when it joined is refused at its deadline, never before (first ${Math.round(a.at)} ms, the other caller ${Math.round(c.at)} ms, refused at ${Math.round(b.at)} ms)`);
}

// ---- turns are fair across callers ----
{
  let who = ["payer:0xBURST"];
  const pace = createSecPace({ perSecond: 4, windowMs: 200, maxWaitMs: 3000, callerOf: () => who });
  const t0 = performance.now();
  const order = [];
  const run = (label) => pace.paced(async () => { order.push(label); return performance.now() - t0; }).then((at) => ({ at }), (e) => ({ e, at: performance.now() - t0 }));
  const burst = Array.from({ length: 100 }, () => run("burst"));
  await sleep(20);
  who = ["payer:0xONE"];
  const one = await run("one");
  ok(one.at != null && one.at < 200 + 150 && order.indexOf("one") <= 5, `one caller's burst of 100 does not hold another caller's single read: it starts with the next window (${one.e ? `refused ${one.e.statusCode}` : `${Math.round(one.at)} ms`}, start number ${order.indexOf("one") + 1})`);
  const settledBurst = await Promise.all(burst);
  const late = settledBurst.filter((o) => o.e);
  // (A read that was just reachable when it joined and then stood behind the
  // other caller's, or missed its window by a timer's slack, is answered at its
  // deadline, as above: the last window's worth at most.)
  const atOnce = late.filter((o) => o.at < 50), atDeadline = late.filter((o) => o.at >= 2990);
  ok(settledBurst.filter((o) => o.at != null && !o.e).length >= 50 && atOnce.length >= 30 && atDeadline.length <= 8 && atOnce.length + atDeadline.length === late.length && late.every((o) => o.e.secBusy),
    `the burst's own reads past what the pace can reach are answered at once (${atOnce.length} at once, ${atDeadline.length} at the deadline, of 100), the rest served`);
  ok(pace.status().waiting === 0, "and the line empties");
  // Work no request asked for (a page build) is one caller of its own.
  const { runAsCallerOf, IN_PROCESS_CALLER } = await import("../src/dispatch-caller.js");
  const seen = [];
  const named = createSecPace({ perSecond: 1, windowMs: 50, callerOf: () => { const k = admissionCallerOfNow(); seen.push(k.join()); return k; } });
  const { admissionCallerOf } = await import("../src/dispatch-caller.js");
  function admissionCallerOfNow() { return admissionCallerOf(null); }
  await named.paced(async () => 1);
  await named.paced(async () => 1);
  await runAsCallerOf({ ip: "203.0.113.7" }, () => named.paced(async () => 1));
  ok(seen[0] === IN_PROCESS_CALLER && /^ip:/.test(seen[1] || ""), `a read with no request is the in-process caller, and a dispatched one is its request's caller (${seen.join(" | ")})`);
}

// ---- a caller that left frees its places ----
{
  const { EventEmitter } = await import("node:events");
  const { runAsCallerOf, currentCallerLeftSignal } = await import("../src/dispatch-caller.js");
  let who = ["payer:0xGONE"];
  const pace = createSecPace({ perSecond: 2, windowMs: 300, maxWaitMs: 5000, callerOf: () => who });
  await Promise.all([pace.paced(async () => 1), pace.paced(async () => 1)]);
  const ac = new AbortController();
  let ran = 0;
  const gone = Array.from({ length: 20 }, () => pace.paced(async () => { ran++; }, { signal: ac.signal }).then(() => null, (e) => e));
  await sleep(10);
  const before = pace.status().waiting;
  who = ["payer:0xSTAYS"];
  const t0 = performance.now();
  const stays = pace.paced(async () => performance.now() - t0);
  ac.abort(Object.assign(new Error("caller went away"), { name: "AbortError" }));
  const errs = await Promise.all(gone);
  const waitingAfter = pace.status().waiting;
  const at = await stays;
  ok(before === 20 && errs.every((e) => e?.name === "AbortError") && ran === 0 && waitingAfter === 1 && at < 300 + 100, `an aborted caller's twenty reads leave the line at once and the next caller takes the next place (waiting ${before} -> ${waitingAfter}, served at ${Math.round(at)} ms)`);
  // With no signal passed, the dispatching request's own is read: a caller
  // whose connection closed before the first byte, and who is not charged.
  const wasFree = process.env.FREE_MODE;
  const reqOf = () => { const res = new EventEmitter(); res.headersSent = false; res.destroyed = false; return { ip: "203.0.113.9", res, socket: {} }; };
  const hangUp = (req) => { req.res.destroyed = true; req.res.emit("close"); };
  const viaRequest = async (free) => {
    if (free) process.env.FREE_MODE = "true"; else delete process.env.FREE_MODE;
    const p = createSecPace({ perSecond: 1, windowMs: 250, maxWaitMs: 5000 });
    await p.paced(async () => 1);
    const req = reqOf();
    let sawSignal = null;
    const out = runAsCallerOf(req, () => { sawSignal = currentCallerLeftSignal(); return p.paced(async () => "ran"); }).then((v) => ({ v }), (e) => ({ e }));
    await sleep(20);
    hangUp(req);
    await sleep(20);
    const waiting = p.status().waiting;
    return { ...(await out), waiting, sawSignal };
  };
  const left = await viaRequest(true);
  ok(left.e?.clientGone === true && left.e.statusCode === 499 && left.waiting === 0 && left.sawSignal instanceof AbortSignal, `a dispatched read whose caller hung up, uncharged, leaves the line (${left.e?.statusCode}, waiting ${left.waiting})`);
  const charged = await viaRequest(false);
  ok(charged.v === "ran" && charged.waiting === 1, `CONTROL: a caller that is still charged keeps its place and its read runs (${charged.v || charged.e?.message}, waiting ${charged.waiting})`);
  if (wasFree === undefined) delete process.env.FREE_MODE; else process.env.FREE_MODE = wasFree;
  ok(currentCallerLeftSignal() === null, "outside a dispatch there is no caller signal");
}

// ---- a run already paid for is never refused by the pace ----
{
  const { setPaidBeforeRunAmbient, paidBeforeRunHere } = await import("../src/settle-first.js");
  ok(paidBeforeRunHere() === false, "with no reader registered no run reads as paid before its work");
  let paid = false;
  setPaidBeforeRunAmbient(() => paid);
  const pace = createSecPace({ perSecond: 1, windowMs: 250, maxWaitMs: 100, queueMax: 1 });
  await pace.paced(async () => 1);
  const refusedNow = await pace.paced(async () => 1).then(() => null, (e) => e);
  paid = true;
  const t0 = performance.now();
  const got = await Promise.all(Array.from({ length: 3 }, () => pace.paced(async () => performance.now() - t0).then((at) => ({ at }), (e) => ({ e }))));
  setPaidBeforeRunAmbient(null);
  ok(refusedNow?.secBusy === true && got.every((o) => o.at != null) && Math.max(...got.map((o) => o.at)) >= 600, `reads of a run whose payment settled first wait past the longest wait and the line bound and are served (unpaid: ${refusedNow?.statusCode}; paid at ${got.map((o) => (o.e ? `refused ${o.e.statusCode}` : Math.round(o.at))).join(", ")} ms)`);
  ok(mostPerWindow(got.map((o) => o.at), 240) === 1 && pace.status().waiting === 0, "and they still start one to a window");
  let err = null, ran = 0;
  paid = true; setPaidBeforeRunAmbient(() => paid);
  try { await withRunCeiling(120, () => pace.paced(async () => { ran++; })); } catch (x) { err = x; }
  setPaidBeforeRunAmbient(null);
  ok(err?.ceilingCut === true && ran === 0, "its wait still ends at the run's ceiling");
}

// ---- spaced arrivals never exceed the pace (a fake clock) ----
{
  const { mock } = await import("node:test");
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const tick = async (ms) => { mock.timers.tick(ms); for (let i = 0; i < 6; i++) await Promise.resolve(); };
  try {
    const spaced = (opts = {}) => createSecPace({ perSecond: 8, now: () => Date.now(), callerOf: () => ["payer:0xSPACED"], ...opts });
    const drive = async (pace) => {
      const at = [];
      for (let i = 0; i < 660; i++) { pace.turn().then(() => at.push(Date.now()), () => {}); await tick(30); }
      for (let i = 0; i < 400; i++) await tick(30);
      return at;
    };
    const at = await drive(spaced());
    const most = mostPerWindow(at);
    ok(at.length >= 150 && most <= 8 && most >= 7, `660 reads arriving 30 ms apart start at most eight to any rolling second (${at.length} started, most ${most})`);
    // CONTROL: a pace that forgot starts after a quarter of the window is caught by the same count.
    const quick = await drive(spaced({ windowMs: SEC_WINDOW_MS_QUARTER }));
    ok(mostPerWindow(quick) > 8, `CONTROL: a window a quarter as long is seen (most ${mostPerWindow(quick)})`);
  } finally { mock.timers.reset(); }
}

// ---- the wait ends at the run's ceiling, and nothing starts after it ----
{
  const pace = createSecPace({ perSecond: 1 });
  await pace.paced(async () => "first");
  let ran = 0;
  const t0 = performance.now();
  let err = null;
  try { await withRunCeiling(120, () => pace.paced(async () => { ran++; })); } catch (e) { err = e; }
  const took = performance.now() - t0;
  ok(err?.statusCode === 504 && err.ceilingCut === true && ran === 0 && took >= 100 && took < 400, `a read waiting at the run's ceiling ends there as a 504 and never starts (${err?.statusCode}, ${Math.round(took)} ms, ran ${ran})`);
  ok(pace.status().waiting === 0, "the read the ceiling ended left the line");
  err = null;
  try { await withRunCeiling(1, async () => { await sleep(10); return pace.paced(async () => { ran++; }); }); } catch (e) { err = e; }
  ok(err?.ceilingCut === true && ran === 0, "nothing starts once the ceiling has passed");
}

// ---- the caller's signal ends the wait ----
{
  const pace = createSecPace({ perSecond: 1 });
  await pace.paced(async () => "first");
  const ac = new AbortController();
  let ran = 0;
  const p = pace.paced(async () => { ran++; }, { signal: ac.signal }).then(() => null, (e) => e);
  await sleep(30);
  const waitingBefore = pace.status().waiting;
  ac.abort(Object.assign(new Error("caller went away"), { name: "AbortError" }));
  const e = await p;
  ok(waitingBefore === 1 && e?.name === "AbortError" && ran === 0 && pace.status().waiting === 0, `an aborted caller leaves the line and its read never starts (${e?.name}, waiting ${waitingBefore} -> ${pace.status().waiting})`);
  const gone = await pace.paced(async () => 1, { signal: AbortSignal.abort() }).then(() => null, (x) => x);
  ok(gone != null, "a signal already aborted starts nothing");
}

// ---- inside a handler budget: the wait leaves the read its reserve ----
{
  let who = ["payer:0xY"];
  const pace = createSecPace({ perSecond: 2, windowMs: 300, callerOf: () => who });
  await Promise.all([pace.paced(async () => 1), pace.paced(async () => 1)]);
  // Reachable when it joined (the next window), then behind another caller's read.
  const first = pace.paced(async () => "first");
  const budgeted = underBudget(async () => pace.paced(async () => "late"), SEC_READ_RESERVE_MS + 400);
  const t0 = performance.now();
  const late = budgeted({}).then(() => null, (e) => ({ e, took: performance.now() - t0 }));
  who = ["payer:0xZ"];
  const other = pace.paced(async () => "other");
  const out = await late;
  await Promise.all([first, other]);
  ok(out?.e?.secBusy === true && out.took >= 350 && out.took < 900, `a wait is bounded by the handler budget less the read's reserve (${out?.e?.statusCode} after ${Math.round(out?.took ?? 0)} ms)`);
  const far = createSecPace({ perSecond: 1, windowMs: 60_000 });
  await far.paced(async () => "first");
  const short = underBudget(async () => far.paced(async () => "late"), SEC_READ_RESERVE_MS + 250);
  let err = null;
  const t2 = performance.now();
  try { await short({}); } catch (e) { err = e; }
  ok(err?.secBusy === true && performance.now() - t2 < 50, `a place the budget cannot wait for is answered at once (${Math.round(performance.now() - t2)} ms)`);
  const spent = underBudget(async () => far.paced(async () => "late"), SEC_READ_RESERVE_MS - 500);
  err = null;
  const t1 = performance.now();
  try { await spent({}); } catch (e) { err = e; }
  ok(err?.secBusy === true && performance.now() - t1 < 100, "with no budget left for a wait and no free place, the answer is at once");
}

// ---- the line is bounded ----
{
  const pace = createSecPace({ perSecond: 2, maxWaitMs: 500 });
  const settled = [];
  const jobs = Array.from({ length: 500 }, () => pace.paced(async () => "read").then((v) => settled.push(v), (e) => settled.push(e)));
  await sleep(5);
  const s = pace.status();
  ok(s.waiting <= pace.lineMax && s.longestLine <= pace.lineMax && pace.lineMax <= 8, `five hundred reads at once hold at most ${pace.lineMax} places in line (waiting ${s.waiting})`);
  ok(settled.filter((x) => x?.secBusy).length >= 500 - 2 - pace.lineMax, "the reads past the line are answered at once");
  await Promise.all(jobs);
  ok(pace.status().waiting === 0, "and the line empties");
}

// ---- the pace is this process's share ----
ok(secStartsPerSecond({}) === 8 && secStartsPerSecond({ RATE_LIMIT_REPLICAS: "1" }) === 8 && secStartsPerSecond({ RATE_LIMIT_REPLICAS: "2" }) === 4 && secStartsPerSecond({ RATE_LIMIT_REPLICAS: "3" }) === 2 && secStartsPerSecond({ RATE_LIMIT_REPLICAS: "40" }) === 1 && secStartsPerSecond({ RATE_LIMIT_REPLICAS: "junk" }) === 8,
  "the pace is divided across replicas (RATE_LIMIT_REPLICAS), never under one start a second");
ok(SEC_STARTS_PER_SECOND_TOTAL <= 8 && SEC_HOSTS.join() === "sec.gov,www.sec.gov,data.sec.gov,efts.sec.gov" && isSecHost("https://EFTS.sec.gov/LATEST/search-index?q=x") && !isSecHost("https://sec.gov.example/") && !isSecHost("https://notsec.gov/") && !isSecHost("nonsense"),
  "the pace is eight a second at most and covers the four hosts, by exact host name");

// ---- every fetch of an SEC host goes through the pace (source guard) ----
// A file under src/ that names an SEC host and makes a network call makes
// every such call inside secPaced(() => ...). Files that only print the host
// (a citation, a URL in an answer) make no network call and are not read.
{
  const CALL_RE = /(?<![.\w])(?:upstreamFetch|safeFetch|fetchWithRetry|probePublicUrl|fetchImpl|fetch)\(/g;
  const HOST_RE = /(?:www\.|data\.|efts\.)?sec\.gov/;
  // A file that names the host for a reader and calls the network for something else.
  const OTHER_CALLS = new Map([
    ["src/pow.js", "a code sample in a string (the proof-of-work snippet); the SEC host is in a comment"],
  ]);
  const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === "generated" || n === "node_modules" ? [] : walk(p)) : (/\.(?:js|mjs)$/.test(n) ? [p] : []); });
  const unpaced = (src) => {
    const out = [];
    for (const m of src.matchAll(CALL_RE)) {
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const line = src.slice(lineStart, src.indexOf("\n", m.index));
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;                       // a comment
      if (/(?:async )?function \w*$/.test(src.slice(lineStart, m.index))) continue; // a declaration
      if (/secPaced\(\(\) => $/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
      out.push(line.trim().slice(0, 110));
    }
    return out;
  };
  const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "workers")), ...walk(join(ROOT, "services"))].filter((f) => !f.endsWith(join("tools", "sec-rate.js")));
  const naming = files.filter((f) => HOST_RE.test(readFileSync(f, "utf8")));
  let pacedFiles = 0;
  for (const f of naming) {
    const rel = relative(ROOT, f), src = readFileSync(f, "utf8");
    const raw = unpaced(src);
    if (OTHER_CALLS.has(rel)) { ok(raw.length > 0 && !/secPaced/.test(src), `${rel} is still an exception with a reason: ${OTHER_CALLS.get(rel)}`); continue; }
    ok(raw.length === 0, `${rel} reaches no SEC host outside the pace${raw.length ? `: ${raw[0]}` : ""}`);
    if (/secPaced\(\(\) => /.test(src)) { pacedFiles++; ok(/import \{ secPaced \} from "\.\/sec-rate\.js";/.test(src), `${rel} imports the pace it uses`); }
  }
  const count = (rel) => (readFileSync(join(ROOT, rel), "utf8").match(/secPaced\(\(\) => /g) || []).length;
  ok(naming.length >= 12 && pacedFiles === 4 && count("src/tools/edgar-kit.js") === 2 && count("src/tools/edgar-13f-datasets.js") === 3 && count("src/tools/filing-watch-kit.js") === 1 && count("src/tools/ticker-pack-kit.js") === 1,
    `the SEC's hosts are read from four files, seven call sites, each inside the pace (${naming.length} files name a host, ${pacedFiles} read one)`);
  // The guard sees a call that leaves the pace, and one added beside it.
  const kit = readFileSync(join(ROOT, "src/tools/edgar-kit.js"), "utf8");
  ok(unpaced(kit.replace("await secPaced(() => upstreamFetch(safeUrl, { headers: { \"User-Agent\": edgarUserAgent(), Accept: \"application/json\" } }, ctx));", "await upstreamFetch(safeUrl, { headers: { \"User-Agent\": edgarUserAgent(), Accept: \"application/json\" } }, ctx);")).length === 1
    && unpaced(`${kit}\nconst r = await fetch("https://data.sec.gov/x");\n`).length === 1 && unpaced(`${kit}\n  const res = await safeFetch(u);\n`).length === 1,
  "CONTROL: the guard fails a call taken out of the pace and a new raw call beside it");
}

// The server names the runs that are paid before their work: an armed run past
// its settle point, and the resend of a payment settled first.
{
  const server = readFileSync(join(ROOT, "src/server.js"), "utf8");
  const reader = server.slice(server.indexOf("setPaidBeforeRunAmbient(() =>"), server.indexOf("setPaidBeforeRunAmbient(() =>") + 260);
  ok(/scope\.settledFirstResend === true/.test(reader) && /settleFirstStarted\(scope\.settleFirstRequest\)/.test(reader) && /markSettledFirstResend\(req,[^\n]+\n[^\n]*\n\s*\{ const scope = currentRequestScope\(\); if \(scope\) scope\.settledFirstResend = true; \}/.test(server),
    "the server registers the paid-before-run reader over the armed request and the resend mark");
}

globalThis.fetch = realFetch;
restoreResolver();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

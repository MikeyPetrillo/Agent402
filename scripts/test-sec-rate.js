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
//     paid for is never refused by the pace and starts ahead of the unpaid
//     line, inside about one window, however many unpaid callers keep coming;
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
  // What the server's reader answers from a request's scope: a settle point
  // reached, a resend, or a payment that was final before the handler ran (a
  // Tempo push transfer). Such a run is never answered the pace's 503.
  const sf = await import("../src/settle-first.js");
  ok(typeof sf.scopePaidBeforeRun === "function" && typeof sf.markFinalBeforeHandler === "function", "settle-first names the runs that are paid before their work from a request's scope");
  if (typeof sf.scopePaidBeforeRun === "function" && typeof sf.markFinalBeforeHandler === "function") {
    const pushScope = {}, plain = {};
    sf.markFinalBeforeHandler(pushScope);
    ok(sf.scopePaidBeforeRun(pushScope) === true && sf.scopePaidBeforeRun({ settledFirstResend: true }) === true && sf.scopePaidBeforeRun(plain) === false && sf.scopePaidBeforeRun(null) === false && sf.scopePaidBeforeRun({ finalBeforeHandler: "yes" }) === false,
      "a scope marked final before its handler, or a resend, reads as paid; an unmarked scope and no scope do not");
    let scope = plain;
    setPaidBeforeRunAmbient(() => sf.scopePaidBeforeRun(scope));
    const tight = createSecPace({ perSecond: 1, windowMs: 250, maxWaitMs: 100, queueMax: 1 });
    await tight.paced(async () => 1);
    const unpaid503 = await tight.paced(async () => 1).then(() => null, (e) => e);
    scope = pushScope;
    const p0 = performance.now();
    const served = await tight.paced(async () => performance.now() - p0).then((at) => ({ at }), (e) => ({ e }));
    setPaidBeforeRunAmbient(null);
    ok(unpaid503?.secBusy === true && served.at >= 100 && !served.e, `a read of a run whose payment was final before its handler waits past the longest wait and is served, where an unpaid one is answered 503 (${unpaid503?.statusCode}; ${served.e ? `refused ${served.e.statusCode}` : `${Math.round(served.at)} ms`})`);
  }
}

// ---- paid means the payment is final, not that a settlement started ----
// A run with two legs: one reaches the settle point while the other still
// reads the source. The second leg's reads are paid only once the settle
// point returned success; in flight and after a failure they are unpaid.
{
  const sf = await import("../src/settle-first.js");
  const armed = (run) => { const req = {}; sf.armSettleFirst(req, { run, reason: "test" }); return { req, scope: { settleFirstRequest: req } }; };
  const gate = () => { let open, fail; const p = new Promise((res, rej) => { open = res; fail = rej; }); return { p, open, fail }; };
  // In flight, then success.
  const g1 = gate(), a = armed(() => g1.p);
  const before = sf.scopePaidBeforeRun(a.scope);
  const p1 = sf.settleBeforeUpstream(a.req);
  const inFlight = sf.scopePaidBeforeRun(a.scope);
  g1.open(); await p1; await null;
  ok(before === false && inFlight === false && sf.settleFirstStarted(a.req) === true && sf.scopePaidBeforeRun(a.scope) === true,
    `an armed run reads unpaid before its settle point and while the settlement is in flight, and paid once it returned success (before ${before}, in flight ${inFlight}, after ${sf.scopePaidBeforeRun(a.scope)})`);
  // Failure.
  const g2 = gate(), b = armed(() => g2.p);
  const p2 = sf.settleBeforeUpstream(b.req);
  g2.fail(sf.settleFirstRefusal ? sf.settleFirstRefusal({ status: 402, body: {} }) : new Error("refused"));
  await p2.catch(() => {}); await null;
  ok(sf.settleFirstStarted(b.req) === true && sf.scopePaidBeforeRun(b.scope) === false, `a run whose settlement failed reads unpaid (${sf.scopePaidBeforeRun(b.scope)})`);
  // Through the pace. A read that comes while its run's settlement is in
  // flight is never answered the unpaid 503 before the outcome is known: a
  // settlement that then succeeds would make that a charged failure of our
  // own pace. It waits for the outcome (to the run's ceiling or its caller's
  // signal): on success it joins the paid line, on failure it is unpaid.
  const say = (o) => (o.e ? `refused ${o.e.statusCode || o.e.name}` : `served at ${Math.round(o.at)} ms`);
  const rigOf = (opts = {}) => {
    const g = gate(), r = armed(() => g.p);
    sf.setPaidBeforeRunAmbient(() => sf.scopePaidBeforeRun(r.scope));
    sf.setSettleFirstAmbient(() => r.req);
    const pace = createSecPace({ perSecond: 1, windowMs: 250, maxWaitMs: 100, queueMax: 1, ...opts });
    const done = () => { sf.setPaidBeforeRunAmbient(null); sf.setSettleFirstAmbient(null); };
    return { g, r, pace, done };
  };
  // The line is already past the read's deadline when it arrives (an unpaid
  // read is answered 503 at once), and the settlement is in flight.
  const arrivesInFlight = async (outcome, at = 300) => {
    const { g, r, pace, done } = rigOf();
    await pace.paced(async () => 1);
    const point = sf.settleBeforeUpstream(r.req); // the first leg reaches the settle point
    point.catch(() => {});
    const t0 = performance.now();
    let early = null;
    const read = pace.paced(async () => performance.now() - t0).then((v) => ({ at: v }), (e) => ({ e }));
    read.then((o) => { if (early === null) early = o; });
    await new Promise((res) => setTimeout(res, at));
    const before = early; // what the read had been answered while the settlement was still in flight
    early = false;
    if (outcome === "success") g.open(); else g.fail(new Error("refused"));
    const out = await read;
    done();
    return { ...out, before, waiting: pace.status().waiting };
  };
  const ok1 = await arrivesInFlight("success"), bad1 = await arrivesInFlight("failure");
  ok(ok1.before === null && bad1.before === null, `a read that arrives while its settlement is in flight, with the line past its deadline, is answered nothing until the outcome is known (${ok1.before ? say(ok1.before) : "waiting"}, ${bad1.before ? say(bad1.before) : "waiting"})`);
  ok(ok1.at >= 300 && !ok1.e && ok1.waiting === 0, `the settlement then succeeds: the read is served, never the 503 (${say(ok1)})`);
  ok(bad1.e?.secBusy === true && bad1.waiting === 0, `the settlement then fails: the read is an unpaid one, answered as any unpaid read is (${say(bad1)})`);
  // CONTROLS: a run with nothing to wait for is unchanged. A run that was
  // never armed (every run served before it is charged), one whose handler
  // ended before its settle point, and one whose settlement failed are
  // answered 503 at once; after a successful one the read waits past the
  // longest wait and is served.
  const noFlight = async (state) => {
    const { g, r, pace, done } = rigOf();
    if (state === "unarmed") sf.setSettleFirstAmbient(() => ({}));
    if (state === "ended") sf.disarmSettleFirst(r.req);
    await pace.paced(async () => 1);
    if (state === "failure" || state === "success") { const point = sf.settleBeforeUpstream(r.req); point.catch(() => {}); if (state === "success") g.open(); else g.fail(new Error("refused")); await point.catch(() => {}); await null; }
    const t0 = performance.now();
    const out = await pace.paced(async () => performance.now() - t0).then((v) => ({ at: v }), (e) => ({ e }));
    done();
    return { ...out, ms: performance.now() - t0, waiting: pace.status().waiting };
  };
  const pre = await noFlight("unarmed"), ended = await noFlight("ended"), failed = await noFlight("failure"), settled = await noFlight("success");
  ok(pre.e?.secBusy === true && pre.ms < 60 && ended.e?.secBusy === true && ended.ms < 60 && failed.e?.secBusy === true && failed.ms < 60, `CONTROL: a run never armed, one whose handler ended unsettled and one whose settlement failed are refused at once as before (${say(pre)} in ${Math.round(pre.ms)} ms; ${say(ended)} in ${Math.round(ended.ms)} ms; ${say(failed)} in ${Math.round(failed.ms)} ms)`);
  ok(settled.at >= 100 && !settled.e && settled.waiting === 0, `CONTROL: after the settle point returned success the same read waits past the longest wait and is served (${say(settled)})`);
  // A read ADMITTED to the unpaid line before the settle point was reached,
  // whose deadline comes while the settlement is in flight: it is not refused
  // at that deadline either. It waits for the outcome.
  const deadlineInFlight = async (outcome) => {
    const g = gate(), r = armed(() => g.p);
    let who = ["ip:first"];
    sf.setPaidBeforeRunAmbient(() => sf.scopePaidBeforeRun(r.scope));
    const pace = createSecPace({ perSecond: 1, windowMs: 200, maxWaitMs: 2000, queueMax: 8, callerOf: () => who });
    await pace.paced(async () => 1);
    const others = [];
    who = ["ip:a"]; others.push(pace.paced(async () => 1).catch(() => 0));
    who = ["ip:b"]; others.push(pace.paced(async () => 1).catch(() => 0));
    who = ["ip:mine"];
    const t0 = performance.now();
    let early = null;
    const read = pace.paced(async () => performance.now() - t0, { waitMs: 500 }).then((v) => ({ at: v }), (e) => ({ e }));
    read.then((o) => { if (early === null) early = o; });
    sf.setSettleFirstAmbient(() => r.req);
    await new Promise((res) => setTimeout(res, 100));
    const point = sf.settleBeforeUpstream(r.req); // reached after the read joined the line
    point.catch(() => {});
    await new Promise((res) => setTimeout(res, 800)); // the read's deadline (500 ms) passes with the settlement in flight
    const before = early;
    early = false;
    if (outcome === "success") g.open(); else g.fail(new Error("refused"));
    const out = await read;
    await Promise.all(others);
    sf.setPaidBeforeRunAmbient(null); sf.setSettleFirstAmbient(null);
    return { ...out, before, waiting: pace.status().waiting };
  };
  const ok2 = await deadlineInFlight("success"), bad2 = await deadlineInFlight("failure");
  ok(ok2.before === null && bad2.before === null, `a waiting read whose deadline comes while its settlement is in flight is answered nothing until the outcome is known (${ok2.before ? say(ok2.before) : "waiting"}, ${bad2.before ? say(bad2.before) : "waiting"})`);
  ok(ok2.at >= 900 && !ok2.e && ok2.waiting === 0, `the settlement then succeeds: it is served (${say(ok2)})`);
  ok(bad2.e?.secBusy === true && bad2.waiting === 0, `the settlement then fails: it is refused as the unpaid read it is (${say(bad2)})`);
  // The wait for the outcome ends at the run's ceiling and on the caller's signal.
  {
    const { r, pace, done } = rigOf();
    await pace.paced(async () => 1);
    const point = sf.settleBeforeUpstream(r.req); point.catch(() => {});
    let cut = null, ran = 0;
    try { await withRunCeiling(120, () => pace.paced(async () => { ran++; })); } catch (x) { cut = x; }
    const ctl = new AbortController();
    const left = pace.paced(async () => { ran++; }, { signal: ctl.signal }).then(() => null, (e) => e);
    setTimeout(() => ctl.abort(), 50);
    const gone = await left;
    done();
    ok(cut?.ceilingCut === true && gone?.name === "AbortError" && ran === 0 && pace.status().waiting === 0, `the wait for a settlement's outcome ends at the run's ceiling and on the caller's signal (${cut?.statusCode}, ${gone?.name}, waiting ${pace.status().waiting})`);
  }
  // ---- an armed run that has not reached its settle point ----
  // A run with two legs: one leg's read meets a full line BEFORE the other
  // leg reaches the settle point. Answered 503, that leg fails a run whose
  // payment the other leg then settles: a charged failure of our own pace.
  // The read is held instead, and judged again when its place comes.
  {
    const armedState = () => { const { r, done } = rigOf(); const a = sf.settleArmedHere(); const p = sf.settleBeforeUpstream(r.req); p?.catch?.(() => {}); const b = sf.settleArmedHere(); done(); return [a, b, sf.settleArmedHere()]; };
    const [a1, a2, a3] = armedState();
    const endedRig = rigOf(); sf.disarmSettleFirst(endedRig.r.req); const a4 = sf.settleArmedHere(); sf.setSettleFirstAmbient(() => ({})); const a5 = sf.settleArmedHere(); endedRig.done();
    ok(a1 === true && a2 === false && a3 === false && a4 === false && a5 === false, `a run reads armed only between its arming and its settle point: not once the settlement started, not with no reader, not after its handler ended, not for a request that was never armed (${[a1, a2, a3, a4, a5].join()})`);
    // On arrival, the line already past the read's deadline.
    const arrivesArmed = async (then) => {
      const { g, r, pace, done } = rigOf({ windowMs: 300 });
      await pace.paced(async () => 1);
      const t0 = performance.now();
      const read = pace.paced(async () => performance.now() - t0).then((v) => ({ at: v }), (e) => ({ e, at: performance.now() - t0 }));
      await sleep(60);
      if (then === "ends") sf.disarmSettleFirst(r.req);
      if (then === "settles" || then === "fails" || then === "in-flight") { const point = sf.settleBeforeUpstream(r.req); point.catch(() => {}); if (then === "settles") g.open(); if (then === "fails") g.fail(new Error("refused")); }
      const out = await read;
      if (then === "in-flight") g.open();
      done();
      return { ...out, waiting: pace.status().waiting, refused: pace.status().refused };
    };
    const held = await arrivesArmed("nothing"), paidLater = await arrivesArmed("settles"), flying = await arrivesArmed("in-flight");
    ok(!held.e && held.at >= 200 && held.waiting === 0 && held.refused === 0, `a read of an armed run that meets a line past its deadline, before the settle point, is held and served at the next place, never the 503 (${say(held)})`);
    ok(!paidLater.e && !flying.e, `and is served when the settlement succeeds or is still in flight as its place comes (${say(paidLater)}; ${say(flying)})`);
    const failedLater = await arrivesArmed("fails"), endedLater = await arrivesArmed("ends");
    ok(failedLater.e?.secBusy === true && failedLater.at >= 200 && endedLater.e?.secBusy === true && endedLater.at >= 200 && failedLater.waiting === 0 && endedLater.waiting === 0,
      `a held read whose run's settlement failed, or whose handler ended with none, is answered the unpaid 503 when its place comes (${say(failedLater)}; ${say(endedLater)})`);
    // Admitted to the unpaid line, its deadline comes before any settle point.
    {
      const { r, pace, done } = rigOf({ windowMs: 200, maxWaitMs: 2000, queueMax: 8 });
      void r;
      await pace.paced(async () => 1);
      const others = [pace.paced(async () => 1).catch(() => 0), pace.paced(async () => 1).catch(() => 0)];
      const t0 = performance.now();
      const out = await pace.paced(async () => performance.now() - t0, { waitMs: 150 }).then((v) => ({ at: v }), (e) => ({ e, at: performance.now() - t0 }));
      await Promise.all(others);
      done();
      ok(!out.e && out.at >= 150 && pace.status().waiting === 0, `a waiting read of an armed run whose deadline comes before the settle point is held, not refused (${say(out)})`);
    }
    // The hold ends at the run's ceiling and on the caller's signal.
    {
      const { pace, done } = rigOf({ windowMs: 600 });
      await pace.paced(async () => 1);
      let cut = null, ran = 0;
      try { await withRunCeiling(120, () => pace.paced(async () => { ran++; })); } catch (x) { cut = x; }
      const ctl = new AbortController();
      const left = pace.paced(async () => { ran++; }, { signal: ctl.signal }).then(() => null, (e) => e);
      setTimeout(() => ctl.abort(), 50);
      const gone = await left;
      done();
      ok(cut?.ceilingCut === true && gone?.name === "AbortError" && ran === 0 && pace.status().waiting === 0, `the hold ends at the run's ceiling and on the caller's signal (${cut?.statusCode}, ${gone?.name}, waiting ${pace.status().waiting})`);
    }
    // Many held reads and unpaid ones together: every start is one start in the one window.
    {
      const WINDOW = 400, LIMIT = 8;
      const { pace, done } = rigOf({ perSecond: LIMIT, windowMs: WINDOW, maxWaitMs: 100, queueMax: 4 });
      const t0 = performance.now(), starts = [];
      const mark = async () => { starts.push(performance.now() - t0); };
      await Promise.all(Array.from({ length: LIMIT }, () => pace.paced(mark)));
      const outs = await Promise.all(Array.from({ length: 20 }, () => pace.paced(mark).then(() => "ran", (e) => e)));
      done();
      const most = mostPerWindow(starts, WINDOW - 60);
      ok(outs.every((o) => o === "ran") && most <= LIMIT && starts.length === LIMIT + 20, `twenty held reads of an armed run are all served, at most ${LIMIT} starts in any window (${outs.filter((o) => o === "ran").length} served, most ${most})`);
    }
    // CONTROL: the same arrivals from a run that was never armed are refused as before.
    {
      const { pace, done } = rigOf({ windowMs: 300 });
      sf.setSettleFirstAmbient(() => ({}));
      await pace.paced(async () => 1);
      const t0 = performance.now();
      const out = await pace.paced(async () => 1).then(() => ({}), (e) => ({ e }));
      const ms = performance.now() - t0;
      done();
      ok(out.e?.secBusy === true && out.e.statusCode === 503 && ms < 60 && pace.status().refused === 1, `CONTROL: a run with no armed payment cannot be held: the same read is answered 503 at once (${out.e?.statusCode} in ${Math.round(ms)} ms)`);
    }
  }
  // Many reads waiting on one settlement: when it succeeds they all start, at
  // most the pace's count in any window, with the unpaid reads counted too.
  {
    const WINDOW = 400, LIMIT = 8;
    const { g, r, pace, done } = rigOf({ perSecond: LIMIT, windowMs: WINDOW, maxWaitMs: 100, queueMax: 4 });
    const t0 = performance.now(), starts = [];
    const mark = async () => { starts.push(performance.now() - t0); };
    await Promise.all(Array.from({ length: LIMIT }, () => pace.paced(mark)));
    const point = sf.settleBeforeUpstream(r.req); point.catch(() => {});
    const reads = Array.from({ length: 20 }, () => pace.paced(mark).then(() => "ran", (e) => e));
    setTimeout(() => g.open(), 60);
    const outs = await Promise.all(reads);
    done();
    const most = mostPerWindow(starts, WINDOW - 60);
    ok(outs.every((o) => o === "ran") && most <= LIMIT && starts.length === LIMIT + 20, `twenty reads waiting on one settlement are all served once it succeeds, at most ${LIMIT} starts in any window (${outs.filter((o) => o === "ran").length} served, most ${most})`);
  }
}

// ---- each read is judged in its own request's scope ----
// The server's readers answer from the request scope an AsyncLocalStorage
// holds. The pace wakes one read from another's turn (the paid line's pump
// hands the next place back to the unpaid holder), and a timer set there
// inherits the waker's scope: every later read of "is this run paid" and "is
// its settlement in flight" must still be made in the read's OWN scope.
{
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const als = new AsyncLocalStorage();
  const gateOf = () => { let open, fail; const p = new Promise((res, rej) => { open = res; fail = rej; }); p.catch(() => {}); return { p, open, fail }; };
  const paceOf = (opts = {}) => createSecPace({ perSecond: 1, windowMs: 200, maxWaitMs: 650, callerOf: () => als.getStore()?.who || "none", leftSignalOf: () => null,
    paidOf: () => als.getStore()?.paid === true,
    pendingOf: () => { const st = als.getStore(); return st?.settling && !st.settled ? st.settling.then(() => {}, () => {}) : null; }, ...opts });
  const t0 = performance.now();
  const run = (pace, scope) => als.run(scope, () => { const s = performance.now(); return pace.turn().then(() => ({ at: performance.now() - s }), (e) => ({ e, at: performance.now() - s })); });
  const say = (o) => (o.e ? `refused ${o.e.statusCode} at ${Math.round(o.at)} ms` : `started at ${Math.round(o.at)} ms`);
  void t0;
  // An unpaid read holding the next place yields to three paid reads that
  // arrive behind it; its deadline comes while they are served.
  {
    const pace = paceOf();
    const first = run(pace, { who: "w0" });
    const unpaid = run(pace, { who: "u" });
    const paid = [1, 2, 3].map((i) => run(pace, { who: `p${i}`, paid: true }));
    const [u, ...ps] = await Promise.all([unpaid, ...paid, first]);
    ok(u.e?.secBusy === true && u.at >= 600 && u.at < 800 && ps.slice(0, 3).every((o) => !o.e), `an unpaid read woken by the paid line is refused at its own deadline, never read as paid in a paid read's scope (${say(u)}; paid ${ps.slice(0, 3).map(say).join(", ")})`);
  }
  // The same unpaid read, its payment become final while it waited: it is
  // read in its own scope when the scope that woke it no longer reads paid.
  {
    const pace = paceOf();
    const mine = { who: "u" }, waker = { who: "p1", paid: true };
    const first = run(pace, { who: "w0" });
    const waited = run(pace, mine);
    const p1 = run(pace, waker);
    const others = [2, 3].map((i) => run(pace, { who: `p${i}`, paid: true }));
    await p1;                 // the waker is served: the place went back to the waiting read from the waker's turn
    waker.paid = false;       // a scope that does not read paid
    mine.paid = true;         // this run's own payment is final
    const [w] = await Promise.all([waited, first, ...others]);
    ok(!w.e && w.at >= 650, `a read whose own payment became final is served past its deadline, whatever the scope that woke it reads (${say(w)})`);
  }
  // A read whose own run's settlement is in flight at its deadline waits for
  // THAT settlement, and is judged on its outcome, not on the waker's run.
  const settleCase = async (outcome) => {
    const pace = paceOf();
    const g = gateOf();
    const mine = { who: "u", settling: g.p };
    const first = run(pace, { who: "w0" });
    const waited = run(pace, mine);
    const paid = [1, 2, 3].map((i) => run(pace, { who: `p${i}`, paid: true }));
    let early = null;
    waited.then((o) => { if (early === null) early = o; });
    await new Promise((res) => setTimeout(res, 900)); // past the 650 ms deadline, the settlement in flight
    const before = early; early = false;
    mine.settled = true;
    if (outcome === "success") { mine.paid = true; g.open(); } else g.fail(new Error("refused"));
    const [w] = await Promise.all([waited, first, ...paid]);
    return { w, before, waiting: pace.status().waiting };
  };
  const won = await settleCase("success"), lost = await settleCase("failure");
  ok(won.before === null && lost.before === null, `a read woken by the paid line, its own settlement in flight at its deadline, is answered nothing until that settlement ends (${won.before ? say(won.before) : "waiting"}, ${lost.before ? say(lost.before) : "waiting"})`);
  ok(!won.w.e && won.waiting === 0 && lost.w.e?.secBusy === true && lost.waiting === 0, `and is judged on its own run's outcome: served when it succeeded, refused when it failed (${say(won.w)}; ${say(lost.w)})`);
  // CONTROL: with no paid read anywhere, unpaid reads are refused as before.
  {
    const pace = paceOf();
    const first = run(pace, { who: "w0" });
    const same = await Promise.all([1, 2, 3, 4, 5].map(() => run(pace, { who: "c" })));
    await first;
    ok(same.filter((o) => o.e?.secBusy === true).length >= 2 && same.filter((o) => !o.e).length >= 2, `CONTROL: one caller's unpaid reads past the deadline are refused and the rest served (${same.map(say).join("; ")})`);
  }
}

// ---- a paid read starts ahead of the unpaid line, at the same pace ----
// Unpaid reads keep arriving from distinct callers faster than the pace starts
// them, so the line always has a holder. A paid read must not wait behind it.
{
  const { setPaidBeforeRunAmbient } = await import("../src/settle-first.js");
  const WINDOW = 500, LIMIT = 8, SLACK = 250;
  let who = ["ip:0"], paid = false, n = 0;
  setPaidBeforeRunAmbient(() => paid);
  const pace = createSecPace({ perSecond: LIMIT, windowMs: WINDOW, maxWaitMs: 1500, callerOf: () => who });
  const startsAt = []; // { at, kind }
  const unpaidJobs = [];
  let onUnpaidStart = null;
  const unpaid = () => {
    paid = false; who = [`ip:${++n}`];
    unpaidJobs.push(pace.paced(async () => { startsAt.push({ at: performance.now(), kind: "unpaid" }); onUnpaidStart?.(); }).catch(() => {}));
  };
  // Forty unpaid arrivals a window against eight places.
  const feed = setInterval(() => { unpaid(); unpaid(); }, 25);
  /** The outcome, or "none" at the deadline: no fixed sleep then count. */
  const within = (p, ms) => { let t; return Promise.race([p, new Promise((r) => { t = setTimeout(() => r("none"), ms); })]).finally(() => clearTimeout(t)); };
  const paidRead = (label) => {
    paid = true; who = ["payer:0xPAID"];
    const arrived = performance.now();
    const p = pace.paced(async () => { const at = performance.now(); startsAt.push({ at, kind: "paid", label }); return { label, waited: at - arrived }; });
    paid = false;
    return p;
  };
  try {
    await sleep(WINDOW + 200); // the line is standing: the first window is spent and a holder waits
    const standing = pace.status().waiting;
    const first = await within(Promise.all([paidRead("p1"), paidRead("p2"), paidRead("p3")]), 4 * WINDOW);
    ok(standing >= LIMIT && first !== "none" && first.every((o) => o.waited <= WINDOW + SLACK),
      `under sustained unpaid demand (${standing} waiting), three paid reads each start within about one window of arriving (${first === "none" ? `none started in ${4 * WINDOW} ms` : first.map((o) => `${Math.round(o.waited)} ms`).join(", ")}; window ${WINDOW} ms)`);
    const order = startsAt.filter((x) => x.kind === "paid").map((x) => x.label).join();
    ok(first === "none" ? false : order === "p1,p2,p3", `paid reads start in the order they arrived (${order || "none"})`);
    // More paid reads than one window holds: all served, oldest first, each window's places theirs first.
    const many = await within(Promise.all(Array.from({ length: 12 }, (_, i) => paidRead(`m${i}`))), 6 * WINDOW);
    const manyOrder = startsAt.filter((x) => x.kind === "paid" && /^m/.test(x.label)).map((x) => x.label).join();
    ok(many !== "none" && Math.max(...many.map((o) => o.waited)) <= 2 * WINDOW + SLACK && manyOrder === Array.from({ length: 12 }, (_, i) => `m${i}`).join(),
      `twelve paid reads are all started inside two windows, oldest first (${many === "none" ? "not all started" : `longest ${Math.round(Math.max(...many.map((o) => o.waited)))} ms`})`);
    // One paid read at a time, arriving at ten different moments of the window:
    // each is the next start, whatever the line's holder was waiting on.
    const singles = [];
    for (let i = 0; i < 10; i++) {
      await sleep(37 + i * 23);
      const one = await within(paidRead(`s${i}`), 4 * WINDOW);
      singles.push(one === "none" ? Infinity : one.waited);
    }
    ok(singles.every((w) => w <= WINDOW + SLACK), `ten paid reads arriving one at a time each start within about one window (${singles.map((w) => (Number.isFinite(w) ? Math.round(w) : "never")).join(", ")} ms)`);
    // Paid reads stop: the unpaid line moves again, from the next place that opens.
    const lastPaid = Math.max(0, ...startsAt.filter((x) => x.kind === "paid").map((x) => x.at));
    const unpaidAfter = () => startsAt.filter((x) => x.kind === "unpaid" && x.at > lastPaid).length;
    const moved = await within(new Promise((r) => { onUnpaidStart = () => { if (unpaidAfter() >= LIMIT) r("moved"); }; onUnpaidStart(); }), 4 * WINDOW);
    ok(moved === "moved", `once paid reads stop, unpaid callers are started again (${unpaidAfter()} unpaid starts after the last paid one)`);
    ok(startsAt.some((x) => x.kind === "unpaid" && x.at < lastPaid), "and unpaid reads were started before the paid ones came");
  } finally {
    clearInterval(feed);
    onUnpaidStart = null;
    await Promise.all(unpaidJobs);
    setPaidBeforeRunAmbient(null);
  }
  // Every start, paid or not, is one start in the one window.
  const most = mostPerWindow(startsAt.map((x) => x.at), WINDOW - 10);
  ok(most <= LIMIT && most >= LIMIT - 1 && startsAt.length > 3 * LIMIT, `paid and unpaid starts together stay at eight to any rolling window (most ${most} of ${startsAt.length} starts)`);
  ok(pace.status().waiting === 0, "and nobody is left waiting");
  // A paid read that leaves hands the next place back to the line's holder.
  setPaidBeforeRunAmbient(() => paid);
  const small = createSecPace({ perSecond: 1, windowMs: 200, maxWaitMs: 2000, callerOf: () => who });
  await small.paced(async () => 1);
  paid = false; who = ["ip:holder"];
  const t0 = performance.now();
  const holder = small.paced(async () => performance.now() - t0);
  await sleep(10);
  paid = true;
  const ac = new AbortController();
  const leaver = small.paced(async () => "ran", { signal: ac.signal }).then((v) => v, (e) => e);
  paid = false;
  await sleep(10);
  ac.abort(Object.assign(new Error("caller went away"), { name: "AbortError" }));
  const [gone, at] = [await leaver, await within(holder, 1000)];
  setPaidBeforeRunAmbient(null);
  ok(gone?.name === "AbortError" && at !== "none" && at < 200 + 150 && small.status().waiting === 0, `a paid read whose caller left frees the next place for the line's holder (${gone?.name}, holder at ${at === "none" ? "never" : `${Math.round(at)} ms`})`);
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
  // The bound is what the pace can start inside the longest wait, not a multiple of it.
  const dflt = createSecPace({ perSecond: 8 }), wide = createSecPace({ perSecond: 4, windowMs: 100, maxWaitMs: 1000 });
  ok(dflt.lineMax === Math.ceil((8 * SEC_MAX_WAIT_MS) / SEC_WINDOW_MS) && wide.lineMax === 40 && createSecPace({ perSecond: 8, maxWaitMs: 100 }).lineMax === 8 && createSecPace({ perSecond: 2, queueMax: 5 }).lineMax === 5,
    `the line holds what the pace starts inside the longest wait (${dflt.lineMax} by default, ${wide.lineMax} at four per 100 ms over a second), never under one window's places`);
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

// The server names the runs that are paid before their work: an armed run
// whose settle point returned success, and the resend of a payment settled first.
{
  const server = readFileSync(join(ROOT, "src/server.js"), "utf8");
  ok(/setPaidBeforeRunAmbient\(\(\) => scopePaidBeforeRun\(currentRequestScope\(\)\)\);/.test(server) && /markSettledFirstResend\(req,[^\n]+\n[^\n]*\n\s*\{ const scope = currentRequestScope\(\); if \(scope\) scope\.settledFirstResend = true; \}/.test(server),
    "the server registers the paid-before-run reader over the armed request and the resend mark");
  // A Tempo push transfer is final before the handler: the scope is marked
  // where the claimed credential is let through to the route, after the claim.
  const claim = server.slice(server.indexOf("try { serve = await tempoPushDebts.claimForServe(req); }"), server.indexOf("req.tempoPushRefunded = true;"));
  ok(/if \(!req\.tempoSettled \|\| !tempoPushHashOf\(req\)\) return next\(\);\s+let serve = true;\s+try \{ serve = await tempoPushDebts\.claimForServe/.test(server) && /if \(serve\) \{ markFinalBeforeHandler\(currentRequestScope\(\)\); return next\(\); \}/.test(claim),
    "the server marks a claimed Tempo push credential's run as paid before its handler");
}

globalThis.fetch = realFetch;
restoreResolver();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

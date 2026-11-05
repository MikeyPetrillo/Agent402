#!/usr/bin/env node
// The EDGAR politeness gate bounded the BUILD from the start. It never bounded
// the WAIT, and those are different things. With 2 concurrent and a queue of 8,
// the last waiter could sit through four full rounds before its own build began
// - up to ~60s on a page meant to answer in one - and nothing capped it.
//
// The module's own comment claims a burst "degrades instead of piling up",
// which was true only for requests turned away PAST the queue. The eight inside
// it piled up silently. Found when a 1062-URL sitemap sweep aborted two fund
// pages at a 20s client timeout; the caller that matters is not the test but
// any crawler walking our sitemap, Googlebot included.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { __gateInternals, gateDepth } from "../src/programmatic-pages.js";

const { withGate, GATE_BUSY } = __gateInternals;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The gate's wait timer is unref'd on purpose - in production a pending HTTP
// request keeps the loop alive and the timer must not hold the process open at
// shutdown. Here the only pending work is a promise, so without this the loop
// empties and Node reports the await as unsettled rather than the timer firing.
const keepalive = setInterval(() => {}, 250);

// Occupy both slots with builds that outlast every wait budget below.
let releaseA, releaseB;
const holdA = withGate(() => new Promise((r) => { releaseA = r; }));
const holdB = withGate(() => new Promise((r) => { releaseB = r; }));
await sleep(20);
ok(gateDepth().active === 2, `gate did not fill: ${JSON.stringify(gateDepth())}`);

// --- the defect: a waiter must not wait forever -----------------------------
const t0 = Date.now();
let err = null;
try { await withGate(() => "never runs", { waitMs: 120 }); } catch (e) { err = e; }
const waited = Date.now() - t0;
ok(err === GATE_BUSY, `a queued waiter did not give up (got ${err && err.message})`);
ok(waited < 1000, `waiter blocked ${waited}ms past its budget - this is the sitemap hang`);
ok(waited >= 100, `waiter gave up in ${waited}ms, before its own budget`);

// Giving up must leave no trace in the queue, or the depth check that protects
// SEC drifts upward until every request is refused.
await sleep(10);
ok(gateDepth().waiting === 0, `abandoned waiter left in queue: ${JSON.stringify(gateDepth())}`);

// --- a permit must never be lost --------------------------------------------
// The race a naive fix loses: a waiter is signalled and gives up in the same
// tick. The permit that woke it then has no owner, and the gate quietly runs
// one slot short for the life of the process.
const results = [];
const queued = Array.from({ length: 4 }, (_, i) =>
  withGate(async () => { results.push(i); await sleep(5); return i; }, { waitMs: 5000 })
    .then((v) => ({ v }), (e) => ({ e: e === GATE_BUSY ? "busy" : String(e?.message) })));
await sleep(20);
releaseA(); releaseB();
await holdA; await holdB;
const settled = await Promise.all(queued);
ok(settled.every((r) => r.v !== undefined), `a queued build was dropped: ${JSON.stringify(settled)}`);
ok(results.length === 4, `only ${results.length} of 4 queued builds ran - a permit was lost`);
await sleep(30);
ok(gateDepth().active === 0 && gateDepth().waiting === 0,
  `gate did not drain: ${JSON.stringify(gateDepth())}`);

// --- an empty gate must not be slowed by any of this -------------------------
const t1 = Date.now();
ok(await withGate(async () => "fast") === "fast", "uncontended call broke");
ok(Date.now() - t1 < 100, "uncontended call now pays a wait it does not need");

// --- the queue ceiling still refuses outright, no waiting --------------------
let hold2 = [];
const rel = [];
for (let i = 0; i < 2; i++) hold2.push(withGate(() => new Promise((r) => rel.push(r))));
await sleep(10);
const filler = Array.from({ length: 8 }, () => withGate(async () => { await sleep(400); }, { waitMs: 60_000 }).catch(() => {}));
await sleep(20);
let over = null;
const t2 = Date.now();
try { await withGate(async () => "x", { waitMs: 60_000 }); } catch (e) { over = e; }
ok(over === GATE_BUSY, "a request past the queue ceiling was queued instead of refused");
ok(Date.now() - t2 < 100, "a request past the queue ceiling waited before being refused");
rel.forEach((r) => r());
await Promise.all(hold2); await Promise.all(filler);

clearInterval(keepalive);
// --- abandoned waiters must not be counted as queue pressure ----------------
// The queue depth is what protects SEC from us. If a waiter that gave up still
// counted, depth would drift upward until every request was refused outright -
// the gate would look saturated while nothing was actually queued.
const rel3 = [];
const held3 = [0, 1].map(() => withGate(() => new Promise((r) => rel3.push(r))));
await sleep(10);
// Enough to FILL the queue (MAX_QUEUE is 8), because that is the only depth at
// which counting abandoned entries actually shuts the door - a handful of them
// leaves room and hides the bug.
const abandoned = Array.from({ length: 8 }, () =>
  withGate(async () => "never", { waitMs: 60 }).catch((e) => (e === GATE_BUSY ? "busy" : "other")));
await sleep(200);
ok(gateDepth().waiting === 0,
  `${gateDepth().waiting} abandoned waiters still counted as queued - the SEC guard drifts shut`);
ok((await Promise.all(abandoned)).every((r) => r === "busy"), "abandoned waiters did not report busy");
// With the queue reported empty, a fresh caller must still be admitted to WAIT
// rather than refused as if the gate were full.
const t3 = Date.now();
let fresh = null;
const freshP = withGate(async () => "served", { waitMs: 5000 }).then((v) => (fresh = v), (e) => (fresh = e === GATE_BUSY ? "busy" : "err"));
await sleep(20);
rel3.forEach((r) => r());
await Promise.all(held3); await freshP;
ok(fresh === "served",
  `a fresh caller was refused behind a queue of nothing but abandoned waiters (got ${fresh}) - ` +
  "the depth guard had drifted shut with an empty queue");
await sleep(20);
ok(gateDepth().active === 0 && gateDepth().waiting === 0, `gate did not drain: ${JSON.stringify(gateDepth())}`);

clearInterval(keepalive);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

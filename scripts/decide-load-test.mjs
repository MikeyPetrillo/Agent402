// Load test: existing paid endpoints' latency with and without decide traffic.
// NOT in CI. Run against a LOCAL boot only (never production).
//
//   TARGET_URL=http://127.0.0.1:PORT node scripts/decide-load-test.mjs [--seconds 30]
//
// Phase A drives a set of existing endpoints alone; phase B drives the same
// set while a second pool hammers /api/decide. Reports p50/p95 per phase.

import { GOLDEN } from "./decide-golden-eval.mjs";

const TARGET = (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const SECONDS = arg("--seconds", 30);
const PAID_CONCURRENCY = arg("--paid", 8);
const DECIDE_CONCURRENCY = arg("--decide", 6);

const PAID = [
  () => fetch(`${TARGET}/api/hash`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `x${Math.random()}`, algo: "sha256" }) }),
  () => fetch(`${TARGET}/api/uuid`),
  () => fetch(`${TARGET}/api/json-format`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ json: '{"a":1,"b":[1,2,3]}' }) }),
];

const pct = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null; };

async function drive(pool, concurrency, until, sink) {
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (Date.now() < until) {
      const f = pool[i++ % pool.length];
      const t0 = performance.now();
      try { const r = await f(); await r.arrayBuffer(); sink.push({ ms: performance.now() - t0, ok: r.status < 500 }); }
      catch { sink.push({ ms: performance.now() - t0, ok: false }); }
    }
  }));
}

async function phase(withDecide) {
  const paid = [], decide = [];
  const until = Date.now() + SECONDS * 1000;
  const decidePool = GOLDEN.map((g) => () => fetch(`${TARGET}/api/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: g.task, depth: "plan", constraints: { maxBudgetUsd: g.budget } }) }));
  await Promise.all([
    drive(PAID, PAID_CONCURRENCY, until, paid),
    withDecide ? drive(decidePool, DECIDE_CONCURRENCY, until, decide) : Promise.resolve(),
  ]);
  const ms = paid.map((r) => r.ms);
  return {
    paid: { requests: paid.length, errors: paid.filter((r) => !r.ok).length, p50: Math.round(pct(ms, 0.5)), p95: Math.round(pct(ms, 0.95)), p99: Math.round(pct(ms, 0.99)) },
    ...(withDecide ? { decide: { requests: decide.length, errors: decide.filter((r) => !r.ok).length, p50: Math.round(pct(decide.map((r) => r.ms), 0.5)), p95: Math.round(pct(decide.map((r) => r.ms), 0.95)) } } : {}),
  };
}

const a = await phase(false);
const b = await phase(true);
const out = { seconds: SECONDS, alone: a, withDecide: b, p95ChangeMs: b.paid.p95 - a.paid.p95 };
console.log(JSON.stringify(out, null, 2));

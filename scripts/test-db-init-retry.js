// src/db-init-retry.js + the analytics explicit-init contract. Offline.
// Pins: the retry schedule after failures, stop on success, no retry on
// "no-db", exhaustion leaves on-demand only, timers unref'd; and that an
// explicit initAnalyticsDb after a failure RETRIES (the 5-min backoff is for
// the per-call path, not for a deliberate init) and never reports ok when no
// pool could be built.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert/strict";
import { initWithRetry } from "../src/db-init-retry.js";

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

// A fake scheduler that records delays and lets the test fire them.
function fakeSchedule() {
  const queue = [];
  const schedule = (fn, ms) => { const t = { fn, ms, unref: () => { t.unrefd = true; } }; queue.push(t); return t; };
  return { queue, schedule, fire: async () => { const t = queue.shift(); await t.fn(); return t; } };
}

// fails twice, then ok
{
  const sched = fakeSchedule(); const logs = []; const results = [];
  let n = 0;
  const init = async () => (++n < 3 ? { ok: false, reason: "init-failed" } : { ok: true });
  await initWithRetry("t", init, { delaysMs: [20, 60, 300], onResult: (r, a) => results.push([r.ok, a]), log: (m) => logs.push(m), schedule: sched.schedule });
  ok(sched.queue.length === 1 && sched.queue[0].ms === 20, "first failure schedules the first delay");
  ok(sched.queue[0].unrefd === true, "retry timer is unref'd (never holds the process open)");
  await sched.fire();
  ok(sched.queue.length === 1 && sched.queue[0].ms === 60, "second failure schedules the second delay");
  await sched.fire();
  ok(sched.queue.length === 0, "success schedules nothing more");
  ok(n === 3, "init called exactly three times");
  ok(JSON.stringify(results) === JSON.stringify([[false, 1], [false, 2], [true, 3]]), "onResult sees every attempt with its number");
  ok(logs.some((m) => /ready \(attempt 3\)/.test(m)), "success log names the attempt");
}
// no-db never retries
{
  const sched = fakeSchedule();
  await initWithRetry("t", async () => ({ ok: false, reason: "no-db" }), { schedule: sched.schedule, log: () => {} });
  ok(sched.queue.length === 0, "no-db: nothing scheduled");
}
// exhaustion
{
  const sched = fakeSchedule(); const logs = [];
  await initWithRetry("t", async () => ({ ok: false, reason: "init-failed" }), { delaysMs: [1], schedule: sched.schedule, log: (m) => logs.push(m) });
  await sched.fire();
  ok(sched.queue.length === 0 && logs.some((m) => /after 2 attempts; on-demand retry only/.test(m)), "exhausted schedule stops and says so");
}
// a throwing init is a failure, not a crash
{
  const sched = fakeSchedule();
  const r = await initWithRetry("t", async () => { throw new Error("boom"); }, { delaysMs: [5], schedule: sched.schedule, log: () => {} });
  ok(r.ok === false && sched.queue.length === 1, "throw -> failed attempt, retry scheduled");
}

// analytics: explicit init after a failure retries and never reports ok pool-less
process.env.ANALYTICS_DATABASE_URL = "postgres://u:p@127.0.0.1:1/x"; // refused port: fails fast
const { initAnalyticsDb, analyticsEnabled } = await import("../src/analytics-db.js");
const r1 = await initAnalyticsDb();
ok(r1.ok === false && r1.reason === "init-failed", "refused port -> init-failed");
ok(analyticsEnabled() === false, "backoff engaged after the failure");
const r2 = await initAnalyticsDb();
ok(r2.ok === false && r2.reason === "init-failed", "explicit re-init RETRIES (does not report ok from behind the backoff)");

// server.js wires both inits through the retry
const fs = await import("node:fs");
const srv = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
ok(/initWithRetry\("leads-db", initLeadsDb/.test(srv) && /initWithRetry\("analytics-db", initAnalyticsDb/.test(srv), "server.js boots both databases through initWithRetry");
for (const f of ["leads-db", "analytics-db"]) {
  const src = fs.readFileSync(new URL(`../src/${f}.js`, import.meta.url), "utf8");
  const m = src.match(/connectionTimeoutMillis:\s*([\d_]+)/);
  ok(m && Number(m[1].replace(/_/g, "")) >= 20_000, `${f}: handshake timeout outlives the boot stall (>= 20 s)`);
}
console.log(`db-init-retry: ${passed} passed, 0 failed`);
process.exit(0);

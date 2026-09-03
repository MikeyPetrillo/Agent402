// src/db-status.js: the Postgres reachability buckets on /api/gateway-status.
// Offline: pings are injected. Pins (1) the three buckets, (2) a hung ping is
// "unreachable" within the timeout, never a hang, (3) the 60 s cache, (4) the
// public shape carries STATUS WORDS ONLY - no host, error text or latency -
// and (5) the analytics backoff replaced the permanent latch.
import assert from "node:assert/strict";
import { databasesStatus, resetDatabasesStatusCache } from "../src/db-status.js";

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

const never = () => new Promise(() => {});
const boom = () => { throw new Error("connect ECONNREFUSED 10.0.0.1:5432 host=postgres.railway.internal"); };

// (1) buckets
resetDatabasesStatusCache();
let r = await databasesStatus({ pings: { leads: async () => null, analytics: async () => true }, timeoutMs: 200, cacheMs: 0 });
ok(r.leads.status === "unconfigured", "no URL -> unconfigured");
ok(r.analytics.status === "ok", "SELECT 1 answered -> ok");
r = await databasesStatus({ pings: { leads: boom, analytics: async () => { throw new Error("timeout"); } }, timeoutMs: 200, cacheMs: 0 });
ok(r.leads.status === "unreachable" && r.analytics.status === "unreachable", "throw -> unreachable");

// (2) a hung ping resolves "unreachable" inside the timeout
const t0 = Date.now();
r = await databasesStatus({ pings: { leads: never, analytics: never }, timeoutMs: 150, cacheMs: 0 });
ok(r.leads.status === "unreachable" && Date.now() - t0 < 1000, "hung ping -> unreachable within timeout");

// (2b) a FAILED reading is not held for the long cache: the observers'
// second reading 20-30 s later must be a fresh ping (2026-09-02: five pages,
// each a single failed ping read twice against the 60 s cache).
{
  resetDatabasesStatusCache();
  let n = 0; let now2 = 5_000_000; const logs = [];
  const flaky = { leads: async () => { n++; if (n === 1) throw new Error("timeout"); return true; }, analytics: async () => true };
  const first = await databasesStatus({ pings: flaky, now: () => now2, timeoutMs: 200, cacheMs: 60_000, failureCacheMs: 5_000, log: (l) => logs.push(l) });
  ok(first.leads.status === "unreachable", "first reading: the failed ping reads unreachable");
  ok(logs.length === 1 && /\[db-status\] leads ping failed after \d+ms: timeout/.test(logs[0]), `a failed ping leaves a redacted server-log line (${logs[0]})`);
  const second = await databasesStatus({ pings: flaky, now: () => now2 + 20_000, timeoutMs: 200, cacheMs: 60_000, failureCacheMs: 5_000, log: () => {} });
  ok(second.leads.status === "ok" && n === 2, "a reading 20 s later re-pings and clears (a failure is cached 5 s, never 60 s)");
  const third = await databasesStatus({ pings: flaky, now: () => now2 + 30_000, timeoutMs: 200, cacheMs: 60_000, failureCacheMs: 5_000, log: () => {} });
  ok(third.leads.status === "ok" && n === 2, "a SUCCESS keeps the 60 s cache (no connection storm)");
  resetDatabasesStatusCache();
}

// (3) cache: a second call inside the window does not ping again
resetDatabasesStatusCache();
let calls = 0;
const counting = { leads: async () => { calls++; return true; }, analytics: async () => { calls++; return true; } };
let now = 1_000_000;
await databasesStatus({ pings: counting, now: () => now, timeoutMs: 200, cacheMs: 60_000 });
await databasesStatus({ pings: counting, now: () => now + 30_000, timeoutMs: 200, cacheMs: 60_000 });
ok(calls === 2, `cached inside 60 s (pinged ${calls} times, want 2)`);
await databasesStatus({ pings: counting, now: () => now + 61_000, timeoutMs: 200, cacheMs: 60_000 });
ok(calls === 4, "re-pinged after the window");

// (4) public shape: status words only, and the error text never leaks
resetDatabasesStatusCache();
r = await databasesStatus({ pings: { leads: boom, analytics: boom }, timeoutMs: 200, cacheMs: 0 });
const body = JSON.stringify(r);
ok(!/railway\.internal|ECONNREFUSED|10\.0\.0\.1|5432/.test(body), "no host/address/port/error text in the public shape");
ok(Object.keys(r).sort().join() === "analytics,checkedAt,leads", "keys are exactly leads/analytics/checkedAt");
ok(Object.keys(r.leads).join() === "status", "per-database object carries only status");
for (const s of [r.leads.status, r.analytics.status]) ok(["ok", "unreachable", "unconfigured"].includes(s), "status is one of three words");

// (5) the analytics module has no permanent latch any more
const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/analytics-db.js", import.meta.url), "utf8"));
ok(!/^\s*unavailable = true;/m.test(src), "analytics-db: permanent `unavailable = true` latch is gone");
ok(/unavailableUntil = Date\.now\(\) \+ RETRY_AFTER_MS/.test(src), "analytics-db: failed init backs off with RETRY_AFTER_MS");
ok(/export async function pingAnalyticsDb/.test(src), "analytics-db exports pingAnalyticsDb");
const leads = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/leads-db.js", import.meta.url), "utf8"));
ok(/export async function pingLeadsDb/.test(leads), "leads-db exports pingLeadsDb");

// (6) the heartbeat has the leg and it reads the fields this module emits
const hb = await import("node:fs").then((fs) => fs.readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8"));
ok(/\.databases\.leads\.status/.test(hb) && /\.databases\.analytics\.status/.test(hb), "heartbeat reads databases.{leads,analytics}.status");
ok(/Postgres UNREACHABLE/.test(hb), "heartbeat opens the Postgres UNREACHABLE issue");
// SINGLE RETRY, like every other probe in that file. Without it the leg paged
// on 2026-08-29 during our OWN deploy: the service is volume-backed, so every
// deploy has a no-container window and the pools re-init behind the boot stall
// after it. The boot log said "[leads-db] ready" three minutes before the issue
// was filed. An alarm that fires on a state which heals itself trains everyone
// to ignore it.
const pgLeg = hb.slice(hb.indexOf("Postgres reachability check"), hb.indexOf("Upstream buyer wallet trend"));
ok(/probe_db\(\)/.test(pgLeg), "the Postgres leg factors its read into a re-runnable probe");
ok(/sleep 30[\s\S]*probe_db/.test(pgLeg), "an unreachable first read is re-probed after a delay before paging");
ok(pgLeg.indexOf("gh issue create") > pgLeg.indexOf("sleep 30"), "the issue is only filed AFTER the second read");

console.log(`db-status: ${passed} passed, 0 failed`);

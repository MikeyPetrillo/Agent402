// Reachability of the two Postgres databases, bucketed for a PUBLIC surface.
//
// Why this exists: both Postgres containers on the platform were down from
// 2026-07-02 until a platform-side image redeploy restarted them on
// 2026-08-25 - 54 days - and nothing paged. The app degrades gracefully
// (leads/analytics simply go dark), which is right for buyers and exactly
// why nobody noticed. This is the alarm: `/api/gateway-status.databases`
// carries one bucket per database and the heartbeat opens an issue on
// "unreachable".
//
// The endpoint is public, so the answer is a STATUS WORD only - never a
// host, port, address, error text or latency (those go to the server log via
// src/db-probe.js at init time). Cached for 60 s so a poll cannot become a
// connection storm against a database that is already struggling.

const STATUS_CACHE_MS = 60_000;
// A FAILED reading is cached only briefly. Both observers outside production
// confirm an alarm with a second reading 20-30 s after the first, and with a
// 60 s cache that second reading was the SAME failed ping: five "Postgres
// UNREACHABLE" pages on 2026-09-02, each minutes after one of our own deploys,
// while the boot log showed both pools ready at the first attempt. A success
// keeps the long cache (a poll must not become a connection storm against a
// struggling database); a failure is re-pinged by the next reading, so
// "confirmed" means two failed pings, not one failed ping read twice.
const FAILURE_CACHE_MS = 5_000;
// The ping timeout sits above the post-listen event-loop stalls prod measures
// (7.8 s and 11.6 s at 20:07 that day): a stall blocks the query AND the timer,
// and when the loop resumes the timer fires first if it is the shorter one.
// Bounded by the observers' 15 s fetch budget on /api/gateway-status.
const PING_TIMEOUT_MS = 12_000;

let cache = null; // { at, value }

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// `ping` resolves when `SELECT 1` answered; rejects/throws otherwise; returns
// null when that database is not configured at all.
async function bucket(name, ping, timeoutMs, log) {
  const started = Date.now();
  try {
    const r = await withTimeout(Promise.resolve().then(ping), timeoutMs);
    if (r === null) return "unconfigured";
    return "ok";
  } catch (e) {
    // Server log only, and only the failure CLASS: the public surface stays a
    // status word, but the next false page needs evidence in the log.
    try { log(`[db-status] ${name} ping failed after ${Date.now() - started}ms: ${e?.message === "timeout" ? "timeout" : (e?.code || e?.name || "error")}`); } catch { /* log is best effort */ }
    return "unreachable";
  }
}

export async function databasesStatus({ pings, now = Date.now, timeoutMs = PING_TIMEOUT_MS, cacheMs = STATUS_CACHE_MS, failureCacheMs = FAILURE_CACHE_MS, log = console.log } = {}) {
  const t = now();
  if (cache && t - cache.at < (cache.failed ? Math.min(failureCacheMs, cacheMs) : cacheMs)) return cache.value;
  let p = pings;
  if (!p) {
    const [{ pingLeadsDb }, { pingAnalyticsDb }] = await Promise.all([import("./leads-db.js"), import("./analytics-db.js")]);
    p = { leads: pingLeadsDb, analytics: pingAnalyticsDb };
  }
  const [leads, analytics] = await Promise.all([bucket("leads", p.leads, timeoutMs, log), bucket("analytics", p.analytics, timeoutMs, log)]);
  const value = { leads: { status: leads }, analytics: { status: analytics }, checkedAt: new Date(t).toISOString() };
  cache = { at: t, value, failed: leads === "unreachable" || analytics === "unreachable" };
  return value;
}

export function resetDatabasesStatusCache() { cache = null; }

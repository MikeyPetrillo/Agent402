// One long event-loop stall pages, and a stall names what it was running.
//
// serving-health used to degrade only on a stall COUNT per hour, so one long
// stall that froze a paid call raised nothing; and a stall with no request in
// flight (background work) could not say which job held the loop. This suite
// covers the single-stall alarm (ALERT_STALL_MS), the job name in the stall
// context for work under leased(), the bounded stall ring the operator reads
// expose, and the serving-health wiring. Offline, no server.
//
// Every check is counted and the suite fails at the end, so a run against the
// old code reports how many checks it fails instead of stopping at the first.
import { readFileSync } from "node:fs";

delete process.env.STATE_DATABASE_URL; // leased() runs fn directly without a database
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`not ok - ${m}`); } };
const tryImport = async (p) => { try { return await import(p); } catch (e) { console.log(`# import ${p} failed: ${String(e?.message || e).slice(0, 120)}`); return {}; } };
const fn = (f) => typeof f === "function";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* hold the loop */ } };

// --- the threshold ------------------------------------------------------------
const lag = await tryImport("../src/loop-lag.js");
ok(fn(lag.stallAlarmMsFromEnv) && lag.stallAlarmMsFromEnv(undefined) === 5000, "ALERT_STALL_MS defaults to 5000 ms");
ok(fn(lag.stallAlarmMsFromEnv) && lag.stallAlarmMsFromEnv("12000") === 12000, "ALERT_STALL_MS takes a number");
ok(fn(lag.stallAlarmMsFromEnv) && lag.stallAlarmMsFromEnv("off") === 0 && lag.stallAlarmMsFromEnv("OFF") === 0, "ALERT_STALL_MS=off disables the single-stall alarm");
ok(fn(lag.stallAlarmMsFromEnv) && lag.stallAlarmMsFromEnv("junk") === 5000, "an unreadable ALERT_STALL_MS keeps the default rather than switching the alarm off");

// --- one long stall degrades on its own -----------------------------------------
{
  const L = await tryImport("../src/loop-lag.js?single");
  const now = Date.now();
  if (fn(L.recordStall)) {
    L.recordStall({ at: now - 120_000, ms: 1500, inFlight: ["GET /api/pricing 1400ms"], jobs: [] });
    ok(fn(L.longStallVerdict) && L.longStallVerdict(5000, 3600_000, now).degraded === false, "a short stall alone does not degrade");
    L.recordStall({ at: now - 60_000, ms: 21_000, gcMs: 40, inFlight: ["POST /api/web-search 20500ms", "GET /v1/models 300ms"], jobs: ["x402-index-crawl"] });
  } else ok(false, "loop-lag records a stall (recordStall)");
  const v = fn(L.longStallVerdict) ? L.longStallVerdict(5000, 3600_000, now) : {};
  ok(L.stallsInWindow?.(3600_000, now).count === 2, "two stalls in the hour: far under the per-hour count the old rule needed");
  ok(v.degraded === true, "ONE stall at or past ALERT_STALL_MS in the last hour degrades");
  ok(JSON.stringify(v.culprits?.routes) === JSON.stringify(["POST /api/web-search", "GET /v1/models"]), `the verdict names the routes in flight during the long stall, without their ages (${JSON.stringify(v.culprits)})`);
  ok(JSON.stringify(v.culprits?.jobs) === JSON.stringify(["x402-index-crawl"]), "the verdict names the background jobs of the long stall");
  ok(fn(L.longStallVerdict) && !L.longStallVerdict(5000, 3600_000, now).culprits.routes.includes("GET /api/pricing"), "a short stall's routes are not named as culprits");
  ok(fn(L.longStallVerdict) && L.longStallVerdict(0, 3600_000, now).degraded === false, "with the alarm off the long stall does not degrade");
  ok(fn(L.longStallVerdict) && L.longStallVerdict(5000, 3600_000, now + 3_700_000).degraded === false, "a long stall older than an hour no longer degrades");
}

// --- the ring stays bounded -----------------------------------------------------
{
  const L = await tryImport("../src/loop-lag.js?ring");
  if (fn(L.recordStall)) for (let i = 0; i < 130; i++) L.recordStall({ at: Date.now() - (130 - i), ms: 1000 + i, inFlight: [], jobs: [] });
  const ring = fn(L.recentStalls) ? L.recentStalls() : [];
  ok(ring.length === 50, `the stall ring keeps the last 50 (${ring.length})`);
  ok(ring[0]?.ms === 1129 && ring[49]?.ms === 1080, "newest first, oldest dropped");
  ok(ring.every((r) => typeof r.at === "string" && "gcMs" in r && Array.isArray(r.inFlight) && Array.isArray(r.jobs) && !("atMs" in r)), "each row carries time, ms, gc ms, in-flight and jobs");
  if (ring[0]) ring[0].jobs.push("mutated");
  ok(fn(L.recentStalls) && !L.recentStalls()[0].jobs.includes("mutated"), "a reader gets copies, not the ring itself");
}

// --- a stall inside leased() names the job ---------------------------------------
{
  const L = await tryImport("../src/loop-lag.js");
  const { leased } = await tryImport("../src/state-db.js");
  const lines = [];
  const stop = fn(L.startLoopLagMonitor) ? L.startLoopLagMonitor({ tickMs: 40, warnMs: 150, log: (s) => lines.push(s), statsLog: () => {} }) : () => {};
  await sleep(120);
  // A job that holds the loop in the middle of its run, and one that holds it
  // in its last synchronous stretch (it has finished before the lag timer fires).
  const mid = leased("stall-test-mid", {}, async () => { await sleep(5); busy(400); await sleep(60); });
  const tail = leased("stall-test-tail", {}, async () => { await sleep(5); busy(400); });
  await mid();
  await sleep(150);
  await tail();
  await sleep(150);
  busy(400); // no job at all
  await sleep(150);
  stop();
  const stallLines = lines.filter((l) => l.startsWith("[loop-lag]"));
  ok(stallLines.length >= 3, `three blocks, three stall lines (${stallLines.length})`);
  ok(stallLines.some((l) => / jobs: stall-test-mid\b/.test(l)), "a stall inside a leased() job names it on the [loop-lag] line");
  ok(stallLines.some((l) => / jobs: stall-test-tail\b/.test(l)), "...also when the job finished in the same stretch that held the loop");
  ok(stallLines.length >= 3 && !/ jobs: /.test(stallLines[stallLines.length - 1]), `a stall outside any job names none (${stallLines[stallLines.length - 1]})`);
  const ring = fn(L.recentStalls) ? L.recentStalls() : [];
  ok(ring.some((r) => r.jobs.includes("stall-test-mid")) && ring.some((r) => r.jobs.includes("stall-test-tail")), "the stall ring records the job names");
  const jobs = await tryImport("../src/active-jobs.js");
  ok(fn(jobs.activeJobs) && jobs.activeJobs().length === 0, "a finished job leaves the active set");
  let threw = false;
  try { await leased("stall-test-throws", {}, async () => { throw new Error("boom"); })(); } catch { threw = true; }
  ok(threw && fn(jobs.activeJobs) && jobs.activeJobs().length === 0, "a job that throws still leaves the active set, and the error reaches the caller");
}

// --- serving health and the operator reads are wired ------------------------------
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const at = src.indexOf("function servingHealth()");
  const body = src.slice(at, src.indexOf("\n}\n", at));
  ok(/stallMs: stallAlarmMsFromEnv\(process\.env\.ALERT_STALL_MS\)/.test(src), "serving health reads its threshold from ALERT_STALL_MS");
  ok(/longStallVerdict\(SERVING\.stallMs/.test(body) && /reasons\.push\("stall"\)/.test(body), "serving health degrades with reason \"stall\" on the single-stall verdict");
  ok(/stallCulprits: longStall\.culprits/.test(body) && /recentStalls: recentStalls\(\)/.test(body), "serving-health.json names the culprits and carries the stall ring");
  const perf = src.slice(src.indexOf('app.get("/__operator/perf.json"'), src.indexOf("\n});", src.indexOf('app.get("/__operator/perf.json"')));
  ok(/recentStalls: recentStalls\(\)/.test(perf) && /activeJobs: activeJobs\(\)/.test(perf), "perf.json carries the stall ring and the running jobs");
  ok(/runAsJob\("revenue-snapshot"/.test(src), "the revenue keep-warm timer (not under a lease) runs as a named job");
  ok(/runAsJob\(surfaceJobName\(key\), buildAsync\)/.test(src), "background surface rebuilds run as named jobs");
  const sd = readFileSync(new URL("../src/state-db.js", import.meta.url), "utf8");
  const wl = sd.slice(sd.indexOf("export async function withLease("), sd.indexOf("function markLeaseLost("));
  ok((wl.match(/await fn\(/g) || []).length === 0 && (wl.match(/runAsJob\(name, \(\) => fn\(/g) || []).length === 3, "every path in withLease that runs fn runs it as the named job");
}

console.log(`test-stall-alarm: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

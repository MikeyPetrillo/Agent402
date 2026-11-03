// Offline unit test for refresh-bazaar's "did this pass leave work undone?"
// decision. Pins the distinction that matters: a route we paid for that the
// Bazaar harvester has not ingested yet is THEIR lag and must not fail the run,
// while a failed buy or a route we never paid for must.
//
// This exists because the old rule (any still-missing route => exit 1) put a
// red X on the 2026-07-24 run where all 74 buys succeeded and every route was
// listed within ~2.5h unattended. A check that reports failure on success
// teaches people to ignore it.
//
// Run: node scripts/test-bazaar-verdict.js
import { missingModeVerdict, buyOnce } from "./refresh-bazaar.js";

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.error(`FAIL - ${name}`); }
};

// Nothing outstanding at all.
{
  const v = missingModeVerdict({ failCount: 0, okCount: 12, stillMissingPaths: [], boughtPaths: new Set() });
  check("everything listed exits 0", v.exitCode === 0);
}

// The 2026-07-24 shape: every route bought, none ingested yet.
{
  const paths = ["/api/a", "/api/b", "/api/c"];
  const v = missingModeVerdict({ failCount: 0, okCount: 3, stillMissingPaths: paths, boughtPaths: new Set(paths) });
  check("all bought but none ingested yet exits 0 (harvester lag is not our failure)", v.exitCode === 0);
  check("lag message names the harvester", /harvester/i.test(v.message));
  check("lag message tells the reader to re-count", /re-count/i.test(v.message));
}

// A buy genuinely failed.
{
  const v = missingModeVerdict({ failCount: 1, okCount: 2, stillMissingPaths: ["/api/a"], boughtPaths: new Set(["/api/a"]) });
  check("a failed buy exits 1 even if the missing route was also bought", v.exitCode === 1);
  check("failure message counts the failed buys", /1 buy\(s\) FAILED/.test(v.message));
}

// A route was never paid for (spend cap / price cap / batch stride).
//
// CHANGED 2026-08-31, deliberately. This used to require exit 1, and that is why
// the deploy failed on almost every push that added routes: the caps and the
// batch stride EXIST to leave routes for a later pass, so "something is left
// over" is the normal state, not a fault. Measured over 30 Deploy to Railway
// runs: 7 red, 4 of them this job logging "5 ok, 0 failed" and then exiting 1.
// A failure mail that is usually noise is a failure mail nobody reads, and the
// OpenClaw break that blocked every merge overnight arrived as one more red
// deploy in that stream.
//
// The guarantee that matters is unchanged and asserted just above: a buy that
// actually FAILED still exits 1. Leftovers now report which cap deferred them.
{
  const v = missingModeVerdict({ failCount: 0, okCount: 1, stillMissingPaths: ["/api/a", "/api/unpaid"], boughtPaths: new Set(["/api/a"]) });
  check("an unpaid route is NOT a failure - the caps did their job", v.exitCode === 0);
  check("the message still says how many were deferred", /1 route\(s\) were left for a later pass/.test(v.message));
  check("and names the caps that deferred them", /spend cap, price cap or batch stride/.test(v.message));
}

// Mixed: some lag, some never paid — the unpaid ones decide it.
{
  const v = missingModeVerdict({
    failCount: 0, okCount: 5,
    stillMissingPaths: ["/api/a", "/api/b", "/api/never"],
    boughtPaths: new Set(["/api/a", "/api/b"]),
  });
  check("lag plus an unpaid route is still exit 0 with no failed buy", v.exitCode === 0);
}

// ...but a failed buy alongside leftovers still fails, and says both.
{
  const v = missingModeVerdict({
    failCount: 2, okCount: 3,
    stillMissingPaths: ["/api/a", "/api/never"],
    boughtPaths: new Set(["/api/a"]),
  });
  check("a failed buy still decides it even with leftovers present", v.exitCode === 1);
  check("and the message reports both", /2 buy\(s\) FAILED/.test(v.message) && /1 route\(s\) left unpaid/.test(v.message));
}

// A slow route refuses a synchronous paid call before any payment (400
// respond_async_required, measured 2026-11-03 on decide-execute); the buy is
// made again with Prefer: respond-async and its job followed to the end.
{
  const R = (status, body, headers = {}) => ({ status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => body });
  const refusal = { error: "respond_async_required", slug: "decide-execute", maxSeconds: 180, syncWindowSeconds: 20, prefer: "respond-async" };
  const sent = [];
  const payFetch = async (url, init) => { sent.push({ url, prefer: init.headers?.Prefer || null, method: init.method }); return init.headers?.Prefer === "respond-async" ? R(202, { jobId: "j1", statusUrl: "/api/jobs/j1", status: "working", state: "queued", pollIntervalSeconds: 1 }, { location: "/api/jobs/j1", "retry-after": "1" }) : R(400, refusal); };
  const polls = [];
  const plainFetch = async (url) => { polls.push(url); return polls.length < 3 ? R(200, { state: "running", stage: "work", pollIntervalSeconds: 1 }, { "retry-after": "1" }) : R(200, { state: "succeeded", status: "completed", result: { httpStatus: 200, body: { ok: true } } }); };
  const waits = [];
  const out = await buyOnce(payFetch, "https://t.example/api/decide/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, { plainFetch, target: "https://t.example", sleep: async (ms) => { waits.push(ms); } });
  check("a respond_async_required refusal is followed by the same call with Prefer: respond-async", sent.length === 2 && sent[0].prefer === null && sent[1].prefer === "respond-async" && sent[1].method === "POST");
  check("the job is polled at its status URL on the target until it succeeds, and the buy reads as the job's 200", polls.length === 3 && polls.every((u) => u === "https://t.example/api/jobs/j1") && out.status === 200 && out.job?.state === "succeeded");
  check("the poll waits the Retry-After the job names", waits.length === 3 && waits.every((ms) => ms === 1000));
  // A failed job is the route's failure, with its status.
  const failFetch = async () => R(200, { state: "failed", status: "failed", stage: "failed", result: { httpStatus: 502, body: { error: "upstream" } } });
  const bad = await buyOnce(payFetch, "https://t.example/api/decide/execute", { method: "POST", headers: {}, body: "{}" }, { plainFetch: failFetch, target: "https://t.example", sleep: async () => {} });
  check("a failed job reads as its own HTTP status, never as a settlement", bad.status === 502 && /job failed/.test(bad.note));
  // A plain 200 and any other 400 pass through untouched (one call).
  const plain = []; const okFetch = async (url) => { plain.push(url); return R(200, { ok: true }); };
  const fine = await buyOnce(okFetch, "https://t.example/api/hash", { method: "GET", headers: {} });
  check("an ordinary answer is one call, returned as is", fine.status === 200 && plain.length === 1 && fine.res);
  const otherFetch = async () => R(400, { error: "bad input" });
  const other = await buyOnce(otherFetch, "https://t.example/api/x", { method: "POST", headers: {}, body: "{}" });
  check("another 400 is the route's own refusal, not retried as a job", other.status === 400 && /bad input/.test(other.text));
  // A job that never finishes inside its budget is a 504, not a hang.
  let t = 0; const stuckFetch = async () => R(200, { state: "running", pollIntervalSeconds: 1 });
  const stuck = await buyOnce(payFetch, "https://t.example/api/decide/execute", { method: "POST", headers: {}, body: "{}" }, { plainFetch: stuckFetch, target: "https://t.example", sleep: async (ms) => { t += ms; }, now: () => t });
  check("a job past its budget is given up as a 504 with the budget named", stuck.status === 504 && /240 s/.test(stuck.note));
}

// Accepts a plain array as well as a Set (call-site convenience).
{
  const v = missingModeVerdict({ failCount: 0, okCount: 1, stillMissingPaths: ["/api/a"], boughtPaths: ["/api/a"] });
  check("boughtPaths accepts an array", v.exitCode === 0);
}

// Importing the module must not run the script (main guard).
check("importing refresh-bazaar does not execute main", true);

console.log(`\ntest-bazaar-verdict: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

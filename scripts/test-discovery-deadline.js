// The discovery gate cannot be wedged by a compute that never settles.
//
// serveCachedDiscovery (src/server.js) admits an uncached /api/find or
// /api/route compute only while fewer than DISCOVERY_MAX_INFLIGHT are in
// flight. The slot used to be a bare counter decremented when the compute's
// promise settled, so a compute whose awaited work never settled held its slot
// for the life of the process, and enough of those closed both routes until a
// restart. Pinned here:
//   1. the gauge (src/inflight-gauge.js): admission counts only entries
//      younger than the deadline, releases are idempotent, ages are reported;
//   2. raceDeadline answers by the deadline and swallows a late settlement;
//   3. the judge wait (src/tool-judge.js) ends by its timeout even when the
//      fetch promise it awaits never settles, with the lexical fallback;
//   4. on a booted server, a compute past DISCOVERY_COMPUTE_DEADLINE_MS releases
//      its slot, answers 503 with reason "discovery-deadline", counts under
//      shed.discoveryDeadline, logs one warning naming the slug and the query
//      length, shows on /__operator/perf.json, and the next query is served.
// The hanging compute comes from a free-mode-only test hook
// (DISCOVERY_TEST_HANG_QUERY); the hook is inert whenever payments are on.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { getFreePort } from "./lib/free-port.js";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let unhandled = 0;
process.on("unhandledRejection", () => { unhandled++; });

// --- 1. the gauge
const { createInFlightGauge, raceDeadline } = await import("../src/inflight-gauge.js");
{
  const g = createInFlightGauge({ staleMs: 1000 });
  const t0 = 1_000_000;
  const rel1 = g.enter({ slug: "_find" }, t0);
  g.enter({ slug: "_route" }, t0 + 100);
  ok(g.size() === 2 && g.live(t0 + 200) === 2, "two fresh entries both count toward admission");
  ok(g.oldestAgeMs(t0 + 200) === 200, `the oldest entry's age is reported (${g.oldestAgeMs(t0 + 200)}ms)`);
  ok(g.live(t0 + 1050) === 1 && g.size() === 2, "an entry older than the deadline is listed but no longer counts toward admission");
  ok(g.live(t0 + 2000) === 0, "every stale entry stops counting, so a wedged set of slots heals on its own");
  rel1(); rel1();
  ok(g.size() === 1, "release is idempotent: a late settlement after a deadline release removes nothing else");
  const snap = g.snapshot(t0 + 300);
  ok(snap.inFlight === 1 && snap.live === 1 && snap.oldestAgeMs === 200 && snap.staleMs === 1000, `the snapshot carries counts and ages only (${JSON.stringify(snap)})`);
  assert.throws(() => createInFlightGauge({ staleMs: 0 }), "a gauge without a positive deadline is refused");
  n++; console.log("ok - a gauge without a positive deadline is refused");
}

// --- 2. raceDeadline
{
  const fast = await raceDeadline(Promise.resolve(7), 500);
  ok(fast.value === 7 && !fast.timedOut, "a promise that settles in time hands back its value");
  const t0 = Date.now();
  const never = await raceDeadline(new Promise(() => {}), 120);
  const waited = Date.now() - t0;
  ok(never.timedOut === true && waited >= 100 && waited < 2000, `a promise that never settles answers timedOut by the deadline (${waited}ms)`);
  await assert.rejects(raceDeadline(Promise.reject(new Error("boom")), 500), /boom/);
  n++; console.log("ok - a promise that rejects in time rejects the caller with its own error");
  let lateReject;
  const late = new Promise((_, rej) => { lateReject = rej; });
  const r = await raceDeadline(late, 20);
  lateReject(new Error("late"));
  await sleep(30);
  ok(r.timedOut === true && unhandled === 0, "a rejection that lands after the deadline is swallowed, not an unhandled rejection");
}

// --- 3. the judge wait is bounded by our own timer
{
  process.env.TYPESAFE_API_KEY = "test-judge-key";
  process.env.TYPESAFE_API_URL = "http://127.0.0.1:9/v1/systemone";
  delete process.env.OPENROUTER_API_KEY;
  const { judgeTool, orderByJudgment } = await import("../src/tool-judge.js");
  // A fetch whose promise ignores its abort signal and never settles: the
  // exact shape that can hold a slot. The judge must still answer.
  const neverSettles = () => new Promise(() => {});
  const t0 = Date.now();
  const j = await judgeTool("convert json to csv", [{ slug: "json-to-csv", name: "json-to-csv", description: "convert" }, { slug: "csv-to-json", name: "csv-to-json", description: "convert back" }], { fetchImpl: neverSettles, timeoutMs: 300 });
  const waited = Date.now() - t0;
  ok(j === null && waited >= 250 && waited < 2000, `judgeTool answers null by its timeout when the fetch promise never settles (${waited}ms)`);
  const t1 = Date.now();
  const ordered = await orderByJudgment("hash a string", [{ slug: "a" }, { slug: "b" }], (r) => ({ name: r.slug, description: r.slug, tags: [] }), { fetchImpl: neverSettles, timeoutMs: 300 });
  ok(ordered.items.length === 2 && ordered.selection?.method === "lexical" && Date.now() - t1 < 2000, "orderByJudgment falls back to the lexical order by the timeout");
}

// --- 4. placement and defaults, from source
const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const gate = src.slice(src.indexOf("const DISCOVERY_MAX_INFLIGHT"), src.indexOf('app.get("/api/find"'));
ok(/DISCOVERY_MAX_INFLIGHT\)\; return Number\.isFinite\(n\) && n >= 1 \? Math\.floor\(n\) : 8; \}\)\(\)/.test(gate), "DISCOVERY_MAX_INFLIGHT defaults to 8");
ok(/DISCOVERY_COMPUTE_DEADLINE_MS\)\; return Number\.isFinite\(n\) && n >= 100 \? Math\.floor\(n\) : 15_000; \}\)\(\)/.test(gate), "DISCOVERY_COMPUTE_DEADLINE_MS defaults to 15000");
ok(/process\.env\.FREE_MODE === "true" && process\.env\.DISCOVERY_TEST_HANG_QUERY/.test(gate), "the hang hook is read only in free mode");
ok(gate.indexOf("discoveryInFlight.live()") > 0 && gate.indexOf("discoveryInFlight.live()") < gate.indexOf("computeFn("), "admission reads the live count (entries younger than the deadline), before the compute");
ok(gate.indexOf("raceDeadline(pending, DISCOVERY_COMPUTE_DEADLINE_MS)") > 0, "the compute is awaited under the deadline");
ok(gate.indexOf("releaseSlot()") > gate.indexOf("raceDeadline(pending") && gate.indexOf("releaseSlot()") < gate.indexOf("if (pastDeadline)"), "the slot is released before the deadline answer is written");
ok(gate.indexOf("cacheSet(cacheKey") > gate.indexOf("if (pastDeadline)"), "nothing is cached on the deadline path");

// --- 5. booted server
const port = await getFreePort();
const TOKEN = "discovery-deadline-operator-token-0123456789";
const DEADLINE_MS = 1500;
const HANG = "hang-marker-7f3a";
let stderr = "";
const proc = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "",
    AGENT402_OPERATOR_TOKEN: TOKEN, DISCOVERY_TEST_HANG_QUERY: HANG, DISCOVERY_COMPUTE_DEADLINE_MS: String(DEADLINE_MS), DISCOVERY_MAX_INFLIGHT: "2",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
proc.stderr.on("data", (d) => { stderr += String(d); });
const base = `http://127.0.0.1:${port}`;
const op = { headers: { authorization: `Bearer ${TOKEN}` } };
const perf = async () => (await fetch(`${base}/__operator/perf.json`, op)).json();
const ask = async (path, q, ip) => {
  const t0 = Date.now();
  const r = await fetch(`${base}${path}?q=${encodeURIComponent(q)}&include=local&top=5`, { headers: { "X-Forwarded-For": ip } });
  let body = null;
  try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, retryAfter: r.headers.get("retry-after"), body, ms: Date.now() - t0 };
};
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await sleep(500); } }
  ok(up, "server booted");
  const p0 = await perf();
  ok(p0.discovery && p0.discovery.inFlight === 0 && p0.discovery.live === 0 && p0.discovery.oldestAgeMs === null && p0.discovery.maxInFlight === 2 && p0.discovery.deadlineMs === DEADLINE_MS, `perf.json carries the gate's live count, oldest age, cap and deadline (${JSON.stringify(p0.discovery)})`);
  ok(p0.shed && p0.shed.discoveryDeadline === 0, "the discoveryDeadline shed counter starts at zero");

  // Two computes that never settle, one per route, from two outside callers.
  const hang1 = ask("/api/find", `${HANG} first`, "203.0.113.11");
  const hang2 = ask("/api/route", `${HANG} second`, "203.0.113.12");
  await sleep(400);
  const mid = await perf();
  ok(mid.discovery.inFlight === 2 && mid.discovery.live === 2 && mid.discovery.oldestAgeMs >= 300 && mid.discovery.oldestAgeMs < DEADLINE_MS, `while they run, perf.json shows two in flight and the oldest one's age (${JSON.stringify(mid.discovery)})`);
  const third = await ask("/api/find", "parse a csv file", "203.0.113.13");
  ok(third.status === 503 && third.body?.reason === "discovery-inflight" && third.retryAfter === "2", `with every slot held, a third outside caller is shed and the body names the gate (${third.status} ${JSON.stringify(third.body)})`);

  const [r1, r2] = await Promise.all([hang1, hang2]);
  for (const [label, r] of [["find", r1], ["route", r2]]) {
    ok(r.status === 503 && r.body?.reason === "discovery-deadline" && /busy/i.test(r.body?.error || ""), `${label}: the hung compute answers 503 with the shed body and reason "discovery-deadline" (${r.status} ${JSON.stringify(r.body)})`);
    ok(r.retryAfter === "2" && r.ms >= DEADLINE_MS - 100 && r.ms < DEADLINE_MS + 3000, `${label}: answered at the deadline with Retry-After (${r.ms}ms)`);
  }
  const after = await perf();
  ok(after.discovery.inFlight === 0 && after.discovery.live === 0 && after.discovery.oldestAgeMs === null, `both slots are released at the deadline (${JSON.stringify(after.discovery)})`);
  ok(after.shed.discoveryDeadline === 2 && after.shed.discoveryInflight === 1, `the sheds are counted apart: deadline ${after.shed.discoveryDeadline}, inflight ${after.shed.discoveryInflight}`);
  await sleep(100);
  const warns = stderr.split("\n").filter((l) => l.includes("[discovery]") && l.includes("passed the") && l.includes("deadline"));
  ok(warns.length === 2 && warns.some((l) => l.includes("_find") && l.includes(`${`${HANG} first`.length} chars`)) && warns.some((l) => l.includes("_route")), `one warning per deadline, naming the slug and the query length (${JSON.stringify(warns)})`);
  const normal = await ask("/api/find", "convert json to csv", "203.0.113.11");
  ok(normal.status === 200 && Array.isArray(normal.body?.results) && normal.body.results.length > 0, `a normal query from the same caller is served afterwards (${normal.status})`);
  const normalRoute = await ask("/api/route", "hash a string with sha256", "203.0.113.12");
  ok(normalRoute.status === 200 && Array.isArray(normalRoute.body?.results), `/api/route is served afterwards too (${normalRoute.status})`);
  const loop = await fetch(`${base}/api/find?q=${encodeURIComponent("resize an image")}`);
  ok(loop.status === 200, "loopback callers are still never gated");
  ok(unhandled === 0, "no unhandled rejection surfaced in the test process");
  console.log(`\nPASS - ${n} checks (discovery deadline)`);
} finally {
  proc.kill("SIGKILL");
}

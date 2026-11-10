// scripts/test-spend-words-shared-redis.js
// The exaSpend and xDataSpend status words survive a new process, over a REAL
// Redis (src/tools/exa-kit.js, src/tools/x-data-kit.js, src/daily-ceilings.js).
//
// Each kit keeps the day's spend in its own process and in a shared day
// counter; the refusal at the hard ceiling reads the shared one. A process
// that starts on a day already past a ceiling has an empty counter of its
// own, so its word is built from the larger of the two, and a refusal any
// process made holds the word at capped for every process.
//
// Every process here is a real child of this file (one container each):
//   A   serves calls past the alarm ceiling through the kit's own handler path
//   B   a new process that made no call: reads over after one status refresh
//   C   is refused at the hard ceiling while the total sits under it
//   D   a new process that made no call: reads capped
//   E   a store that refuses the connection, then one that accepts and never
//       answers: the word is this process's own, inside a bounded wait
// and last a booted server that made no call answers both words on
// /api/gateway-status from the same counters.
// The parent writes nothing to the store. Every figure is a multiple of the
// kit's own estimate, never typed.
//
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-spend-words-shared-redis.js
//
// Under CI a missing REDIS_URL fails the test: a skipped integration test is
// not coverage. Locally it prints how to point one at the test and exits 0.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { bootServer } from "./lib/boot-server.js";

const SELF = fileURLToPath(import.meta.url);

// ---- a child: one container -------------------------------------------------
if (process.env.SPEND_WORDS_CHILD) {
  const job = JSON.parse(process.env.SPEND_WORDS_CHILD);
  process.env.EXA_API_KEY = "test-key";
  process.env.X_BEARER_TOKEN = "test-bearer";
  console.warn = () => {};
  const { requireUpstreamCosts } = await import("./lib/require-upstream-costs.js");
  requireUpstreamCosts("test-spend-words-shared-redis");
  let kit;
  if (job.kit === "exa") {
    const m = await import("../src/tools/exa-kit.js");
    const E = m.estimateExaUsd("/search", { numResults: 10 });
    const search = m.EXA_TOOLS.find((t) => t.slug === "exa-search").handler;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [{ url: "https://a.example", title: "t" }], costDollars: { total: E } }), headers: { get: () => null } });
    kit = { E, alarm: "EXA_DAILY_MAX_USD", hard: "EXA_DAILY_HARD_MAX_USD", call: () => search({ query: "agent payments" }), book: m._exaSpendBook, refresh: m.refreshExaSpendShared, status: m.exaSpendStatus };
  } else {
    const m = await import("../src/tools/x-data-kit.js");
    const E = m.estimateXReadUsd("/tweets/search/recent", { max_results: 10 });
    globalThis.fetch = async () => new Response(JSON.stringify({ data: Array.from({ length: 10 }, (_, i) => ({ id: String(1e10 + i), text: "t" })), meta: {} }), { status: 200, headers: { "content-type": "application/json" } });
    kit = { E, alarm: "X_DATA_DAILY_MAX_USD", hard: "X_DATA_DAILY_HARD_MAX_USD", call: () => m.__test.xGet("/tweets/search/recent", { max_results: 10 }), book: m._xSpendBook, refresh: m.refreshXDataSpendShared, status: m.xDataSpendStatus };
  }
  process.env[kit.alarm] = String(job.alarm * kit.E);
  process.env[kit.hard] = String(job.hard * kit.E);
  const out = [];
  for (const step of job.steps) {
    const [verb, arg] = String(step).split(":");
    try {
      if (verb === "call") out.push(await kit.call().then(() => 200, (e) => e?.statusCode || 0));
      else if (verb === "book") { kit.book(Number(arg) * kit.E); out.push("booked"); }
      else if (verb === "refresh") { const t = performance.now(); await kit.refresh(); out.push(Math.round(performance.now() - t)); }
      else if (verb === "status") { const s = kit.status(); out.push(s.status); }
      else if (verb === "sleep") { await new Promise((r) => setTimeout(r, Number(arg))); out.push("slept"); }
    } catch (e) { out.push(`threw:${String(e?.message || e).slice(0, 80)}`); }
  }
  process.stdout.write(`\nSPEND_WORDS_RESULT ${JSON.stringify(out)}\n`);
  process.exit(0);
}

// ---- the parent ---------------------------------------------------------------
if (!String(process.env.REDIS_URL || "").trim()) {
  const msg = "test-spend-words-shared-redis: no REDIS_URL; start a local redis and export REDIS_URL=redis://127.0.0.1:6379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`);
  process.exit(0);
}
{
  const { requireUpstreamCosts } = await import("./lib/require-upstream-costs.js");
  requireUpstreamCosts("test-spend-words-shared-redis");
}
const { STATUS_READ_MS } = await import("../src/daily-ceilings.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

/** Run one container: the steps' results, the wall time and the exit code. */
function container(job, { prefix, redisUrl = process.env.REDIS_URL, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, SPEND_WORDS_CHILD: JSON.stringify(job), SHARED_LIMITS_PREFIX: prefix, REDIS_URL: redisUrl };
    delete env.SHARED_LIMITS;
    const child = spawn(process.execPath, [SELF], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const m = stdout.match(/SPEND_WORDS_RESULT (.*)/);
      resolve({ code, out: m ? JSON.parse(m[1]) : null, skipped: /^SKIP - /m.test(stdout), stderr: stderr.slice(-400) });
    });
  });
}
const show = (r) => (r.out ? JSON.stringify(r.out) : `exit ${r.code} ${r.stderr}`);

// A prefix of its own per run, so reruns and parallel lanes never share a day.
const prefix = `spend-words-${randomBytes(5).toString("hex")}`;
let ran = 0;
for (const kit of ["exa", "x"]) {
  const base = { kit, alarm: 2, hard: 4.5 };
  const run = (steps, opts = {}) => container({ ...base, steps }, { prefix, ...opts });

  // The live control: with nothing spent a new process reads ok, so every
  // other word below comes from what another process wrote.
  const control = await run(["refresh", "status"]);
  if (control.skipped) { console.log(`SKIP - ${kit}: the private upstream-cost table is not loaded`); continue; }
  ran++;
  ok(control.out?.[1] === "ok", `${kit}: before any spend a new process reads ok (${show(control)})`);

  // A: three served calls take the day past the alarm ceiling (2 estimates).
  const a = await run(["call", "call", "call", "status", "refresh", "status"]);
  ok(a.out?.slice(0, 3).every((s) => s === 200) && a.out?.[3] === "over" && a.out?.[5] === "over", `${kit}: process A serves three calls past the alarm ceiling and reads over (${show(a)})`);

  // B: a new process, no call of its own.
  const b = await run(["status", "refresh", "status"]);
  ok(b.out?.[0] === "ok", `${kit}: a new process's own counter is empty before its status read (${show(b)})`);
  ok(b.out?.[2] === "over", `${kit}: a new process reads over from the shared day (${show(b)})`);

  // C: one more served call (4 estimates, under the hard ceiling of 4.5), then
  // a refusal that books nothing, so the total stays under the hard ceiling.
  const c = await run(["call", "call", "status", "refresh", "status"]);
  ok(c.out?.[0] === 200 && c.out?.[1] === 503, `${kit}: process C serves up to the hard ceiling, then is refused 503 (${show(c)})`);
  ok(c.out?.[2] === "capped" && c.out?.[4] === "capped", `${kit}: the refusing process reads capped with the total under the hard ceiling (${show(c)})`);

  // D: a new process, no call of its own.
  const d = await run(["refresh", "status"]);
  ok(d.out?.[1] === "capped", `${kit}: a new process reads capped while another process refuses (${show(d)})`);

  // A different prefix is a different day counter: the word above is not a
  // constant of the code path.
  const other = await container({ ...base, steps: ["refresh", "status"] }, { prefix: `${prefix}-other` });
  ok(other.out?.[1] === "ok", `${kit}: a process on another counter still reads ok (${show(other)})`);

  // E1: a store that refuses the connection. The word is this process's own.
  const closed = createServer();
  const closedPort = await new Promise((r) => closed.listen(0, "127.0.0.1", () => r(closed.address().port)));
  await new Promise((r) => closed.close(r));
  const e1 = await run(["refresh", "status", "book:2", "refresh", "status"], { redisUrl: `redis://127.0.0.1:${closedPort}` });
  ok(e1.code === 0 && e1.out && !e1.out.some((s) => String(s).startsWith("threw")), `${kit}: with the store refusing connections nothing throws (${show(e1)})`);
  ok(e1.out?.[1] === "ok" && e1.out?.[4] === "over", `${kit}: and the word is this process's own: ok, then over once it books past the alarm ceiling (${show(e1)})`);

  // E2: a store that accepts the connection and never answers. The status
  // read gives up inside its bound (re-armed at most once for loop time).
  const sockets = new Set();
  const mute = createServer((s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => {}); });
  const mutePort = await new Promise((r) => mute.listen(0, "127.0.0.1", () => r(mute.address().port)));
  const e2 = await run(["book:2", "refresh", "status"], { redisUrl: `redis://127.0.0.1:${mutePort}` });
  for (const s of sockets) s.destroy();
  await new Promise((r) => mute.close(r));
  const waited = e2.out?.[1];
  ok(e2.code === 0 && e2.out?.[2] === "over", `${kit}: with the store accepting and never answering the word is this process's own (${show(e2)})`);
  ok(Number.isFinite(waited) && waited <= 2 * STATUS_READ_MS + 100, `${kit}: and the status read waited ${waited} ms, inside its bound (${STATUS_READ_MS} ms, re-armed at most once)`);
}

// ---- the caller path: /api/gateway-status on a server that made no call ------
// A booted server on the same counters (its own process, its own empty day)
// answers the two words the pagers read. The refusals above are inside their
// hold, so both read capped; another prefix is the control.
if (ran === 2) {
  const exa = await import("../src/tools/exa-kit.js");
  const x = await import("../src/tools/x-data-kit.js");
  const eE = exa.estimateExaUsd("/search", { numResults: 10 }), eX = x.estimateXReadUsd("/tweets/search/recent", { max_results: 10 });
  const ceilings = { EXA_DAILY_MAX_USD: String(2 * eE), EXA_DAILY_HARD_MAX_USD: String(4.5 * eE), X_DATA_DAILY_MAX_USD: String(2 * eX), X_DATA_DAILY_HARD_MAX_USD: String(4.5 * eX) };
  const words = async (label, sharedPrefix) => {
    const srv = await bootServer({ stores: label, env: { FREE_MODE: "true", ...ceilings, SHARED_LIMITS_PREFIX: sharedPrefix, SHARED_LIMITS: "" } });
    try {
      const t = performance.now();
      const r = await fetch(`${srv.url}/api/gateway-status`, { signal: AbortSignal.timeout(20_000) });
      const j = await r.json();
      return { status: r.status, exa: j.exaSpend, x: j.xDataSpend, ms: Math.round(performance.now() - t) };
    } finally { await srv.stop(); }
  };
  const live = await words("spend-words", prefix);
  ok(live.status === 200 && live.exa?.status === "capped" && live.x?.status === "capped", `a new server that made no call answers capped for both words on /api/gateway-status (exaSpend ${live.exa?.status}, xDataSpend ${live.x?.status})`);
  ok([live.exa, live.x].every((w) => w && Object.keys(w).sort().join() === "day,status" && Object.values(w).every((v) => typeof v === "string")), "and the public answer carries the day and the word only, no figure");
  const quiet = await words("spend-words-control", `${prefix}-quiet`);
  ok(quiet.exa?.status === "ok" && quiet.x?.status === "ok", `control: the same server on counters nobody spent reads ok (exaSpend ${quiet.exa?.status}, xDataSpend ${quiet.x?.status})`);
}

console.log(`\ntest-spend-words-shared-redis: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

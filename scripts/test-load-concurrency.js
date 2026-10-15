// CI load gate: 30 buyers at once, and the event loop stays answerable.
//
// scripts/test-perf-budget.js floods uncached search from many addresses and
// watches one paid probe. This is the other shape of load: thirty buyers each
// running a realistic session (discover, then call a handful of cheap tools, a
// proof-of-work leg and one slower CPU-bound tool, over and over) for
// LOAD_MS, against a FREE_MODE server on a free port, while a separate probe
// reads /health every PROBE_EVERY_MS as the event-loop responsiveness signal.
//
// Buyers are told apart by address: each sends x-forwarded-for 198.51.100.<n>,
// which Express turns into req.ip because the server trusts exactly one proxy
// hop (TRUST_PROXY_HOPS, default 1; src/server.js). Every per-client gate the
// discovery path has (the 30-a-minute uncached-search limiter, the per-client
// CPU share) keys on that address, so a single loopback address would trip
// them for all thirty buyers at once and measure the limiter, not the server.
// A loopback address is also exempt from every discovery gate
// (isLoopbackIp in serveCachedDiscovery), which would hide the shedding this
// test counts.
//
// Fails when a tool route answers anything but 200, when discovery sheds more
// than a small share of its calls, when /health under load is slow relative to
// its idle reading from the same run, or when any request hits the hard timeout.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";

// ---- thresholds -----------------------------------------------------------
// 30 buyers: the concurrency the service is asked to hold without a replica.
const BUYERS = Number(process.env.LOAD_BUYERS || 30);
// 45 s of load: long enough for the per-second discovery budget and the
// 500 ms lag ticks (src/loop-lag.js) to settle into a steady state.
const LOAD_MS = Number(process.env.LOAD_MS || 45_000);
// /health every 250 ms: twice per loop-lag tick, so a held loop shows up in
// the probe before the server's own lag gate reacts.
const PROBE_EVERY_MS = 250;
// 5 s of idle probing before the load: the same-run baseline the load p95 is
// read against (runner speed varies; an absolute bound would not).
const IDLE_MS = 5_000;
// /health p95 under load may be at most this many times its idle p95: an
// event loop that answers a 2 ms probe in 40 ms under thirty buyers is sharing
// fairly; one that takes hundreds of ms is being held by synchronous work.
const HEALTH_P95_RATIO = 20;
// ...but never tighter than two slow-tool handlers, at the slow tool's idle
// cost measured in this run: the probe can always land behind the synchronous
// levenshtein that is running plus one that queued ahead of it, so a bound
// below that would measure the mix, not the loop. Read from the run, not
// typed, because that cost scales with the runner the way idle /health does not.
const HEALTH_FLOOR_SLOW_HANDLERS = 2;
// Discovery sheds (503 + Retry-After) are admission control, not errors, but
// at most this share of discovery calls. The gates: DISCOVERY_MAX_INFLIGHT (4
// uncached computes at once) and the 800 ms/s shared CPU budget (src/load-shed.js,
// src/server.js serveCachedDiscovery). Thirty buyers pacing one search every
// DISCOVERY_MIN_GAP_MS send about 15 searches a second at 5-15 ms of CPU each,
// so the steady-state in-flight count is well under 4 and the budget is under
// a quarter spent. A shed therefore means the loop was held long enough for
// more than four searches to queue behind the hold; a saturated loop sheds
// most of a second's arrivals at once (far above 5%), while a few GC pauses
// on a slow runner stay under it.
const SHED_MAX_FRACTION = 0.05;
// One uncached search per buyer per 2 s: under the 30-a-minute per-client
// limiter (23 searches in 45 s), the way an agent that discovers, then calls,
// actually behaves. A 429 here is a pacing bug in this test, and fails it.
const DISCOVERY_MIN_GAP_MS = 2_000;
// Think time between a buyer's calls, 300-700 ms jittered per buyer so thirty
// loops never march in step. An agent reads an answer before its next call,
// and half a second is faster than a model turn; at this pace the thirty
// buyers send about 60 calls a second, one in eight of them to the slower tool.
const THINK_MS = 500;
// Hard per-request timeout: a buyer that waits this long has been failed.
const HARD_TIMEOUT_MS = 10_000;
// The slow tool's input: two strings of this length to /api/levenshtein (an
// O(n*m) synchronous compute, about 25 ms locally; the kit caps far above).
const SLOW_INPUT_CHARS = 2_000;
// The slow tool takes at most this share of the server thread, whatever the
// runner: each buyer calls it no more often than BUYERS x its idle cost /
// this share, so a slower core sends proportionally fewer of them. Without
// it the mix itself saturates a slow runner (thirty buyers at a 50 ms compute
// are most of a core) and the /health bound measures the machine, not the
// loop. One CPU-bound tool hammered by every buyer is a capacity question for
// replicas, not a responsiveness one.
const SLOW_TOOL_THREAD_SHARE = 0.25;

// ---- the server ----------------------------------------------------------
// Keys the server could spend are stripped from the child's environment:
// this test touches no upstream, and the CI lane's job-level keys must never
// reach a server a load test drives.
const SPEND_KEYS = ["BRAVE_API_KEY", "FRED_API_KEY", "FRED_API_KEY_V2", "E2B_API_KEY", "COINGECKO_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "EXA_API_KEY", "OPENAI_API_KEY", "X_BEARER_TOKEN", "STRIPE_SECRET_KEY", "MPP_SECRET_KEY", "TEMPO_API_KEY", "REDIS_URL", "STATE_DATABASE_URL"];
const childEnv = { ...process.env };
for (const k of Object.keys(childEnv)) if (SPEND_KEYS.includes(k) || /_API_KEY$/.test(k)) delete childEnv[k];
const TOKEN = "load-concurrency-operator-token-0123456789";
const dir = mkdtempSync(join(tmpdir(), "a402-load-"));
const port = await getFreePort();
Object.assign(childEnv, {
  FREE_MODE: "true", PORT: String(port),
  X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0",
  AGENT402_OPERATOR_TOKEN: TOKEN,
  POW_DB_PATH: join(dir, "pow.db"),
  // The lag gate's boot warm-up (60 s, longer than this run) is off so the
  // gate is live the way it is in a long-running container.
  SHED_LAG_WARMUP_MS: "0",
  // Lazy package warming blocks the loop for seconds and fires 30 s after
  // boot by default, inside the load window; none of the mix's tools uses a
  // lazy package, so it is left off rather than waited for.
  LAZY_DEPS_WARM: "off",
  // The proof-of-work leg solves at the floor difficulty (8 bits, about 256
  // hashes) so the solver's CPU in this process does not compete with the
  // server on the same runner; the challenge path on the server is the same.
  POW_DIFFICULTY: "8",
});
const proc = spawn(process.execPath, ["src/server.js"], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
const onLog = (d) => { serverLog += d; if (serverLog.length > 4_000_000) serverLog = serverLog.slice(-2_000_000); };
proc.stdout.on("data", onLog);
proc.stderr.on("data", onLog);
const base = `http://127.0.0.1:${port}`;

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] : null; };
const r0 = (x) => (x == null ? "-" : String(Math.round(x)));

// ---- measurements --------------------------------------------------------
const stats = new Map(); // key -> { lat: [], status: {}, timeouts, errors }
const statFor = (key) => { let s = stats.get(key); if (!s) { s = { lat: [], status: {}, timeouts: 0, errors: 0 }; stats.set(key, s); } return s; };
async function call(key, url, init = {}, ip = null) {
  const s = statFor(key);
  const headers = { ...(init.headers || {}) };
  if (ip) headers["x-forwarded-for"] = ip;
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(HARD_TIMEOUT_MS) });
    const text = await res.text();
    s.lat.push(performance.now() - t0);
    s.status[res.status] = (s.status[res.status] || 0) + 1;
    let json = null;
    try { json = JSON.parse(text); } catch { /* not every answer is JSON (qr, images) */ }
    return { status: res.status, json, headers: res.headers };
  } catch (e) {
    s.lat.push(performance.now() - t0);
    if (e?.name === "TimeoutError") s.timeouts++; else s.errors++;
    return { status: 0, json: null, error: e?.name || String(e) };
  }
}

// /health probe: fixed cadence, never serialized behind its own slow answer,
// so a held loop is recorded as the long waits an outside monitor would see.
function probeHealth(ms) {
  const lat = [];
  let bad = 0;
  const pending = [];
  const end = Date.now() + ms;
  return (async () => {
    while (Date.now() < end) {
      const t0 = performance.now();
      pending.push(fetch(`${base}/health`, { signal: AbortSignal.timeout(HARD_TIMEOUT_MS) })
        .then(async (r) => { await r.arrayBuffer(); lat.push(performance.now() - t0); if (r.status !== 200) bad++; })
        .catch(() => { lat.push(performance.now() - t0); bad++; }));
      await sleep(PROBE_EVERY_MS);
    }
    await Promise.all(pending);
    return { lat, bad };
  })();
}

// ---- proof-of-work solver (the published rule: sha256(challenge:nonce)) ----
const leadingZeroBits = (buf) => { let t = 0; for (const b of buf) { if (!b) { t += 8; continue; } t += Math.clz32(b) - 24; break; } return t; };
function solvePow(ch) {
  let nonce = 0;
  while (leadingZeroBits(createHash("sha256").update(`${ch.challenge}:${nonce}`).digest()) < ch.difficulty) nonce++;
  return nonce;
}

// ---- deterministic text for the varied queries and the slow tool ----------
const WORDS = ["convert", "hash", "json", "csv", "weather", "price", "token", "pdf", "image", "dns", "email", "wallet", "stock", "search", "crypto", "qr", "uuid", "markdown", "regex", "color", "date", "geo", "yaml", "jwt"];
function lcg(seed) { let x = seed >>> 0 || 1; return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x; }; }
function randomText(chars, seed) { const next = lcg(seed); const alpha = "abcdefghijklmnopqrstuvwxyz "; let s = ""; while (s.length < chars) s += alpha[(next() >>> 8) % alpha.length]; return s; }
const SLOW_A = randomText(SLOW_INPUT_CHARS, 3);
const SLOW_B = randomText(SLOW_INPUT_CHARS, 9);

try {
  // ---- boot --------------------------------------------------------------
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await sleep(500); } }
  ok(up, `server booted on :${port}`);
  const bound = serverLog.match(/listening on :(\d+)/);
  ok(bound && Number(bound[1]) === port, `the server reports the port the test chose (${bound?.[1]})`);

  // Published examples, read from the server's own /openapi.json the way
  // scripts/test-all.js does (query params' `example`, requestBody example).
  const spec = await (await fetch(`${base}/openapi.json`)).json();
  const exampleCall = (method, path) => {
    const op = spec.paths?.[path]?.[method];
    assert.ok(op, `${method.toUpperCase()} ${path} is in /openapi.json`);
    if (method === "get") {
      const qs = new URLSearchParams();
      for (const p of op.parameters ?? []) if (p.example !== undefined && p.in === "query") qs.set(p.name, typeof p.example === "string" ? p.example : JSON.stringify(p.example));
      return { key: `GET ${path}`, url: `${base}${path}${[...qs].length ? `?${qs}` : ""}`, init: {} };
    }
    const example = op.requestBody?.content?.["application/json"]?.example;
    assert.ok(example && typeof example === "object", `${path} publishes a request example`);
    return { key: `POST ${path}`, url: `${base}${path}`, init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(example) } };
  };
  const cheap = [exampleCall("get", "/api/uuid"), exampleCall("post", "/api/hash"), exampleCall("post", "/api/unit-convert"), exampleCall("post", "/api/base64")];
  ok(cheap.length === 4, `cheap tools by published example: ${cheap.map((c) => c.key).join(", ")}`);
  const slowInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: SLOW_A, b: SLOW_B }) };
  // The slow tool's idle cost, serial, on the quiet server: the unit the
  // /health floor is read in.
  let warm = null;
  for (let i = 0; i < 8; i++) warm = await call("slow-idle", `${base}/api/levenshtein`, slowInit);
  const slowIdleP50 = pct(stats.get("slow-idle").lat, 0.5);
  ok(warm.status === 200 && typeof warm.json?.distance === "number", `the slow tool answers its ${SLOW_INPUT_CHARS}-char input (distance ${warm.json?.distance}, idle p50 ${r0(slowIdleP50)}ms)`);
  stats.delete("slow-idle");

  // ---- idle baseline -----------------------------------------------------
  const idle = await probeHealth(IDLE_MS);
  const idleP95 = pct(idle.lat, 0.95);
  ok(idle.bad === 0 && idle.lat.length >= IDLE_MS / PROBE_EVERY_MS - 2, `idle /health: n=${idle.lat.length} p50=${r0(pct(idle.lat, 0.5))}ms p95=${r0(idleP95)}ms`);
  await fetch(`${base}/__operator/perf.json?reset=1`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const logMarkAt = serverLog.length;

  // ---- 30 buyers for LOAD_MS, with the probe beside them -----------------
  const loadStart = Date.now();
  const until = loadStart + LOAD_MS;
  const slowGapMs = Math.ceil((BUYERS * slowIdleP50) / SLOW_TOOL_THREAD_SHARE);
  console.log(`# slow tool: one call per buyer every ${slowGapMs} ms (${Math.round(SLOW_TOOL_THREAD_SHARE * 100)}% of the thread at ${r0(slowIdleP50)} ms idle)`);
  const probe = probeHealth(LOAD_MS);
  let powAccepted = 0, powSolves = 0;
  const buyer = async (id) => {
    const ip = `198.51.100.${id + 1}`;
    const next = lcg(1000 + id);
    const think = () => sleep(Math.round(THINK_MS * (0.6 + 0.8 * (next() / 0x7fffffff))));
    let nextDiscoveryAt = loadStart + (id * 61) % DISCOVERY_MIN_GAP_MS; // staggered first search
    let useFind = id % 2 === 0;
    let nextSlowAt = loadStart + (id * 97) % slowGapMs; // staggered first slow call
    for (let i = 0; Date.now() < until; i++) {
      if (Date.now() >= nextDiscoveryAt) {
        const q = `${WORDS[(id + i) % WORDS.length]} ${WORDS[(id * 7 + i * 3) % WORDS.length]} ${WORDS[(i * 11) % WORDS.length]} ${id}-${i}`;
        const path = useFind ? "/api/find" : "/api/route";
        await call(`GET ${path}`, `${base}${path}?q=${encodeURIComponent(q)}`, {}, ip);
        useFind = !useFind;
        nextDiscoveryAt = Date.now() + DISCOVERY_MIN_GAP_MS;
        await think();
        if (Date.now() >= until) break;
      }
      for (const c of cheap) { await call(c.key, c.url, c.init, ip); await think(); if (Date.now() >= until) break; }
      if (Date.now() >= until) break;
      // Proof-of-work leg: challenge, solve, redeem. In FREE_MODE the paywall
      // block that verifies a solution is not mounted, so this exercises the
      // challenge issuer and the solver's cost, not the verifier.
      const ch = await call("GET /api/pow/challenge", `${base}/api/pow/challenge?slug=hash`, {}, ip);
      if (ch.json?.challenge) {
        const nonce = solvePow(ch.json); powSolves++;
        const redeemed = await call("POST /api/hash (pow)", `${base}/api/hash`, { method: "POST", headers: { "content-type": "application/json", "x-pow-solution": `${ch.json.token}:${nonce}` }, body: JSON.stringify({ text: `pow ${id}-${i}` }) }, ip);
        if (redeemed.headers?.get("x-pow-accepted") === "true") powAccepted++;
      }
      await think();
      if (Date.now() >= until) break;
      if (Date.now() >= nextSlowAt) {
        await call("POST /api/levenshtein", `${base}/api/levenshtein`, slowInit, ip);
        nextSlowAt = Date.now() + slowGapMs;
        await think();
      }
    }
  };
  await Promise.all([...Array.from({ length: BUYERS }, (_, id) => buyer(id))]);
  const load = await probe;
  const loadP95 = pct(load.lat, 0.95);
  const perf = await (await fetch(`${base}/__operator/perf.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  const loadLog = serverLog.slice(logMarkAt);
  const stallLines = loadLog.split("\n").filter((l) => l.includes("[loop-lag]"));
  const slowDiscovery = loadLog.split("\n").filter((l) => l.includes("[discovery] slow")).length;

  // ---- table -------------------------------------------------------------
  const keys = [...stats.keys()].sort();
  const w = Math.max(...keys.map((k) => k.length), 22);
  console.log(`\n# ${BUYERS} buyers x ${Math.round((Date.now() - loadStart) / 1000)}s; think ${THINK_MS}ms; one search per buyer per ${DISCOVERY_MIN_GAP_MS / 1000}s`);
  console.log(`${"path".padEnd(w)}  ${"n".padStart(6)}  ${"p50".padStart(6)}  ${"p95".padStart(6)}  ${"max".padStart(6)}  statuses`);
  let totalCalls = 0;
  for (const k of keys) {
    const s = stats.get(k); totalCalls += s.lat.length;
    const st = Object.entries(s.status).map(([c, v]) => `${c}:${v}`).join(" ") + (s.timeouts ? ` timeout:${s.timeouts}` : "") + (s.errors ? ` error:${s.errors}` : "");
    console.log(`${k.padEnd(w)}  ${String(s.lat.length).padStart(6)}  ${r0(pct(s.lat, 0.5)).padStart(6)}  ${r0(pct(s.lat, 0.95)).padStart(6)}  ${r0(Math.max(...s.lat)).padStart(6)}  ${st}`);
  }
  console.log(`${"GET /health (probe)".padEnd(w)}  ${String(load.lat.length).padStart(6)}  ${r0(pct(load.lat, 0.5)).padStart(6)}  ${r0(loadP95).padStart(6)}  ${r0(Math.max(...load.lat)).padStart(6)}  idle p95 ${r0(idleP95)}ms, ratio ${(loadP95 / Math.max(idleP95, 0.01)).toFixed(1)}x`);
  console.log(`# total ${totalCalls} calls (${Math.round(totalCalls / (LOAD_MS / 1000))}/s); pow solves ${powSolves}, accepted headers ${powAccepted}; shed=${JSON.stringify(perf.shed)}; discoveryCpuSpentMs=${perf.discoveryCpuSpentMs}; loop stalls>=1s=${perf.loop?.stalls ?? "?"} worst=${perf.loop?.worstMs ?? "?"}ms; [discovery] slow lines=${slowDiscovery}`);
  for (const l of stallLines.slice(0, 10)) console.log(`# server: ${l.trim()}`);

  // ---- assertions --------------------------------------------------------
  const isDiscovery = (k) => k === "GET /api/find" || k === "GET /api/route";
  const toolKeys = keys.filter((k) => !isDiscovery(k));
  const toolNon200 = toolKeys.flatMap((k) => Object.entries(stats.get(k).status).filter(([c]) => c !== "200").map(([c, v]) => `${k} ${c}:${v}`));
  const tool5xx = toolKeys.reduce((a, k) => a + Object.entries(stats.get(k).status).filter(([c]) => c >= 500).reduce((b, [, v]) => b + v, 0), 0);
  ok(tool5xx === 0, `zero 5xx on tool routes (${toolKeys.length} routes)`);
  ok(toolNon200.length === 0, `every tool call answered 200${toolNon200.length ? `: ${toolNon200.join(", ")}` : ""}`);
  let discoveryN = 0, discoveryShed = 0;
  const discoveryOther = [];
  for (const k of keys.filter(isDiscovery)) {
    for (const [c, v] of Object.entries(stats.get(k).status)) {
      discoveryN += v;
      if (c === "503") discoveryShed += v;
      else if (c !== "200") discoveryOther.push(`${k} ${c}:${v}`);
    }
  }
  ok(discoveryN >= BUYERS * Math.floor(LOAD_MS / DISCOVERY_MIN_GAP_MS) * 0.5, `discovery was exercised (${discoveryN} uncached searches)`);
  ok(discoveryOther.length === 0, `discovery answered only 200 or a shed 503 (no 429 from the per-client limiter, no 5xx)${discoveryOther.length ? `: ${discoveryOther.join(", ")}` : ""}`);
  const shedCounted = (perf.shed?.discoveryBudget || 0) + (perf.shed?.discoveryInflight || 0) + (perf.shed?.shedLag || 0) + (perf.shed?.shedInflight || 0);
  ok(discoveryShed <= Math.floor(SHED_MAX_FRACTION * discoveryN), `discovery sheds ${discoveryShed}/${discoveryN} (${(100 * discoveryShed / Math.max(1, discoveryN)).toFixed(1)}%) within ${SHED_MAX_FRACTION * 100}% (server counters: budget ${perf.shed?.discoveryBudget || 0}, inflight ${perf.shed?.discoveryInflight || 0}, lag ${perf.shed?.shedLag || 0}, total ${shedCounted})`);
  const timeouts = [...stats.values()].reduce((a, s) => a + s.timeouts, 0);
  const errors = [...stats.values()].reduce((a, s) => a + s.errors, 0);
  ok(timeouts === 0 && errors === 0, `no request hit the ${HARD_TIMEOUT_MS / 1000}s hard timeout or failed to connect (timeouts ${timeouts}, errors ${errors})`);
  ok(load.bad === 0 && load.lat.length >= LOAD_MS / PROBE_EVERY_MS * 0.8, `/health answered 200 on every probe during the load (n=${load.lat.length})`);
  const floor95 = HEALTH_FLOOR_SLOW_HANDLERS * slowIdleP50;
  const bound95 = Math.max(HEALTH_P95_RATIO * idleP95, floor95);
  ok(loadP95 <= bound95, `/health p95 under load ${r0(loadP95)}ms <= ${r0(bound95)}ms (${HEALTH_P95_RATIO}x idle p95 ${r0(idleP95)}ms, floor ${HEALTH_FLOOR_SLOW_HANDLERS}x slow-tool idle p50 ${r0(slowIdleP50)}ms = ${r0(floor95)}ms)`);
} catch (e) {
  console.error(`\n# server log tail:\n${serverLog.split("\n").slice(-60).join("\n")}`);
  throw e;
} finally {
  proc.kill("SIGKILL");
}
console.log(`test-load-concurrency: ${n} passed`);

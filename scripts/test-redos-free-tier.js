#!/usr/bin/env node
// No free-tier tool and no skill may hold the event loop on a long adversarial
// string. One server serves every buyer, so a regex or loop that goes
// quadratic on one request stalls every other request for its whole run.
//
//   node scripts/test-redos-free-tier.js            (boots its own server, port 0)
//   REDOS_BOUND_MS=250 REDOS_ONLY=duration,base58 node scripts/test-redos-free-tier.js
//
// HOW: the server boots in FREE_MODE under scripts/offline-egress-preload.js,
// so every outbound call fails at once and a tool's remaining time is its own
// work. Every string field of every free-tier tool (src/free-tier.js, less the
// WALLET_ONLY_SLUGS overrides) and of every skill (/api/skill/*) is sent each
// shape of the adversarial corpus below (inside an object and a list for an
// object or array field), one call at a time, while /health is
// polled. The longest /health wait during the call is how long the loop was
// held; a call that holds it past the bound is re-run once and fails if it
// holds it again.
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOUND_MS = Number(process.env.REDOS_BOUND_MS) || 250;
const ONLY = process.env.REDOS_ONLY ? new Set(process.env.REDOS_ONLY.split(",").map((s) => s.trim())) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The corpus: long runs of the shapes that make a backtracking regex or a
// per-character rescan go quadratic. Bodies carry 20,000 characters; query
// strings carry fewer so the request line stays under the header limit.
function corpus(n) {
  return {
    a: "a".repeat(n),
    dotsAt: "x@" + ".".repeat(n) + " ",
    aDot: "a.".repeat(n / 2) + "-",
    spaces: "a" + " ".repeat(n) + "!",
    digits: "1".repeat(n) + "x",
    dash: "a-".repeat(n / 2) + "!",
    lt: "<a".repeat(n / 2),
    nl: "a\n".repeat(n / 2) + "!",
  };
}

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

const srv = spawn(process.execPath, ["--import", "./scripts/offline-egress-preload.js", "src/server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    FREE_MODE: "true",
    PORT: "0",
    X402_INDEX_CRAWL: "off",
    X402_SYNC_ON_START: "false",
    X402_PAYWALL_PROBES_PER_CYCLE: "0",
    AGENT402_MCP_MAX_PER_MIN: "999999",
    AGENT402_MCP_MAX_PER_HOUR: "9999999",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvLog = "";
srv.stdout.on("data", (d) => { srvLog += d; });
srv.stderr.on("data", (d) => { srvLog += d; });

async function timedCall(B, job) {
  let inflight = true, maxWait = 0;
  const pinger = (async () => {
    while (inflight) {
      const t = Date.now();
      try { await (await fetch(`${B}/health`, { signal: AbortSignal.timeout(60_000) })).arrayBuffer(); } catch { /* counted by the wait */ }
      maxWait = Math.max(maxWait, Date.now() - t);
      await sleep(15);
    }
  })();
  let status = "ERR";
  try {
    const r = await fetch(B + job.url, { method: job.method, headers: job.body ? { "content-type": "application/json" } : {}, body: job.body, signal: AbortSignal.timeout(60_000) });
    await r.arrayBuffer();
    status = r.status;
  } catch { /* a timeout is reported through the wait */ }
  inflight = false;
  await pinger;
  return { maxWait, status };
}

try {
  let B = null;
  for (let i = 0; i < 180 && !B; i++) {
    const m = srvLog.match(/listening on :(\d+)/);
    if (m) B = `http://127.0.0.1:${m[1]}`;
    else await sleep(500);
  }
  if (!B) throw new Error(`server never came up:\n${srvLog.slice(-800)}`);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* not yet */ } await sleep(500); }
  ok(true, `offline server booted at ${B}`);
  await sleep(3000); // let boot-time work settle before measuring

  const [pricing, openapi] = await Promise.all([
    fetch(`${B}/api/pricing`).then((r) => r.json()),
    fetch(`${B}/openapi.json`).then((r) => r.json()),
  ]);
  const targets = pricing.endpoints.filter((e) =>
    (ONLY ? ONLY.has(e.slug) : true) &&
    ((FREE_TIER_SLUGS.has(e.slug) && !WALLET_ONLY_SLUGS.has(e.slug)) || e.path.startsWith("/api/skill/")));
  const jobs = [];
  for (const e of targets) {
    const op = openapi.paths?.[e.path]?.[e.method.toLowerCase()];
    if (!op) continue;
    if (e.method === "POST") {
      const c = op.requestBody?.content?.["application/json"];
      if (!c) continue;
      const ex = c.example || {};
      for (const [k, v] of Object.entries(c.schema?.properties || {})) {
        const types = [].concat(v.type || []);
        // A string field gets the string; an object or array field (or one
        // with no declared type) gets the string inside an object and a list.
        const asString = !types.length || types.includes("string");
        const asNested = !types.length || types.includes("object") || types.includes("array");
        if (!asString && !asNested) continue;
        for (const [pn, pv] of Object.entries(corpus(20_000))) {
          if (asString) jobs.push({ slug: e.slug, method: "POST", url: e.path, body: JSON.stringify({ ...ex, [k]: pv }), label: `${e.slug} ${k} ${pn}` });
          if (asNested) jobs.push({ slug: e.slug, method: "POST", url: e.path, body: JSON.stringify({ ...ex, [k]: types.includes("array") ? [pv] : { v: pv, list: [pv] } }), label: `${e.slug} ${k}.nested ${pn}` });
        }
      }
    } else if (e.method === "GET") {
      const params = (op.parameters || []).filter((p) => p.in === "query" && (!p.schema?.type || p.schema.type === "string"));
      const ex = Object.fromEntries((op.parameters || []).filter((p) => p.in === "query" && p.example !== undefined).map((p) => [p.name, String(p.example)]));
      for (const p of params) {
        for (const [pn, pv] of Object.entries(corpus(4_000))) jobs.push({ slug: e.slug, method: "GET", url: `${e.path}?${new URLSearchParams({ ...ex, [p.name]: pv })}`, label: `${e.slug} ${p.name} ${pn}` });
      }
    }
  }
  const slugs = new Set(jobs.map((j) => j.slug));
  ok(slugs.size >= (ONLY ? 1 : 100), `${jobs.length} adversarial calls across ${slugs.size} tools and skills`);

  // Baseline: a trivial call must leave /health well under the bound, or the
  // bound is measuring the runner rather than the tools.
  if (!ONLY) {
    const ctl = await timedCall(B, { method: "POST", url: "/api/calc", body: JSON.stringify({ expression: "1+1" }) });
    ok(ctl.maxWait < BOUND_MS, `control: a trivial call leaves /health answering (${ctl.maxWait}ms)`);
  }

  const slow = [];
  const t0 = Date.now();
  for (const job of jobs) {
    let r = await timedCall(B, job);
    if (r.maxWait > BOUND_MS) r = await timedCall(B, job); // re-probe once
    if (r.maxWait > BOUND_MS) slow.push(`${job.label}: loop held ${r.maxWait}ms (status ${r.status})`);
  }
  for (const s of slow) console.error(`  slow: ${s}`);
  ok(slow.length === 0, `no call holds the event loop past ${BOUND_MS}ms (${jobs.length} calls in ${Math.round((Date.now() - t0) / 1000)}s)`);
  ok(srv.exitCode === null, "the server is still up after the corpus");
} catch (e) {
  failed++;
  console.error(`FAIL - ${e.message}`);
} finally {
  srv.kill("SIGKILL");
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

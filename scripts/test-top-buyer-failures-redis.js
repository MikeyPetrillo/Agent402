#!/usr/bin/env node
// topBuyerFailures across containers, over a REAL Redis
// (src/top-buyer-failures.js).
//
// Each process keeps the failures it served and writes each one to a
// per-payer window in the shared store, so a container that served none of
// a top payer's failed calls reads the same word as the one that did.
// Every process here is a real child of this file (one container each):
//   A   serves three failed paid calls of the top payer: reads alert
//   B   a new process that served nothing: reads alert, with A's tools,
//       statuses and error text on its operator view
//   C   watches only the lowercased spelling of the same Solana payer: reads
//       ok (an address is never case-folded, so it is another payer)
//   D   watches another payer with no failures: reads ok
//   E   a store that refuses the connection: its own failures still raise
//       the word, from this process alone, inside a bounded wait
//
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-top-buyer-failures-redis.js
//
// Under CI a missing REDIS_URL fails the test: a skipped integration test is
// not coverage. Locally it prints how to point one at the test and exits 0.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { childJson } from "./lib/child-json.js";

const SELF = fileURLToPath(import.meta.url);
const PAYER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"; // a Solana address shape, mixed case

if (process.env.TOP_BUYER_CHILD) {
  const job = JSON.parse(process.env.TOP_BUYER_CHILD);
  console.warn = () => {};
  const T = await import("../src/top-buyer-failures.js");
  const { sharedLimitsMode } = await import("../src/shared-limits.js");
  T.setTopBuyers(job.top);
  const t0 = Date.now();
  for (let i = 0; i < (job.fail || 0); i++) T.noteVerifiedPaidOutcome({ payer: PAYER, slug: "onchain-sql", status: 502, error: `we said ${i}`, at: t0 + i });
  await T._flushTopBuyerWrites();
  const started = performance.now();
  const pub = await T.topBuyerFailuresStatus({ now: t0 + 1_000 });
  const ms = Math.round(performance.now() - started);
  const full = await T.topBuyerFailuresStatus({ now: t0 + 1_000, full: true });
  process.stdout.write(`\n${JSON.stringify({ mode: sharedLimitsMode(), pub, full, ms })}\n`);
  process.exit(0);
}

if (!String(process.env.REDIS_URL || "").trim()) {
  const msg = "test-top-buyer-failures-redis: no REDIS_URL; start a local redis and export REDIS_URL=redis://127.0.0.1:6379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`);
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const prefix = `top-buyer-${randomBytes(5).toString("hex")}`;
function container(job, { redisUrl = process.env.REDIS_URL, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, TOP_BUYER_CHILD: JSON.stringify(job), SHARED_LIMITS_PREFIX: prefix, REDIS_URL: redisUrl, SHARED_LIMITS_OP_MS: "1000",
      // Short windows, so this run's keys expire within minutes.
      TOP_BUYER_FAIL_WINDOW_MS: "60000", TOP_BUYER_FAIL_HOLD_MS: "60000", TOP_BUYER_FAIL_MIN: "3" };
    delete env.SHARED_LIMITS; delete env.STATE_DATABASE_URL;
    const child = spawn(process.execPath, [SELF], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      let out = null;
      try { out = childJson(stdout); } catch { out = null; }
      resolve({ code, out, stderr: stderr.slice(-400) });
    });
  });
}
const show = (r) => (r.out ? JSON.stringify({ pub: r.out.pub, alerting: r.out.full?.alerting, sharedStore: r.out.full?.sharedStore }) : `exit ${r.code} ${r.stderr}`);

const a = await container({ top: [PAYER], fail: 3 });
ok(a.out?.mode === "redis" && a.out.pub?.status === "alert", `A: three failures it served read alert (${show(a)})`);
const b = await container({ top: [PAYER], fail: 0 });
ok(b.out?.pub?.status === "alert" && b.out.full?.sharedStore === "on", `B: a process that served none of them reads alert from the shared store (${show(b)})`);
const fb = b.out?.full?.alerting?.[0];
ok(fb && fb.payer === PAYER.slice(0, 4) && fb.rank === 1 && fb.failures.length === 3 && fb.failures.every((f, i) => f.slug === "onchain-sql" && f.status === 502 && f.error === `we said ${i}`), `B: its operator view carries A's tools, statuses and error text (${JSON.stringify(fb)})`);
ok(Object.keys(b.out?.pub || {}).join() === "status", "B: the public answer is the word alone");
const c = await container({ top: [PAYER.toLowerCase()], fail: 0 });
ok(c.out?.pub?.status === "ok", `C: the lowercased spelling of the Solana payer is another payer and reads ok (${show(c)})`);
const d = await container({ top: ["0x00000000000000000000000000000000000000d1"], fail: 0 });
ok(d.out?.pub?.status === "ok", `D: another top payer with no failures reads ok on every process (${show(d)})`);
// A store that refuses the connection: the word is this process's own.
const e = await container({ top: [PAYER], fail: 3 }, { redisUrl: "redis://127.0.0.1:1" });
ok(e.out?.pub?.status === "alert" && e.out.full?.sharedStore === "unread" && e.out.ms < 5_000, `E: with the store refusing, its own failures still read alert inside a bounded wait (${show(e)}, ${e.out?.ms} ms)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

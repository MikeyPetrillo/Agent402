#!/usr/bin/env node
// Two processes, one Redis: what one replica counts, the other refuses on.
//
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-shared-limits-crossprocess.js
//
// Two halves, both against a REAL redis:
//   1. Two real servers (src/server.js, FREE_MODE, port 0) report the shared
//      store on /api/gateway-status (sharedLimits.status on), and a control
//      that runs end to end in free mode, the operator wrong-credential
//      counter, is counted on one server and read elevated on the other.
//   2. Two child processes load the real control modules (the gateway settle
//      breaker, the composite spend guard, the external spend guard's
//      per-payer ledger, the hang-up forgiveness budget, the daily spend
//      helper) with the same REDIS_URL: failures and spend recorded on A are
//      refused on B, and a settlement or a success on A clears B.
// Deliberately does not skip without REDIS_URL: this is the test the
// two-replica deployment rests on, and CI provides the service container.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { getFreePorts } from "./lib/free-port.js";

if (!process.env.REDIS_URL) {
  console.error("FAIL: REDIS_URL is not set. This test needs a real redis (CI provides a service container). It deliberately does not skip.");
  process.exit(1);
}
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Every key this run touches is namespaced, so a second run on the same Redis
// (or a leftover pause flag from an earlier one) cannot change an answer.
const PREFIX = `xp${process.pid}${Date.now().toString(36)}`;
const BASE_ENV = { ...process.env, SHARED_LIMITS_PREFIX: PREFIX, SHARED_LIMITS: "on" };
const children = [];
const done = (code) => { for (const c of children) { try { c.kill("SIGKILL"); } catch { /* */ } } process.exit(code); };

// ---- 1. two real servers -----------------------------------------------------------
{
  const TOKEN = "operator-crossprocess-secret";
  const [pa, pb] = await getFreePorts(2);
  const boot = (port) => {
    const c = spawn(process.execPath, ["src/server.js"], {
      env: { ...BASE_ENV, FREE_MODE: "true", PORT: String(port), AGENT402_OPERATOR_TOKEN: TOKEN, OPERATOR_AUTH_FAIL_ALERT: "10" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    c.log = "";
    c.stdout.on("data", (d) => { c.log += d; });
    c.stderr.on("data", (d) => { c.log += d; });
    children.push(c);
    return c;
  };
  const A = boot(pa), Bs = boot(pb);
  const up = async (port) => { for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* */ } await wait(500); } return false; };
  const [ua, ub] = await Promise.all([up(pa), up(pb)]);
  ok(ua && ub, "two servers booted on free ports against one Redis");
  if (!(ua && ub)) { console.error(A.log.slice(-800), Bs.log.slice(-800)); done(1); }
  const status = async (port, auth = false) => (await fetch(`http://127.0.0.1:${port}/api/gateway-status`, auth ? { headers: { authorization: `Bearer ${TOKEN}` } } : {})).json();
  const sa = await status(pa), sb = await status(pb);
  ok(sa.sharedLimits?.status === "on" && sb.sharedLimits?.status === "on", `both servers publish sharedLimits.status on (${sa.sharedLimits?.status}, ${sb.sharedLimits?.status})`);
  ok(Object.keys(sa.sharedLimits).join() === "status", "the public field is the word alone");
  const opA = await status(pa, true);
  ok(opA.sharedLimits?.mode === "redis" && typeof opA.sharedLimits?.ops === "number", `the operator view carries the mode and counts (${JSON.stringify(opA.sharedLimits)})`);
  ok(opA.operatorAuth?.status === "ok", "control: before any wrong credential the operator auth word is ok on A");
  // Ten wrong credentials, all on A; the alarm threshold is ten.
  for (let i = 0; i < 10; i++) await fetch(`http://127.0.0.1:${pa}/__operator`, { headers: { authorization: `Bearer wrong-${i}` } });
  const opB = await status(pb, true);
  ok(opB.operatorAuth?.status === "elevated" && opB.operatorAuth?.failures1h >= 10, `B reads the wrong credentials counted on A: operatorAuth ${opB.operatorAuth?.status}, failures1h ${opB.operatorAuth?.failures1h}`);
  const pubB = await status(pb);
  ok(pubB.operatorAuth?.status === "elevated" && !("failures1h" in pubB.operatorAuth), "and the public word on B is elevated, with no number");
  A.kill("SIGKILL"); Bs.kill("SIGKILL");
}

// ---- 2. two replicas of the control modules --------------------------------------------
function replica(name) {
  const c = spawn(process.execPath, ["scripts/lib/shared-limits-driver.js"], {
    env: { ...BASE_ENV, EXTERNAL_MAX_UNSETTLED_USD: "1", HANGUP_FORGIVE_KEY_USD: "0.25", HANGUP_FORGIVE_GLOBAL_USD: "2", HANGUP_FORGIVE_SALT: `salt-${PREFIX}`, HANGUP_FORGIVE_FILE: "off", COMPOSITE_GUARD_MAX_FAILS: "3", COMPOSITE_GUARD_GLOBAL_MAX_FAILS: "6", GATEWAY_SETTLE_BREAKER_MAX: "3", GATEWAY_SETTLE_BREAKER_GLOBAL_MAX: "4" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(c);
  c.stderr.on("data", (d) => { const s = String(d); if (!/\[shared-limit\]|\[gateway-breaker\]|\[hangup\]|\[spend-guard\]/.test(s)) process.stderr.write(`[${name}] ${s}`); });
  const pending = new Map();
  let seq = 0;
  const rl = createInterface({ input: c.stdout });
  const ready = new Promise((r) => { c.once("exit", () => r(false)); rl.once("line", () => r(true)); });
  rl.on("line", (line) => { let m; try { m = JSON.parse(line); } catch { return; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  return {
    name, ready,
    send(cmd) { const id = `${name}${++seq}`; return new Promise((r) => { pending.set(id, r); c.stdin.write(JSON.stringify({ id, ...cmd }) + "\n"); }); },
    exit() { try { c.stdin.write(JSON.stringify({ op: "exit" }) + "\n"); } catch { /* */ } },
  };
}
const A = replica("A"), B = replica("B");
ok((await A.ready) && (await B.ready), "two control replicas started");
{
  const ma = await A.send({ op: "mode" }), mb = await B.send({ op: "mode" });
  ok(ma.mode === "redis" && mb.mode === "redis" && ma.word === "on", `both replicas run the shared backend (${ma.mode}, word ${ma.word})`);
  ok(ma.breakerShared && ma.compositeShared && ma.hangupShared && ma.payerLedgerShared, "every control reports writing through to the shared store");
}
// --- the gateway settle breaker ---
{
  const ip = "203.0.113.17", key = `ip:${ip}`;
  let r = await B.send({ op: "gwb.check", ip });
  ok(r.ok === true, "breaker control: a fresh wallet passes on B");
  await A.send({ op: "gwb.fail", key, n: 3 });
  r = await B.send({ op: "gwb.check", ip });
  ok(r.ok === false && r.status === 429, `breaker: three settle failures recorded on A refuse the same wallet on B (${r.status})`);
  const local = await B.send({ op: "gwb.local", key });
  ok(local.fails === 0, "and B's own counter never saw them (the refusal came from the shared window)");
  await A.send({ op: "gwb.success", key });
  r = await B.send({ op: "gwb.check", ip });
  ok(r.ok === true, "a settled call on A clears the wallet on B");
  // The global pause: distinct buyers failing on both replicas, two each.
  await A.send({ op: "gwb.fail", key: "ip:198.51.100.1" });
  await A.send({ op: "gwb.fail", key: "ip:198.51.100.2" });
  r = await B.send({ op: "gwb.check", ip: "198.51.100.9" });
  ok(r.ok === true, "global control: two failing buyers on A alone do not pause B (threshold four)");
  await B.send({ op: "gwb.fail", key: "ip:198.51.100.3" });
  await B.send({ op: "gwb.fail", key: "ip:198.51.100.4" });
  r = await A.send({ op: "gwb.check", ip: "198.51.100.9" });
  ok(r.ok === false && r.status === 503, `global: four distinct failing buyers split across A and B pause every /v1 call on A (${r.status})`);
  r = await B.send({ op: "gwb.check", ip: "198.51.100.9" });
  ok(r.ok === false && r.status === 503, "and on B");
  r = await A.send({ op: "gwb.check", ip: "198.51.100.9", global: false });
  ok(r.ok === true, "a wallet-only consult (global:false) is not held by the pause");
}
// --- the composite spend guard ---
{
  const P = "0xaaaa000000000000000000000000000000000001";
  let r = await B.send({ op: "cg.blocked", payer: P });
  ok(r.blocked === false, "composite control: a fresh payer is not blocked on B");
  await A.send({ op: "cg.fail", payer: P, n: 2 });
  r = await B.send({ op: "cg.blocked", payer: P });
  ok(r.blocked === false, "two spend-then-fail on A: under the threshold on B");
  await B.send({ op: "cg.fail", payer: P, n: 1 });
  r = await A.send({ op: "cg.blocked", payer: P });
  ok(r.blocked === true, "the third failure, recorded on B, blocks the payer on A");
  r = await B.send({ op: "cg.blocked", payer: P });
  ok(r.blocked === true, "and on B");
  // Global pause (threshold six): the blocked payer above already counts
  // three (one payer adds at most MAX_FAILS); two more payers on A make five,
  // a sixth on B trips the pause for both.
  r = await A.send({ op: "cg.paused" });
  ok(r.paused === false, "global control: not paused before the burst");
  for (let i = 0; i < 2; i++) await A.send({ op: "cg.fail", payer: `0xrotA${i}` });
  r = await B.send({ op: "cg.paused" });
  ok(r.paused === false, "five spend-then-fail across A and B (three of them one payer's) do not pause B (threshold six)");
  await B.send({ op: "cg.fail", payer: "0xrotB0" });
  r = await A.send({ op: "cg.paused" });
  ok(r.paused === true, "the sixth, recorded on B, pauses the reports on A");
  r = await B.send({ op: "cg.paused" });
  ok(r.paused === true, "and on B");
}
// --- the external spend guard, per payer ---
{
  const X = "0xbbbb000000000000000000000000000000000002";
  let r = await A.send({ op: "esg.reserve", payer: X, usd: 0.7, ceiling: 1 });
  ok(r.ok === true, "spend control: A books $0.7 of unsettled spend for a payer (ceiling $1)");
  const h = r.handle;
  r = await B.send({ op: "esg.reserve", payer: X, usd: 0.5, ceiling: 1 });
  ok(r.ok === false && /not settled/.test(r.reason || ""), `B refuses the same payer another $0.5: the spend booked on A counts (${r.reason})`);
  const ex = await B.send({ op: "esg.exposure", payer: X });
  ok(ex.local === 0, "B's own ledger holds nothing for the payer (the refusal came from the shared window)");
  await A.send({ op: "esg.adjust", handle: h, usd: 0.4 });
  r = await B.send({ op: "esg.reserve", payer: X, usd: 0.5, ceiling: 1 });
  ok(r.ok === true, "A lowers the booking to the real price ($0.4); B may now book $0.5");
  r = await B.send({ op: "esg.reserve", payer: X, usd: 0.2, ceiling: 1 });
  ok(r.ok === false, "control: a further $0.2 would pass the ceiling ($0.4 + $0.5) and is refused");
  await A.send({ op: "esg.resolve", handle: h, settled: true });
  r = await B.send({ op: "esg.reserve", payer: X, usd: 0.2, ceiling: 1 });
  ok(r.ok === true, "A's payment settles; its spend leaves the window and B may book again");
}
// --- the hang-up forgiveness budget ---
{
  const K = ["0xcccc000000000000000000000000000000000003", "ip:192.0.2.10"];
  let r = await B.send({ op: "hf.reserve", keys: K, price: 0.1 });
  ok(r.granted === true, "hangup control: a fresh wallet is forgiven on B (ticket released)");
  await B.send({ op: "hf.settle", abandoned: false });
  await A.send({ op: "hf.reserve", keys: K, price: 0.2, abandon: true });
  r = await B.send({ op: "hf.reserve", keys: K, price: 0.1 });
  ok(r.granted === false && r.reason === "payer budget", `a run abandoned on A ($0.20 of the $0.25 per-key budget) denies the wallet on B (${r.reason})`);
  r = await B.send({ op: "hf.reserve", keys: ["0xdddd000000000000000000000000000000000004", "ip:192.0.2.11"], price: 0.1, release: true });
  ok(r.granted === true, "a wallet with no abandoned record is still forgiven");
  // In-flight runs count too: a granted, unfinished ticket on A holds budget on B.
  const K2 = ["0xeeee000000000000000000000000000000000005", "ip:192.0.2.12"];
  await A.send({ op: "hf.reserve", keys: K2, price: 0.2, hold: "inflight" });
  r = await B.send({ op: "hf.reserve", keys: K2, price: 0.1 });
  ok(r.granted === false && r.reason === "payer budget", "a ticket in flight on A holds the wallet's budget on B");
  await A.send({ op: "hf.settle", hold: "inflight", abandoned: false });
  r = await B.send({ op: "hf.reserve", keys: K2, price: 0.1, release: true });
  ok(r.granted === true, "released on A (the buyer stayed), the budget is free on B");
  // The service-wide budget spans both: $2 total, $0.20 of it already
  // abandoned above, so the eighth quarter (and anything after) is denied.
  const granted = [];
  for (let i = 0; i < 4; i++) granted.push((await A.send({ op: "hf.reserve", keys: [`0xg${i}`, `ip:192.0.2.${20 + i}`], price: 0.25, abandon: true })).granted);
  for (let i = 0; i < 4; i++) granted.push((await B.send({ op: "hf.reserve", keys: [`0xh${i}`, `ip:192.0.2.${30 + i}`], price: 0.25, abandon: true })).granted);
  ok(granted.filter(Boolean).length === 7 && granted[7] === false, `seven of eight quarters split across A and B are granted; the eighth would pass the $2 service budget (${granted.map((g) => (g ? "y" : "n")).join("")})`);
  r = await A.send({ op: "hf.reserve", keys: ["0xlast", "ip:192.0.2.99"], price: 0.1 });
  ok(r.granted === false && r.reason === "global budget", `the service budget is spent for a fresh wallet on A too (${r.reason})`);
}
// --- the daily spend helper (the X data and Exa caps) ---
{
  let r = await A.send({ op: "daily.reserve", name: "cap", usd: 0.6, cap: 1 });
  ok(r.ok === true, "daily cap control: A reserves $0.6 of a $1 day");
  r = await B.send({ op: "daily.reserve", name: "cap", usd: 0.6, cap: 1 });
  ok(r.ok === false && Math.abs(r.today - 0.6) < 1e-9, `B's $0.6 would pass the day's cap with A's spend counted and is refused (today ${r.today})`);
  r = await B.send({ op: "daily.reserve", name: "cap", usd: 0.3, cap: 1 });
  ok(r.ok === true, "B's $0.3 fits");
}
A.exit(); B.exit();
await wait(200);
// Clean up this run's keys.
try {
  const { getSharedRedisClient } = await import("../src/shared-limit.js");
  const c = await getSharedRedisClient();
  const keys = c ? await c.keys(`sl:${PREFIX}:*`) : [];
  if (keys.length) await c.del(keys);
} catch { /* best effort */ }
console.log(`\ntest-shared-limits-crossprocess: ${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);

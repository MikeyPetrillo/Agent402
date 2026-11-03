#!/usr/bin/env node
// A store deadline counts loop time (src/loop-deadline.js), offline.
//
// Under load, a server's boot work held the loop past the shared store's 1 s
// command deadline while the answer sat unread; the timers phase ran before
// the poll phase, so the deadline fired first, a healthy Redis read "degraded"
// for a minute and the control decided on local counters. Here the answer is
// a single threadpool read issued before the loop is held, which completes
// during the hold exactly like a socket answer would:
//   - an answer that arrived while the loop was held is taken (the shared
//     store's command deadline, the connect wait, the CoinGecko budget's);
//   - a store that never answers still times out, promptly when the loop is
//     free and boundedly when it is held;
//   - a rejection still propagates;
//   - the shared store's connect wait, through its own module in a child
//     process (the connect, from the redis package, completes during a hold);
//   - a ref'd deadline keeps a process alive until it expires, an unref'd one
//     does not (a child process with nothing else pending).
//   node scripts/test-loop-deadline.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loopDeadline, withLoopTimeout, withLoopDeadline } from "../src/loop-deadline.js";
import { createRedisLimits } from "../src/shared-limits.js";
import { cgWithin } from "../src/tools/coingecko-rate.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
// The deadline timers are unref'd, as in production: hold the process open.
const keepAlive = setInterval(() => {}, 1000);
// Each held case starts in the check phase (right after setImmediate), so the
// next phase to run after the hold is the timers phase: the order a held boot
// meets, where a plain timer fires before the poll phase reads the answer.
const checkPhase = () => new Promise((r) => setImmediate(r));
// The limits resolve their client before sending: let those microtasks run
// (no loop turn, so no I/O is read) so the command is in flight before the hold.
const inFlight = async () => { for (let i = 0; i < 20; i++) await null; };
const spin = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* the loop is held */ } };

const file = join(mkdtempSync(join(tmpdir(), "loop-deadline-")), "answer");
writeFileSync(file, "x".repeat(64));
const fh = await open(file, "r");
// One threadpool request, issued now: its completion is read in a poll phase.
const answerSoon = (value) => fh.read(Buffer.alloc(8), 0, 8, 0).then(() => value);
// A case that needs its own process: `code` is an ES module body run with
// SRC (the src/ directory URL), FILE (the answer file) and the spin helper in
// scope; it prints one JSON line, parsed here.
const SRC = new URL("../src/", import.meta.url).href;
function inChild(code, env = {}) {
  const prelude = `const SRC = ${JSON.stringify(SRC)}; const FILE = ${JSON.stringify(file)};\nconst spin = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* the loop is held */ } };\n`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", prelude + code], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 30_000 });
  const line = String(r.stdout || "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop() || "";
  let out = null; try { out = JSON.parse(line); } catch { /* reported below */ }
  return { out, status: r.status, stderr: String(r.stderr || "").trim().slice(-400) };
}

// 1. The shared store's command deadline, through the real Redis-backed limits.
{
  const fakeClient = { eval: () => answerSoon([1, 1, []]) };
  const limits = createRedisLimits(async () => fakeClient, { opTimeoutMs: 200 });
  await checkPhase();
  const p = limits.windowRead("t", "k", { windowMs: 60_000 });
  await inFlight();
  spin(500); // the loop held past the 200 ms deadline while the answer landed
  const r = await p;
  ok(r.ok === true, `an answer that arrived while the loop was held is read, not a timeout (${JSON.stringify(r)})`);
}
{
  const hung = { eval: () => new Promise(() => {}) };
  const limits = createRedisLimits(async () => hung, { opTimeoutMs: 150 });
  const t0 = performance.now();
  const r = await limits.windowRead("t", "k", { windowMs: 60_000 });
  const took = performance.now() - t0;
  ok(r.ok === false && /timed out/.test(r.error) && took >= 140 && took < 600, `a store that never answers still times out on a free loop (${Math.round(took)} ms, ${r.error})`);
}
{
  const hung = { eval: () => new Promise(() => {}) };
  const limits = createRedisLimits(async () => hung, { opTimeoutMs: 150 });
  const t0 = performance.now();
  await checkPhase();
  const p = limits.windowRead("t", "k", { windowMs: 60_000 });
  await inFlight();
  spin(400);
  const r = await p;
  const took = performance.now() - t0;
  ok(r.ok === false && took < 400 + 2 * 150 + 300, `with the loop held it still ends, within twice the deadline past the hold (${Math.round(took)} ms)`);
}
// 2. The connect wait (src/shared-limit.js): a connect that completed during a hold is taken.
{
  await checkPhase();
  const p = withLoopDeadline(answerSoon("client"), 200, null);
  spin(500);
  ok((await p) === "client", "a connect that completed while the loop was held is taken, not reported unreachable");
  ok((await withLoopDeadline(new Promise(() => {}), 50, null)) === null, "a connect that never completes gives the fallback");
  let threw = null;
  try { await withLoopDeadline(Promise.reject(new Error("boom")), 50, null); } catch (e) { threw = e; }
  ok(threw?.message === "boom", "a rejected wait still rejects");
  threw = null;
  try { await withLoopTimeout(new Promise(() => {}), 50, () => new Error("late")); } catch (e) { threw = e; }
  ok(threw?.message === "late", "withLoopTimeout rejects with the given error");
}
// 2a. The same wait through the module itself: getSharedRedisClient() opens
//     its client through the redis package, and that connect completes while
//     the loop is held past the 1 s request wait. In a child, since the
//     module reads REDIS_URL at import and this process pins it unset; the
//     package is replaced at the module boundary by a stub whose connect is
//     the threadpool read, so nothing connects.
{
  const stub = "data:text/javascript," + encodeURIComponent("export function createClient() { return globalThis.__client; }\nexport default { createClient };");
  const { out, status, stderr } = inChild(`
    import { register } from "node:module";
    import { open } from "node:fs/promises";
    register("data:text/javascript," + encodeURIComponent('export async function resolve(s, c, n) { if (s === "redis") return { url: ${JSON.stringify(stub)}, shortCircuit: true }; return n(s, c); }'));
    const fh = await open(FILE, "r");
    let connects = 0;
    globalThis.__client = { isReady: true, on() {}, connect: () => { connects++; return fh.read(Buffer.alloc(8), 0, 8, 0).then(() => {}); } };
    const { loadRedis } = await import(SRC + "lazy-redis.js");
    await loadRedis(); // cached, so the connect is sent within the microtasks below
    const { getSharedRedisClient } = await import(SRC + "shared-limit.js");
    await new Promise((r) => setImmediate(r));
    const t0 = performance.now();
    const p = getSharedRedisClient();
    for (let i = 0; i < 40; i++) await null;
    const sent = connects;
    spin(1300);
    const c = await p;
    console.log(JSON.stringify({ sent, got: c === globalThis.__client, took: Math.round(performance.now() - t0) }));
  `, { REDIS_URL: "redis://127.0.0.1:1/0" });
  ok(status === 0 && out?.sent === 1 && out.got === true, `the shared store's connect wait, through its module: a connect that completed while the loop was held is the client, not null (${out ? JSON.stringify(out) : `exit ${status}: ${stderr}`})`);
}
// 2b. The CoinGecko budget's own deadline (src/tools/coingecko-rate.js), same rule.
{
  await checkPhase();
  const p = cgWithin(answerSoon("ok"), 100).catch((e) => e.message);
  spin(400);
  ok((await p) === "ok", "the CoinGecko shared budget takes an answer that landed while the loop was held");
}
// 3. Each correction on its own. The expiry waits one poll phase: a hold that
//    ends just past the deadline (not late enough to re-arm) still reads the
//    answer that landed in it. The re-arm gives back the held time: an answer
//    that needs a second round trip after the hold still lands.
{
  await checkPhase();
  const p = withLoopDeadline(answerSoon("one"), 200, null);
  spin(205);
  ok((await p) === "one", "an answer that landed during a hold ending at the deadline is read before the expiry");
}
{
  await checkPhase();
  const p = withLoopDeadline(answerSoon(null).then(() => answerSoon("two")), 200, null);
  spin(500);
  ok((await p) === "two", "an answer needing a second round trip after a long hold gets the held time back");
}
// 4. The re-arm is bounded to once, whatever the clock says.
{
  let t = 0, fired = 0;
  const now = () => t;
  await new Promise((resolve) => {
    loopDeadline(10, () => { fired++; resolve(); }, { now: () => { t += 1000; return now(); } });
  });
  ok(fired === 1, "a clock that always reads late re-arms once and then expires");
}
// 5. The `ref` option: a deadline that must keep the process alive (a wait
//    whose answer the process exists for) does so until it expires; the
//    default does not hold a process open. Each is the only thing pending in
//    a child, which reports how long its loop ran after the deadline was set.
{
  const child = (ref) => inChild(`
    import { writeSync } from "node:fs";
    const { loopDeadline } = await import(SRC + "loop-deadline.js");
    const t0 = performance.now();
    let expired = false;
    process.on("exit", () => writeSync(1, JSON.stringify({ alive: Math.round(performance.now() - t0), expired }) + "\\n"));
    loopDeadline(300, () => { expired = true; }, { ref: ${ref} });
  `);
  const kept = child(true), dropped = child(false);
  ok(kept.status === 0 && kept.out?.expired === true && kept.out.alive >= 280 && kept.out.alive < 3000, `a ref'd deadline keeps the process alive until it expires (${kept.out ? JSON.stringify(kept.out) : `exit ${kept.status}: ${kept.stderr}`})`);
  ok(dropped.status === 0 && dropped.out?.expired === false && dropped.out.alive < 150, `an unref'd deadline (the default) lets the process exit at once (${dropped.out ? JSON.stringify(dropped.out) : `exit ${dropped.status}: ${dropped.stderr}`})`);
}
await fh.close();
clearInterval(keepAlive);
console.log(`\ntest-loop-deadline: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

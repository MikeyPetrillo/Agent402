#!/usr/bin/env node
// The in-flight run cover across containers (src/inflight-cover.js).
//
//   node scripts/test-inflight-cover-shared.js            memory and degraded halves
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-inflight-cover-shared.js   all three
//
// A wallet's concurrent runs on the expensive routes must be covered by its
// balance together. Each container keeps its own ledger; with a shared store
// every run is also a reservation in a shared window, so a run another
// container holds counts here. Three halves:
//   1. memory (no shared store; run in a child process with REDIS_URL unset):
//      the shared half is off and the local ledger decides exactly as one
//      replica always did.
//   2. degraded (a shared store is configured and does not answer; run in a
//      child process pointed at a closed port): every admission is decided on
//      the local ledger, the misses are counted, nothing throws, and the
//      local refusals still hold (failing toward the local, stricter view).
//   3. redis (a real server): a reservation another container holds (written
//      straight into the shared window under another process's id) is judged
//      with this process's ledger; when it leaves, the wallet is admitted on a
//      fresh read; this process's own runs being judged together are not
//      counted twice; a refused or released run leaves the window.
// Under CI a missing REDIS_URL fails (a skipped integration test is not
// coverage); a local run says the Redis half was skipped. The two-process
// case is scripts/test-shared-limits-crossprocess.js.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROLE = process.argv[2] || "main";
let pass = 0;
const fail = (m) => { console.error(`FAIL - ${m}`); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

const PRICE = 600000n;
const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const hdr = (from, value = PRICE) => Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", asset: ASSET }, payload: { signature: "0x11", authorization: { from, to: "0x" + "cd".repeat(20), value: String(value), validAfter: "0", validBefore: "9999999999", nonce: "0x01" } } })).toString("base64");
const reqFor = (from) => { const h = hdr(from); return { header: (n) => (String(n).toLowerCase() === "payment-signature" ? h : undefined) }; };
const coverKeyOf = (from) => `eip155:8453|${ASSET}|${from.toLowerCase()}`;
const attempt = async (C, from) => { try { return { release: await C.admitCoveredRun(reqFor(from)) }; } catch (e) { return { err: e }; } };

if (ROLE === "degraded") {
  // A shared store is configured (REDIS_URL, closed port) and never answers.
  const C = await import("../src/inflight-cover.js");
  let reads = 0, balance = PRICE;
  C._setBalanceReaderForTest(async () => { reads++; return balance; });
  ok(C._inflightCoverShared === true, "degraded: the shared half is configured (REDIS_URL set)");
  const W = "0x" + "d4".repeat(20);
  const t0 = Date.now();
  const first = await attempt(C, W);
  ok(typeof first.release === "function" && reads === 0, `degraded: a wallet's first run is admitted on verify's proof, no read, no throw (${first.err?.message || "admitted"})`);
  const second = await attempt(C, W);
  ok(second.err?.statusCode === 429 && reads === 1, `degraded: the local ledger still refuses a second run the balance cannot also cover (${second.err?.statusCode})`);
  // Control: another wallet whose balance covers two runs.
  const W2 = "0x" + "d5".repeat(20);
  balance = 2n * PRICE;
  const own = await attempt(C, W2);
  const third = await attempt(C, W2);
  ok(typeof own.release === "function" && typeof third.release === "function", `degraded control: a wallet whose balance covers two runs is admitted twice (${third.err?.message || "admitted"})`);
  const s = C.inflightCoverStatus();
  ok(s.shared === true && s.sharedMisses >= 4 && s.runsInFlight === 3, `degraded: every admission counted a shared miss and decided on the local ledger (misses ${s.sharedMisses}, in flight ${s.runsInFlight})`);
  ok(Date.now() - t0 < 10_000, `degraded: a store that does not answer costs at most its op timeout per call (${Date.now() - t0} ms)`);
  first.release(); own.release(); third.release();
  ok(C.inflightCoverStatus().runsInFlight === 0, "degraded: released runs leave the local ledger");
  console.log(`CHILD_PASS ${pass}`);
  process.exit(0);
}

if (ROLE === "memory") {
  const C = await import("../src/inflight-cover.js");
  ok(C._inflightCoverShared === false && C.inflightCoverStatus().shared === false, "memory: without a shared store the shared half is off");
  let reads = 0;
  C._setBalanceReaderForTest(async () => { reads++; return PRICE; });
  const W = "0x" + "a7".repeat(20);
  const a = await attempt(C, W);
  const readsAfterFirst = reads;
  const b = await attempt(C, W);
  ok(typeof a.release === "function" && readsAfterFirst === 0 && b.err?.statusCode === 429 && reads === 1, "memory: the first run needs no read, a second the balance cannot also cover is refused on one read");
  a.release();
  const c = await attempt(C, W);
  ok(typeof c.release === "function", "memory: once the run leaves, the next is admitted");
  c.release();
  console.log(`CHILD_PASS ${pass}`);
  process.exit(0);
}

// ---- 1 and 2: memory and degraded, each in its own process (the backend is
// fixed at boot) ----------------------------------------------------------------------
const here = fileURLToPath(import.meta.url);
for (const [role, extra, min] of [
  ["memory", { REDIS_URL: "" }, 3],
  ["degraded", { REDIS_URL: "redis://127.0.0.1:1", SHARED_LIMITS: "on", SHARED_LIMITS_OP_MS: "150" }, 7],
]) {
  const env = { ...process.env, INFLIGHT_COVER: "", ...extra };
  const r = spawnSync(process.execPath, [here, role], { env, encoding: "utf8", timeout: 60_000 });
  for (const l of String(r.stdout || "").split("\n").filter((x) => x.startsWith("ok - ") || x.startsWith("FAIL"))) console.log(`  ${l}`);
  const m = /CHILD_PASS (\d+)/.exec(r.stdout || "");
  if (m) pass += Number(m[1]);
  ok(r.status === 0 && m && Number(m[1]) >= min, `the ${role} half passed in its own process (exit ${r.status}, ${m ? m[1] : 0} checks)${r.status === 0 ? "" : `\n${String(r.stderr || "").slice(-600)}`}`);
}

// ---- 3. redis ------------------------------------------------------------------------
if (!process.env.REDIS_URL) {
  if (process.env.CI) fail("REDIS_URL is not set under CI: the Redis half needs the real redis service container (a skipped integration test is not coverage)");
  console.log("SKIPPED - the Redis half: REDIS_URL is not set (start a local redis and set REDIS_URL to run it; CI runs it against its service container)");
  console.log(`\ntest-inflight-cover-shared: ${pass} passed, 0 failed`);
  process.exit(0);
}
process.env.SHARED_LIMITS_PREFIX ||= `icx${process.pid}${Date.now().toString(36)}`;
process.env.SHARED_LIMITS = "on";
const C = await import("../src/inflight-cover.js");
const { shared } = await import("../src/shared-limits.js");
const WIN = 15 * 60_000;
const NAME = "inflight-cover";
const windowOf = async (from) => (await shared.windowRead(NAME, coverKeyOf(from), { windowMs: WIN }));
const foreign = (from, id, weight = PRICE) => shared.windowAdd(NAME, coverKeyOf(from), { windowMs: WIN, member: `otherproc-1:${id}`, weight: Number(weight) });
const unforeign = (from, id, weight = PRICE) => shared.windowRemove(NAME, coverKeyOf(from), { member: `otherproc-1:${id}`, weight: Number(weight) });
ok(C._inflightCoverShared === true, "redis: the shared half writes through");
let reads = 0, balance = PRICE;
C._setBalanceReaderForTest(async () => { reads++; return balance; });
{
  // Another container holds a run of this wallet: the first run here is no
  // longer judged on verify's proof alone.
  const W = "0x" + "b8".repeat(20);
  ok((await foreign(W, "r1")).ok, "redis: another container's run is in the shared window");
  const r = await attempt(C, W);
  ok(r.err?.statusCode === 429 && reads === 1 && /does not cover this one as well/.test(r.err.message), `redis: this container's first run is judged with the other's and refused on a read (${r.err?.statusCode}, reads ${reads})`);
  const w = await windowOf(W);
  ok(w.ok && w.count === 1, `redis: the refused run's reservation left the window (count ${w.count})`);
  ok(C.inflightCoverStatus().foreignReads >= 1, "redis: the judgment was counted as one taken on a foreign run");
  balance = 2n * PRICE;
  const r2 = await attempt(C, W);
  ok(typeof r2.release === "function", "redis control: a balance for both admits it beside the other container's run");
  const w2 = await windowOf(W);
  ok(w2.count === 2 && w2.sum === Number(2n * PRICE), `redis: the admitted run is a reservation beside the foreign one (count ${w2.count}, sum ${w2.sum})`);
  r2.release();
  await new Promise((res) => setTimeout(res, 50));
  ok((await windowOf(W)).count === 1, "redis: a released run leaves the window");
  // The foreign run leaves: the wallet's next run is admitted on its own proof.
  await unforeign(W, "r1");
  balance = 0n;
  const before = reads;
  const r3 = await attempt(C, W);
  ok(typeof r3.release === "function" && reads === before, "redis: with nothing in flight anywhere the first run is admitted on verify's proof, no read");
  r3.release();
}
{
  // A cached balance read taken BEFORE the other container's run appeared
  // does not decide: that run drew on a balance the read never saw.
  C._resetInflightCoverForTest();
  reads = 0; balance = 3n * PRICE;
  C._setBalanceReaderForTest(async () => { reads++; return balance; });
  const W = "0x" + "c9".repeat(20);
  const a = await attempt(C, W);
  const b = await attempt(C, W);
  ok(typeof a.release === "function" && typeof b.release === "function" && reads === 1, "redis: two local runs against a balance for three, one read (cached)");
  b.release();
  // Now another container's run, and the balance has been drawn on by it: the
  // cached read (three prices) would cover this run beside the two in flight,
  // the fresh one (two prices) does not.
  await foreign(W, "r2");
  balance = 2n * PRICE;
  const c = await attempt(C, W);
  ok(c.err?.statusCode === 429 && reads === 2, `redis: the cached read (balance for three) is not reused once a foreign run is in the window; a fresh read refuses (reads ${reads})`);
  a.release();
  await unforeign(W, "r2");
}
{
  // Four at once from one wallet against a balance for three, the first
  // already in flight: this process's own reservations are not counted twice
  // (they enter the ledger one at a time), so exactly three run.
  C._resetInflightCoverForTest();
  balance = 3n * PRICE;
  C._setBalanceReaderForTest(async () => { await new Promise((r) => setTimeout(r, 30)); return balance; });
  const W = "0x" + "e1".repeat(20);
  const first = await attempt(C, W);
  const racing = await Promise.all([1, 2, 3].map(() => attempt(C, W)));
  const fit = racing.filter((x) => typeof x.release === "function");
  ok(typeof first.release === "function" && fit.length === 2 && racing.filter((x) => x.err?.statusCode === 429).length === 1, `redis: four at once against a balance for three admit three, refuse one (admitted ${fit.length + 1})`);
  first.release(); fit.forEach((x) => x.release());
  await new Promise((r) => setTimeout(r, 50));
  ok((await windowOf(W)).count === 0 && C.inflightCoverStatus().runsInFlight === 0, "redis: every reservation left the window and the ledger");
}
// Clean up this run's keys.
try {
  const { getSharedRedisClient } = await import("../src/shared-limit.js");
  const c = await getSharedRedisClient();
  const keys = c ? await c.keys(`sl:${process.env.SHARED_LIMITS_PREFIX}:*`) : [];
  if (keys.length) await c.del(keys);
} catch { /* best effort */ }
console.log(`\ntest-inflight-cover-shared: ${pass} passed, 0 failed`);
process.exit(0);

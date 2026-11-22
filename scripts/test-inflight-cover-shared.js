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
//      counted twice; a refused or released run leaves the window. A view of
//      the window and a balance read are ordered by the process's own count:
//      with the clock held still (every stamp equal), a read that began
//      before the view still does not decide, in either direction, whether
//      it has finished (cached) or is still under way (pending), and reads
//      that began after it are still shared. A run another container held
//      that leaves the window is a departure: with a read cached, with a read
//      under way, and with nothing in flight here at all, the next judgment
//      is on a read taken after it; so is a local run that leaves while the
//      window is being read. A wallet's burst beside another container's run
//      (at once, or one run after another) shares one read at a time and
//      nobody in it is refused or admitted unread. At the production
//      default, a run beside another container's run that stays is refused
//      after about one second, a run that leaves before the wait runs out is
//      seen by a last look, and a waiting run's reservation is out of the
//      window while it waits and back in it before it is judged.
// Under CI a missing REDIS_URL fails (a skipped integration test is not
// coverage); a local run says the Redis half was skipped. The two-process
// case is scripts/test-shared-limits-crossprocess.js.
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROLE = process.argv[2] || "main";
let pass = 0;
// Holders this process started: a failure stops them before it exits, so no
// container is left holding the output pipe open.
const holders = new Set();
const fail = (m) => { console.error(`FAIL - ${m}`); for (const c of holders) { try { c.kill("SIGKILL"); } catch { /* gone */ } } process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };

const PRICE = 600000n;
const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const hdr = (from, value = PRICE) => Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", asset: ASSET }, payload: { signature: "0x11", authorization: { from, to: "0x" + "cd".repeat(20), value: String(value), validAfter: "0", validBefore: "9999999999", nonce: "0x01" } } })).toString("base64");
const reqFor = (from) => { const h = hdr(from); return { header: (n) => (String(n).toLowerCase() === "payment-signature" ? h : undefined) }; };
const coverKeyOf = (from) => `eip155:8453|${ASSET}|${from.toLowerCase()}`;
// A run the balance does not cover beside another container's run waits for
// one to leave before it is refused; the suite keeps that wait short unless a
// case is about it.
const QUICK = { settleWaitMs: 150 };
const attempt = async (C, from, opts = QUICK) => { try { return { release: await C.admitCoveredRun(reqFor(from), opts) }; } catch (e) { return { err: e }; } };
const turn = () => new Promise((r) => setImmediate(r));
// Waits for an outcome with a deadline (on a clock no case holds still), so a
// regression fails here and never hangs the suite.
const until = async (cond, what, ms = 15_000) => { const end = performance.now() + ms; while (!cond()) { if (performance.now() > end) { fail(`timed out waiting for ${what}`); return false; } await turn(); } return true; };

// A Solana payment of one fixed wallet (the same keys in every process for
// one `seed`), in
// either shape: `lookup` puts the source, mint and destination in a lookup
// table, so the source account is not known and the run is keyed on the
// wallet; otherwise it is keyed on the source token account.
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
async function solReq(lookup, seed = 10) {
  const kit = await import("@solana/kit");
  const signer = (n) => kit.createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(n));
  const [buyer, fp, src, payTo, table] = await Promise.all([1, 2, 3, 4, 5].map((i) => signer(seed + i)));
  const u64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; };
  const CB = "ComputeBudget111111111111111111111111111111", TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const ixs = [
    { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([2, 0x20, 0x4e, 0, 0]) },
    { programAddress: kit.address(CB), accounts: [], data: new Uint8Array([3, ...u64(Date.now())]) },
    { programAddress: kit.address(TOKEN), accounts: [
      { address: src.address, role: kit.AccountRole.WRITABLE },
      { address: kit.address(SOL_USDC), role: kit.AccountRole.READONLY },
      { address: payTo.address, role: kit.AccountRole.WRITABLE },
      { address: buyer.address, role: kit.AccountRole.READONLY_SIGNER, signer: buyer },
    ], data: new Uint8Array([12, ...u64(PRICE), 6]) },
  ];
  const blockhash = { blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n };
  let msg = kit.pipe(kit.createTransactionMessage({ version: 0 }), (x) => kit.setTransactionMessageFeePayer(fp.address, x), (x) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, x), (x) => kit.appendTransactionMessageInstructions(ixs, x));
  if (lookup) msg = kit.compressTransactionMessageUsingAddressLookupTables(msg, { [table.address]: [src.address, kit.address(SOL_USDC), payTo.address] });
  const transaction = kit.getBase64EncodedWireTransaction(await kit.partiallySignTransaction([buyer.keyPair], kit.compileTransaction(msg)));
  const h = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: SOL_NET, asset: SOL_USDC, amount: String(PRICE), payTo: payTo.address, extra: { feePayer: fp.address } }, payload: { transaction } })).toString("base64");
  return { header: (n) => (String(n).toLowerCase() === "payment-signature" ? h : undefined) };
}

if (ROLE === "svm-holder") {
  // A container that admits one Solana run of the fixed wallet, in the shape
  // HOLD_SHAPE names, on a balance of one price, and holds it until killed.
  const C = await import("../src/inflight-cover.js");
  C._setBalanceReaderForTest(async () => PRICE);
  (await import("../src/paid-record.js"))._setPaidRecordForTest(() => true);
  let r;
  try { r = { release: await C.admitCoveredRun(await solReq(process.env.HOLD_SHAPE === "lookup", Number(process.env.HOLD_SEED)), QUICK) }; } catch (e) { r = { err: e }; }
  console.log(typeof r.release === "function" ? "HOLDING" : `NOT-HOLDING ${r.err?.message}`);
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (ROLE === "holder") {
  // A container that admits one run for the wallet named in HOLD_WALLET and
  // holds it until it is killed (the Redis half kills it with SIGKILL).
  const C = await import("../src/inflight-cover.js");
  C._setBalanceReaderForTest(async () => PRICE);
  const r = await attempt(C, process.env.HOLD_WALLET);
  console.log(typeof r.release === "function" ? "HOLDING" : `NOT-HOLDING ${r.err?.message}`);
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
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
  {
    // The read lane (8 at once across wallets) is a queue: a ninth and tenth
    // wallet's reads find it full and wait for a place inside the admission
    // wait (about a second); with none, they are admitted inside the unread
    // allowance. A full lane never reads as unknown at once.
    C._resetInflightCoverForTest();
    const gated = [];
    C._setBalanceReaderForTest(() => new Promise((res) => gated.push(res)));
    const wallets = Array.from({ length: 10 }, (_, i) => "0x" + (0x10 + i).toString(16).repeat(20));
    const firsts = [];
    for (const w of wallets) firsts.push(await attempt(C, w));
    const t0 = performance.now();
    // The first eight take the lane and wait the long way; the ninth and
    // tenth are given the suite's short admission wait.
    const seconds = wallets.map((w, i) => attempt(C, w, i < 8 ? { settleWaitMs: 5_000 } : QUICK));
    const late = await Promise.all(seconds.slice(8));
    const lateMs = performance.now() - t0;
    ok(firsts.every((x) => typeof x.release === "function") && gated.length === 8 && late.every((x) => typeof x.release === "function") && C.inflightCoverStatus().admittedUnread === 2 && C.inflightCoverStatus().readsQueued === 2 && lateMs >= 100 && lateMs < 1_000,
      `memory: with eight reads under way, a ninth and tenth wallet's second runs wait for a place in the lane and, with none inside their admission wait, are admitted inside the unread allowance (under way ${gated.length}, unread ${C.inflightCoverStatus().admittedUnread}, ${Math.round(lateMs)} ms)`);
    for (const g of gated) g(2n * PRICE);
    await Promise.all(seconds);
    // A run waiting on a settling one is woken when that run leaves, not
    // when its wait runs out (ten minutes here).
    C._resetInflightCoverForTest();
    let bal = PRICE;
    C._setBalanceReaderForTest(async () => bal);
    const S = "0x" + "1c".repeat(20);
    const s1 = await attempt(C, S);
    s1.release.settling();
    let woken = false;
    const s2p = attempt(C, S, { settleWaitMs: 600_000 }).then((r) => { woken = true; return r; });
    await until(() => C.inflightCoverStatus().settleWaits >= 1, "the second run to wait on the settling one");
    s1.release();
    ok(await until(() => woken, "the waiting run to be woken by the departure") && typeof (await s2p).release === "function", "memory: a run waiting on a settling run is judged again as soon as that run leaves");
  }
  console.log(`CHILD_PASS ${pass}`);
  process.exit(0);
}

if (ROLE === "model") {
  // The shared half is on and the window is a model in this process (the
  // store's three window calls are replaced before the first run), so the
  // cases below need no server: a window too large to list, the bound on
  // the last-view memory, and the read that follows the read under way.
  const C = await import("../src/inflight-cover.js");
  const { shared } = await import("../src/shared-limits.js");
  // Every wallet here has a paid record: these cases are about coverage across
  // containers, not a new wallet's first calls (scripts/test-inflight-admission.js).
  (await import("../src/paid-record.js"))._setPaidRecordForTest(() => true);
  ok(C._inflightCoverShared === true, "model: the shared half is on");
  const wins = new Map(); // coverKey -> Map(member -> weight)
  const scores = new Map(); // member -> when it was written (0: long ago)
  let unlisted = false, beforeRead = null;
  const winOf = (k) => { if (!wins.has(k)) wins.set(k, new Map()); return wins.get(k); };
  const snap = (k) => { const w = winOf(k); const sum = [...w.values()].reduce((x, y) => x + y, 0); return { ok: true, count: w.size, sum, entries: unlisted ? null : [...w].map(([member, weight]) => ({ member, weight, score: scores.get(member) || 0 })) }; };
  shared.windowAdd = async (n, k, { member, weight }) => { winOf(k).set(String(member), weight); return snap(k); };
  shared.windowRead = async (n, k) => { const step = beforeRead; beforeRead = null; if (step) step(k); return snap(k); };
  shared.windowRemove = async (n, k, { member }) => { winOf(k).delete(String(member)); return { ok: true }; };
  // Liveness keys, in the model: "otherproc-1" is a live container; a process
  // named nowhere here has none.
  const live = new Set(["otherproc-1"]);
  const marks = new Map(); // wallet -> the `until` of its last-settlement mark
  shared.flagSet = async (n, k, until) => { if (n === "inflight-cover-live") live.add(String(k)); if (n === "inflight-cover-settled") marks.set(String(k), until); return { ok: true }; };
  shared.flagGet = async (n, k) => ({ ok: true, until: n === "inflight-cover-live" ? (live.has(String(k)) ? Date.now() + 60_000 : 0) : n === "inflight-cover-settled" ? (marks.get(String(k)) || 0) : 0 });
  const P = Number(PRICE);
  let reads = 0, balance = 0n;
  {
    // A window too large to list names nobody: a run that leaves it shows
    // only as a lower count between this run's two views. The balance read
    // taken before that is not judged on; the run is judged on a fresh one.
    for (const [label, after, admitted] of [["the balance left does not cover it", 600n * PRICE + PRICE / 2n, false], ["control: the balance left covers it", 601n * PRICE, true]]) {
      C._resetInflightCoverForTest();
      reads = 0; balance = 602n * PRICE; unlisted = true;
      C._setBalanceReaderForTest(async () => { reads++; return balance; });
      const W = "0x" + (admitted ? "c2" : "c1").repeat(20), k = coverKeyOf(W);
      for (let i = 0; i < 600; i++) winOf(k).set(`otherproc-1:u${i}`, P);
      const a = await attempt(C, W, { settleWaitMs: 0 });
      beforeRead = () => { winOf(k).delete("otherproc-1:u0"); balance = after; };
      const b = await attempt(C, W, { settleWaitMs: 0 });
      ok(typeof a.release === "function" && reads === 3 && (admitted ? typeof b.release === "function" : b.err?.statusCode === 429),
        `model, unlisted window (${label}): a lower count between two views is a departure; the run is ${admitted ? "admitted" : "refused"} on a read taken after it (${b.err?.statusCode || "admitted"}, reads ${reads}, want 3)`);
      a.release?.(); b.release?.();
      unlisted = false;
    }
  }
  {
    // A window too large to list, and a run waiting outside it beside runs
    // that stay: its own absence is not a departure, so it looks without
    // reading the balance again and is refused once, on its first read.
    C._resetInflightCoverForTest();
    reads = 0; balance = 600n * PRICE + PRICE / 2n; unlisted = true;
    C._setBalanceReaderForTest(async () => { reads++; return balance; });
    const W = "0x" + "c4".repeat(20), k = coverKeyOf(W);
    for (let i = 0; i < 600; i++) winOf(k).set(`otherproc-1:v${i}`, P);
    const r = await attempt(C, W, { settleWaitMs: 800 });
    const st = C.inflightCoverStatus();
    ok(r.err?.statusCode === 429 && reads === 1 && st.withdrawals === 1, `model, unlisted window: a run waiting outside it does not take its own absence for a departure (${r.err?.statusCode || "admitted"}, reads ${reads}, want 1; waits ${st.withdrawals}, want 1)`);
    // A balance short beside another container's run does not clear when
    // that run settles (its amount leaves the balance and the window
    // together): the refusal's advice is to add funds, in the fix and the
    // message alike (runs with no shared store).
    ok(r.err?.coverRefusal === "beside" && r.err.fix === "Your input is fine. Add funds to this wallet, then retry after Retry-After." && /add funds to this wallet, then retry after Retry-After\. You have not been charged\./.test(r.err.message) && r.err.retryAfter === 30, `model: a beside refusal gives the add-funds advice (${r.err?.coverRefusal}: ${r.err?.fix})`);
    unlisted = false;
  }
  {
    // The last-view memory is bounded: past 10,000 wallets the least recently
    // viewed goes, and a view older than the shared window is dropped.
    C._resetInflightCoverForTest();
    balance = 100n * PRICE;
    C._setBalanceReaderForTest(async () => balance);
    let peak = 0;
    const walletAt = (i) => "0x" + i.toString(16).padStart(40, "0");
    for (let i = 1; i <= 10_300; i++) {
      const k = coverKeyOf(walletAt(i));
      winOf(k).set("otherproc-1:m", P);
      (await C.admitCoveredRun(reqFor(walletAt(i))))();
      peak = Math.max(peak, C.inflightCoverStatus().viewsKept);
    }
    ok(peak === 10_000 && C.inflightCoverStatus().viewsKept === 10_000, `model: the last-view memory holds at most 10,000 wallets (peak ${peak}, now ${C.inflightCoverStatus().viewsKept})`);
    // The newest wallet is still remembered: its foreign run leaving sends
    // its next run to a read.
    reads = 0;
    C._setBalanceReaderForTest(async () => { reads++; return balance; });
    winOf(coverKeyOf(walletAt(10_300))).delete("otherproc-1:m");
    (await C.admitCoveredRun(reqFor(walletAt(10_300))))();
    ok(reads === 1 && C.inflightCoverStatus().viewsKept === 9_999, `model: a wallet still remembered is judged on a read when its foreign run has left, and its entry goes (reads ${reads}, kept ${C.inflightCoverStatus().viewsKept})`);
    const realNow = Date.now;
    Date.now = () => realNow() + 16 * 60_000;
    try {
      const k = coverKeyOf(walletAt(20_000));
      winOf(k).set("otherproc-1:m", P);
      (await C.admitCoveredRun(reqFor(walletAt(20_000))))();
    } finally { Date.now = realNow; }
    ok(C.inflightCoverStatus().viewsKept === 1, `model: views older than the shared window are dropped at the next view (kept ${C.inflightCoverStatus().viewsKept}, want 1)`);
  }
  {
    // The read that follows the read under way becomes the read under way
    // when it begins: a run whose view lands after that waits behind it and
    // starts no read beside it.
    C._resetInflightCoverForTest();
    wins.clear();
    const gated = [];
    C._setBalanceReaderForTest(() => new Promise((res) => gated.push(res)));
    const W = "0x" + "c3".repeat(20);
    winOf(coverKeyOf(W)).set("otherproc-1:q", P);
    const judged = () => C.inflightCoverStatus().foreignReads;
    const ap = attempt(C, W);
    await until(() => gated.length === 1, "run a's read");
    let mark = judged();
    const bp = attempt(C, W);
    await until(() => judged() > mark, "run b to ask for a balance");
    for (let i = 0; i < 5; i++) await turn();
    const besideFirst = gated.length;
    gated[0](100n * PRICE);
    await until(() => gated.length === 2, "the read that follows to begin");
    mark = judged();
    const cp = attempt(C, W);
    await until(() => judged() > mark, "run c to ask for a balance");
    for (let i = 0; i < 5; i++) await turn();
    const besideSecond = gated.length;
    gated[1](100n * PRICE);
    await until(() => gated.length === 3, "run c's read to begin after the second ended");
    gated[2](100n * PRICE);
    const out = await Promise.all([ap, bp, cp]);
    ok(besideFirst === 1 && besideSecond === 2 && gated.length === 3 && out.every((x) => typeof x.release === "function"),
      `model: one read under way at a time across three runs whose views land one read apart (under way ${besideFirst}, then ${besideSecond}; reads ${gated.length}, want 1, 2, 3)`);
    out.forEach((x) => x.release?.());
  }
  {
    // A process that died mid-run left its reservation in the window. It has
    // no liveness key, so it is not counted: a wallet holding exactly this
    // call's price is admitted, on a read taken after the drop (the process
    // may have settled the run before it went), and the reservation is
    // taken out of the window. The same reservation from a live process counts.
    C._resetInflightCoverForTest();
    unlisted = false; reads = 0; balance = PRICE;
    C._setBalanceReaderForTest(async () => { reads++; return balance; });
    const D = "0x" + "d7".repeat(20), kD = coverKeyOf(D);
    winOf(kD).set("live~deadproc-9:r1", P);
    live.add("live~liveproc-2");
    const a = await attempt(C, D);
    ok(typeof a.release === "function" && reads === 1 && !winOf(kD).has("live~deadproc-9:r1") && C.inflightCoverStatus().deadReservationsIgnored === 1, `model: a reservation whose process has no liveness key is ignored and removed; the drop is a departure, so the wallet's call is judged on a read and admitted (${a.err?.statusCode || "admitted"}, reads ${reads})`);
    a.release();
    const L = "0x" + "d8".repeat(20), kL = coverKeyOf(L);
    winOf(kL).set("live~liveproc-2:r1", P);
    const b2 = await attempt(C, L);
    ok(b2.err?.statusCode === 429 && winOf(kL).has("live~liveproc-2:r1"), `model control: the same reservation from a live process is counted, and the call the balance cannot also cover is refused (${b2.err?.statusCode || "admitted"})`);
    // A reservation written a moment ago is counted whether or not its
    // process's key is there yet (a key can lag its first reservation).
    const Y = "0x" + "d9".repeat(20), kY = coverKeyOf(Y);
    winOf(kY).set("live~startingproc-3:r1", P); scores.set("live~startingproc-3:r1", Date.now());
    const y1 = await attempt(C, Y);
    ok(y1.err?.statusCode === 429 && winOf(kY).has("live~startingproc-3:r1"), `model: a reservation younger than a liveness key's life is counted without one (${y1.err?.statusCode || "admitted"})`);
    // The owner dies: its key lapses, and from then on its reservation is ignored.
    live.delete("live~liveproc-2");
    await new Promise((res) => setTimeout(res, 2100)); // past the liveness cache
    const c2 = await attempt(C, L);
    ok(typeof c2.release === "function" && !winOf(kL).has("live~liveproc-2:r1"), `model: once the owner's liveness key is gone its reservation no longer refuses the wallet (${c2.err?.statusCode || "admitted"})`);
    c2.release();
    ok([...live].some((k) => /^live~\d+-[a-z0-9]+$/.test(k)), `model: this process keeps a liveness key of its own, under an id that says so (${[...live].join(", ")})`);
    // A build that keeps no liveness key (the one this build replaces, still
    // serving while a deploy overlaps) writes ids without the mark. Its
    // reservation is counted until it ages out of the window, however old it
    // is and with no key anywhere: never dropped early.
    const O = "0x" + "da".repeat(20), kO = coverKeyOf(O);
    const ignoredBefore = C.inflightCoverStatus().deadReservationsIgnored;
    winOf(kO).set("4242-ab12cd:r1", P); // score 0: written long ago
    const o1 = await attempt(C, O);
    ok(o1.err?.statusCode === 429 && winOf(kO).has("4242-ab12cd:r1") && C.inflightCoverStatus().deadReservationsIgnored === ignoredBefore, `model: a reservation of a build that keeps no liveness key counts, however old, and stays in the window (${o1.err?.statusCode || "admitted"})`);
    // The wallet's last-settlement mark is shared. A run of the wallet settled
    // on ANOTHER container after this call arrived: verify may predate that
    // payment, so the call is judged on a read here too, not on verify alone.
    const M = "0x" + "dc".repeat(20), kM = coverKeyOf(M);
    reads = 0; balance = 0n;
    marks.set(kM, Date.now() - 50 + 120_000); // settled there 50 ms ago
    const late = await attempt(C, M, { arrivedAt: Date.now() - 500 });
    ok(late.err?.statusCode === 429 && reads === 1 && C.inflightCoverStatus().foreignSettlementsSeen >= 1, `model: a call that arrived before another container's settlement of the wallet is judged on a read (${late.err?.statusCode || "admitted"}, reads ${reads})`);
    const after = await attempt(C, M, { arrivedAt: Date.now() });
    ok(typeof after.release === "function" && reads === 1, `model control: a call that arrived after it is admitted on verify's proof, with no read (${after.err?.statusCode || "admitted"}, reads ${reads})`);
    marks.delete(kM);
    after.release.settled();
    await new Promise((res) => setTimeout(res, 30));
    ok(marks.get(kM) > Date.now() + 100_000, "model: a settlement here writes the wallet's mark for the other containers");
    // A settlement another container made was never taken off this process's
    // reads of the wallet: its last good read here is forgotten, so with the
    // balance unreadable the wallet is judged as one never read (the
    // allowance), not as covered by that read.
    const G = "0x" + "dd".repeat(20), kG = coverKeyOf(G);
    balance = PRICE * 10n; reads = 0;
    const g0 = await attempt(C, G); g0.release.settled(); // leaves a last good read of ten prices here
    await new Promise((res) => setTimeout(res, 30));
    const onKeptBefore = C.inflightCoverStatus().admittedOnKeptRead;
    marks.set(kG, Date.now() + 5_000 + 120_000); // another container settles a run of the wallet after that read
    C._setBalanceReaderForTest(async () => { throw new Error("rpc down"); });
    C._ageKeptReadsForTest(60_000);
    const g1 = await attempt(C, G, { arrivedAt: Date.now() + 10_000 });
    const g2 = await attempt(C, G, { arrivedAt: Date.now() + 10_000 });
    ok(typeof g1.release === "function" && typeof g2.release === "function" && C.coveredRunStateOf(g2.req) !== "covered" && C.inflightCoverStatus().admittedOnKeptRead === onKeptBefore, `model: after another container's settlement the wallet's last good read here is not judged on (${C.coveredRunStateOf(g2.req)})`);
    g1.release(); g2.release();
    C._setBalanceReaderForTest(async () => { reads++; return balance; });
    // A process stalled for longer than its liveness key lasts: another
    // container dropped its reservation meanwhile. At its next renewal it
    // writes back every reservation it still holds.
    const R = "0x" + "db".repeat(20), kR = coverKeyOf(R);
    balance = PRICE * 10n;
    const r1 = await attempt(C, R);
    const mine = [...winOf(kR).keys()].filter((m) => m.startsWith("live~"));
    await C._liveBeatForTest(Date.now());
    for (const m of mine) winOf(kR).delete(m); // dropped by another container while this one was stalled
    const written = await C._liveBeatForTest(Date.now() + 10 * 60_000);
    await new Promise((res) => setTimeout(res, 20));
    ok(typeof r1.release === "function" && mine.length === 1 && written >= 1 && winOf(kR).has(mine[0]) && C.inflightCoverStatus().reservationsWrittenBack >= 1, `model: a process that renews its liveness key later than the key lasts writes its reservations back (${written} written)`);
    r1.release();
    await new Promise((res) => setTimeout(res, 20));
    const none = await C._liveBeatForTest(Date.now() + 20 * 60_000);
    ok(none === 0 || !winOf(kR).has(mine[0]), "model: a reservation already removed is not written back");
  }
  {
    // JUDGED AT ONCE beside other containers. A kept balance read is trusted
    // only once the wallet's last-settlement mark has been read: another
    // container that admitted and settled runs of the wallet between two of
    // this one's views left nothing in the window, only its mark and a lower
    // balance on chain.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const [label, left, want] of [["the balance left covers one run", 1n, 0], ["control: the balance left still covers them all", 20n, 12]]) {
      C._resetInflightCoverForTest();
      const W = "0x" + (want ? "e2" : "e1").repeat(20), k = coverKeyOf(W);
      let chain = 10n * PRICE, made = 0;
      C._setBalanceReaderForTest(async () => { made++; return chain; });
      // This container: one long run in flight, and a second call that reads
      // the balance (ten prices) and ends.
      const a1 = await attempt(C, W);
      const a2 = await attempt(C, W); a2.release?.();
      const kept = made;
      // Control: nothing settled elsewhere, so a call is admitted at once on the kept read.
      let s0 = C.inflightCoverStatus();
      const c1 = await attempt(C, W);
      let s1 = C.inflightCoverStatus();
      ok(typeof c1.release === "function" && made === kept && s1.admittedAtOnceOnKeptRead === s0.admittedAtOnceOnKeptRead + 1 && s1.foreignSettlementsSeen === s0.foreignSettlementsSeen, `model, at once (${label}): control, with no settlement elsewhere a call is admitted on the kept read with no new read`);
      c1.release?.();
      // Another container settles nine runs of the wallet: what is left is
      // the balance on chain and that container's mark.
      chain = left * PRICE;
      marks.set(k, Date.now() + 5 + C.SETTLED_MARK_MS);
      await sleep(30);
      s0 = C.inflightCoverStatus();
      const burst = []; for (let i = 0; i < 12; i++) burst.push(await attempt(C, W));
      s1 = C.inflightCoverStatus();
      const admitted = burst.filter((x) => x.release).length;
      ok(admitted === want && s1.foreignSettlementsSeen === s0.foreignSettlementsSeen + 1 && made === kept + 1 && burst.every((x) => x.release || x.err?.coverRefusal === "short"),
        `model, at once (${label}): the mark is read before the kept read is trusted; a settlement made elsewhere drops it and the burst of 12 is judged on one new read: ${want} admitted (${admitted} admitted, new reads ${made - kept}, settlements seen ${s1.foreignSettlementsSeen - s0.foreignSettlementsSeen})`);
      for (const x of [a1, ...burst]) x.release?.();
    }
  }
  console.log(`CHILD_PASS ${pass}`);
  process.exit(0);
}

// ---- 1 and 2: memory and degraded, each in its own process (the backend is
// fixed at boot) ----------------------------------------------------------------------
const here = fileURLToPath(import.meta.url);
for (const [role, extra, min] of [
  ["memory", { REDIS_URL: "" }, 5],
  ["model", { REDIS_URL: "redis://127.0.0.1:1", SHARED_LIMITS: "on" }, 8],
  ["degraded", { REDIS_URL: "redis://127.0.0.1:1", SHARED_LIMITS: "on", SHARED_LIMITS_OP_MS: "150" }, 7],
]) {
  const env = { ...process.env, INFLIGHT_COVER: "", ...extra };
  const r = spawnSync(process.execPath, [here, role], { env, encoding: "utf8", timeout: 120_000 });
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
// A short liveness key, so the case that kills a container does not wait 30 s.
const LIVE_TTL = 1_500;
process.env.INFLIGHT_COVER_LIVE_TTL_MS = String(LIVE_TTL);
const C = await import("../src/inflight-cover.js");
const { shared } = await import("../src/shared-limits.js");
// "otherproc-1" stands for a live container throughout this half.
await shared.flagSet("inflight-cover-live", "otherproc-1", Date.now() + 30 * 60_000);
(await import("../src/paid-record.js"))._setPaidRecordForTest(() => true);
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
  ok(r.err?.statusCode === 429 && reads === 1 && /does not cover this one as well/.test(r.err.message), `redis: this container's first run is judged with the other's and refused on a read (${r.err?.statusCode}, reads ${reads}: ${String(r.err?.message).slice(0, 80)})`);
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
  // The foreign run leaves. It may have settled since this run's payment
  // was verified, so the wallet's next run is judged on one read, taken after
  // the view that no longer shows it; the run after that needs none.
  await unforeign(W, "r1");
  balance = PRICE;
  const before = reads;
  const r3 = await attempt(C, W);
  ok(typeof r3.release === "function" && reads === before + 1, `redis: the first run after another container's run left the window is admitted on one fresh read (reads ${reads - before})`);
  r3.release();
  balance = 0n;
  const r4 = await attempt(C, W);
  ok(typeof r4.release === "function" && reads === before + 1, "redis: with nothing in flight anywhere and nothing gone since, the next run is admitted on verify's proof, no read");
  r4.release();
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
{
  // The clock is held still, so a read and the next view of the window carry
  // one timestamp. The read began before that view, so it does not decide.
  C._resetInflightCoverForTest();
  reads = 0; balance = PRICE;
  C._setBalanceReaderForTest(async () => { reads++; return balance; });
  const realNow = Date.now, T = realNow();
  Date.now = () => T;
  try {
    const W = "0x" + "f2".repeat(20);
    await foreign(W, "r3");
    const short = await attempt(C, W);
    ok(short.err?.statusCode === 429 && reads === 1, `still clock: a balance for one beside another container's run is refused on a read (${short.err?.statusCode}, reads ${reads})`);
    // The wallet is funded. The read above finished in the same millisecond
    // as the view this run takes: it is not reused, and the run is admitted.
    balance = 2n * PRICE;
    const funded = await attempt(C, W);
    ok(typeof funded.release === "function" && reads === 2, `still clock: the funded wallet's run is judged on a read begun after its view and admitted (${funded.err?.statusCode || "admitted"}, reads ${reads})`);
    // The other direction: the balance was drawn on after a read. The earlier
    // read (three prices) would admit a run the balance left (two) cannot pay.
    const U = "0x" + "f3".repeat(20);
    await foreign(U, "r4");
    balance = 3n * PRICE;
    const u1 = await attempt(C, U);
    const before = reads;
    balance = 2n * PRICE;
    const u2 = await attempt(C, U);
    ok(typeof u1.release === "function" && u2.err?.statusCode === 429 && reads === before + 1, `still clock: a run the balance no longer covers is refused on a read begun after its view (${u2.err?.statusCode || "admitted"}, reads ${reads - before})`);
    // Control: runs judged together beside a foreign run still share reads
    // (the read begins after their views), never one read each.
    const X = "0x" + "f4".repeat(20);
    await foreign(X, "r5");
    balance = 100n * PRICE;
    const mark = reads;
    const six = await Promise.all([1, 2, 3, 4, 5, 6].map(() => attempt(C, X)));
    ok(six.every((x) => typeof x.release === "function") && reads - mark >= 1 && reads - mark <= 2 && C.inflightCoverStatus().admittedUnread === 0, `still clock control: six runs at once beside a foreign run are admitted on shared reads, none unread (reads ${reads - mark})`);
    funded.release(); u1.release(); six.forEach((x) => x.release?.());
    for (const [w, id] of [[W, "r3"], [U, "r4"], [X, "r5"]]) await unforeign(w, id);
  } finally { Date.now = realNow; }
}
{
  // A read still PENDING when a later view lands does not decide for that
  // view's run either. The test holds each read open and answers it by hand:
  // run A's read is under way when run B's view of the window lands, so B
  // gets a read of its own, begun after its view, and B's verdict follows
  // the balance that second read returns, in both directions. Clock held.
  C._resetInflightCoverForTest();
  const gated = [];
  C._setBalanceReaderForTest(() => new Promise((res) => gated.push(res)));
  const realNow = Date.now, T = realNow();
  Date.now = () => T;
  try {
    for (const [wallet, id, firstRead, secondRead, bAdmitted] of [
      // A's read covers all three runs; the balance B's own read finds does not.
      ["0x" + "f6".repeat(20), "r7", 3n * PRICE, 2n * PRICE, false],
      // A's read covers two runs; B's own read finds a balance for all three.
      ["0x" + "f7".repeat(20), "r8", 2n * PRICE, 3n * PRICE, true],
    ]) {
      gated.length = 0;
      await foreign(wallet, id);
      const judged = C.inflightCoverStatus().foreignReads;
      const a = attempt(C, wallet);
      await until(() => C.inflightCoverStatus().foreignReads >= judged + 1 && gated.length >= 1, "run A's read to begin");
      const b = attempt(C, wallet);
      // B has asked for a balance (counted just before it asks). The read
      // under way began before B's view, so B waits for the one that follows
      // it: one read at a time for the wallet, begun after B's view.
      await until(() => C.inflightCoverStatus().foreignReads >= judged + 2, "run B to ask for a balance");
      await turn();
      ok(gated.length === 1, `pending read: a run whose view landed while another run's read was under way does not share it and starts no second read beside it (reads under way ${gated.length}, want 1)`);
      gated[0](firstRead);
      const ra = await a;
      await until(() => gated.length >= 2, "run B's own read to begin after run A's ended");
      gated[1](secondRead);
      const rb = await b;
      ok(typeof ra.release === "function" && (bAdmitted ? typeof rb.release === "function" : rb.err?.statusCode === 429) && gated.length === 2,
        `pending read: the later run is ${bAdmitted ? "admitted" : "refused"} on the balance its own read returned, not the earlier read's (first ${ra.err?.statusCode || "admitted"}, later ${rb.err?.statusCode || "admitted"}, reads ${gated.length})`);
      ra.release?.(); rb.release?.();
      await unforeign(wallet, id);
    }
  } finally { Date.now = realNow; }
}
{
  // Control: a cached read that began AFTER a run's latest view is reused by
  // it. A run waits on a settling one; a second run reads meanwhile; when the
  // wait ends with nobody gone, the first is judged on that read, not a new one.
  C._resetInflightCoverForTest();
  reads = 0; balance = 2n * PRICE;
  C._setBalanceReaderForTest(async () => { reads++; return balance; });
  const S = "0x" + "f5".repeat(20);
  await foreign(S, "r6");
  const held = await attempt(C, S);
  held.release?.settling();
  const waiting = C.admitCoveredRun(reqFor(S), { settleWaitMs: 1500 }).then((release) => ({ release }), (err) => ({ err }));
  await until(() => C.inflightCoverStatus().settleWaits >= 1, "the run to wait on the settling one");
  const parked = reads;
  let z = null; try { await C.admitCoveredRun(reqFor(S), { settleWaitMs: 0 }); } catch (e) { z = e; }
  const afterZ = reads;
  const y = await waiting;
  ok(typeof held.release === "function" && parked === 2 && z?.statusCode === 429 && afterZ === 3 && y.err?.statusCode === 429 && reads === 3, `control: a read begun after the waiting run's view is reused when its wait ends, no further read, and the run the balance does not cover is still refused (reads ${parked}, ${afterZ}, ${reads}; ${y.err?.statusCode || "admitted"})`);
  held.release?.();
  await unforeign(S, "r6");
}
// ---- departures of another container's run, and a wallet's own burst ----
// The window calls of the process under test, counted, with one step the
// test can run just before the next read of the window.
let adds = 0, beforeWindowRead = null;
const realAdd = shared.windowAdd, realRead = shared.windowRead;
let failOwnAdd = false;
shared.windowAdd = async (...a) => {
  const own = String(a[2]?.member || "").indexOf("otherproc-") !== 0;
  if (own && failOwnAdd) { failOwnAdd = false; return { ok: false, error: "injected" }; }
  const r = await realAdd(...a);
  if (own) adds++;
  return r;
};
shared.windowRead = async (...a) => { const step = beforeWindowRead; beforeWindowRead = null; if (step) await step(); return realRead(...a); };
for (const [label, settledBalance, admitted] of [["the balance left does not cover it", PRICE, false], ["control: the balance left covers it", 2n * PRICE, true]]) {
  // 1. A read is CACHED when the other container's run leaves. Run b reads
  // the balance, then its view of the window shows the foreign run gone (it
  // settled: the balance fell by its price). The read b just took is from
  // before that settlement and would cover b beside the local run; it is
  // dropped, and b is judged on a read taken after the departure.
  C._resetInflightCoverForTest();
  reads = 0; balance = settledBalance + PRICE;
  C._setBalanceReaderForTest(async () => { reads++; return balance; });
  const W = "0x" + (admitted ? "a2" : "a1").repeat(20);
  await foreign(W, "d1");
  const a = await attempt(C, W);
  ok(typeof a.release === "function" && reads === 1, `departure, cached read (${label}): a run beside another container's is admitted on one read`);
  beforeWindowRead = async () => { await unforeign(W, "d1"); balance = settledBalance; };
  const b = await attempt(C, W);
  ok((admitted ? typeof b.release === "function" : b.err?.statusCode === 429) && reads === 3, `departure, cached read (${label}): the read taken before the other container's run left is not reused; the run is ${admitted ? "admitted" : "refused"} on a read taken after it (${b.err?.statusCode || "admitted"}, reads ${reads}, want 3)`);
  a.release(); b.release?.();
}
for (const [label, before, after, admittedCount] of [["the balance left covers neither waiting run", 2n * PRICE, PRICE, 0], ["control: the balance left covers both", 4n * PRICE, 3n * PRICE, 2]]) {
  // 2. A read is PENDING when the other container's run leaves. Run b's read
  // is under way (begun while the foreign run was in the window); the foreign
  // run settles and leaves; run c's view no longer shows it. c must not share
  // b's read, and that read must not be cached: both are judged on a read
  // begun after the view that saw the run gone.
  C._resetInflightCoverForTest();
  const gated = [];
  let auto = null;
  C._setBalanceReaderForTest(() => (auto != null ? Promise.resolve(auto) : new Promise((res) => gated.push(res))));
  const W = "0x" + (admittedCount ? "a4" : "a3").repeat(20);
  await foreign(W, "d2");
  const ap = attempt(C, W);
  await until(() => gated.length === 1, "run a's read");
  gated[0](before);
  const a = await ap;
  const bp = attempt(C, W);
  await until(() => gated.length === 2, "run b's read");
  await unforeign(W, "d2");
  const mark = adds;
  const cp = attempt(C, W);
  await until(() => adds > mark, "run c's view of the window");
  for (let i = 0; i < 5; i++) await turn();
  const fresh = gated.length;
  // b's read answers with the balance from before the settlement; every
  // read begun from here on sees the balance after it.
  auto = after;
  gated[1](before);
  for (let i = 2; i < gated.length; i++) gated[i](after);
  const [b, c] = await Promise.all([bp, cp]);
  const inNow = [b, c].filter((x) => typeof x.release === "function").length;
  ok(typeof a.release === "function" && fresh === 3 && inNow === admittedCount && [b, c].every((x) => typeof x.release === "function" || x.err?.statusCode === 429),
    `departure, pending read (${label}): a run whose view shows the other container's run gone starts a read of its own (reads begun ${fresh}, want 3) and ${admittedCount} of the two waiting runs are admitted (${inNow})`);
  a.release?.(); b.release?.(); c.release?.();
}
for (const [label, after, admitted] of [["nothing left", 0n, false], ["control: the balance left covers it", PRICE, true]]) {
  // 3. The other container's run simply VANISHES from the view, with nothing
  // in flight here and no judgment under way: this process last saw it while
  // judging run a. The wallet's next run was verified against a balance that
  // run's settlement may since have come out of, so it is judged on a read.
  C._resetInflightCoverForTest();
  reads = 0; balance = 2n * PRICE;
  C._setBalanceReaderForTest(async () => { reads++; return balance; });
  const W = "0x" + (admitted ? "a6" : "a5").repeat(20);
  await foreign(W, "d3");
  const a = await attempt(C, W);
  a.release?.();
  await unforeign(W, "d3");
  balance = after;
  const c = await attempt(C, W);
  ok(typeof a.release === "function" && reads === 2 && (admitted ? typeof c.release === "function" : c.err?.statusCode === 429 && /no longer covers/.test(c.err.message)),
    `departure, vanished from the view (${label}): the next run is judged on a fresh read and ${admitted ? "admitted" : "refused"} (${c.err?.statusCode || "admitted"}, reads ${reads}, want 2)`);
  c.release?.();
}
for (const [label, after, admitted] of [["nothing left", 0n, false], ["control: the balance left covers it", PRICE, true]]) {
  // 4. A LOCAL run settles and leaves while run b's view of the window is
  // being read, after b's balance read: that read is from before the
  // settlement, and b is judged again on one taken after it.
  C._resetInflightCoverForTest();
  reads = 0; balance = PRICE;
  C._setBalanceReaderForTest(async () => { reads++; return balance; });
  const W = "0x" + (admitted ? "a8" : "a7").repeat(20);
  const a = await attempt(C, W);
  beforeWindowRead = async () => { balance = after; a.release(); };
  const b = await attempt(C, W);
  ok(typeof a.release === "function" && reads === 2 && (admitted ? typeof b.release === "function" : b.err?.statusCode === 429 && /no longer covers/.test(b.err.message)),
    `a local run that leaves while the window is read (${label}): the run is judged on a read taken after it and ${admitted ? "admitted" : "refused"} (${b.err?.statusCode || "admitted"}, reads ${reads}, want 2)`);
  b.release?.();
}
for (const [label, staggered] of [["one after another", true], ["at once", false]]) {
  // 5. A wallet's own burst beside another container's run. Every run needs
  // a read begun after its own view. Thirty runs, each view landing after the
  // read before it began (or all at once): one read under way at a time, the
  // rest share the one that follows, nobody is refused and nobody is unread.
  C._resetInflightCoverForTest();
  const gated = [];
  C._setBalanceReaderForTest(() => new Promise((res) => gated.push(res)));
  const W = "0x" + (staggered ? "a9" : "aa").repeat(20);
  await foreign(W, "d5");
  const N = 30, runs = [];
  for (let i = 0; i < N; i++) {
    const mark = adds;
    runs.push(attempt(C, W));
    if (staggered) { await until(() => adds > mark, "the run's view of the window"); for (let k = 0; k < 3; k++) await turn(); }
  }
  let answered = 0, settled = false;
  const all = Promise.all(runs).then((x) => { settled = true; return x; });
  const end = Date.now() + 20_000;
  while (!settled && Date.now() < end) { while (answered < gated.length) gated[answered++](100n * PRICE); await turn(); }
  const out = await all;
  const st = C.inflightCoverStatus();
  ok(out.every((x) => typeof x.release === "function") && st.refused === 0 && st.admittedUnread === 0 && st.admittedByRead === N && gated.length <= 2,
    `burst beside a foreign run, ${label}: all ${N} are admitted on a read, none refused, none unread, on at most two reads (admitted ${out.filter((x) => typeof x.release === "function").length}, unread ${st.admittedUnread}, refused ${st.refused}, reads ${gated.length})`);
  out.forEach((x) => x.release?.());
  await unforeign(W, "d5");
}
{
  // 6. The read ahead never answers. The run behind it waits its bound, then
  // begins the read that follows and is judged on it; it is not held for as
  // long as the first read hangs.
  C._resetInflightCoverForTest();
  const gated = [];
  C._setBalanceReaderForTest(() => new Promise((res) => gated.push(res)));
  const W = "0x" + "ab".repeat(20);
  await foreign(W, "d6");
  const ap = attempt(C, W);
  await until(() => gated.length === 1, "run a's read");
  const t0 = Date.now();
  // (Run b is still waiting when the read ahead's bound ends: a queued read
  // nobody waits for any more is not made.)
  const bp = C.admitCoveredRun(reqFor(W), { settleWaitMs: 3_000 }).then((release) => ({ release }), (err) => ({ err }));
  await until(() => gated.length === 2, "run b's own read, begun although the read ahead has not answered");
  const waited = Date.now() - t0;
  gated[1](3n * PRICE);
  const b = await bp;
  ok(typeof b.release === "function" && waited >= 240 && waited < 2_000 && C.inflightCoverStatus().admittedUnread === 0, `a read ahead that does not answer: the run behind it begins its own read after 250 ms and is admitted on it (${b.err?.statusCode || "admitted"}, waited ${waited} ms)`);
  gated[0](3n * PRICE);
  const a = await ap;
  a.release?.(); b.release?.();
  await unforeign(W, "d6");
}
{
  // 7. A local run settles and leaves while run y's view of the window is
  // read, and another container's run has settled on chain but is still in
  // the window. The balance left covers y; counted beside that run it would
  // not. y waits for a run to leave the window and is admitted when it does.
  C._resetInflightCoverForTest();
  reads = 0; balance = 3n * PRICE;
  C._setBalanceReaderForTest(async () => { reads++; return balance; });
  const W = "0x" + "ac".repeat(20);
  await foreign(W, "d7");
  const x = await attempt(C, W);
  beforeWindowRead = async () => { balance = PRICE; x.release(); };
  let done = false;
  const yp = attempt(C, W, { settleWaitMs: 10_000 }).then((r) => { done = true; return r; });
  await until(() => done || C.inflightCoverStatus().foreignWaits >= 1, "run y to wait beside the other container's run");
  const waited = !done;
  await unforeign(W, "d7");
  const y = await yp;
  // The read (3 prices) predates both settlements. The local run's amount is
  // taken off it (2 prices left as a lower bound) and the other container's
  // run is still counted in what must be covered (2 prices): y fits, with or
  // without a wait, and is never refused.
  void waited;
  ok(typeof x.release === "function" && typeof y.release === "function" && C.inflightCoverStatus().refused === 0, `a local run leaves during the window read while another container's settled run is still in the window: the run is admitted, not refused (${y.err?.statusCode || "admitted"}, waited ${waited})`);
  y.release?.();
  // The same with nothing local: the other container's run has settled on
  // chain and is still in the window when this wallet's next run arrives.
  C._resetInflightCoverForTest();
  reads = 0; balance = PRICE;
  C._setBalanceReaderForTest(async () => { reads++; return balance; });
  const V = "0x" + "ad".repeat(20);
  await foreign(V, "d8");
  done = false;
  const zp = attempt(C, V, { settleWaitMs: 10_000 }).then((r) => { done = true; return r; });
  await until(() => done || C.inflightCoverStatus().foreignWaits >= 1, "run z to wait beside the other container's run");
  const zWaited = !done, readsWaiting = reads;
  for (let i = 0; i < 20; i++) await turn();
  await unforeign(V, "d8");
  const z = await zp;
  ok(zWaited && typeof z.release === "function" && readsWaiting === 1 && reads === 2, `another container's settled run still in the window: the wallet's run waits, looks at the window without reading the balance, and is admitted on one fresh read once it leaves (${z.err?.statusCode || "admitted"}, reads ${readsWaiting} then ${reads}, want 1 then 2)`);
  z.release?.();
  // Control: the other container's run is unsettled and stays. The balance
  // does not cover both, the wait ends with nobody gone, and the run is
  // refused as before, after the wait and no later than it allows.
  C._resetInflightCoverForTest();
  reads = 0; balance = PRICE + PRICE / 2n;
  C._setBalanceReaderForTest(async () => { reads++; return balance; });
  const U = "0x" + "ae".repeat(20);
  await foreign(U, "d9");
  const t0 = performance.now();
  const u = await attempt(C, U, { settleWaitMs: 300 });
  const took = performance.now() - t0;
  ok(u.err?.statusCode === 429 && /does not cover this one as well/.test(u.err.message) && took >= 290 && C.inflightCoverStatus().foreignWaits === 1 && reads <= 2, `control: beside a run that stays, a run the balance does not cover is refused when the wait ends, with the same answer (${u.err?.statusCode || "admitted"}, ${Math.round(took)} ms, reads ${reads})`);
  // A shortfall beside another container's run does not clear when that run
  // settles (its amount leaves the balance and the window together): the
  // answer's next step is to add funds, in the fix and the message alike.
  ok(u.err?.coverRefusal === "beside" && u.err.fix === "Your input is fine. Add funds to this wallet, then retry after Retry-After." && /add funds to this wallet, then retry after Retry-After\. You have not been charged\./.test(u.err.message) && u.err.retryAfter === 30, `a beside refusal gives the add-funds advice (${u.err?.coverRefusal}: ${u.err?.fix})`);
  await unforeign(U, "d9");
}
{
  // 8. At the production default (no wait given). Three wallets at once,
  // each beside another container's run:
  //   bound: that run stays and the balance does not cover both; the run is
  //     refused when the five-second wait runs out, not sooner, not later.
  //   last look: that run (settled on chain) leaves at 4.75 s, after the last
  //     timed look and before the wait runs out; the look taken when the wait
  //     runs out sees it gone and the run is admitted.
  //   reservation: the run's reservation is in the window while it is
  //     judged, out of it while it waits, and back in it once admitted.
  C._resetInflightCoverForTest();
  const want = new Map([["0x" + "b1".repeat(20), PRICE + PRICE / 2n], ["0x" + "b2".repeat(20), PRICE], ["0x" + "b3".repeat(20), PRICE]]);
  const gate = new Map();
  const ownIn = async (w) => (await windowOf(w)).entries?.some((e) => !String(e.member).startsWith("otherproc-")) === true;
  // The third wallet's later reads look at the window first: a judgment
  // after the wait must be made with the run's reservation back in it.
  const heldAtRejudge = [];
  C._setBalanceReaderForTest(async (terms) => {
    const w = terms.payer;
    if (w === "0x" + "b3".repeat(20)) {
      if (!gate.has(w)) { gate.set(w, null); await new Promise((res) => gate.set(w, res)); }
      else heldAtRejudge.push(await ownIn(w));
    }
    return want.get(w);
  });
  const [B1, B2, B3] = [...want.keys()];
  for (const w of [B1, B2, B3]) await foreign(w, "p8");
  const timed = async (w) => { const t = performance.now(); const r = await attempt(C, w, {}); return { ...r, ms: performance.now() - t }; };
  const guard = (p) => Promise.race([p, new Promise((res) => setTimeout(() => res({ err: { statusCode: "no answer within 9 s" }, ms: 9_000 }), 9_000))]);
  const p1 = guard(timed(B1));
  const p2 = guard(timed(B2));
  const p3 = guard(timed(B3));
  await until(() => typeof gate.get(B3) === "function", "the third wallet's read to be under way");
  const heldWhileJudged = await ownIn(B3);
  gate.get(B3)();
  await until(() => C.inflightCoverStatus().withdrawals >= 3, "all three runs to wait");
  const heldWhileWaiting = await ownIn(B3);
  // (The whole admission wait is about a second: looks at 100, 300 and 700 ms, and one at the end.)
  setTimeout(() => { void unforeign(B2, "p8"); }, 850);
  setTimeout(() => { void unforeign(B3, "p8"); }, 250);
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  ok(r1.err?.statusCode === 429 && r1.ms >= 950 && r1.ms < 2_500, `production default: beside another container's run that stays, an uncovered run is refused when the wait runs out, about one second (${r1.err?.statusCode || "admitted"}, ${Math.round(r1.ms)} ms)`);
  ok(typeof r2.release === "function" && r2.ms >= 800 && r2.ms < 2_500, `production default: a run that leaves after the last timed look and before the wait runs out is seen by the look taken at the end, and the run is admitted (${r2.err?.statusCode || "admitted"}, ${Math.round(r2.ms)} ms)`);
  const heldAdmitted = await ownIn(B3);
  ok(heldWhileJudged && !heldWhileWaiting && typeof r3.release === "function" && heldAdmitted, `a run's reservation is in the window while it is judged (${heldWhileJudged}), out while it waits (${!heldWhileWaiting}), and back once it is admitted (${heldAdmitted})`);
  ok(heldAtRejudge.length >= 1 && heldAtRejudge.every(Boolean), `a run judged again after its wait has its reservation back in the window before its balance read (${JSON.stringify(heldAtRejudge)})`);
  r2.release?.(); r3.release?.();
  await unforeign(B1, "p8");
}
{
  // 9. The run waits beside another container's settled run and is woken
  // when it leaves, but its reservation cannot be put back (the write
  // fails). Judged now it would be unseen by the other container; it is
  // refused instead, as it was judged before the wait. Control: the same
  // with the write answered admits the run.
  for (const [label, fails] of [["the put-back fails", true], ["control: the put-back is written", false]]) {
    C._resetInflightCoverForTest();
    C._setBalanceReaderForTest(async () => PRICE);
    const W = "0x" + (fails ? "b4" : "b5").repeat(20);
    await foreign(W, "p9");
    const p = attempt(C, W, { settleWaitMs: 5_000 });
    await until(() => C.inflightCoverStatus().withdrawals >= 1, "the run to wait outside the window");
    failOwnAdd = fails;
    await unforeign(W, "p9");
    const r = await p;
    failOwnAdd = false;
    const own = (await windowOf(W)).entries?.filter((e) => !String(e.member).startsWith("otherproc-")).length;
    const st = C.inflightCoverStatus();
    ok(fails
      ? r.err?.statusCode === 429 && /does not cover this one as well/.test(r.err.message) && own === 0 && st.runsInFlight === 0 && st.putBackMisses === 1
      : typeof r.release === "function" && own === 1 && !(st.putBackMisses > 0),
      `${label}: the waiting run is ${fails ? "refused with the answer it was judged on, and holds nothing" : "admitted with its reservation in the window"} (${r.err?.statusCode || "admitted"}, own reservations ${own})`);
    r.release?.();
  }
}
shared.windowAdd = realAdd; shared.windowRead = realRead;
{
  // A container KILLED with a run in flight: its reservation stays in the
  // window, and is counted only while its liveness key lasts. A wallet
  // holding exactly the next call's price is refused while the owner lives
  // and served once the dead owner's key has lapsed.
  C._resetInflightCoverForTest();
  C._setBalanceReaderForTest(async () => PRICE);
  const K = "0x" + "e1".repeat(20);
  const child = spawn(process.execPath, [here, "holder"], { env: { ...process.env, HOLD_WALLET: K }, stdio: ["ignore", "pipe", "inherit"] });
  holders.add(child);
  let said = "";
  child.stdout.on("data", (d) => { said += d; });
  await until(() => /HOLDING/.test(said), "the other container to hold a run", 30_000);
  ok(/^HOLDING/m.test(said) && (await windowOf(K)).count === 1, "redis: another container holds a run of the wallet");
  const alive = await attempt(C, K);
  ok(alive.err?.statusCode === 429, `redis: while that container lives its run is counted: a call the balance cannot also cover is refused (${alive.err?.statusCode || "admitted"})`);
  child.kill("SIGKILL");
  await new Promise((res) => child.once("exit", res));
  ok((await windowOf(K)).count === 1, "redis: the killed container's reservation is still in the window");
  await new Promise((res) => setTimeout(res, LIVE_TTL + 2_300)); // its liveness key lapses; this process's view of it is 2 s old at most
  const after = await attempt(C, K);
  ok(typeof after.release === "function", `redis: once the killed container's liveness key has lapsed, the wallet's call is served (${after.err?.statusCode || "admitted"})`);
  await new Promise((res) => setTimeout(res, 100));
  const w = await windowOf(K);
  ok(w.count === 1 && C.inflightCoverStatus().deadReservationsIgnored >= 1, `redis: the dead reservation was taken out of the window (${w.count} left: this run's own)`);
  after.release();
}
{
  // ONE SOLANA WALLET, TWO SHAPES, TWO CONTAINERS. A payment that names its
  // source account and one that names it through a lookup table may draw on
  // the same account, so a run of one shape held by another container counts
  // against the other shape here. One price in the account: whichever shape
  // the other container holds, the second shape here is refused.
  for (const [held, shape, seed, name] of [["static", "lookup", 10, "a static run held elsewhere, a lookup-table payment here"], ["lookup", "static", 20, "a lookup-table run held elsewhere, a static payment here"]]) {
    C._resetInflightCoverForTest();
    C._setBalanceReaderForTest(async () => PRICE);
    const child = spawn(process.execPath, [here, "svm-holder"], { env: { ...process.env, HOLD_SHAPE: held, HOLD_SEED: String(seed) }, stdio: ["ignore", "pipe", "inherit"] });
    holders.add(child);
    let said = "";
    child.stdout.on("data", (d) => { said += d; });
    try {
      await until(() => /HOLDING/.test(said), "the other container to hold a Solana run", 30_000);
      ok(/^HOLDING/m.test(said), `redis: ${name}: the other container holds its run`);
      let r;
      try { r = { release: await C.admitCoveredRun(await solReq(shape === "lookup", seed), QUICK) }; } catch (e) { r = { err: e }; }
      ok(r.err?.statusCode === 429, `redis: ${name}: one price in the account covers one run, so the second is refused (${r.err?.statusCode || "admitted"} ${r.err?.coverRefusal || ""})`);
      r.release?.();
    } finally {
      child.kill("SIGKILL");
      await new Promise((res) => child.once("exit", res));
    }
  }
  // Control: with nothing held elsewhere, either shape here is admitted on
  // that one price.
  for (const [shape, seed] of [["static", 30], ["lookup", 40]]) {
    C._resetInflightCoverForTest();
    C._setBalanceReaderForTest(async () => PRICE);
    let r;
    try { r = { release: await C.admitCoveredRun(await solReq(shape === "lookup", seed), QUICK) }; } catch (e) { r = { err: e }; }
    ok(typeof r.release === "function", `redis control: a ${shape} payment with nothing held elsewhere is admitted (${r.err?.statusCode || "admitted"})`);
    r.release?.();
  }
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

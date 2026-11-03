#!/usr/bin/env node
// A facilitator that broadcasts the buyer's transfer and then answers
// `settlement_pending` ("transaction did not confirm in time: context deadline
// exceeded") with the transaction hash used to leave a buyer who paid with a
// 402, and the late-settlement book then found the transfer mined seconds
// later and booked a refund. src/pending-settle.js reads that transaction's
// receipt for a bounded time first, and serves the answer only when the
// receipt proves the transfer is this payment's.
//
// Part 1, offline units: the classifier, which failures it applies to, the
// receipt verdict, the bounds (the wait, the CDN answer window, validBefore),
// a buyer gone before the first byte, and the failure monitor's forgiveness.
// Part 2 boots a PAID server against a stub facilitator and a stub RPC (port
// 0) and sends real paid requests through the middleware:
//   receipt appears within the wait (thrown 5xx and graceful) -> 200 with
//     PAYMENT-RESPONSE naming the tx, one sale at the paid price, nothing in
//     the late-settlement book or refunds, the facilitator's pending 5xx
//     answers not counted as upstream failures, and a resend of the same
//     payment answered from the idempotency cache
//   the breaker counts recovered calls as settled (a failure blocks the next)
//   never mined / reverted / another payTo / short / no authorization log /
//   RPC errors -> 402, booked in the late-settlement book as before
//   client gone during settle -> not served, booked
//   a genuine 5xx with no tx -> 402, the chain is never read, still counted
//
//   node scripts/test-pending-settle.js
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";

// Every store here is a file in this run's own directory: the booted server
// runs with STATE_DATABASE_URL and REDIS_URL blank, and the books this process
// opens (the late-settlement book reads the file that server wrote) must read
// the same files. Inherited from the shell, either variable would point this
// process at a shared database that outlives the run (a book that never sees
// the server's entries, rows and claims left by an earlier run).
delete process.env.STATE_DATABASE_URL;
delete process.env.REDIS_URL;

let pass = 0;
const procs = [];
let stubs = [];
const serverLog = [];
const DIR = mkdtempSync(join(tmpdir(), "a402-pending-"));
const cleanup = () => { for (const p of procs) p.kill("SIGKILL"); for (const s of stubs) s.close(); try { rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } };
const fail = (m) => { console.error(`FAIL - ${m}`); for (const l of serverLog.slice(-40)) console.error("  server:", l); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const topic = (a) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const txOf = (s) => "0x" + createHash("sha256").update(String(s)).digest("hex");
const AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const OTHER = "0x00000000000000000000000000000000000000ee";
const PENDING_MSG = "transaction did not confirm in time: context deadline exceeded";

// ============================================================ part 1: units
{
  const ps = await import("../src/pending-settle.js");
  const { createToolFailureMonitor } = await import("../src/tool-failure-monitor.js");
  const TX = txOf("unit");
  const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const payer = "0x" + "a1".repeat(20), nonce = word(77);
  const pend = (extra = {}) => ({ errorReason: "settlement_pending", errorMessage: PENDING_MSG, transaction: TX, ...extra });

  ok(ps.pendingSettleTxOf(pend()) === TX.toLowerCase(), "settlement_pending with a tx is pending");
  ok(ps.pendingSettleTxOf({ errorReason: "unexpected_settle_error", errorMessage: PENDING_MSG, transaction: TX }) === TX.toLowerCase(), "the timeout words with a tx read as pending");
  ok(ps.pendingSettleTxOf(pend({ transaction: "" })) === null, "pending with no tx is not handled");
  ok(ps.pendingSettleTxOf({ errorReason: "invalid_exact_evm_payload_signature", errorMessage: PENDING_MSG, transaction: TX }) === null, "a payment verdict is never pending");
  ok(ps.pendingSettleTxOf({ errorReason: "unexpected_settle_error", errorMessage: "boom", transaction: TX }) === null, "another failure naming a tx is not pending");
  ok(ps.pendingSettleWaitMs({}) === 12_000 && ps.pendingSettleWaitMs({ PENDING_SETTLE_RECEIPT_WAIT_MS: "999999" }) === 30_000 && ps.pendingSettleWaitMs({ PENDING_SETTLE_RECEIPT_WAIT_MS: "0" }) === 0, "the wait defaults to 12 s, is capped at 30 s, and 0 turns it off");

  const rq = (network = "eip155:8453") => ({ scheme: "exact", network, asset: ASSET, payTo: PAY_TO, amount: "5000" });
  const ctxOf = ({ network, error = pend(), req = null, validBefore = String(Math.floor(Date.now() / 1000) + 300), auth = true } = {}) => ({
    requirements: rq(network), error,
    paymentPayload: { payload: auth ? { authorization: { from: payer, to: PAY_TO, value: "5000", validAfter: "0", validBefore, nonce } } : { permit2Authorization: { from: payer } } },
    ...(req ? { transportContext: { request: { adapter: { req } } } } : {}),
  });
  const rpcFor = (n) => (n.startsWith("eip155:") ? "http://rpc.invalid" : null);
  ok(ps.pendingSettleApplies(ctxOf(), { rpcFor }), "applies on Base with an RPC");
  ok(!ps.pendingSettleApplies(ctxOf({ network: "eip155:4663" }), { rpcFor }), "never on Robinhood 4663 (its own outage path)");
  ok(!ps.pendingSettleApplies(ctxOf({ network: "eip155:5042" }), { rpcFor }), "never on Arc (its own pending book)");
  ok(!ps.pendingSettleApplies(ctxOf({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }), { rpcFor }), "never off EVM");
  ok(!ps.pendingSettleApplies(ctxOf({ auth: false }), { rpcFor }), "never on a payload without an EIP-3009 authorization");
  ok(!ps.pendingSettleApplies(ctxOf(), { rpcFor: () => null }), "never without a configured RPC");

  const receipt = ({ status = "0x1", to = PAY_TO, value = 5000n, authLog = true } = {}) => ({
    status, transactionHash: TX, blockNumber: "0x10",
    logs: [
      ...(authLog ? [{ address: ASSET, topics: [AUTH_USED, topic(payer), nonce], data: "0x" }] : []),
      { address: ASSET, topics: [TRANSFER, topic(payer), topic(to)], data: word(value) },
    ],
  });
  const facts = { asset: ASSET, payer, nonce, payTo: PAY_TO, amount: "5000" };
  ok(ps.judgePendingReceipt(receipt(), facts).ours, "a mined transfer of the price to our payTo, using this authorization, is ours");
  ok(!ps.judgePendingReceipt(receipt({ status: "0x0" }), facts).ours, "a reverted receipt is not");
  ok(!ps.judgePendingReceipt(receipt({ to: OTHER }), facts).ours, "a transfer to another payTo is not");
  ok(!ps.judgePendingReceipt(receipt({ value: 4999n }), facts).ours, "a short transfer is not");
  ok(!ps.judgePendingReceipt(receipt({ authLog: false }), facts).ours, "a transfer that did not use this authorization is not");

  // The bounded read, against an in-process RPC.
  const fetchWith = (answer) => async (_u, init) => {
    const { method } = JSON.parse(init.body);
    const r = await answer(method);
    if (r instanceof Error) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { message: r.message } }) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: r }) };
  };
  const unsold = async () => null;
  let reads = 0;
  const t0 = Date.now();
  let r = await ps.confirmPendingSettle(ctxOf(), { rpcFor, fetchImpl: fetchWith(() => { reads++; return Date.now() - t0 > 250 ? receipt() : null; }), waitMs: 3000, pollMs: 100, saleByTx: unsold });
  ok(r.recovered && r.result.transaction === TX.toLowerCase() && r.result.payer === payer && reads >= 2, `a receipt that appears within the wait recovers (${reads} reads)`);
  r = await ps.confirmPendingSettle(ctxOf(), { rpcFor, fetchImpl: fetchWith(() => receipt()), waitMs: 3000, pollMs: 100, saleByTx: async () => ({ id: 1 }) });
  ok(!r.recovered && /recorded sale/.test(r.reason), "a tx already in the sales ledger is not recovered");
  r = await ps.confirmPendingSettle(ctxOf(), { rpcFor, fetchImpl: fetchWith(() => receipt()), waitMs: 3000, pollMs: 100, saleByTx: async () => { throw new Error("db down"); } });
  ok(!r.recovered && /sales ledger/.test(r.reason), "an unreadable sales ledger fails closed");
  let t = Date.now();
  r = await ps.confirmPendingSettle(ctxOf(), { rpcFor, fetchImpl: fetchWith(() => new Error("upstream down")), waitMs: 600, pollMs: 100, saleByTx: unsold });
  ok(!r.recovered && /could not read the chain/.test(r.reason) && Date.now() - t < 1500, `RPC errors until the deadline are refused inside the bound (${Date.now() - t} ms)`);
  // CDN answer window shorter than the wait.
  t = Date.now();
  r = await ps.confirmPendingSettle(ctxOf({ req: { cdnSyncDeadlineMs: Date.now() + ps.CDN_MARGIN_MS + 400 } }), { rpcFor, fetchImpl: fetchWith(() => null), waitMs: 10_000, pollMs: 100, saleByTx: unsold, clientGone: () => false });
  ok(!r.recovered && Date.now() - t < 1500, `the wait ends inside the CDN answer window, less its margin (${Date.now() - t} ms of a 10 s wait)`);
  r = await ps.confirmPendingSettle(ctxOf({ req: { cdnSyncDeadlineMs: Date.now() + 1000 } }), { rpcFor, fetchImpl: fetchWith(() => receipt()), waitMs: 10_000, pollMs: 100, saleByTx: unsold, clientGone: () => false });
  ok(!r.recovered && /no time left/.test(r.reason), "a CDN window already inside its margin reads nothing");
  // The authorization's validBefore bounds the wait.
  t = Date.now();
  r = await ps.confirmPendingSettle(ctxOf({ validBefore: String(Math.floor(Date.now() / 1000) + 1) }), { rpcFor, fetchImpl: fetchWith(() => null), waitMs: 10_000, pollMs: 100, saleByTx: unsold });
  ok(!r.recovered && Date.now() - t < 2500, `the wait ends at the authorization's validBefore (${Date.now() - t} ms)`);
  // A buyer gone before the first byte is not served, even with the proof.
  reads = 0;
  r = await ps.confirmPendingSettle(ctxOf({ req: {} }), { rpcFor, fetchImpl: fetchWith(() => { reads++; return receipt(); }), waitMs: 3000, pollMs: 100, saleByTx: unsold, clientGone: () => true });
  ok(!r.recovered && /buyer left/.test(r.reason) && reads === 0, "a buyer gone before the first byte is not served");
  let goneNow = false;
  r = await ps.confirmPendingSettle(ctxOf({ req: {} }), { rpcFor, fetchImpl: fetchWith(() => { goneNow = true; return receipt(); }), waitMs: 3000, pollMs: 100, saleByTx: unsold, clientGone: () => goneNow });
  ok(!r.recovered && /buyer left/.test(r.reason), "a buyer who leaves during the read is not served");
  r = await ps.confirmPendingSettle(ctxOf({ error: { errorReason: "unexpected_settle_error", transaction: "" } }), { rpcFor, fetchImpl: fetchWith(() => receipt()), waitMs: 3000, pollMs: 100, saleByTx: unsold });
  ok(!r.recovered, "a failure that is not pending is never read");

  // Noting pending answers, and the monitor's forgiveness.
  const payload = { payload: { authorization: { nonce: word(1) } } };
  let lane = "outside";
  const client = { settle: async () => { throw Object.assign(new Error("settlement_pending"), { statusCode: 500, ...pend() }); } };
  ps.notePendingSettleAnswers(client, "https://fac.example/x402", { lane: () => lane });
  for (let i = 0; i < 2; i++) { lane = i ? "synthetic" : "outside"; try { await client.settle(payload, {}); } catch { /* expected */ } }
  const graceful = { settle: async () => ({ success: false, ...pend() }) };
  ps.notePendingSettleAnswers(graceful, "https://fac.example/x402", { lane: () => "background" });
  const payload2 = { payload: { authorization: { nonce: word(2) } } };
  await graceful.settle(payload2, {});
  // A scheme that enriches the settle payload copies it but keeps the authorization.
  const enriched = { ...payload, payload: { ...payload.payload, extraField: 1 } };
  ok(ps.peekPendingAnswers(enriched).length === 2, "a note is found through a copied payload that keeps the authorization object");
  const notes = ps.takePendingAnswers(payload);
  ok(notes.length === 2 && notes.every((x) => x.host === "fac.example" && x.tx === TX.toLowerCase() && x.s5xx === true) && notes[0].lane === "outside" && notes[1].lane === "synthetic" && ps.takePendingAnswers(payload).length === 0,
    `each pending 5xx answer is noted once with its tx, host and origin lane (${JSON.stringify(notes.map((x) => x.lane))})`);
  const gnotes = ps.takePendingAnswers(payload2);
  ok(gnotes.length === 1 && gnotes[0].tx === TX.toLowerCase() && gnotes[0].s5xx === false && gnotes[0].lane === "background", "a graceful pending answer is noted for its tx, not as a 5xx (the meter counted it ok)");
  // Two answers naming two transactions: both are read.
  const TX2 = txOf("unit-2");
  let call = 0;
  const twoTx = { settle: async () => { call++; throw Object.assign(new Error("settlement_pending"), { statusCode: 500, ...pend({ transaction: call === 1 ? TX : TX2 }) }); } };
  ps.notePendingSettleAnswers(twoTx, "https://fac.example/x402", { lane: () => "outside" });
  const ctx2 = ctxOf({ error: pend({ transaction: TX2 }) });
  for (let i = 0; i < 2; i++) { try { await twoTx.settle(ctx2.paymentPayload, {}); } catch { /* expected */ } }
  ok(JSON.stringify(ps.pendingTxsOf(ctx2)) === JSON.stringify([TX.toLowerCase(), TX2.toLowerCase()]), "pendingTxsOf lists every noted transaction, first answer first, deduped");
  // The library's own retry settling a payment that holds pending notes hands them over.
  let handed = null;
  let n2 = 0;
  const retryOk = { settle: async () => { n2++; if (n2 === 1) throw Object.assign(new Error("settlement_pending"), { statusCode: 502, ...pend() }); return { success: true, transaction: TX }; } };
  ps.notePendingSettleAnswers(retryOk, "https://fac.example/x402", { lane: () => "outside", onSettledAfterPending: (ns) => { handed = ns; } });
  const payload3 = { payload: { authorization: { nonce: word(3) } } };
  try { await retryOk.settle(payload3, {}); } catch { /* expected */ }
  await retryOk.settle(payload3, {});
  ok(handed?.length === 1 && handed[0].s5xx && ps.peekPendingAnswers(payload3).length === 0, "a retry that settles hands the first pending answer over for forgiveness and clears the notes");
  // Another client (a settle fallback) succeeding after the primary's pending
  // answers is not the library's retry: those answers are handed over as
  // settled by another facilitator, never for forgiveness.
  {
    const got = { mine: null, other: null, fbMine: null, fbOther: null };
    const prim = { settle: async () => { throw Object.assign(new Error("settlement_pending"), { statusCode: 502, ...pend() }); } };
    const fb = { settle: async () => ({ success: true, transaction: TX2 }) };
    ps.notePendingSettleAnswers(prim, "https://prim.example/x402", { lane: () => "outside", via: "Prim", onSettledAfterPending: (ns) => { got.mine = ns; }, onSettledByOther: (ns) => { got.other = ns; } });
    ps.notePendingSettleAnswers(fb, "https://fb.example/x402", { lane: () => "outside", via: "Fb", onSettledAfterPending: (ns) => { got.fbMine = ns; }, onSettledByOther: (ns) => { got.fbOther = ns; } });
    const pl = { payload: { authorization: { nonce: word(30) } } };
    try { await prim.settle(pl, {}); } catch { /* expected */ }
    ok(ps.peekPendingAnswers(pl)[0]?.via === "Prim", "a pending note carries the label of the facilitator that answered it");
    await fb.settle(pl, {});
    ok(got.fbMine === null && got.fbOther?.length === 1 && got.fbOther[0].via === "Prim" && got.mine === null,
      `a fallback's success after another client's pending answer is not a retry (${JSON.stringify({ mine: !!got.fbMine, other: got.fbOther?.length })})`);
  }
  // Circle Gateway batched payments are never noted or read.
  const batched = { accepted: { extra: { name: "GatewayWalletBatched" } }, payload: { authorization: { nonce: word(4) } } };
  try { await client.settle(batched, {}); } catch { /* expected */ }
  ok(ps.peekPendingAnswers(batched).length === 0, "a Gateway batched payment's pending answer is not noted");
  const bctx = ctxOf();
  bctx.requirements.extra = { name: "GatewayWalletBatched" };
  ok(!ps.pendingSettleApplies(bctx, { rpcFor }), "never on a Gateway batched requirement");
  const bctx2 = ctxOf();
  bctx2.paymentPayload.accepted = { extra: { name: "GatewayWalletBatched" } };
  ok(!ps.pendingSettleApplies(bctx2, { rpcFor }), "never on a Gateway batched payload");

  const m = createToolFailureMonitor({});
  m.registerUpstreamHost("https://fac.example/x402", "facilitator:fac.example");
  const at = Date.now();
  m.noteUpstream("fac.example", "s5xx", { origin: "outside", at });
  m.noteUpstream("fac.example", "s5xx", { origin: "outside", at });
  m.noteUpstream("fac.example", "s5xx", { origin: "synthetic", at });
  ok(m.forgiveUpstream("fac.example", "s5xx", { at, origin: "outside" }) === true, "forgiveUpstream moves one s5xx to ok");
  const row = (await m.report()).upstreams.find((u) => u.upstream === "facilitator:fac.example");
  ok(row?.hour?.outside?.s5xx === 1 && row?.hour?.outside?.ok === 1, `one counted failure stays (${JSON.stringify(row?.hour?.outside)})`);
  ok(m.forgiveUpstream("fac.example", "s5xx", { at, origin: "outside" }) === true && m.forgiveUpstream("fac.example", "s5xx", { at, origin: "outside" }) === false, "never forgives more than was counted in that lane");
  ok(m.forgiveUpstream("fac.example", "s5xx", { at, origin: "background" }) === false, "a background recovery never forgives another lane's failure");
  const row2 = (await m.report()).upstreams.find((u) => u.upstream === "facilitator:fac.example");
  ok(row2?.hour?.synthetic?.s5xx === 1 && m.forgiveUpstream("fac.example", "s5xx", { at, origin: "synthetic" }) === true, "a synthetic recovery forgives in the synthetic lane only");
  // The 5xx is counted when it arrives; the note's time is read when the
  // settle returns, which can fall in the next five-minute bucket.
  {
    const mb5 = createToolFailureMonitor({});
    mb5.registerUpstreamHost("https://edge.example/x402", "facilitator:edge.example");
    const edge = Math.ceil(Date.now() / 300_000) * 300_000 - 300_000;
    mb5.noteUpstream("edge.example", "s5xx", { origin: "outside", at: edge - 200 });
    ok(mb5.forgiveUpstream("edge.example", "s5xx", { at: edge + 300, origin: "outside" }) === true, "a note taken just past a bucket edge forgives the 5xx counted just before it");
    ok(mb5.forgiveUpstream("edge.example", "s5xx", { at: edge + 300, origin: "outside" }) === false, "across the edge, never more than was counted");
    mb5.noteUpstream("edge.example", "s5xx", { origin: "outside", at: edge - 600_000 });
    ok(mb5.forgiveUpstream("edge.example", "s5xx", { at: edge + 300, origin: "outside" }) === false, "a count two buckets back is not reached");
  }

  // Pending-settle keys whose counts have aged out are evicted; a key past the
  // cap while every key is live is dropped and counted.
  {
    let clock = Date.now() - 2 * 86_400_000;
    const mk = createToolFailureMonitor({ now: () => clock });
    for (let i = 0; i < 64; i++) mk.notePendingSettle({ network: `eip155:${i}`, facilitator: "f", outcome: "notMined" });
    clock += 86_400_000 + 600_000;
    ok(mk.notePendingSettle({ network: "eip155:999", facilitator: "f", outcome: "recovered" }) === "recovered", "a new key is counted once the full set has aged out");
    for (let i = 0; i < 63; i++) mk.notePendingSettle({ network: `eip155:${1000 + i}`, facilitator: "f", outcome: "notMined" });
    ok(mk.notePendingSettle({ network: "eip155:5000", facilitator: "f", outcome: "notMined" }) === null, "past the cap with every key live, the outcome is dropped");
    const kr = await mk.report();
    ok(kr.pendingSettles.dropped?.hour === 1 && kr.pendingSettles.dropped?.day === 1 && kr.pendingSettles.rows.length === 64,
      `the drop is counted on the operator view (${JSON.stringify(kr.pendingSettles.dropped)}, ${kr.pendingSettles.rows.length} rows)`);
  }

  // Outcome counts: per network and facilitator, merged across replicas.
  const ma = createToolFailureMonitor({ replicaId: "a" });
  ma.notePendingSettle({ network: "eip155:8453", facilitator: "facilitator:fac.example", outcome: "recovered" });
  ma.notePendingSettle({ network: "eip155:8453", facilitator: "facilitator:fac.example", outcome: "notMined" });
  ok(ma.notePendingSettle({ network: "eip155:8453", facilitator: "x", outcome: "bogus" }) === null, "an unknown outcome is not counted");
  const snapA = JSON.parse(JSON.stringify(ma.snapshot()));
  const mb = createToolFailureMonitor({ replicaId: "b", store: { publish: async () => ({ ok: true }), readAll: async () => ({ ok: true, snapshots: [{ id: "a", ...snapA }] }) } });
  mb.notePendingSettle({ network: "eip155:8453", facilitator: "facilitator:fac.example", outcome: "recovered" });
  mb.notePendingSettle({ network: "eip155:137", facilitator: "facilitator:other", outcome: "rateLimited" });
  const rep = await mb.report();
  const base = rep.pendingSettles.rows.find((x) => x.network === "eip155:8453");
  ok(rep.scope === "shared" && base?.hour?.recovered === 2 && base?.hour?.notMined === 1 && rep.pendingSettles.totals.day.rateLimited === 1 && rep.pendingSettles.rows.length === 2,
    `pending-settle outcomes are counted by network and facilitator and merged across replicas (${JSON.stringify(rep.pendingSettles.totals.hour)})`);

  // Every noted transaction is read; the one that used the authorization recovers.
  const receiptFor = (tx, opts) => ({ ...receipt(opts), transactionHash: tx });
  const byTx = (fn) => async (_u, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "eth_call") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: word(6) }) };
    const out = await fn(params[0]);
    if (out instanceof Error) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { message: out.message } }) };
    if (typeof out === "number") return { ok: false, status: out, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: out }) };
  };
  const both = [TX.toLowerCase(), TX2.toLowerCase()];
  const t1 = Date.now();
  r = await ps.confirmPendingSettle(ctxOf({ error: pend({ transaction: TX2 }) }), { rpcFor, txs: both, fetchImpl: byTx((tx) => (tx === TX.toLowerCase() && Date.now() - t1 > 250 ? receiptFor(TX) : null)), waitMs: 3000, pollMs: 100, saleByTx: unsold });
  ok(r.recovered && r.result.transaction === TX.toLowerCase(), "the first answer's tx lands while the retry's never mines -> recovered with the first tx");
  r = await ps.confirmPendingSettle(ctxOf({ error: pend({ transaction: TX2 }) }), { rpcFor, txs: both, fetchImpl: byTx((tx) => (tx === TX.toLowerCase() ? receiptFor(TX) : receiptFor(TX2, { status: "0x0" }))), waitMs: 3000, pollMs: 100, saleByTx: unsold });
  ok(r.recovered && r.result.transaction === TX.toLowerCase(), "the retry's tx reverts on the used nonce, the first lands -> recovered with the first tx");
  r = await ps.confirmPendingSettle(ctxOf({ error: pend({ transaction: TX2 }) }), { rpcFor, txs: both, fetchImpl: byTx((tx) => receiptFor(tx, { status: "0x0" })), waitMs: 3000, pollMs: 100, saleByTx: unsold });
  ok(!r.recovered && r.code === "reverted" && /0x/.test(r.reason), `every noted tx reverted -> not recovered, without waiting out the bound (${r.reason})`);

  // The in-flight cap: past it the read is skipped (today's path).
  let slowReads = 0, capReads = 0;
  const slow = ps.confirmPendingSettle(ctxOf(), { rpcFor, fetchImpl: byTx(() => { slowReads++; return null; }), waitMs: 600, pollMs: 100, saleByTx: unsold, maxInflight: 1 });
  await sleep(50);
  ok(ps.pendingSettleInflight() === 1, "one read is in flight");
  r = await ps.confirmPendingSettle(ctxOf(), { rpcFor, fetchImpl: byTx(() => { capReads++; return receipt(); }), waitMs: 600, pollMs: 100, saleByTx: unsold, maxInflight: 1 });
  ok(!r.recovered && r.code === "capped" && capReads === 0, `past PENDING_SETTLE_MAX_INFLIGHT the chain is not read (${r.reason})`);
  await slow;
  ok(ps.pendingSettleInflight() === 0 && slowReads >= 2, "the in-flight count returns to zero when the read ends");
  ok(ps.pendingSettleMaxInflight({}) === 8 && ps.pendingSettleMaxInflight({ PENDING_SETTLE_MAX_INFLIGHT: "2" }) === 2, "the cap defaults to 8");
  // A rate-limited RPC ends the wait at once.
  for (const [label, answer] of [["HTTP 429", 429], ["a rate-limit error", new Error("rate limit exceeded, retry later")]]) {
    let rl = 0;
    t = Date.now();
    r = await ps.confirmPendingSettle(ctxOf(), { rpcFor, fetchImpl: byTx(() => { rl++; return answer; }), waitMs: 3000, pollMs: 100, saleByTx: unsold });
    ok(!r.recovered && r.code === "rateLimited" && rl === 1 && Date.now() - t < 1000, `${label}: the wait ends after one read (${rl} reads, ${Date.now() - t} ms)`);
  }
  // The sales-ledger read is bounded by the time left, and the bounds are re-read after it.
  t = Date.now();
  r = await ps.confirmPendingSettle(ctxOf(), { rpcFor, fetchImpl: fetchWith(() => receipt()), waitMs: 500, pollMs: 100, saleByTx: () => new Promise(() => {}) });
  ok(!r.recovered && r.code === "noTime" && Date.now() - t < 1200, `a sales ledger that never answers is cut at the deadline (${Date.now() - t} ms)`);
  let leftDuringLookup = false;
  r = await ps.confirmPendingSettle(ctxOf({ req: {} }), { rpcFor, fetchImpl: fetchWith(() => receipt()), waitMs: 3000, pollMs: 100, clientGone: () => leftDuringLookup, saleByTx: async () => { leftDuringLookup = true; return null; } });
  ok(!r.recovered && r.code === "buyerGone", "a buyer who leaves during the sales-ledger read is not served");
  let clock = Date.now();
  r = await ps.confirmPendingSettle(ctxOf(), { rpcFor, now: () => clock, fetchImpl: fetchWith(() => receipt()), waitMs: 1000, pollMs: 100, saleByTx: async () => { clock += 5000; return null; } });
  ok(!r.recovered && r.code === "noTime", "a sales-ledger read that ends past the deadline is not served");
  // External text in reasons is bounded; the wait turned off says so.
  const long = ps.judgePendingReceipt({ status: "0x0" + "z".repeat(500), logs: [] }, facts);
  ok(!long.ours && long.reason.length < 80, `a receipt status is sliced in the reason (${long.reason.length} chars)`);
  r = await ps.confirmPendingSettle(ctxOf(), { rpcFor, fetchImpl: fetchWith(() => receipt()), waitMs: 0, pollMs: 100, saleByTx: unsold });
  ok(!r.recovered && r.code === "noTime" && /turned off/.test(r.reason), `PENDING_SETTLE_RECEIPT_WAIT_MS=0 reads as turned off (${r.reason})`);

  // The late-settlement book: every noted tx is booked with the authorization's
  // nonce, and only the one that used it can be owed.
  const late = await import("../src/late-settlements.js");
  const cands = late.lateSettleCandidates(ctx2);
  ok(cands.length === 2 && cands.every((c) => c.authNonce === nonce.toLowerCase()) && cands.map((c) => c.tx).sort().join() === both.slice().sort().join(),
    `a failure whose answers named two txs leaves two entries, each pinned to the authorization (${cands.length})`);
  ok(late.lateSettleCandidates(ctxOf({ error: { errorReason: "unexpected_settle_error", transaction: TX } }))[0]?.authNonce === undefined, "a failure with no pending notes books as before (no nonce pin)");
  // A stopping fallback's own transaction is booked under its name; the
  // primary's noted pending transaction under the primary's, not the fallback's.
  {
    const TX3 = txOf("unit-fallback");
    const primC = { settle: async () => { throw Object.assign(new Error("settlement_pending"), { statusCode: 500, ...pend() }); } };
    ps.notePendingSettleAnswers(primC, "https://prim2.example/x402", { lane: () => "outside", via: "Primary label" });
    const fctx = ctxOf({ error: pend() });
    try { await primC.settle(fctx.paymentPayload, {}); } catch { /* expected */ }
    fctx.__a402LateTx = { transaction: TX3, via: "Fallback name" };
    const fc = late.lateSettleCandidates(fctx);
    const byTx = Object.fromEntries(fc.map((e) => [e.tx.toLowerCase(), e.via]));
    ok(fc.length === 2 && byTx[TX3.toLowerCase()] === "Fallback name" && byTx[TX.toLowerCase()] === "Primary label",
      `each noted tx is booked under the facilitator that answered it (${JSON.stringify(byTx)})`);
    ps.takePendingAnswers(fctx.paymentPayload);
    // A note with no label never takes the stopping fallback's name.
    const bareC = { settle: async () => { throw Object.assign(new Error("settlement_pending"), { statusCode: 500, ...pend() }); } };
    ps.notePendingSettleAnswers(bareC, "https://bare.example/x402", { lane: () => "outside" });
    const bctxF = ctxOf({ error: pend() });
    try { await bareC.settle(bctxF.paymentPayload, {}); } catch { /* expected */ }
    bctxF.__a402LateTx = { transaction: TX3, via: "Fallback name" };
    const bareVia = late.lateSettleCandidates(bctxF).find((e) => e.tx.toLowerCase() === TX.toLowerCase())?.via;
    ok(bareVia === "primary", `an unlabeled noted tx is booked as the primary's, not the fallback's (${bareVia})`);
    ps.takePendingAnswers(bctxF.paymentPayload);
  }
  const owed = [];
  const bookFile = join(DIR, "unit-late.json");
  let ts = Date.now();
  const book = late.createLateSettleBook({
    file: bookFile, rpcFor, now: () => ts, log: () => {},
    recordOwed: async (row) => { if (!owed.some((o) => o.tx === row.tx)) owed.push(row); },
    owedRecorded: async (tx) => owed.some((o) => o.tx === tx),
    fetchImpl: byTx((tx) => (tx === TX.toLowerCase() ? receiptFor(TX, { authLog: false }) : receiptFor(TX2))),
  });
  for (const c of cands) ok(await book.book({ ...c, resource: "https://x.example/api/hash" }), `booked ${c.tx.slice(0, 10)}`);
  ts += 31_000;
  const out = await book.reconcile();
  ok(out.owed === 1 && out.notOurs === 1 && owed.length === 1 && owed[0].tx === TX2.toLowerCase(), `only the tx carrying this authorization is owed; a transfer without it is not (${JSON.stringify(out)})`);
}

// ============================================================ part 2: booted
const [PORT, FAC_PORT, RPC_PORT] = await getFreePorts(3);
const LATE = join(DIR, "late.json");
const LEDGER = join(DIR, "sales.db");
const OP = "op-" + Math.random().toString(36).slice(2);

let settleMode = "pending";   // pending | pending-graceful | plain-5xx | tx2 (the retry names another tx) | pending-then-ok
let rpcMode = "mined";        // mined | never | reverted | elsewhere | short | noauth | error | ratelimit
let mineAfterMs = 1200;
let settleDelayMs = 0;
let settles = 0, receiptReads = 0;
const payments = new Map();   // nonce(lower) -> payment
const minedAt = new Map();    // tx -> ms
const settleCalls = new Map(); // nonce(lower) -> settle calls

const reply = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });

const fac = createServer(async (req, res) => {
  const parsed = await readBody(req);
  const auth = parsed?.paymentPayload?.payload?.authorization || {};
  if (req.url === "/supported") return reply(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
  if (req.url === "/verify") return reply(res, 200, { isValid: true, payer: auth.from });
  if (req.url === "/settle") {
    settles++;
    if (settleDelayMs) await sleep(settleDelayMs);
    const k = String(auth.nonce || "").toLowerCase();
    const p = payments.get(k);
    const call = (settleCalls.get(k) || 0) + 1;
    settleCalls.set(k, call);
    if (settleMode === "pending-then-ok" && call >= 2) return reply(res, 200, { success: true, transaction: p?.tx || "", network: "eip155:8453", payer: auth.from });
    if (settleMode === "plain-5xx") return reply(res, 502, { success: false, errorReason: "unexpected_settle_error", errorMessage: "upstream failure", transaction: "", network: "eip155:8453", payer: auth.from });
    if (p && !minedAt.has(p.tx)) minedAt.set(p.tx, Date.now() + mineAfterMs);
    const named = settleMode === "tx2" && call >= 2 ? p?.tx2 : p?.tx;
    const body = { success: false, errorReason: "settlement_pending", errorMessage: PENDING_MSG, transaction: named || "", network: "eip155:8453", payer: auth.from };
    return reply(res, settleMode === "pending-graceful" ? 200 : 500, body);
  }
  return reply(res, 404, {});
});
const rpcSrv = createServer(async (req, res) => {
  const parsed = await readBody(req);
  const rpcReply = (result) => reply(res, 200, { jsonrpc: "2.0", id: parsed.id ?? 1, result });
  if (parsed.method === "eth_getTransactionReceipt") {
    receiptReads++;
    if (rpcMode === "ratelimit") return reply(res, 429, { jsonrpc: "2.0", id: parsed.id ?? 1, error: { code: -32005, message: "too many requests" } });
    if (rpcMode === "error") return reply(res, 200, { jsonrpc: "2.0", id: parsed.id ?? 1, error: { code: -32603, message: "upstream timeout" } });
    const tx = parsed.params?.[0];
    const p = [...payments.values()].find((x) => x.tx === tx);
    if (!p || rpcMode === "never" || !(minedAt.get(tx) <= Date.now())) return rpcReply(null);
    const to = rpcMode === "elsewhere" ? OTHER : PAY_TO;
    const value = rpcMode === "short" ? BigInt(p.amount) - 1n : BigInt(p.amount);
    return rpcReply({
      status: rpcMode === "reverted" ? "0x0" : "0x1", transactionHash: tx, blockNumber: "0x10",
      logs: [
        ...(rpcMode === "noauth" ? [] : [{ address: p.asset, topics: [AUTH_USED, topic(p.payer), p.nonce], data: "0x" }]),
        { address: p.asset, topics: [TRANSFER, topic(p.payer), topic(to)], data: word(value) },
      ],
    });
  }
  if (parsed.method === "eth_blockNumber") return rpcReply("0x10");
  if (parsed.method === "eth_call") return rpcReply(word(6));
  return rpcReply(null);
});
stubs = [fac, rpcSrv];
await new Promise((r) => fac.listen(FAC_PORT, "127.0.0.1", r));
await new Promise((r) => rpcSrv.listen(RPC_PORT, "127.0.0.1", r));

const proc = spawn("node", ["src/server.js"], {
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "",
    WALLET_ADDRESS: PAY_TO, NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${RPC_PORT}/rpc`,
    EVM_RPC_8453: `http://127.0.0.1:${RPC_PORT}/rpc`, PAYMENT_SETTLE_FALLBACK: "",
    PENDING_SETTLE_RECEIPT_WAIT_MS: "4000", PENDING_SETTLE_POLL_MS: "400", LATE_SETTLE_RECONCILE: "off",
    GATEWAY_SETTLE_BREAKER_MAX: "1", GATEWAY_SETTLE_BREAKER_MIN_FAIL_SHARE: "0",
    LATE_SETTLE_FILE: LATE, REFUND_DB_DIR: DIR, SALES_LEDGER_DB: LEDGER, STATS_ALLOW_EPHEMERAL: "true", STATE_DATABASE_URL: "",
    AGENT402_OPERATOR_TOKEN: OP,
    REDIS_URL: "", CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
procs.push(proc);
const keepLog = (chunk) => { for (const line of String(chunk).split("\n")) if (line.trim()) serverLog.push(line.slice(0, 400)); if (serverLog.length > 200) serverLog.splice(0, serverLog.length - 200); };
proc.stdout.on("data", keepLog); proc.stderr.on("data", keepLog);
const BASE = `http://127.0.0.1:${PORT}`;
let booted = false;
for (let i = 0; i < 120 && !booted; i++) { try { booted = (await fetch(`${BASE}/health`)).ok; } catch { /* booting */ } if (!booted) await sleep(500); }
if (!booted) fail("server did not boot");

const ROUTES = { hash: { path: "/api/hash", body: JSON.stringify({ text: "x" }) }, usage: { path: "/api/my-usage", body: JSON.stringify({ days: 1 }) } };
const accepted = {};
let n = 0;
async function newPayment(route, { payer = null } = {}) {
  const R = ROUTES[route];
  if (!accepted[route]) {
    const r = await fetch(`${BASE}${R.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: R.body });
    ok(r.status === 402, `unpaid ${R.path} -> 402 (got ${r.status})`);
    const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf-8"));
    accepted[route] = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
    ok(!!accepted[route], `${R.path} offers exact on Base`);
  }
  const a = accepted[route];
  n++;
  const nonce = word(BigInt(Date.now()) * 1000n + BigInt(n));
  const p = { route, payer: payer || "0x" + (0xb000 + n).toString(16).padStart(40, "0"), nonce, asset: a.asset, amount: a.amount, tx: txOf(`${nonce}-${n}`), tx2: txOf(`${nonce}-${n}-retry`) };
  payments.set(nonce.toLowerCase(), p);
  p.cred = Buffer.from(JSON.stringify({
    x402Version: 2, resource: a.resource, accepted: a,
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: p.payer, to: a.payTo, value: a.amount, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce } },
  })).toString("base64");
  return p;
}
async function send(p, { abortAfterMs = 0 } = {}) {
  const R = ROUTES[p.route];
  const t0 = Date.now();
  const ctl = new AbortController();
  if (abortAfterMs) setTimeout(() => ctl.abort(), abortAfterMs);
  try {
    const r = await fetch(`${BASE}${R.path}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": p.cred }, body: R.body, signal: ctl.signal });
    const body = await r.text();
    let receipt = null;
    const hdr = r.headers.get("payment-response");
    if (hdr) { try { receipt = JSON.parse(Buffer.from(hdr, "base64").toString("utf-8")); } catch { /* */ } }
    return { status: r.status, receipt, body, ms: Date.now() - t0, replayed: r.headers.get("x-replayed-answer") === "1" };
  } catch (e) {
    return { status: 0, aborted: true, ms: Date.now() - t0, error: String(e?.name || e) };
  }
}
const Database = (await import("better-sqlite3")).default;
const salesFor = (tx) => { if (!existsSync(LEDGER)) return []; const db = new Database(LEDGER, { readonly: true, fileMustExist: true }); try { return db.prepare("SELECT slug, price_usd, network, payer, tx FROM sales WHERE lower(tx) = lower(?)").all(tx); } finally { db.close(); } };
const refundsFor = (tx) => { const f = join(DIR, "agent402-refunds.db"); if (!existsSync(f)) return []; const db = new Database(f, { readonly: true, fileMustExist: true }); try { return db.prepare("SELECT * FROM refunds").all().filter((r) => JSON.stringify(r).toLowerCase().includes(tx.toLowerCase())); } catch { return []; } finally { db.close(); } };
const lateHas = (tx) => existsSync(LATE) && readFileSync(LATE, "utf8").toLowerCase().includes(tx.toLowerCase());
const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return !!(await fn()); };
const facUp = async () => {
  const r = await fetch(`${BASE}/__operator/tool-failures.json`, { headers: { "X-Operator-Token": OP } });
  const j = await r.json();
  return j.upstreams.find((u) => u.upstream === `facilitator:127.0.0.1:${FAC_PORT}`)?.hour?.outside || { s5xx: 0, ok: 0 };
};

const pendingView = async () => {
  const r = await fetch(`${BASE}/__operator/tool-failures.json`, { headers: { "X-Operator-Token": OP } });
  const j = await r.json();
  const sum = {};
  for (const row of j.pendingSettles?.rows || []) if (row.network === "eip155:8453") for (const [k, v] of Object.entries(row.day)) sum[k] = (sum[k] || 0) + v;
  return new Proxy(sum, { get: (o, k) => o[k] || 0 });
};

try {
  // --- recovered: thrown 5xx pending, receipt mined within the wait -------
  settleMode = "pending"; rpcMode = "mined"; mineAfterMs = 1200;
  const before5xx = (await facUp()).s5xx;
  let p = await newPayment("hash");
  let s0 = settles, r0 = receiptReads;
  let r = await send(p);
  ok(r.status === 200 && r.receipt?.success === true && r.receipt?.transaction === p.tx.toLowerCase(), `pending 5xx, mined within the wait -> 200 with PAYMENT-RESPONSE naming the tx (status ${r.status}, ${r.ms} ms)`);
  ok(!/settlement-unconfirmed/.test(String(r.body)), "a recovered answer carries no pending explanation");
  ok(receiptReads - r0 >= 2 && settles - s0 === 2, `the receipt was polled (${receiptReads - r0} reads) after the facilitator's answer and its single retry (${settles - s0} settles)`);
  ok(serverLog.some((l) => l.includes(`recovered eip155:8453 settlement after a pending answer: tx ${p.tx.toLowerCase()}`)), "the recovery is logged with its tx");
  ok(await waitFor(() => salesFor(p.tx).length === 1), `one sale booked for the tx (${salesFor(p.tx).length})`);
  const sale = salesFor(p.tx)[0];
  const listUsd = Number(accepted.hash.amount) / 1e6;
  ok(sale && Math.abs(sale.price_usd - listUsd) < 1e-9 && sale.network === "base" && sale.payer === p.payer.toLowerCase(), `the sale is booked at the paid price (${sale?.price_usd} vs ${listUsd}, ${sale?.network})`);
  await sleep(300);
  ok(!lateHas(p.tx) && refundsFor(p.tx).length === 0, "nothing in the late-settlement book or the refund ledger");
  const after5xx = (await facUp()).s5xx;
  ok(after5xx === before5xx, `the facilitator's pending 5xx answers that recovered are not counted as failures (s5xx ${before5xx} -> ${after5xx})`);
  // Idempotency: the same signed payment again is answered from the first answer.
  s0 = settles;
  const again = await send(p);
  ok(again.status === 200 && again.replayed && again.body === r.body && settles === s0, `a resend of the recovered payment is answered from its first answer, never settled again (status ${again.status}, replayed ${again.replayed}, settles +${settles - s0})`);
  ok(salesFor(p.tx).length === 1, "still one sale for the tx");

  // --- recovered: graceful 200 pending ------------------------------------
  settleMode = "pending-graceful";
  p = await newPayment("hash");
  r = await send(p);
  ok(r.status === 200 && r.receipt?.transaction === p.tx.toLowerCase(), `graceful pending answer, mined within the wait -> 200 (status ${r.status})`);

  // --- the library's retry names a second tx that never mines ------------
  settleMode = "tx2"; rpcMode = "mined"; mineAfterMs = 1200;
  let pv0 = await pendingView();
  let s5a = (await facUp()).s5xx;
  p = await newPayment("hash");
  r = await send(p);
  ok(r.status === 200 && r.receipt?.transaction === p.tx.toLowerCase(), `tx2: the first answer's tx lands within the wait, the retry's never mines -> 200 naming the first tx (status ${r.status}, ${r.ms} ms)`);
  ok(await waitFor(() => salesFor(p.tx).length === 1) && salesFor(p.tx2).length === 0, "tx2: one sale, on the tx that landed");
  await sleep(300);
  ok(!lateHas(p.tx) && !lateHas(p.tx2) && refundsFor(p.tx).length === 0, "tx2: nothing booked, nothing owed");
  ok((await facUp()).s5xx === s5a, "tx2: both pending 5xx answers are forgiven");
  let pv = await pendingView();
  ok(pv.recovered === pv0.recovered + 1 && pv.forgivenPending === pv0.forgivenPending + 2, `tx2: counted recovered, two answers forgiven (${JSON.stringify({ ...pv })})`);
  // The first tx lands only after the wait: 402, both txs booked, and the late
  // book then owes the one that landed, once.
  mineAfterMs = 6500;
  pv0 = await pendingView();
  p = await newPayment("hash");
  r = await send(p);
  ok(r.status === 402, `tx2 late: the first tx lands after the wait -> 402 (status ${r.status}, ${r.ms} ms)`);
  ok(await waitFor(() => lateHas(p.tx) && lateHas(p.tx2)), "tx2 late: BOTH noted txs are booked in the late-settlement book");
  pv = await pendingView();
  ok(pv.notMined === pv0.notMined + 1, "tx2 late: counted not mined");
  ok(await waitFor(() => minedAt.get(p.tx) <= Date.now(), 8000), "tx2 late: the first tx has now landed");
  {
    const late = await import("../src/late-settlements.js");
    const owedRows = [];
    const book = late.createLateSettleBook({
      file: LATE, rpcFor: () => `http://127.0.0.1:${RPC_PORT}/rpc`, now: () => Date.now() + 31_000, log: () => {},
      recordOwed: async (row) => { if (!owedRows.some((o) => o.tx === row.tx)) owedRows.push(row); },
      owedRecorded: async (tx) => owedRows.some((o) => o.tx === tx),
    });
    const entries = book.list().filter((e) => e.tx === p.tx.toLowerCase() || e.tx === p.tx2.toLowerCase());
    ok(entries.length === 2 && entries.every((e) => e.authNonce === p.nonce.toLowerCase()), "tx2 late: both entries carry the authorization's nonce");
    const out1 = await book.reconcile();
    ok(owedRows.length === 1 && owedRows[0].tx === p.tx.toLowerCase() && /settled_after_402/.test(owedRows[0].note), `tx2 late: reconciled, the first tx is owed (${JSON.stringify(out1)})`);
    ok(!lateHas(p.tx) && lateHas(p.tx2), "tx2 late: the owed tx leaves the book; the never-mined retry stays open until its absence is proven");
    await book.reconcile();
    ok(owedRows.length === 1, "tx2 late: a second pass owes nothing more");
  }

  // --- the library's own retry settles: the first pending answer is forgiven
  settleMode = "pending-then-ok"; mineAfterMs = 1200;
  pv0 = await pendingView();
  s5a = (await facUp()).s5xx;
  p = await newPayment("hash");
  let rr0 = receiptReads;
  r = await send(p);
  ok(r.status === 200 && receiptReads === rr0, `retry settles: 200 with no chain read (status ${r.status})`);
  ok((await facUp()).s5xx === s5a, "retry settles: the first pending 5xx is not left counted");
  pv = await pendingView();
  ok(pv.retrySettled === pv0.retrySettled + 1 && pv.forgivenPending === pv0.forgivenPending + 1, `retry settles: counted (${JSON.stringify({ ...pv })})`);

  // --- the breaker counts a recovered call as settled ---------------------
  settleMode = "pending";
  const P = "0x" + "c1".repeat(20);
  for (let i = 0; i < 3; i++) {
    p = await newPayment("usage", { payer: P });
    r = await send(p);
    ok(r.status === 200 && r.receipt?.transaction === p.tx.toLowerCase(), `breaker (max 1 failure): recovered call ${i + 1} from one wallet -> 200 (status ${r.status})`);
  }
  // The control: one unrecovered pending call does block that wallet's next.
  const Q = "0x" + "d1".repeat(20);
  rpcMode = "never";
  p = await newPayment("usage", { payer: Q });
  r = await send(p);
  ok(r.status === 402, `control: an unrecovered pending call -> 402 (status ${r.status})`);
  rpcMode = "mined";
  p = await newPayment("usage", { payer: Q });
  s0 = settles;
  r = await send(p);
  ok(r.status === 429 && settles === s0, `control: that wallet's next call is refused by the breaker (status ${r.status})`);

  // --- not proven: today's path -------------------------------------------
  pv0 = await pendingView();
  for (const mode of ["never", "reverted", "elsewhere", "short", "noauth", "error", "ratelimit"]) {
    rpcMode = mode; settleMode = "pending";
    p = await newPayment("hash");
    r0 = receiptReads;
    const s5 = (await facUp()).s5xx;
    r = await send(p);
    ok(r.status === 402 && r.receipt?.success !== true, `${mode}: 402, not served (status ${r.status}, ${r.ms} ms, ${receiptReads - r0} receipt reads)`);
    ok((await facUp()).s5xx === s5 + 2, `${mode}: the facilitator's two pending 5xx answers stay counted`);
    ok(r.ms < 4000 + 2 * 20_000, `${mode}: answered inside the bound`);
    ok(await waitFor(() => lateHas(p.tx)), `${mode}: booked in the late-settlement book as before`);
    ok(salesFor(p.tx).length === 0, `${mode}: no sale`);
    let jb = null; try { jb = JSON.parse(r.body); } catch { /* not json */ }
    ok(jb?.reason === "settlement-unconfirmed" && JSON.stringify(jb.transactions) === JSON.stringify([p.tx.toLowerCase()]) && jb.network === "eip155:8453" && /may still land/.test(jb.hint) && /owed/.test(jb.hint) && !/not charged|nothing (?:was|is) charged/i.test(r.body),
      `${mode}: the 402 says the transfer may still land and is then owed, and names the tx (${String(r.body).slice(0, 160)})`);
    ok(r.receipt && r.receipt.success === false && String(r.receipt.transaction || "").toLowerCase() === p.tx.toLowerCase(), `${mode}: PAYMENT-RESPONSE is the facilitator's failed receipt, unchanged`);
  }
  pv = await pendingView();
  ok(pv.notMined === pv0.notMined + 1 && pv.reverted === pv0.reverted + 1 && pv.wrongTransfer === pv0.wrongTransfer + 3 && pv.rpcError === pv0.rpcError + 1 && pv.rateLimited === pv0.rateLimited + 1,
    `each unrecovered outcome is counted by reason on the operator view (${JSON.stringify({ ...pv })})`);
  rpcMode = "never";
  const t0 = Date.now();
  p = await newPayment("hash");
  await send(p);
  ok(Date.now() - t0 < 4000 + 3000, `never mined: the wait ends at PENDING_SETTLE_RECEIPT_WAIT_MS (${Date.now() - t0} ms for 4000 ms)`);

  // --- client gone during the settle -------------------------------------
  rpcMode = "mined"; mineAfterMs = 0; settleDelayMs = 1200;
  p = await newPayment("hash");
  r = await send(p, { abortAfterMs: 500 });
  settleDelayMs = 0;
  ok(r.aborted, "the buyer hung up while the facilitator was settling");
  ok(await waitFor(() => lateHas(p.tx), 8000), "client gone: the tx is booked in the late-settlement book as before");
  ok(salesFor(p.tx).length === 0, "client gone: not served, no sale");
  ok(serverLog.some((l) => l.includes("pending settle not recovered: the buyer left")), "client gone: the refusal names the reason");
  ok((await pendingView()).buyerGone >= 1, "client gone: counted buyerGone");

  // --- a genuine 5xx with no tx: unchanged --------------------------------
  settleMode = "plain-5xx"; rpcMode = "mined";
  const s5Before = (await facUp()).s5xx;
  p = await newPayment("hash");
  r0 = receiptReads;
  r = await send(p);
  ok(r.status === 402 && receiptReads === r0, `a 5xx with no tx -> 402 and the chain is never read (status ${r.status}, reads ${receiptReads - r0})`);
  ok(!/settlement-unconfirmed/.test(String(r.body)), "a 5xx with no tx carries no pending explanation");
  ok((await facUp()).s5xx > s5Before, "a genuine 5xx stays counted against the facilitator");
  await sleep(200);
  ok(!lateHas(p.tx), "a 5xx with no tx books nothing");

  // --- the hook in this process: a tx another request holds is not served --
  {
    process.env.EVM_RPC_8453 = `http://127.0.0.1:${RPC_PORT}/rpc`;
    process.env.PENDING_SETTLE_RECEIPT_WAIT_MS = "2000";
    process.env.SALES_LEDGER_DB = join(DIR, "unit-sales.db");
    const { registerFacilitatorFailureHooks } = await import("../src/payments.js");
    const { claimSettlementKey, txClaimKey } = await import("../src/settlement-claims.js");
    const hooks = [];
    registerFacilitatorFailureHooks({ onVerifyFailure() { return this; }, onAfterVerify() { return this; }, onAfterSettle() { return this; }, onSettleFailure(fn) { hooks.push(fn); return this; } }, null, null);
    rpcMode = "mined";
    const runHooks = async (q) => {
      const a = accepted.hash;
      const ctx = {
        requirements: { scheme: "exact", network: "eip155:8453", asset: a.asset, amount: a.amount, payTo: a.payTo },
        paymentPayload: { x402Version: 2, payload: { authorization: { from: q.payer, to: a.payTo, value: a.amount, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: q.nonce } } },
        error: Object.assign(new Error("settlement_pending"), { statusCode: 500, errorReason: "settlement_pending", errorMessage: PENDING_MSG, transaction: q.tx }),
        transportContext: { request: { adapter: { req: {} } } },
      };
      for (const h of hooks) { const out = await h(ctx); if (out?.recovered) return out; }
      return null;
    };
    let q = await newPayment("hash");
    minedAt.set(q.tx, 0);
    let out = await runHooks(q);
    ok(out?.result?.transaction === q.tx.toLowerCase(), "hook: a proven pending tx is recovered");
    q = await newPayment("hash");
    minedAt.set(q.tx, 0);
    await claimSettlementKey(txClaimKey("eip155:8453", q.tx), "another-request");
    out = await runHooks(q);
    ok(out === null, "hook: a proven tx another request already holds is not served");
    // Circle Gateway batched: never read, whatever the failure says.
    q = await newPayment("hash");
    minedAt.set(q.tx, 0);
    const before = receiptReads;
    const a = accepted.hash;
    const bctx = {
      requirements: { scheme: "exact", network: "eip155:8453", asset: a.asset, amount: a.amount, payTo: a.payTo, extra: { name: "GatewayWalletBatched" } },
      paymentPayload: { x402Version: 2, accepted: { extra: { name: "GatewayWalletBatched" } }, payload: { authorization: { from: q.payer, to: a.payTo, value: a.amount, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: q.nonce } } },
      error: Object.assign(new Error("settlement_pending"), { statusCode: 500, errorReason: "settlement_pending", errorMessage: PENDING_MSG, transaction: q.tx }),
      transportContext: { request: { adapter: { req: {} } } },
    };
    let bout = null;
    for (const h of hooks) { const o = await h(bctx); if (o?.recovered) { bout = o; break; } }
    ok(bout === null && receiptReads === before, "hook: a Gateway batched payment's pending answer is never read on chain");
  }

  console.log(`\nOK: ${pass} passed, 0 failed`);
} catch (e) {
  fail(`unexpected: ${e.stack || e}`);
}
cleanup();
process.exit(0);

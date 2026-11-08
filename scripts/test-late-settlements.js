#!/usr/bin/env node
// Settle failures that name a transaction are booked and read from the chain
// (src/late-settlements.js): a transfer that landed after the buyer was
// refused becomes an owed refund, once; a reverted, foreign or never-mined
// one owes nothing; a served one is never also owed.
//
// Offline: a stub JSON-RPC answers receipts and decimals() in-process; the
// refund ledger is the real one on a temp file. The settle-failure hooks run
// through a stand-in for @x402/core's hook loop (one failure context passed to
// each hook in order, stopping at the first recovery), with the real
// registerFacilitatorFailureHooks fallback chain and our relayer's
// settlement_pending answer shape.

// Settlement claims, refund rows and the late-settle book key on fixed
// transaction hashes and nonces: Redis or a state database left by an earlier
// run would already hold them (a claim lives past the run), so the next run's
// recoveries read "already held". The suite runs on in-process state whatever
// the calling shell exports; the shared claim has its own Redis suite
// (test-settle-onchain-proof.js).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/file-mode.js";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-late-settle-"));
process.env.REFUND_DB_DIR = dir;
process.env.PAYMENT_SETTLE_FALLBACK = "true";

const { createLateSettleBook, registerLateSettleHook, lateSettleCandidate, WINDOW_MS, MAX_AGE_MS, SETTLED_AFTER_402, UNRESOLVED_RECHECK_MS, UNRESOLVED_RECHECK_PER_PASS, UNRECORDED_WINDOW_MS } = await import("../src/late-settlements.js");
const { recordRefundOwed, refundByEvidenceFresh, listRefunds, refundAlarmStatus } = await import("../src/refund-ledger.js");
const { registerFacilitatorFailureHooks } = await import("../src/payments.js");

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); } catch (e) { failures++; console.log(`FAIL - ${name}\n  ${e?.stack || e}`); }
}

const RH = "eip155:4663";
const RPC = "http://rpc.stub.invalid";
const TOKEN = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TREASURY = "0x000000000000000000000000000000000000dead";
const OTHER = "0x00000000000000000000000000000000000beef1";
const payer = (i) => `0x${(0xa000 + i).toString(16).padStart(40, "0")}`;
const txh = (i) => `0x${i.toString(16).padStart(64, "0")}`;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (a) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const transferLog = (from, to, amount, token = TOKEN) => ({ address: token, topics: [TRANSFER, topic(from), topic(to)], data: `0x${BigInt(amount).toString(16)}` });

// The chain: receipts by tx; null = not mined; "fail" = the RPC errors.
const receipts = new Map();
const fetchImpl = async (_url, opts) => {
  const { method, params } = JSON.parse(opts.body);
  const answer = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
  if (method === "eth_getTransactionReceipt") {
    const r = receipts.get(String(params[0]).toLowerCase());
    if (r === "fail") return { ok: false, status: 503, json: async () => ({}) };
    return answer(r ?? null);
  }
  if (method === "eth_call") return answer("0x6"); // decimals() = 6
  return answer(null);
};

let clock = 1_000_000_000;
const now = () => clock;
let n = 0;
const bookFile = () => join(dir, `book-${++n}.json`);
const entry = (i, over = {}) => ({ network: RH, tx: txh(i), payer: payer(i), payTo: TREASURY, asset: TOKEN, amount: "2500", resource: "https://agent402.tools/api/stock-history?symbol=X", validBefore: Math.floor(clock / 1000) + 300, via: "own relayer", ...over });
const makeBook = (over = {}) => createLateSettleBook({ file: bookFile(), now, log: () => {}, fetchImpl, rpcFor: (net) => (net === RH ? RPC : null), ...over });

await check("a pending answer that later mines our transfer is booked owed once, at the charged amount, in the real refund ledger", async () => {
  const book = makeBook({ recordOwed: recordRefundOwed, owedRecorded: async (tx) => !!(await refundByEvidenceFresh(tx)) });
  assert.equal(await book.book(entry(1)), true);
  assert.equal(await book.book(entry(1)), true, "booking the same tx again is one entry");
  assert.equal(book.list().length, 1);
  clock += 60_000;
  let r = await book.reconcile();
  assert.equal(r.pending, 1, "not mined yet: kept");
  receipts.set(txh(1), { status: "0x1", logs: [transferLog(payer(1), TREASURY, 2500)] });
  clock += 10 * 60_000;
  r = await book.reconcile();
  assert.equal(r.owed, 1);
  assert.equal(book.list().length, 0, "dropped once the ledger holds the debt");
  const rows = listRefunds({ status: "owed" }).filter((x) => x.evidence === txh(1));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].priceUsd, 0.0025);
  assert.equal(rows[0].slug, "stock-history");
  assert.equal(String(rows[0].payer).toLowerCase(), payer(1));
  assert.equal(rows[0].httpStatus, 402);
  assert.ok(String(rows[0].note).startsWith(SETTLED_AFTER_402));
  // A later pass and a second book on the same tx never add a second row.
  clock += 10 * 60_000;
  r = await book.reconcile();
  assert.equal(r.checked, 0);
  assert.equal(listRefunds({ status: "owed" }).filter((x) => x.evidence === txh(1)).length, 1);
  assert.notEqual(refundAlarmStatus({ owedHours: 0, now: clock + 3600_000 }), "ok", "refundsOwed reads owed once the debt ages");
});

await check("two checker ticks and two replicas sharing one store book a landed transfer once", async () => {
  const file = bookFile();
  const owed = [];
  const recorded = new Set();
  const opts = { file, now, log: () => {}, fetchImpl, rpcFor: () => RPC, recordOwed: async (row) => { owed.push(row.tx); recorded.add(row.tx); return true; }, owedRecorded: async (tx) => recorded.has(tx) };
  const a = createLateSettleBook(opts);
  const b = createLateSettleBook(opts);
  await a.book(entry(2));
  await b.book(entry(2));
  receipts.set(txh(2), { status: "0x1", logs: [transferLog(payer(2), TREASURY, 2500)] });
  clock += 2 * 60_000;
  await a.reconcile();
  await b.reconcile();
  await a.reconcile();
  assert.deepEqual(owed, [txh(2)]);
});

await check("a reverted transaction is closed with nothing owed", async () => {
  const owed = [];
  const book = makeBook({ recordOwed: async (row) => { owed.push(row); return true; }, owedRecorded: async () => true });
  await book.book(entry(3));
  receipts.set(txh(3), { status: "0x0", logs: [] });
  clock += 2 * 60_000;
  const r = await book.reconcile();
  assert.equal(r.reverted, 1);
  assert.equal(owed.length, 0);
  assert.equal(book.list().length, 0);
});

await check("a mined transaction without this payment's transfer (another payTo, short, another token) owes nothing", async () => {
  const owed = [];
  const book = makeBook({ recordOwed: async (row) => { owed.push(row); return true; }, owedRecorded: async () => true });
  await book.book(entry(4));
  await book.book(entry(5));
  await book.book(entry(6));
  receipts.set(txh(4), { status: "0x1", logs: [transferLog(payer(4), OTHER, 2500)] });
  receipts.set(txh(5), { status: "0x1", logs: [transferLog(payer(5), TREASURY, 2499)] });
  receipts.set(txh(6), { status: "0x1", logs: [transferLog(payer(6), TREASURY, 2500, OTHER)] });
  clock += 2 * 60_000;
  const r = await book.reconcile();
  assert.equal(r.notOurs, 3);
  assert.equal(owed.length, 0);
});

await check("never mined: kept inside the window, closed once past it with the authorization expired", async () => {
  const book = makeBook({ recordOwed: async () => { throw new Error("nothing is owed"); } });
  await book.book(entry(7));
  clock += 2 * 60_000;
  let r = await book.reconcile();
  assert.equal(r.pending, 1);
  clock += WINDOW_MS;
  r = await book.reconcile();
  assert.equal(r.absent, 1);
  assert.equal(book.list().length, 0);
});

await check("never mined but its authorization still valid: kept past the window, since it can still land", async () => {
  const book = makeBook({ recordOwed: async () => { throw new Error("nothing is owed yet"); } });
  await book.book(entry(17, { validBefore: Math.floor(clock / 1000) + 24 * 3600 }));
  clock += WINDOW_MS + 2 * 60_000;
  const r = await book.reconcile();
  assert.equal(r.absent, 0, "absence is not proven while the authorization can still move money");
  assert.equal(book.list().length, 1);
});

await check("an authorization that never expires (2^64-1) or names no validBefore is never closed as not landed", async () => {
  const book = makeBook({ recordOwed: async () => { throw new Error("nothing is owed yet"); } });
  await book.book(entry(19, { validBefore: "18446744073709551615" }));
  await book.book(entry(20, { validBefore: undefined }));
  assert.deepEqual(book.list().map((e) => e.validBefore), [null, null], "an unreadable or far validBefore reads as no expiry");
  clock += WINDOW_MS + 2 * 60_000;
  let r = await book.reconcile();
  assert.equal(r.absent, 0, "absence is not proven while the authorization may still move money");
  clock += MAX_AGE_MS;
  r = await book.reconcile();
  assert.equal(r.absent, 0);
  assert.ok(book.list().every((e) => e.state === "unresolved"), "left for a human, never closed");
});

await check("a booking whose store write fails is kept in the journal, logged, and landed by the next pass", async () => {
  const { writeFileSync } = await import("node:fs");
  // A store path under a regular file: every write to it fails.
  const blocker = join(dir, `blocker-${Date.now()}`);
  writeFileSync(blocker, "not a directory");
  const held = [];
  const journal = {
    add: (kind, payload) => { held.push({ id: held.length + 1, kind, payload }); return held.length; },
    size: () => held.length,
    drain: async (apply) => { let n = 0; for (const e of [...held]) { const r = await apply(e); if (r === "stop") break; if (r === "landed" || r === "drop") { held.splice(held.indexOf(e), 1); if (r === "landed") n++; } } return n; },
  };
  const logs = [];
  const broken = createLateSettleBook({ file: join(blocker, "late.json"), now, log: (m) => logs.push(m), alarm: (m) => logs.push(`ALARM ${m}`), fetchImpl, rpcFor: (net) => (net === RH ? RPC : null), journal });
  assert.equal(await broken.book(entry(21)), true, "the booking is kept");
  assert.equal(held.length, 1, "in the journal");
  assert.ok(logs.some((m) => /store write failed; kept in the journal/.test(m)), "and the log says so");
  assert.ok(!logs.some((m) => /booked until its receipt is read/.test(m)), "never logged as booked when the store refused it");
  // The store answers again (a writable path): the next pass lands it.
  const healed = createLateSettleBook({ file: bookFile(), now, log: () => {}, fetchImpl, rpcFor: (net) => (net === RH ? RPC : null), journal });
  const r = await healed.reconcile();
  assert.equal(r.journaled, 1);
  assert.equal(held.length, 0);
  assert.deepEqual(healed.list().map((e) => e.tx), [txh(21)]);
  // Neither the store nor the journal takes it: an alarm, and it says so.
  const none = createLateSettleBook({ file: join(blocker, "late2.json"), now, log: (m) => logs.push(m), alarm: (m) => logs.push(`ALARM ${m}`), fetchImpl, rpcFor: (net) => (net === RH ? RPC : null), journal: { add: () => null, size: () => 0, drain: async () => 0 } });
  assert.equal(await none.book(entry(22)), false);
  assert.ok(logs.some((m) => /^ALARM .*could NOT be recorded/.test(m)), "an unrecordable booking raises an alarm");
});

await check("an RPC that never answers keeps the entry, then marks it unresolved for a human (never dropped)", async () => {
  const book = makeBook();
  await book.book(entry(8));
  receipts.set(txh(8), "fail");
  clock += 2 * 60_000;
  let r = await book.reconcile();
  assert.equal(r.unreadable, 1);
  clock += WINDOW_MS + 60_000;
  r = await book.reconcile();
  assert.equal(r.absent, 0, "absence is not proven by failing reads");
  clock += MAX_AGE_MS;
  r = await book.reconcile();
  assert.equal(r.unresolved, 1);
  const view = await book.operatorView();
  assert.equal(view.unresolved, 1);
  assert.equal(view.open[0].tx, txh(8));
  assert.ok(!("amount" in view.open[0]), "no amounts on the operator view");
});

await check("the status word: ok, near_capacity, then full at the open bound, where a new booking is journaled (never refused) and lands once there is room; unresolved entries never count toward the bound and read unresolved", async () => {
  const held = [];
  const journal = {
    add: (kind, payload) => { held.push({ id: held.length + 1, kind, payload }); return held.length; },
    size: () => held.length,
    drain: async (apply) => { let n = 0; for (const e of [...held]) { const r = await apply(e); if (r === "stop") break; if (r === "landed" || r === "drop") { held.splice(held.indexOf(e), 1); if (r === "landed") n++; } } return n; },
  };
  const logs = [];
  const alarms = [];
  const book = makeBook({ maxEntries: 5, journal, log: (m) => logs.push(m), alarm: (m) => alarms.push(m) });
  assert.equal(await book.alarmStatus({ ttlMs: 0 }), "ok");
  for (let i = 0; i < 4; i++) assert.equal(await book.book(entry(500 + i)), true);
  assert.equal(await book.alarmStatus({ ttlMs: 0 }), "near_capacity");
  assert.equal(await book.book(entry(504)), true);
  assert.equal(await book.alarmStatus({ ttlMs: 0 }), "full");
  // At the bound: kept in the journal, never refused, and the word stays full.
  assert.equal(await book.book(entry(505)), true, "a booking at the bound is kept");
  assert.equal(held.length, 1, "in the journal");
  assert.ok(logs.some((m) => /book is full \(5 open\).*kept in the journal/.test(m)), "and the log says so");
  assert.equal(alarms.length, 0);
  assert.equal(await book.alarmStatus({ ttlMs: 0 }), "full");
  // Every open entry ages out to unresolved (reads fail): they no longer hold the bound.
  for (let i = 500; i < 505; i++) receipts.set(txh(i), "fail");
  clock += MAX_AGE_MS + 60_000;
  const r = await book.reconcile();
  assert.equal(r.unresolved, 5);
  assert.equal(book.list().filter((e) => e.state === "unresolved").length, 5);
  // The journaled booking landed on the pass after it (the drain runs first).
  const r2 = await book.reconcile();
  assert.equal(r2.journaled, 1, "the journaled booking lands once the bound has room");
  assert.equal(held.length, 0);
  assert.ok(r2.checked >= 1 && r2.absent === 1, "and is then read like any booking (never mined, authorization expired: closed)");
  assert.equal(await book.book(entry(506)), true);
  assert.ok(book.list().some((e) => e.tx === txh(506)), "a new booking lands beside five unresolved entries");
  assert.equal(await book.alarmStatus({ ttlMs: 0 }), "unresolved", "unresolved entries page");
  const view = await book.operatorView();
  assert.equal(view.status, "unresolved");
  assert.equal(view.unresolved, 5);
  for (let i = 500; i < 507; i++) receipts.delete(txh(i));
});

await check("the status word reads unresolved while a booking sits in the journal, or could not be recorded anywhere, and the read is reused for its ttl", async () => {
  const held = [{ id: 1, kind: "late", payload: { key: "x" } }];
  const journal = { add: () => null, size: () => held.length, drain: async () => 0 };
  const book = makeBook({ journal, alarm: () => {} });
  assert.equal(await book.alarmStatus({ ttlMs: 0 }), "unresolved", "a journaled booking outside the book pages");
  held.length = 0;
  assert.equal(await book.alarmStatus({ ttlMs: 0 }), "ok");
  const { writeFileSync } = await import("node:fs");
  const blocker = join(dir, `blocker-word-${Date.now()}`);
  writeFileSync(blocker, "not a directory");
  const lost = createLateSettleBook({ file: join(blocker, "late.json"), now, log: () => {}, alarm: () => {}, fetchImpl, rpcFor: (net) => (net === RH ? RPC : null), journal });
  assert.equal(await lost.alarmStatus({ ttlMs: 0 }), "ok");
  assert.equal(await lost.book(entry(520)), false);
  assert.equal(await lost.alarmStatus(), "unresolved", "a booking recorded nowhere pages (and the booking reset the cached word)");
  const cached = makeBook({ journal });
  assert.equal(await cached.alarmStatus(), "ok");
  held.push({ id: 2 });
  assert.equal(await cached.alarmStatus(), "ok", "reused inside its ttl");
  clock += 11_000;
  assert.equal(await cached.alarmStatus(), "unresolved", "read again after it");
});

await check("a transfer served after all (a sale or a held claim for the tx) is never also owed", async () => {
  const owed = [];
  const book = makeBook({ recordOwed: async (row) => { owed.push(row); return true; }, owedRecorded: async () => true, wasServed: async ({ tx }) => tx === txh(9) });
  await book.book(entry(9));
  receipts.set(txh(9), { status: "0x1", logs: [transferLog(payer(9), TREASURY, 2500)] });
  clock += 2 * 60_000;
  const r = await book.reconcile();
  assert.equal(r.served, 1);
  assert.equal(owed.length, 0);
});

await check("networks without a receipt reader are skipped, not booked", async () => {
  const book = makeBook({ rpcFor: (net) => (net === RH ? RPC : null) });
  assert.equal(await book.book(entry(10, { network: "eip155:999999" })), false);
  assert.equal(await book.book(entry(11, { network: "eip155:4217" })), false, "Tempo has its own confirm path");
  assert.equal(await book.book(entry(12, { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })), false);
  assert.equal(book.list().length, 0);
});

// ---- The settle path: the hooks see every failure that names a transaction.
function hookHost() {
  const hooks = [];
  const server = { onSettleFailure: (h) => hooks.push(h), onVerifyFailure: () => {}, onAfterVerify: () => {}, onAfterSettle: () => {} };
  // @x402/core: one failure context, each hook in order, stop at a recovery.
  const fail = async (ctx) => { for (const h of hooks) { const r = await h(ctx); if (r && r.recovered) return r; } return null; };
  return { server, fail };
}
const ctxFor = (i, error) => ({
  requirements: { scheme: "exact", network: RH, payTo: TREASURY, asset: TOKEN, amount: "2500" },
  paymentPayload: { resource: { url: "https://agent402.tools/api/stock-history" }, payload: { authorization: { from: payer(i), to: TREASURY, value: "2500", validAfter: "0", validBefore: String(Math.floor(clock / 1000) + 300), nonce: txh(9000 + i) } } },
  error,
});
const pendingErr = (tx) => Object.assign(new Error("settlement_pending"), { name: "SettleError", errorReason: "settlement_pending", transaction: tx });

await check("our relayer's settlement_pending (the last fallback) is booked through the real fallback chain", async () => {
  const book = makeBook();
  const { server, fail } = hookHost();
  const relayer = { settle: async () => ({ success: false, errorReason: "settlement_pending", errorMessage: "no receipt within 30 s", transaction: txh(13), network: RH }) };
  registerFacilitatorFailureHooks(server, null, null, { [RH]: () => [{ name: "own relayer", client: relayer, revertRetry: true }] });
  registerLateSettleHook(server, async () => book);
  const reverted = Object.assign(new Error('invalid_exact_evm_transaction_failed: The contract function "transferWithAuthorization" reverted.'), { errorReason: "invalid_exact_evm_transaction_failed", errorMessage: 'The contract function "transferWithAuthorization" reverted.', transaction: "" });
  const r = await fail(ctxFor(13, reverted));
  assert.equal(r, null, "nothing recovered: the buyer is refused");
  assert.deepEqual(book.list().map((e) => [e.tx, e.via]), [[txh(13), "own relayer"]]);
});

await check("a facilitator timeout or 5xx that names a transaction is booked; one that names none is not", async () => {
  const book = makeBook();
  const { server, fail } = hookHost();
  registerFacilitatorFailureHooks(server, null, null, {});
  registerLateSettleHook(server, async () => book);
  await fail(ctxFor(14, Object.assign(new Error("settle timed out"), { name: "SettleError", statusCode: 504, errorReason: "unexpected_settle_error", transaction: txh(14) })));
  await fail(ctxFor(15, Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } })));
  await fail(ctxFor(16, pendingErr(txh(16))));
  assert.deepEqual(book.list().map((e) => e.tx).sort(), [txh(14), txh(16)]);
  assert.equal(lateSettleCandidate(ctxFor(17, pendingErr("0x1234"))), null, "a malformed hash is not a candidate");
});

await check("our relayer settled first (the facilitator read dry) and answered pending: the entry says own relayer, not primary", async () => {
  const { createRobinhoodOrder, withRobinhoodGasOrder } = await import("../src/robinhood-order.js");
  const book = makeBook();
  const { server, fail } = hookHost();
  registerFacilitatorFailureHooks(server, null, null, {});
  registerLateSettleHook(server, async () => book);
  const order = createRobinhoodOrder({ host: "facilitator.example", log: () => {} });
  order.update([{ network: RH, facilitator: "facilitator.example", runway: 2, status: "low", at: Date.now() }]);
  const primary = { settle: async () => ({ success: true, transaction: txh(99), network: RH }) };
  withRobinhoodGasOrder(primary, { order, relayer: { settle: async () => ({ success: false, errorReason: "settlement_pending", errorMessage: "no receipt within 30 s", transaction: txh(19), network: RH }) } });
  const ctx = ctxFor(19, null);
  const res = await primary.settle(ctx.paymentPayload, ctx.requirements);
  ctx.error = pendingErr(res.transaction);
  assert.equal(await fail(ctx), null, "nothing recovered");
  assert.deepEqual(book.list().map((e) => [e.tx, e.via]), [[txh(19), "own relayer"]]);
  // Control: the facilitator's own pending answer still reads primary.
  await fail(ctxFor(20, pendingErr(txh(20))));
  assert.deepEqual(book.list().filter((e) => e.tx === txh(20)).map((e) => e.via), ["primary"]);
});

await check("a recovered settlement (a fallback settled it) books nothing", async () => {
  const book = makeBook();
  const { server, fail } = hookHost();
  const good = { settle: async () => ({ success: true, transaction: txh(18), network: RH }) };
  registerFacilitatorFailureHooks(server, null, null, { [RH]: () => [{ name: "listed", client: good, revertRetry: true }] });
  registerLateSettleHook(server, async () => book);
  const reverted = Object.assign(new Error("reverted"), { errorReason: "invalid_exact_evm_transaction_failed", errorMessage: 'The contract function "transferWithAuthorization" reverted.', transaction: "" });
  const r = await fail(ctxFor(18, reverted));
  assert.equal(r?.recovered, true);
  assert.equal(book.list().length, 0);
});

// ---- The authorization claim (src/settlement-claims.js) on the same path.
const claims = await import("../src/settlement-claims.js");
function fullHost() {
  const h = { beforeVerify: [], beforeSettle: [], fail: [] };
  const server = { onBeforeVerify: (f) => h.beforeVerify.push(f), onBeforeSettle: (f) => h.beforeSettle.push(f), onAfterSettle: () => {}, onAfterVerify: () => {}, onSettleFailure: (f) => h.fail.push(f), onVerifyFailure: () => {} };
  // One request: stamp, claim its authorization, then (when the primary
  // fails) every settle-failure hook in order, stopping at a recovery.
  const request = async (ctx, primaryError) => {
    for (const f of h.beforeVerify) await f(ctx);
    for (const f of h.beforeSettle) { const r = await f(ctx); if (r?.abort) return { aborted: r.reason }; }
    const fctx = { ...ctx, error: primaryError };
    for (const f of h.fail) { const r = await f(fctx); if (r?.recovered) return { recovered: r }; }
    return { refused: true, ctx: fctx };
  };
  return { server, request };
}
const reqCtx = (i, nonce) => ({ ...ctxFor(i, undefined), transportContext: { request: { adapter: { req: {} } } }, paymentPayload: { resource: { url: "https://agent402.tools/api/stock-history" }, payload: { authorization: { from: payer(i), to: TREASURY, value: "2500", validAfter: "0", validBefore: String(Math.floor(clock / 1000) + 300), nonce } } } });
const revertedPrimary = () => Object.assign(new Error('invalid_exact_evm_transaction_failed: The contract function "transferWithAuthorization" reverted.'), { errorReason: "invalid_exact_evm_transaction_failed", errorMessage: 'The contract function "transferWithAuthorization" reverted.', transaction: "" });

await check("a resend of an authorization our relayer left pending is refused: the claim is kept while its transaction may land", async () => {
  claims.__resetSettlementClaims();
  const book = makeBook();
  const { server, request } = fullHost();
  // A settler that, like a cached pending result, would answer success for the
  // same signature on a resend.
  let calls = 0;
  const relayer = { settle: async () => (++calls === 1
    ? { success: false, errorReason: "settlement_pending", errorMessage: "no receipt within 30 s", transaction: txh(31), network: RH }
    : { success: true, transaction: txh(31), network: RH }) };
  claims.registerSettlementClaimHooks(server);
  registerFacilitatorFailureHooks(server, null, null, { [RH]: () => [{ name: "own relayer", client: relayer, revertRetry: true }] });
  claims.registerSettlementClaimRelease(server);
  registerLateSettleHook(server, async () => book);
  const nonce = txh(9301);
  const first = await request(reqCtx(31, nonce), revertedPrimary());
  assert.ok(first.refused, "the first request is refused with its transaction pending");
  assert.deepEqual(book.list().map((e) => e.tx), [txh(31)], "and its transaction is booked for the reconcile");
  const resend = await request(reqCtx(31, nonce), revertedPrimary());
  assert.equal(resend.aborted, claims.DUPLICATE_AUTHORIZATION, "the resend never reaches a settler");
  assert.equal(calls, 1, "our relayer was asked once");
});

await check("a fallback that answers a transaction already held (served, or booked owed) is not served again", async () => {
  claims.__resetSettlementClaims();
  const { server, request } = fullHost();
  const good = (tx) => ({ settle: async () => ({ success: true, transaction: tx, network: RH }) });
  claims.registerSettlementClaimHooks(server);
  registerFacilitatorFailureHooks(server, null, null, { [RH]: () => [{ name: "listed", client: good(txh(32)), revertRetry: true }] });
  claims.registerSettlementClaimRelease(server);
  // The late-settlement book took this transaction when it booked it owed.
  assert.equal((await claims.claimSettlementKey(claims.txClaimKey(RH, txh(32)), "late-settle:x")).claimed, true);
  const held = await request(reqCtx(32, txh(9302)), revertedPrimary());
  assert.ok(held.refused, "a transaction the book holds is never served as this request's payment");
  // Control: a fresh transaction is recovered, and is then held for this request.
  const { server: s2, request: r2 } = fullHost();
  claims.registerSettlementClaimHooks(s2);
  registerFacilitatorFailureHooks(s2, null, null, { [RH]: () => [{ name: "listed", client: good(txh(33)), revertRetry: true }] });
  claims.registerSettlementClaimRelease(s2);
  const ok2 = await r2(reqCtx(33, txh(9303)), revertedPrimary());
  assert.ok(ok2.recovered, "a fresh transaction is recovered");
  assert.equal((await claims.claimSettlementKey(claims.txClaimKey(RH, txh(33)), "late-settle:y")).claimed, false, "and the book can no longer book it owed");
});

await check("the paid server registers the booking hook after every hook that can recover a payment", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  // Live calls only: a line that is commented out does not register anything.
  const at = (re) => { const m = re.exec(src); return m ? m.index : -1; };
  const fallbackAt = at(/^[ \t]*registerFacilitatorFailureHooks\(server, payAiClient/m);
  const releaseAt = at(/^[ \t]*registerSettlementClaimRelease\(server\);/m);
  const lateAt = at(/^[ \t]*registerLateSettleHook\(server, lateSettleBook\);/m);
  assert.ok(fallbackAt > 0 && releaseAt > fallbackAt && lateAt > releaseAt, "order: fallback chain, claim release, late booking");
});

// The alarm can close: an operator resolves an unresolved entry, a slow
// re-read resolves one the chain later answers, and an unrecorded booking
// stops paging after its window or an acknowledgement.
const ageOut = async (book, i) => {
  receipts.set(txh(i), "fail");
  await book.book(entry(i));
  clock += 2 * 60_000;
  await book.reconcile();
  clock += MAX_AGE_MS + 60_000;
  const r = await book.reconcile();
  assert.ok(r.unresolved >= 1, "aged out to unresolved");
};

await check("an operator resolves an unresolved entry (dismissed, paid, booked_owed): recorded, dropped, and the word returns to ok", async () => {
  const logs = [];
  const book = makeBook({ recordOwed: recordRefundOwed, owedRecorded: async (tx) => !!(await refundByEvidenceFresh(tx)), log: (m) => logs.push(m) });
  await ageOut(book, 700);
  await ageOut(book, 701);
  await ageOut(book, 702);
  assert.equal(await book.alarmStatus({ ttlMs: 0 }), "unresolved", "an unresolved entry pages");
  const key = (i) => book.list().find((e) => e.tx === txh(i)).key;
  // Refusals: no note, an unknown outcome, an unknown or inherited key, a paid without its refund tx.
  assert.equal((await book.resolve(key(700), { outcome: "dismissed" })).ok, false);
  assert.equal((await book.resolve(key(700), { outcome: "forgotten", note: "x" })).ok, false);
  assert.equal((await book.resolve("__proto__", { outcome: "dismissed", note: "x" })).ok, false);
  assert.equal((await book.resolve(`${RH}|${txh(9999)}`, { outcome: "dismissed", note: "x" })).ok, false);
  assert.equal((await book.resolve(key(701), { outcome: "paid", note: "repaid" })).ok, false, "paid needs the refund tx");
  assert.equal(book.list().length, 3, "nothing dropped by a refused resolution");
  // Dismissed and paid close without touching the ledger.
  assert.deepEqual(await book.resolve(key(700), { outcome: "dismissed", note: "explorer: never mined" }), { ok: true, key: `${RH}|${txh(700)}`, outcome: "dismissed" });
  assert.equal((await book.resolve(key(701), { outcome: "paid", note: "repaid by hand", tx: txh(7011) })).ok, true);
  assert.equal(await refundByEvidenceFresh(txh(700)), null, "dismissed writes no debt");
  assert.equal(await book.alarmStatus({ ttlMs: 0 }), "unresolved", "one still waits");
  // booked_owed writes the debt (decimals read on chain) and closes only once the ledger holds it.
  assert.equal((await book.resolve(key(702), { outcome: "booked_owed", note: "explorer: landed, block 1" })).ok, true);
  const row = await refundByEvidenceFresh(txh(702));
  assert.ok(row && row.status === "owed" && Math.abs(row.priceUsd - 0.0025) < 1e-9 && row.payer === payer(702), JSON.stringify(row));
  assert.equal(book.list().length, 0);
  assert.equal(await book.alarmStatus({ ttlMs: 0 }), "ok", "the word returns to ok");
  const view = await book.operatorView();
  assert.deepEqual(view.resolutions.map((r) => r.outcome), ["dismissed", "paid", "booked_owed"], "every resolution is recorded");
  assert.equal(view.resolutions[1].tx, txh(7011));
  assert.ok(view.resolutions.every((r) => !("amount" in r)));
  assert.ok(logs.filter((m) => /operator resolved/.test(m)).length === 3);
  for (let i = 700; i < 703; i++) receipts.delete(txh(i));
});

await check("a pending entry is the reconcile pass's: an operator cannot resolve it, and booked_owed keeps the entry when the ledger does not take the debt", async () => {
  const book = makeBook({ recordOwed: async () => false, owedRecorded: async () => false });
  await book.book(entry(710));
  const k = book.list()[0].key;
  assert.match((await book.resolve(k, { outcome: "dismissed", note: "x" })).error, /pending/);
  await ageOut(book, 711);
  const k2 = book.list().find((e) => e.tx === txh(711)).key;
  const r = await book.resolve(k2, { outcome: "booked_owed", note: "landed", decimals: 6 });
  assert.equal(r.ok, false);
  assert.match(r.error, /ledger/);
  assert.ok(book.list().some((e) => e.key === k2), "kept");
  assert.equal((await book.resolve(k2, { outcome: "booked_owed", note: "landed", decimals: 99 })).ok, false, "decimals are bounded");
  receipts.delete(txh(711));
});

await check("an unresolved entry is read on chain again on a slow cadence: one that later shows as settled is booked owed and the word clears", async () => {
  const book = makeBook({ recordOwed: recordRefundOwed, owedRecorded: async (tx) => !!(await refundByEvidenceFresh(tx)) });
  await ageOut(book, 720);
  assert.equal(await book.alarmStatus({ ttlMs: 0 }), "unresolved");
  // Still unreadable: kept, the re-read is pushed back.
  clock += UNRESOLVED_RECHECK_MS + 1;
  let r = await book.reconcile();
  assert.equal(r.rechecked, 1, "re-read once its recheck time came");
  assert.equal(book.list()[0].state, "unresolved");
  r = await book.reconcile();
  assert.equal(r.checked, 0, "not re-read before its next recheck time");
  receipts.set(txh(720), { status: "0x1", logs: [transferLog(payer(720), TREASURY, 2500)] });
  clock += UNRESOLVED_RECHECK_MS + 1;
  r = await book.reconcile();
  assert.equal(r.owed, 1, "landed after all: booked owed");
  assert.equal((await refundByEvidenceFresh(txh(720)))?.status, "owed");
  assert.equal(book.list().length, 0);
  assert.equal(await book.alarmStatus({ ttlMs: 0 }), "ok");
  // A reverted one closes the same way.
  await ageOut(book, 721);
  receipts.set(txh(721), { status: "0x0", logs: [] });
  clock += UNRESOLVED_RECHECK_MS + 1;
  r = await book.reconcile();
  assert.equal(r.reverted, 1);
  assert.equal(await book.alarmStatus({ ttlMs: 0 }), "ok");
  // At most UNRESOLVED_RECHECK_PER_PASS re-reads per pass.
  for (let i = 0; i < UNRESOLVED_RECHECK_PER_PASS + 2; i++) await ageOut(book, 730 + i);
  clock += UNRESOLVED_RECHECK_MS + 1;
  r = await book.reconcile();
  assert.equal(r.rechecked, UNRESOLVED_RECHECK_PER_PASS, "bounded per pass");
  for (let i = 720; i < 740; i++) receipts.delete(txh(i));
});

await check("a booking recorded nowhere pages for its window, then clears; an operator acknowledgement clears it at once", async () => {
  const { writeFileSync } = await import("node:fs");
  const blocker = join(dir, `blocker-unrec-${Date.now()}`);
  writeFileSync(blocker, "not a directory");
  const journal = { add: () => null, size: () => 0, drain: async () => 0 };
  const mk = () => createLateSettleBook({ file: join(blocker, "late.json"), now, log: () => {}, alarm: () => {}, fetchImpl, rpcFor: (net) => (net === RH ? RPC : null), journal });
  const a = mk();
  assert.equal(await a.book(entry(750)), false);
  assert.equal(await a.alarmStatus({ ttlMs: 0 }), "unresolved");
  clock += UNRECORDED_WINDOW_MS + 1;
  assert.equal(await a.alarmStatus({ ttlMs: 0 }), "ok", "the count is windowed: it clears after the window");
  assert.equal(await a.book(entry(751)), false);
  assert.equal(await a.alarmStatus({ ttlMs: 0 }), "unresolved");
  // The acknowledgement is recorded first: on a store that cannot write, it is refused and the word stays.
  assert.equal((await a.acknowledgeUnrecorded({ note: "checked the log line" })).ok, false);
  assert.equal(await a.alarmStatus({ ttlMs: 0 }), "unresolved");
  const b = makeBook({ journal });
  // Same path, a writable store: force one unrecorded booking through a store that refuses.
  const refusing = createLateSettleBook({ file: bookFile(), now, log: () => {}, alarm: () => {}, fetchImpl, rpcFor: (net) => (net === RH ? RPC : null), journal, maxEntries: 0 });
  assert.equal(await refusing.book(entry(752)), false);
  assert.equal(await refusing.alarmStatus({ ttlMs: 0 }), "full");
  assert.equal((await b.acknowledgeUnrecorded({})).ok, false, "a note is required");
  assert.equal((await refusing.acknowledgeUnrecorded({ note: "checked" })).acknowledged, 1);
  assert.equal((await refusing.operatorView()).unrecordedInMemory, 0, "acknowledged");
});

console.log(`test-late-settlements: ${failures ? `FAILED (${failures})` : "all passed"}`);
process.exit(failures ? 1 : 0);

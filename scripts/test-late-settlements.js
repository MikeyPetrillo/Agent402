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

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-late-settle-"));
process.env.REFUND_DB_DIR = dir;
delete process.env.STATE_DATABASE_URL;
process.env.PAYMENT_SETTLE_FALLBACK = "true";

const { createLateSettleBook, registerLateSettleHook, lateSettleCandidate, WINDOW_MS, MAX_AGE_MS, SETTLED_AFTER_402 } = await import("../src/late-settlements.js");
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

console.log(`test-late-settlements: ${failures ? `FAILED (${failures})` : "all passed"}`);
process.exit(failures ? 1 : 0);

#!/usr/bin/env node
// Robinhood outage handling (src/robinhood-outage.js, wired by
// src/payments.js registerFacilitatorFailureHooks): an AMBIGUOUS settle
// failure from a listed facilitator on eip155:4663 (5xx, timeout, transport
// error, an answer with no verdict and no transaction) is read on chain
// instead of stopping the settle chain. Offline: a stub 4663 JSON-RPC (an
// in-process fetch), a stub relayer, the real failure hooks, the real
// late-settlement book and claims. Hooks run in registration order and stop at
// the first recovery, as @x402/core does.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettleError } from "@x402/core/types";
import { keccak256, toHex, decodeFunctionData, parseAbi, encodeEventTopics, pad } from "viem";

const dir = mkdtempSync(join(tmpdir(), "a402-rh-outage-"));
process.env.PAYMENT_SETTLE_FALLBACK = "true";
process.env.LATE_SETTLE_FILE = join(dir, "late.json");
const { registerFacilitatorFailureHooks } = await import("../src/payments.js");
const { createRobinhoodOutage, isAmbiguousSettleFailure } = await import("../src/robinhood-outage.js");
const { createLateSettleBook, registerLateSettleHook } = await import("../src/late-settlements.js");
const { namesUnsettledTx, __resetSettlementClaims, txServedElsewhere } = await import("../src/settlement-claims.js");

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.stack?.split("\n").slice(0, 2).join(" | ") || e.message}`); }
};

const RH = "eip155:4663", BASE = "eip155:8453";
const TOKEN = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TREASURY = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
const OTHER = "0x00000000000000000000000000000000000beef1";
const RPC_URL = "http://stub-rh.invalid/rpc";
const TOKEN_ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);

// ------------------------------------------------------------ stub 4663 chain
const chain = { head: 100_000, used: new Map(), receipts: new Map(), fail: false, reads: 0, hiddenReceipts: new Set() };
const txh = (s) => keccak256(toHex(String(s)));
/** A transfer that uses (payer, nonce) and moves `value` to `to` in `tx`. */
function land({ payer, nonce, to = TREASURY, value = 2500n, tx = txh(`${payer}${nonce}${Math.random()}`), status = "0x1" }) {
  chain.head += 5;
  const block = toHex(chain.head);
  const logs = status === "0x1" ? [
    { address: TOKEN, topics: encodeEventTopics({ abi: TOKEN_ABI, eventName: "Transfer", args: { from: payer, to } }), data: pad(toHex(value)), transactionHash: tx, blockNumber: block },
    { address: TOKEN, topics: encodeEventTopics({ abi: TOKEN_ABI, eventName: "AuthorizationUsed", args: { authorizer: payer, nonce } }), data: "0x", transactionHash: tx, blockNumber: block },
  ] : [];
  if (status === "0x1") chain.used.set(`${payer.toLowerCase()}|${nonce.toLowerCase()}`, tx);
  chain.receipts.set(tx.toLowerCase(), { status, logs, transactionHash: tx, blockNumber: block });
  return tx;
}
const fetchImpl = async (url, init) => {
  chain.reads++;
  const { method, params } = JSON.parse(init.body);
  const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
  if (chain.fail) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "upstream timeout" } }) };
  if (method === "eth_blockNumber") return ok(toHex(chain.head));
  if (method === "eth_getBlockByNumber") return ok({ number: params[0], timestamp: toHex(Math.floor(Date.now() / 1000) - (chain.head - Number(BigInt(params[0]))) / 10) });
  if (method === "eth_call") {
    if (params[0].data === "0x313ce567") return ok(toHex(6, { size: 32 }));
    const { args } = decodeFunctionData({ abi: TOKEN_ABI, data: params[0].data });
    return ok(chain.used.has(`${args[0].toLowerCase()}|${args[1].toLowerCase()}`) ? toHex(1, { size: 32 }) : toHex(0, { size: 32 }));
  }
  if (method === "eth_getLogs") {
    const f = params[0];
    const out = [];
    for (const r of chain.receipts.values()) for (const l of r.logs) {
      const n = Number(BigInt(l.blockNumber));
      if (n < Number(BigInt(f.fromBlock)) || n > Number(BigInt(f.toBlock))) continue;
      if (f.topics.every((t, i) => t == null || String(l.topics[i]).toLowerCase() === String(t).toLowerCase())) out.push(l);
    }
    return ok(out);
  }
  if (method === "eth_getTransactionReceipt") return ok(chain.hiddenReceipts.has(String(params[0]).toLowerCase()) ? null : (chain.receipts.get(String(params[0]).toLowerCase()) || null));
  return ok(null);
};

// ------------------------------------------------------------- the harness
let seq = 0;
const payment = ({ network = RH, payTo = TREASURY, authTo = payTo, validBefore = Math.floor(Date.now() / 1000) + 300 } = {}) => {
  seq++;
  const payer = `0x${(0xa000 + seq).toString(16).padStart(40, "0")}`;
  const nonce = txh(`nonce-${seq}-${Math.random()}`);
  return {
    payer, nonce,
    requirements: { scheme: "exact", network, asset: TOKEN, amount: "2500", payTo, maxTimeoutSeconds: 300 },
    paymentPayload: { x402Version: 2, resource: { url: "https://agent402.tools/api/stock-history" }, payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: authTo, value: "2500", validAfter: "0", validBefore: String(validBefore), nonce } } },
  };
};
const ambiguous5xx = (network = RH) => new SettleError(502, { success: false, errorReason: "", transaction: "", network });
const timeoutErr = () => Object.assign(new Error("fetch failed"), { cause: new Error("ETIMEDOUT") });

function makeRelayer(mode, p) {
  const r = { sends: 0, mode };
  r.settle = async () => {
    r.sends++;
    if (r.mode === "settles") return { success: true, transaction: land({ payer: p.payer, nonce: p.nonce }), network: RH, payer: p.payer };
    if (r.mode === "race") {
      // The facilitator's transfer lands while ours is in flight: ours is
      // refused (the authorization is used).
      land({ payer: p.payer, nonce: p.nonce, tx: txh(`facilitator-${p.nonce}`) });
      return { success: false, errorReason: "invalid_exact_evm_nonce_already_used", transaction: "", network: RH };
    }
    return { success: false, errorReason: "relayer_refused", transaction: "", network: RH };
  };
  return r;
}

const book = createLateSettleBook({ file: join(dir, "late.json"), rpcFor: (n) => (n === RH ? RPC_URL : null), fetchImpl, log: () => {},
  wasServed: async ({ tx, network, key }) => txServedElsewhere(network, tx, `late-settle:${key}`), owedRecorded: async (tx) => owed.some((o) => o.tx === tx),
  recordOwed: async (row) => { owed.push(row); } });
const owed = [];

/** Runs the settle-failure hooks for one failed settlement, core-style. */
async function settleFails({ p, error, outage, listed = [], req = null }) {
  const hooks = [];
  const server = { onVerifyFailure() { return this; }, onAfterVerify() { return this; }, onAfterSettle() { return this; }, onSettleFailure(fn) { hooks.push(fn); return this; } };
  const asked = [];
  const listedClients = listed.map((l) => ({ name: l.name, revertRetry: true, confirmed: true, client: { settle: async () => { asked.push(l.name); return l.answer(); } } }));
  registerFacilitatorFailureHooks(server, null, null, { [RH]: () => listedClients }, { outageFor: () => outage });
  registerLateSettleHook(server, async () => book);
  const ctx = { requirements: p.requirements, paymentPayload: p.paymentPayload, error, ...(req ? { transportContext: { request: { adapter: { req } } } } : {}) };
  let recovered = null;
  for (const h of hooks) { const r = await h(ctx); if (r?.recovered) { recovered = r; break; } }
  return { ctx, recovered, asked };
}
const outageWith = (relayer, waitMs = 400, opts = {}) => createRobinhoodOutage({ network: RH, token: TOKEN, treasury: TREASURY, rpcUrl: RPC_URL, relayer, waitMs, pollMs: 50, fetchImpl, log: () => {}, clientGone: () => false, ...opts });

// ------------------------------------------------------------------- tests
await check("ambiguous means no transaction, no verdict, not pre-broadcast and not a reverted transfer", () => {
  assert.equal(isAmbiguousSettleFailure(ambiguous5xx()), true);
  assert.equal(isAmbiguousSettleFailure(timeoutErr()), true);
  assert.equal(isAmbiguousSettleFailure(Object.assign(new Error("x"), { transaction: txh("named") })), false, "names a tx");
  assert.equal(isAmbiguousSettleFailure(new SettleError(500, { success: false, errorReason: "invalid_exact_evm_payload_signature", transaction: "", network: RH })), false, "a verdict");
  assert.equal(isAmbiguousSettleFailure(ambiguous5xx(), { isPreBroadcast: () => true }), false);
});

await check("facilitator 5xx, the authorization lands within the wait with our transfer -> served once, our relayer never sends", async () => {
  __resetSettlementClaims();
  const p = payment(); const relayer = makeRelayer("settles", p);
  setTimeout(() => land({ payer: p.payer, nonce: p.nonce, tx: txh(`fac-${p.nonce}`) }), 120);
  const { recovered, ctx } = await settleFails({ p, error: ambiguous5xx(), outage: outageWith(relayer) });
  assert.ok(recovered, "recovered");
  assert.equal(recovered.result.transaction, txh(`fac-${p.nonce}`).toLowerCase());
  assert.equal(relayer.sends, 0);
  assert.equal(ctx.__a402LateAuth, undefined);
  // The same transfer cannot answer a second request.
  const again = await settleFails({ p, error: ambiguous5xx(), outage: outageWith(makeRelayer("settles", p)) });
  assert.equal(again.recovered, null, "a resend of the same authorization is not served twice");
});

await check("facilitator 5xx, still unused after the wait -> our relayer settles it once -> served", async () => {
  __resetSettlementClaims();
  const p = payment(); const relayer = makeRelayer("settles", p);
  const { recovered } = await settleFails({ p, error: ambiguous5xx(), outage: outageWith(relayer, 150) });
  assert.ok(recovered?.result?.success, "served");
  assert.equal(relayer.sends, 1);
});

await check("timeout, the facilitator's transfer lands during our relayer's attempt -> served once by that transfer, nothing owed", async () => {
  __resetSettlementClaims();
  owed.length = 0;
  const p = payment(); const relayer = makeRelayer("race", p);
  const { recovered, ctx } = await settleFails({ p, error: timeoutErr(), outage: outageWith(relayer, 150) });
  assert.ok(recovered, "served");
  assert.equal(recovered.result.transaction, txh(`facilitator-${p.nonce}`).toLowerCase());
  assert.equal(relayer.sends, 1);
  assert.equal(ctx.__a402LateAuth, undefined, "nothing left unresolved");
  await book.reconcile();
  assert.equal(owed.length, 0, "a served payment is never owed");
});

await check("used, but by a transfer to someone else -> refused (402), nobody else asked, nothing booked", async () => {
  __resetSettlementClaims();
  const p = payment(); const relayer = makeRelayer("settles", p);
  land({ payer: p.payer, nonce: p.nonce, to: OTHER });
  const { recovered, ctx, asked } = await settleFails({ p, error: ambiguous5xx(), outage: outageWith(relayer) });
  assert.equal(recovered, null);
  assert.equal(relayer.sends, 0);
  assert.deepEqual(asked, []);
  assert.equal(ctx.__a402LateAuth, undefined);
});

await check("a chain read failure -> refused (402), the authorization booked; it books owed once the transfer appears", async () => {
  __resetSettlementClaims();
  owed.length = 0;
  const p = payment(); const relayer = makeRelayer("settles", p);
  chain.fail = true;
  let r;
  try { r = await settleFails({ p, error: ambiguous5xx(), outage: outageWith(relayer) }); } finally { chain.fail = false; }
  assert.equal(r.recovered, null);
  assert.equal(relayer.sends, 0, "nothing submitted on a failed read");
  assert.equal(r.ctx.__a402LateAuth?.nonce, p.nonce);
  assert.equal(namesUnsettledTx(r.ctx), true, "the authorization stays claimed while unresolved");
  await book.refresh();
  const entry = book.list().find((e) => e.nonce === p.nonce.toLowerCase());
  assert.ok(entry && !entry.tx, "booked by authorization");
  const tx = land({ payer: p.payer, nonce: p.nonce, tx: txh(`late-${p.nonce}`) });
  await book.refresh();
  for (const e of book.list()) e.nextCheckAt = 0;
  // Make the entry due now.
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try { await book.reconcile(); } finally { Date.now = realNow; }
  assert.equal(owed.length, 1, `owed once (${JSON.stringify(owed)})`);
  assert.equal(owed[0].tx, tx.toLowerCase());
});

await check("relayer not configured -> the chain stops as before: 402, nothing asked, nothing read", async () => {
  __resetSettlementClaims();
  const p = payment();
  const reads = chain.reads;
  const { recovered, asked, ctx } = await settleFails({ p, error: ambiguous5xx(), outage: null, listed: [{ name: "listed", answer: () => ({ success: true, transaction: txh("x") }) }] });
  assert.equal(recovered, null);
  assert.deepEqual(asked, []);
  assert.equal(chain.reads, reads);
  assert.equal(ctx.__a402LateAuth, undefined);
});

await check("another network is never handled, even with the handler wired", async () => {
  __resetSettlementClaims();
  const p = payment({ network: BASE }); const relayer = makeRelayer("settles", p);
  const reads = chain.reads;
  const { recovered } = await settleFails({ p, error: ambiguous5xx(BASE), outage: outageWith(relayer) });
  assert.equal(recovered, null);
  assert.equal(relayer.sends, 0);
  assert.equal(chain.reads, reads);
});

await check("a payment to another payTo on 4663 is never handled", async () => {
  __resetSettlementClaims();
  const p = payment({ payTo: OTHER }); const relayer = makeRelayer("settles", p);
  const { recovered } = await settleFails({ p, error: ambiguous5xx(), outage: outageWith(relayer) });
  assert.equal(recovered, null);
  assert.equal(relayer.sends, 0);
});

await check("an authorization at its deadline: the wait is cut to its window, our relayer is not tried, it is booked", async () => {
  __resetSettlementClaims();
  const p = payment({ validBefore: Math.floor(Date.now() / 1000) + 8 }); const relayer = makeRelayer("settles", p);
  const t0 = Date.now();
  const { recovered, ctx } = await settleFails({ p, error: ambiguous5xx(), outage: outageWith(relayer, 8000) });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `the wait follows the authorization's window, not the 8 s default (${elapsed} ms)`);
  assert.equal(recovered, null);
  assert.equal(relayer.sends, 0);
  assert.equal(ctx.__a402LateAuth?.nonce, p.nonce);
});

await check("used, with our transfer SHORT of the price -> 402, not served, nobody else asked", async () => {
  __resetSettlementClaims();
  const p = payment(); const relayer = makeRelayer("settles", p);
  land({ payer: p.payer, nonce: p.nonce, value: 1000n });
  const { recovered, asked } = await settleFails({ p, error: ambiguous5xx(), outage: outageWith(relayer), listed: [{ name: "listed", answer: () => ({ success: true, transaction: txh("never") }) }] });
  assert.equal(recovered, null, "a short transfer is not this payment");
  assert.equal(relayer.sends, 0);
  assert.deepEqual(asked, []);
});

await check("used, signed to and paid to another address while the price names our treasury -> 402, not served", async () => {
  __resetSettlementClaims();
  const p = payment({ authTo: OTHER }); const relayer = makeRelayer("settles", p);
  assert.equal(p.requirements.payTo, TREASURY);
  land({ payer: p.payer, nonce: p.nonce, to: OTHER });
  const { recovered, asked, ctx } = await settleFails({ p, error: ambiguous5xx(), outage: outageWith(relayer), listed: [{ name: "listed", answer: () => ({ success: true, transaction: txh("never2") }) }] });
  assert.equal(recovered, null, "only a transfer to our treasury proves our payment");
  assert.equal(relayer.sends, 0);
  assert.deepEqual(asked, []);
  assert.equal(ctx.__a402LateAuth, undefined);
});

await check("a listed fallback's ambiguous failure (after the primary reverted) is read on chain too", async () => {
  __resetSettlementClaims();
  const p = payment(); const relayer = makeRelayer("settles", p);
  const reverted = new SettleError(500, { success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: 'The contract function "transferWithAuthorization" reverted.', transaction: "", network: RH });
  const { recovered, asked } = await settleFails({ p, error: reverted, outage: outageWith(relayer, 150), listed: [{ name: "listed", answer: () => { throw timeoutErr(); } }] });
  assert.deepEqual(asked, ["listed"]);
  assert.ok(recovered?.result?.success, "served by our relayer after the listed fallback's timeout");
  assert.equal(relayer.sends, 1);
});

await check("used, its transaction's receipt not readable yet -> 402, the authorization booked and its claim kept (never read as a revert)", async () => {
  __resetSettlementClaims();
  const p = payment(); const relayer = makeRelayer("settles", p);
  const tx = land({ payer: p.payer, nonce: p.nonce, tx: txh(`lag-${p.nonce}`) });
  chain.hiddenReceipts.add(tx.toLowerCase());
  let r;
  try { r = await settleFails({ p, error: ambiguous5xx(), outage: outageWith(relayer) }); } finally { chain.hiddenReceipts.delete(tx.toLowerCase()); }
  assert.equal(r.recovered, null);
  assert.equal(relayer.sends, 0);
  assert.equal(r.ctx.__a402LateAuth?.nonce, p.nonce, "booked by authorization");
  assert.equal(namesUnsettledTx(r.ctx), true, "the authorization stays claimed");
});

await check("the late book never closes a used authorization as not landed, even when its receipt cannot be read", async () => {
  const p = payment({ validBefore: Math.floor(Date.now() / 1000) - 10 });
  const tx = land({ payer: p.payer, nonce: p.nonce, tx: txh(`lagbook-${p.nonce}`) });
  chain.hiddenReceipts.add(tx.toLowerCase());
  const booked = await book.book({ network: RH, nonce: p.nonce, payer: p.payer, payTo: TREASURY, asset: TOKEN, amount: "2500", resource: "https://agent402.tools/api/x", validBefore: p.paymentPayload.payload.authorization.validBefore });
  assert.equal(booked, true);
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 3600_000;
  try {
    await book.refresh();
    for (const e of book.list()) e.nextCheckAt = 0;
    await book.reconcile();
    await book.refresh();
    assert.ok(book.list().some((e) => e.nonce === p.nonce.toLowerCase()), "kept past the window: the authorization was used");
  } finally { Date.now = realNow; chain.hiddenReceipts.delete(tx.toLowerCase()); }
});

await check("the buyer left holding a forgiveness ticket -> our relayer is not used, the authorization is booked", async () => {
  __resetSettlementClaims();
  const p = payment(); const relayer = makeRelayer("settles", p);
  const { recovered, ctx } = await settleFails({ p, error: ambiguous5xx(), outage: outageWith(relayer, 100, { clientGone: () => true }), req: {} });
  assert.equal(recovered, null);
  assert.equal(relayer.sends, 0, "no money moved for a buyer who left");
  assert.equal(ctx.__a402LateAuth?.nonce, p.nonce);
});

await check("a CDN answer window shorter than our relayer's worst case -> relayer skipped, the authorization booked", async () => {
  __resetSettlementClaims();
  const p = payment(); const relayer = makeRelayer("settles", p);
  const req = { cdnSyncDeadlineMs: Date.now() + 20_000 };
  const { recovered, ctx } = await settleFails({ p, error: ambiguous5xx(), outage: outageWith(relayer, 100, { relayerWorstMs: 45_000 }), req });
  assert.equal(recovered, null);
  assert.equal(relayer.sends, 0);
  assert.equal(ctx.__a402LateAuth?.nonce, p.nonce);
  // A window that covers the worst case lets the relayer settle.
  __resetSettlementClaims();
  const p2 = payment(); const relayer2 = makeRelayer("settles", p2);
  const ok2 = await settleFails({ p: p2, error: ambiguous5xx(), outage: outageWith(relayer2, 100, { relayerWorstMs: 45_000 }), req: { cdnSyncDeadlineMs: Date.now() + 80_000 } });
  assert.ok(ok2.recovered?.result?.success, "served when the window is wide enough");
  assert.equal(relayer2.sends, 1);
});

rmSync(dir, { recursive: true, force: true });
console.log(`test-rh-outage: ${failures ? `FAILED (${failures})` : "all passed"}`);
process.exit(failures ? 1 : 0);

#!/usr/bin/env node
// Our own Robinhood relayer (src/robinhood-relayer.js): the last settle
// fallback on eip155:4663, for our own sales only.
//
// Offline: a stub JSON-RPC chain on port 0 holds the USDG token's state
// (balances, used authorization nonces, the relayer's nonce and balance) and
// checks every signature the way the token does. Buyers and the relayer use
// throwaway keys generated here; nothing is ever sent to a real chain.
//
// Pins: verify refuses another recipient, a wrong amount, a used nonce and an
// expired window; settle submits once and answers the mined tx; two replicas
// (two module instances sharing one lease) never sign the same nonce; a send
// that is never mined answers pending WITH its hash, which stops the chain;
// the chain order is the listed facilitators, then ours; the gas check reads
// our relayer; and a paid server with the key set settles a Robinhood payment
// through it after the primary reverts, while one without the key does not.

import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAbi, decodeFunctionData, encodeFunctionResult, encodeAbiParameters, parseTransaction, recoverTypedDataAddress,
  serializeSignature, keccak256, getAddress, isAddressEqual, pad, toHex, encodeEventTopics,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SettleError } from "@x402/core/types";
import { getFreePorts } from "./lib/free-port.js";

const RH = "eip155:4663";
const CHAIN_ID = 4663;
const TOKEN = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");
const TREASURY = getAddress("0x000000000000000000000000000000000000dEaD");
const OTHER = getAddress("0x00000000000000000000000000000000000bEEF1");
const DOMAIN = { name: "Global Dollar", version: "1", chainId: CHAIN_ID, verifyingContract: TOKEN };
const AUTH_TYPES = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] };
const TOKEN_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function balanceOf(address account) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const MULTI_ABI = parseAbi(["function tryAggregate(bool requireSuccess, (address target, bytes callData)[] calls) returns ((bool success, bytes returnData)[])"]);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e?.stack?.split("\n").slice(0, 3).join("\n       ") || e}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the stub chain
function stubChain() {
  const st = {
    balances: new Map(), used: new Set(), nonces: new Map(), ethBalance: new Map(), receipts: new Map(),
    gasPrice: 20_000_000n, block: 100n, sendDelayMs: 0, neverMine: false, sends: [], refusedSends: 0,
    // Every eth_sendRawTransaction that reached the node, taken or not.
    sendAttempts: 0,
    // The node takes the transaction, then the connection drops before it answers.
    resetAfterAccept: false,
  };
  const lc = (a) => String(a).toLowerCase();
  const bal = (a) => st.balances.get(lc(a)) || 0n;
  async function transferCheck(args, at) {
    const [from, to, value, validAfter, validBefore, nonce, ...sig] = args;
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (st.used.has(`${lc(from)}|${nonce}`)) return "FiatTokenV2: authorization is used or canceled";
    if (now <= validAfter) return "FiatTokenV2: authorization is not yet valid";
    if (now >= validBefore) return "FiatTokenV2: authorization is expired";
    const signature = sig.length === 3 ? serializeSignature({ v: BigInt(sig[0]), r: sig[1], s: sig[2] }) : sig[0];
    const who = await recoverTypedDataAddress({ domain: DOMAIN, types: AUTH_TYPES, primaryType: "TransferWithAuthorization", message: { from, to, value, validAfter, validBefore, nonce }, signature }).catch(() => null);
    if (!who || !isAddressEqual(who, from)) return "FiatTokenV2: invalid signature";
    if (bal(from) < value) return "ERC20: transfer amount exceeds balance";
    void at;
    return null;
  }
  async function tokenCall(data) {
    const { functionName, args } = decodeFunctionData({ abi: TOKEN_ABI, data });
    if (functionName === "transferWithAuthorization") {
      const why = await transferCheck(args);
      if (why) return { revert: why };
      return { data: "0x" };
    }
    if (functionName === "balanceOf") return { data: encodeFunctionResult({ abi: TOKEN_ABI, functionName, result: bal(args[0]) }) };
    if (functionName === "authorizationState") return { data: encodeFunctionResult({ abi: TOKEN_ABI, functionName, result: st.used.has(`${lc(args[0])}|${args[1]}`) }) };
    if (functionName === "name") return { data: encodeFunctionResult({ abi: TOKEN_ABI, functionName, result: DOMAIN.name }) };
    if (functionName === "version") return { data: encodeFunctionResult({ abi: TOKEN_ABI, functionName, result: DOMAIN.version }) };
    return { revert: "unknown" };
  }
  const receiptOf = (hash, from, ok, logs) => ({
    transactionHash: hash, blockHash: pad(toHex(st.block), { size: 32 }), blockNumber: toHex(st.block), transactionIndex: "0x0",
    from, to: TOKEN, status: ok ? "0x1" : "0x0", gasUsed: "0x15f90", cumulativeGasUsed: "0x15f90", effectiveGasPrice: toHex(st.gasPrice),
    type: "0x2", contractAddress: null, logsBloom: "0x" + "00".repeat(256),
    logs: logs.map((l, i) => ({ ...l, blockNumber: toHex(st.block), blockHash: pad(toHex(st.block), { size: 32 }), transactionHash: hash, transactionIndex: "0x0", logIndex: toHex(i), removed: false })),
  });
  async function handle(method, params) {
    switch (method) {
      case "eth_chainId": return toHex(CHAIN_ID);
      case "eth_blockNumber": return toHex(st.block);
      case "eth_gasPrice": return toHex(st.gasPrice);
      case "eth_getBalance": return toHex(st.ethBalance.get(lc(params[0])) || 0n);
      case "eth_getTransactionCount": return toHex(st.nonces.get(lc(params[0])) || 0);
      case "eth_estimateGas": return toHex(90_000);
      case "eth_getCode": return isAddressEqual(params[0], TOKEN) || isAddressEqual(params[0], MULTICALL3) ? "0x6080" : "0x";
      case "eth_call": {
        const { to, data } = params[0];
        if (isAddressEqual(to, MULTICALL3)) {
          const { args } = decodeFunctionData({ abi: MULTI_ABI, data });
          const out = [];
          for (const c of args[1]) { const r = await tokenCall(c.callData); out.push({ success: !r.revert, returnData: r.data || "0x" }); }
          return encodeFunctionResult({ abi: MULTI_ABI, functionName: "tryAggregate", result: out });
        }
        const r = await tokenCall(data);
        if (r.revert) throw Object.assign(new Error(`execution reverted: ${r.revert}`), { rpcCode: 3 });
        return r.data;
      }
      case "eth_sendRawTransaction": {
        st.sendAttempts++;
        const raw = params[0];
        const tx = parseTransaction(raw);
        if (tx.maxFeePerGas < st.gasPrice) throw Object.assign(new Error("max fee per gas less than block base fee"), { rpcCode: -32000 });
        const hash = keccak256(raw);
        const from = await import("viem").then((v) => v.recoverTransactionAddress({ serializedTransaction: raw }));
        const expected = st.nonces.get(lc(from)) || 0;
        if (tx.chainId !== CHAIN_ID) throw Object.assign(new Error("invalid chain id"), { rpcCode: -32000 });
        if (tx.nonce !== expected) { st.refusedSends++; throw Object.assign(new Error(tx.nonce < expected ? "nonce too low" : "nonce too high"), { rpcCode: -32000 }); }
        const gasCost = tx.gas * tx.maxFeePerGas;
        if ((st.ethBalance.get(lc(from)) || 0n) < gasCost) throw Object.assign(new Error("insufficient funds for gas * price + value"), { rpcCode: -32000 });
        st.nonces.set(lc(from), expected + 1);
        st.sends.push({ hash, nonce: tx.nonce, from });
        if (st.sendDelayMs) await sleep(st.sendDelayMs);
        if (st.neverMine) return hash;
        st.block++;
        const { args } = decodeFunctionData({ abi: TOKEN_ABI, data: tx.data });
        const why = await transferCheck(args);
        st.ethBalance.set(lc(from), (st.ethBalance.get(lc(from)) || 0n) - 90_000n * st.gasPrice);
        if (why) { st.receipts.set(hash, receiptOf(hash, from, false, [])); return hash; }
        const [aFrom, aTo, value, , , nonce] = args;
        st.used.add(`${lc(aFrom)}|${nonce}`);
        st.balances.set(lc(aFrom), bal(aFrom) - value);
        st.balances.set(lc(aTo), bal(aTo) + value);
        const topics = encodeEventTopics({ abi: TOKEN_ABI, eventName: "Transfer", args: { from: aFrom, to: aTo } });
        st.receipts.set(hash, receiptOf(hash, from, true, [{ address: TOKEN, topics, data: encodeAbiParameters([{ type: "uint256" }], [value]) }]));
        return hash;
      }
      case "eth_getTransactionReceipt": return st.receipts.get(params[0]) || null;
      case "eth_getTransactionByHash": return null;
      default: throw Object.assign(new Error(`method ${method} not stubbed`), { rpcCode: -32601 });
    }
  }
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", async () => {
      let body;
      try { body = JSON.parse(b); } catch { res.writeHead(400).end(); return; }
      const one = async (m) => {
        try { return { jsonrpc: "2.0", id: m.id, result: await handle(m.method, m.params || []) }; }
        catch (e) { return { jsonrpc: "2.0", id: m.id, error: { code: e.rpcCode ?? -32603, message: e.message, ...(e.rpcCode === 3 ? { data: "0x" } : {}) } }; }
      };
      const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
      if (st.resetAfterAccept && !Array.isArray(body) && body.method === "eth_sendRawTransaction" && out.result) { req.socket.destroy(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  return { st, server };
}

// ---------------------------------------------------------------- helpers
async function signedPayment(buyer, { to = TREASURY, value = 5000n, validAfter = 0n, validBefore = BigInt(Math.floor(Date.now() / 1000) + 300), nonce = keccak256(toHex(`${Math.random()}`)) } = {}) {
  const message = { from: buyer.address, to, value, validAfter, validBefore, nonce };
  const signature = await buyer.signTypedData({ domain: DOMAIN, types: AUTH_TYPES, primaryType: "TransferWithAuthorization", message });
  const requirements = { scheme: "exact", network: RH, asset: TOKEN, amount: String(5000n), payTo: TREASURY, maxTimeoutSeconds: 300, extra: { name: DOMAIN.name, version: DOMAIN.version } };
  const payload = { x402Version: 2, accepted: requirements, payload: { signature, authorization: { from: buyer.address, to, value: String(value), validAfter: String(validAfter), validBefore: String(validBefore), nonce } } };
  return { payload, requirements };
}
// One lease row shared by every "replica" in this process, as the state
// database's leases table would be.
function sharedLease() {
  const rows = new Map();
  let acquires = 0;
  return {
    get acquires() { return acquires; },
    withLease: async (name, _opts, fn) => {
      if (rows.has(name)) return { ran: false, reason: "held" };
      rows.set(name, true);
      acquires++;
      try { return { ran: true, result: await fn({ stillHeld: () => true, signal: new AbortController().signal }) }; }
      finally { rows.delete(name); }
    },
  };
}

console.log("own Robinhood relayer");
const { st, server } = stubChain();
const [rpcPort] = await getFreePorts(1);
await new Promise((r) => server.listen(rpcPort, "127.0.0.1", r));
const RPC = `http://127.0.0.1:${rpcPort}`;
const relayerKey = generatePrivateKey();
const relayer = privateKeyToAccount(relayerKey);
st.ethBalance.set(relayer.address.toLowerCase(), 10n ** 16n);
const buyer = privateKeyToAccount(generatePrivateKey());
st.balances.set(buyer.address.toLowerCase(), 1_000_000n);

const relayerA = await import("../src/robinhood-relayer.js?replica=a");
const relayerB = await import("../src/robinhood-relayer.js?replica=b");
const lease = sharedLease();
const settings = { maxFeeGwei: 5, gasLimitCap: 200_000, receiptTimeoutMs: 3_000, lockWaitMs: 10_000 };
const mk = (mod, extra = {}) => mod.createOwnRelayerClient({ key: relayerKey, network: RH, asset: TOKEN, payTo: TREASURY, rpcUrl: RPC, settings, leaseImpl: lease.withLease, log: () => {}, ...extra });
const A = mk(relayerA);
const B = mk(relayerB);

await check("the client settles eip155:4663 only and names our relayer's address", () => {
  assert.throws(() => relayerA.createOwnRelayerClient({ key: relayerKey, network: "eip155:8453", asset: TOKEN, payTo: TREASURY, rpcUrl: RPC }), /4663 only/);
  assert.equal(A.address, relayer.address);
});

await check("verify refuses another recipient, a wrong amount, a used nonce and an expired window", async () => {
  const toOther = await signedPayment(buyer, { to: OTHER });
  assert.equal((await A.verify(toOther.payload, toOther.requirements)).isValid, false, "authorization to someone else");
  const ok = await signedPayment(buyer);
  assert.equal((await A.verify(ok.payload, { ...ok.requirements, payTo: OTHER })).isValid, false, "requirements naming another payTo");
  const wrongAmount = await signedPayment(buyer, { value: 4999n });
  assert.equal((await A.verify(wrongAmount.payload, wrongAmount.requirements)).isValid, false, "amount");
  const expired = await signedPayment(buyer, { validBefore: BigInt(Math.floor(Date.now() / 1000) - 5) });
  assert.equal((await A.verify(expired.payload, expired.requirements)).isValid, false, "window");
  const used = await signedPayment(buyer);
  st.used.add(`${buyer.address.toLowerCase()}|${used.payload.payload.authorization.nonce}`);
  const v = await A.verify(used.payload, used.requirements);
  assert.equal(v.isValid, false, "used nonce");
  assert.match(String(v.invalidReason), /nonce|used/i);
  assert.equal((await A.verify(ok.payload, ok.requirements)).isValid, true, "control: a good payment verifies");
  assert.equal(st.sends.length, 0, "verify sends nothing");
});

await check("settle refuses another network, token or recipient before any chain call", async () => {
  const p = await signedPayment(buyer);
  for (const req of [{ ...p.requirements, network: "eip155:8453" }, { ...p.requirements, asset: OTHER }, { ...p.requirements, payTo: OTHER }]) {
    const r = await A.settle(p.payload, req);
    assert.equal(r.success, false);
    assert.equal(r.errorReason, "own_relayer_refused");
    assert.equal(r.transaction, "");
  }
  assert.equal(st.sends.length, 0);
});

await check("settle submits once and answers the mined transaction; the buyer pays our treasury", async () => {
  const before = st.balances.get(TREASURY.toLowerCase()) || 0n;
  const p = await signedPayment(buyer);
  const r = await A.settle(p.payload, p.requirements);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.match(r.transaction, /^0x[0-9a-f]{64}$/);
  assert.equal(st.sends.length, 1);
  assert.equal(st.sends[0].hash, r.transaction);
  assert.equal((st.balances.get(TREASURY.toLowerCase()) || 0n) - before, 5000n);
  const again = await A.settle(p.payload, p.requirements);
  assert.equal(again.success, false, "the same authorization never settles twice");
  assert.equal(st.sends.length, 1, "a replay is refused before sending");
});

await check("two replicas settling at once never sign the same nonce (one lease per relayer key)", async () => {
  st.sendDelayMs = 300;
  const sendsBefore = st.sends.length, refusedBefore = st.refusedSends, acquiresBefore = lease.acquires;
  try {
    const [p1, p2, p3] = await Promise.all([signedPayment(buyer), signedPayment(buyer), signedPayment(buyer)]);
    const out = await Promise.all([A.settle(p1.payload, p1.requirements), B.settle(p2.payload, p2.requirements), A.settle(p3.payload, p3.requirements)]);
    assert.deepEqual(out.map((r) => r.success), [true, true, true], JSON.stringify(out.map((r) => r.errorReason || r.errorMessage)));
    const nonces = st.sends.slice(sendsBefore).map((s) => s.nonce);
    assert.equal(new Set(nonces).size, 3, `distinct nonces (${nonces})`);
    assert.equal(st.refusedSends, refusedBefore, "no send was refused for its nonce");
    assert.equal(lease.acquires - acquiresBefore, 3, "each submission held the shared lease");
  } finally { st.sendDelayMs = 0; }
});

await check("a send that is never mined answers pending WITH its hash, so the fallback chain stops", async () => {
  st.neverMine = true;
  try {
    const p = await signedPayment(buyer);
    const r = await A.settle(p.payload, p.requirements);
    assert.equal(r.success, false);
    assert.match(String(r.transaction), /^0x[0-9a-f]{64}$/, "the result carries the hash");
    const { isRetryableSettleRefusal } = await import("../src/payments.js");
    const refusal = Object.assign(new Error(String(r.errorMessage || r.errorReason)), { errorReason: r.errorReason, errorMessage: r.errorMessage, transaction: r.transaction });
    assert.equal(isRetryableSettleRefusal(refusal, RH), false, "possibly on-chain: nobody after it");
  } finally { st.neverMine = false; }
});

await check("an empty relayer refuses before signing", async () => {
  const C = mk(relayerA);
  const saved = st.ethBalance.get(relayer.address.toLowerCase());
  st.ethBalance.set(relayer.address.toLowerCase(), 1n);
  const sends = st.sends.length, attempts = st.sendAttempts;
  try {
    const p = await signedPayment(buyer);
    const r = await C.settle(p.payload, p.requirements);
    assert.equal(r.success, false);
    assert.equal(r.transaction, "");
    assert.equal(st.sends.length, sends);
    assert.equal(st.sendAttempts, attempts, "nothing was signed or sent: the balance is checked first");
    assert.match(String(r.errorMessage), /balance/i);
  } finally { st.ethBalance.set(relayer.address.toLowerCase(), saved); }
});

await check("a gas price over the cap refuses before signing", async () => {
  const saved = st.gasPrice;
  st.gasPrice = BigInt(settings.maxFeeGwei + 1) * 1_000_000_000n;
  const attempts = st.sendAttempts;
  try {
    const p = await signedPayment(buyer);
    const r = await A.settle(p.payload, p.requirements);
    assert.equal(r.success, false);
    assert.equal(r.transaction, "");
    assert.equal(st.sendAttempts, attempts, "nothing was sent at a fee the cap does not allow");
    assert.match(String(r.errorMessage), /over the relayer cap/);
  } finally { st.gasPrice = saved; }
});

await check("with the state database down the lease refuses and nothing is sent (never fails open)", async () => {
  // The real withLease answers { ran: false, reason: "db" } on a database
  // error unless the caller opted into failOpen, when it runs anyway.
  const dbDown = async (_name, opts, fn) => (opts?.failOpen ? { ran: true, reason: "db-failopen", result: await fn({ stillHeld: () => true, signal: new AbortController().signal }) } : { ran: false, reason: "db" });
  const D = mk(relayerA, { leaseImpl: dbDown });
  const attempts = st.sendAttempts;
  const p = await signedPayment(buyer);
  const r = await D.settle(p.payload, p.requirements);
  assert.equal(r.success, false);
  assert.equal(r.transaction, "");
  assert.equal(st.sendAttempts, attempts);
  assert.match(String(r.errorMessage), /relayer lock not available \(db\)/);
});

await check("a send the node took but whose answer was lost still answers its hash", async () => {
  st.resetAfterAccept = true;
  const sends = st.sends.length;
  try {
    const p = await signedPayment(buyer);
    const r = await A.settle(p.payload, p.requirements);
    assert.equal(st.sends.length, sends + 1, "the node took it");
    assert.equal(r.transaction, st.sends.at(-1).hash, "the result names the transaction that was sent");
    assert.equal(r.success, true, "and it mined, so it settled");
  } finally { st.resetAfterAccept = false; }
});

await check("post-broadcast: the receipt wait runs out, the result carries the hash, nobody is asked after it", async () => {
  const { registerFacilitatorFailureHooks } = await import("../src/payments.js");
  const prev = process.env.PAYMENT_SETTLE_FALLBACK;
  process.env.PAYMENT_SETTLE_FALLBACK = "true";
  st.neverMine = true;
  st.resetAfterAccept = true; // and the send's own answer was lost too
  try {
    const REVERTED = 'The contract function "transferWithAuthorization" reverted.';
    const hooks = {};
    const s = { onVerifyFailure(fn) { hooks.vf = fn; return this; }, onAfterSettle(fn) { hooks.as = fn; return this; }, onSettleFailure(fn) { hooks.sf = fn; return this; } };
    const asked = [];
    let ownResult = null;
    const own = { name: "own relayer", revertRetry: true, client: { settle: async (pp, rq) => { asked.push("own"); ownResult = await A.settle(pp, rq); return ownResult; } } };
    const tail = { name: "default", client: { settle: async () => { asked.push("default"); return { success: true, transaction: "0x" + "22".repeat(32) }; } } };
    registerFacilitatorFailureHooks(s, null, null, { [RH]: () => [own, tail] });
    const sends = st.sends.length;
    const p = await signedPayment(buyer);
    const r = await hooks.sf({ requirements: p.requirements, paymentPayload: p.payload, error: new SettleError(500, { success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: REVERTED, transaction: "", network: RH }) });
    assert.equal(r, undefined, "not recovered: the buyer is not told it settled");
    assert.equal(st.sends.length, sends + 1, "one transaction went out");
    assert.equal(ownResult?.success, false);
    assert.equal(ownResult?.transaction, st.sends.at(-1).hash, "the pending result carries that transaction's hash");
    assert.deepEqual(asked, ["own"], "nobody after a send that may land");
  } finally {
    st.neverMine = false;
    st.resetAfterAccept = false;
    if (prev === undefined) delete process.env.PAYMENT_SETTLE_FALLBACK; else process.env.PAYMENT_SETTLE_FALLBACK = prev;
  }
});

await check("chain order: the listed facilitators first, our relayer after them, then the default chain", async () => {
  const { registerFacilitatorFailureHooks } = await import("../src/payments.js");
  const prev = process.env.PAYMENT_SETTLE_FALLBACK;
  process.env.PAYMENT_SETTLE_FALLBACK = "true";
  try {
    const REVERTED = 'The contract function "transferWithAuthorization" reverted.';
    const revertErr = () => new SettleError(500, { success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: REVERTED, transaction: "", network: RH });
    const hooks = {};
    const s = { onVerifyFailure(fn) { hooks.vf = fn; return this; }, onAfterSettle(fn) { hooks.as = fn; return this; }, onSettleFailure(fn) { hooks.sf = fn; return this; } };
    const asked = [];
    const listed = { name: "listed", revertRetry: true, client: { settle: async () => { asked.push("listed"); return { success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: REVERTED, transaction: "" }; } } };
    const own = { name: "own relayer", revertRetry: true, client: { settle: async (pp, rq) => { asked.push("own"); return A.settle(pp, rq); } } };
    const tail = { name: "default", client: { settle: async () => { asked.push("default"); return { success: true, transaction: "0x" + "11".repeat(32) }; } } };
    registerFacilitatorFailureHooks(s, null, null, { [RH]: () => [listed, own, tail] });
    const p = await signedPayment(buyer);
    const r = await hooks.sf({ requirements: p.requirements, paymentPayload: p.payload, error: revertErr() });
    assert.equal(r?.recovered, true);
    assert.deepEqual(asked, ["listed", "own"], "ours after the listed one, and nothing after a settle");
    assert.match(r.result.transaction, /^0x[0-9a-f]{64}$/);
  } finally {
    if (prev === undefined) delete process.env.PAYMENT_SETTLE_FALLBACK; else process.env.PAYMENT_SETTLE_FALLBACK = prev;
  }
});

await check("the gas check reads our relayer as a facilitator of its own", async () => {
  const { createRelayerGasCheck } = await import("../src/facilitator-gas.js");
  const g = createRelayerGasCheck({ urls: [], network: RH, rpcUrl: RPC, settings: { minRunway: 500, gasPerSettlement: 100_000, failAfter: 3, intervalMs: 60_000 }, ownSigners: [{ label: "own relayer", signer: relayer.address }], log: () => {} });
  const full = await g.check();
  assert.equal(full.length, 1);
  assert.equal(full[0].facilitator, "own relayer");
  assert.equal(full[0].signer, relayer.address);
  assert.equal(full[0].status, "ok");
  const saved = st.ethBalance.get(relayer.address.toLowerCase());
  st.ethBalance.set(relayer.address.toLowerCase(), 100_000n * st.gasPrice * 10n);
  try {
    const low = await g.check();
    assert.equal(low[0].status, "low", "ten settlements left reads low");
  } finally { st.ethBalance.set(relayer.address.toLowerCase(), saved); }
});

// ---------------------------------------------------------------- paid-mode boot
// The caller path: a paid server whose one listed Robinhood facilitator
// reverts every settle. With ROBINHOOD_RELAYER_KEY the payment settles
// through our relayer and the buyer gets 200; without it the buyer gets 402
// and our relayer sends nothing, as before.
async function bootAndPay({ withKey }) {
  const [PORT, BASE_FAC, RH1] = await getFreePorts(3);
  const json = (res, s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const stub = (h) => createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { let body = {}; try { body = JSON.parse(b || "{}"); } catch { /* empty */ } h(req, res, body); }); });
  const rhAsked = { settle: 0 };
  const servers = [
    [stub((q, r) => q.url === "/supported" ? json(r, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }) : q.url === "/rpc" ? json(r, 200, { jsonrpc: "2.0", id: 1, result: "0x0" }) : json(r, 404, {})), BASE_FAC],
    [stub((q, r, b) => {
      if (q.url === "/supported") return json(r, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: RH }], extensions: [], signers: {} });
      if (q.url === "/verify") return json(r, 200, { isValid: true, payer: b?.paymentPayload?.payload?.authorization?.from });
      if (q.url === "/settle") { rhAsked.settle++; return json(r, 200, { success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: 'The contract function "transferWithAuthorization" reverted.', transaction: "", network: RH }); }
      return json(r, 404, {});
    }), RH1],
  ];
  await Promise.all(servers.map(([srv, p]) => new Promise((r) => srv.listen(p, "127.0.0.1", r))));
  const tmp = mkdtempSync(join(tmpdir(), "a402-ownrelayer-"));
  const env = { ...process.env };
  for (const k of ["STATE_DATABASE_URL", "REDIS_URL", "SOLVADOR_KEY", "ROBINHOOD_RELAYER_KEY"]) delete env[k];
  const proc = spawn(process.execPath, ["src/server.js"], { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"], env: { ...env, PORT: String(PORT), FREE_MODE: "",
    WALLET_ADDRESS: TREASURY, NETWORK: "base", FACILITATOR_URL: `http://127.0.0.1:${BASE_FAC}`, AGENT402_BASE_RPC: `http://127.0.0.1:${BASE_FAC}/rpc`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", MPP_SECRET_KEY: "", PAYMENT_NETWORKS: "base,robinhood",
    ROBINHOOD_FACILITATOR_URL: `http://127.0.0.1:${RH1}`, EVM_RPC_4663: RPC, ...(withKey ? { ROBINHOOD_RELAYER_KEY: relayerKey } : {}),
    PAYMENT_SETTLE_FALLBACK: "true", SALES_LEDGER_DB: join(tmp, "sales.db"), REFUND_DB_DIR: tmp, FACILITATOR_GAS_CHECK: "off",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" } });
  const log = [];
  proc.stdout.on("data", (c) => log.push(String(c)));
  proc.stderr.on("data", (c) => log.push(String(c)));
  try {
    const B = `http://127.0.0.1:${PORT}`, PATH = "/api/demand-radar?limit=1";
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch { /* booting */ } if (!up) await sleep(500); }
    assert.ok(up, "server booted");
    const r402 = await fetch(`${B}${PATH}`);
    const accepted = JSON.parse(Buffer.from(r402.headers.get("payment-required"), "base64").toString()).accepts.find((a) => a.network === RH);
    assert.ok(accepted, "USDG on 4663 is offered");
    const message = { from: buyer.address, to: getAddress(accepted.payTo), value: BigInt(accepted.amount), validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: keccak256(toHex(`boot-${withKey}-${Date.now()}`)) };
    const signature = await buyer.signTypedData({ domain: { name: accepted.extra.name, version: accepted.extra.version, chainId: CHAIN_ID, verifyingContract: getAddress(accepted.asset) }, types: AUTH_TYPES, primaryType: "TransferWithAuthorization", message });
    const cred = Buffer.from(JSON.stringify({ x402Version: 2, resource: accepted.resource, accepted, payload: { signature, authorization: { from: message.from, to: message.to, value: String(message.value), validAfter: "0", validBefore: String(message.validBefore), nonce: message.nonce } } })).toString("base64");
    const sends = st.sends.length;
    const paid = await fetch(`${B}${PATH}`, { headers: { "payment-signature": cred } });
    await paid.text();
    return { status: paid.status, ownSends: st.sends.length - sends, primarySettles: rhAsked.settle, log: log.join("") };
  } finally {
    proc.kill("SIGKILL");
    for (const [srv] of servers) srv.close();
  }
}

await check("paid server WITH the key: the primary reverts, our relayer settles once, the buyer gets 200", async () => {
  const r = await bootAndPay({ withKey: true });
  assert.ok(/own relayer 0x[0-9a-fA-F]{40} enabled/.test(r.log), "boot names the relayer by address");
  assert.ok(!r.log.includes(relayerKey.slice(2)), "the key never reaches the log");
  assert.equal(r.primarySettles, 1);
  assert.equal(r.ownSends, 1, r.log.slice(-1500));
  assert.equal(r.status, 200, r.log.slice(-1500));
});

await check("paid server WITHOUT the key: one URL behaves as before (402, our relayer sends nothing)", async () => {
  const r = await bootAndPay({ withKey: false });
  assert.ok(!/own relayer/.test(r.log));
  assert.equal(r.primarySettles, 1);
  assert.equal(r.ownSends, 0);
  assert.equal(r.status, 402);
});

server.close();
console.log(failures ? `\ntest-own-relayer: FAILED (${failures})` : "\ntest-own-relayer: all passed");
process.exit(failures ? 1 : 0);

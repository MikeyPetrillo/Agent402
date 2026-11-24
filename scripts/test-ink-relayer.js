#!/usr/bin/env node
// Our own Ink relayer (src/robinhood-relayer.js on eip155:57073, key
// INK_RELAYER_KEY): the LAST settle fallback on Ink, after every listed
// facilitator (INK_FACILITATOR_URL), for our own sales only.
//
// Offline: a stub JSON-RPC chain on port 0 (scripts/lib/stub-eip3009-chain.js)
// holds Ink USDC's state and checks every signature under its EIP-712 domain
// ("USDC" v2 on chain 57073). Buyers and the relayer use throwaway keys made
// here; nothing is ever sent to a real chain.
//
// Pins: the client settles Ink with its own lease, caps and minimum; the
// order is listed first, ours last, and ours is reached only by a refusal
// that moved nothing (pre-broadcast, a reverted transfer, a known nothing-sent
// node refusal), never by an ambiguous answer, a passed-on refusal, a buyer
// verdict, a used authorization or a compliance refusal; a sale under the
// minimum and a listed payer (EIP-3009 or Permit2) are refused with nothing
// sent, and the screen's refusal is final; our own nothing-sent refusal leaves
// the primary's refusal standing (not unconfirmed); the gas check reads our
// relayer and the coverage rule follows the Ink minimum; the key is Ink's own
// (the Robinhood key is refused); and a paid server settles an Ink payment
// through it after the listed facilitator reverts, while one without the key
// does not.
//   node scripts/test-ink-relayer.js

import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, getAddress, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SettleError } from "@x402/core/types";
import { bootServer } from "./lib/boot-server.js";
import { stubEip3009Chain, AUTH_TYPES, STUB_OTHER as OTHER } from "./lib/stub-eip3009-chain.js";

const INK = "eip155:57073";
const CHAIN_ID = 57073;
const TOKEN = getAddress("0x2D270e6886d130D724215A266106e6832161EAEd");
const TREASURY = getAddress("0x000000000000000000000000000000000000dEaD");
const DOMAIN = { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: TOKEN };
const REVERTED = 'The contract function "transferWithAuthorization" reverted.';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e?.stack?.split("\n").slice(0, 3).join("\n       ") || e}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withEnv = async (vars, fn) => {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

async function signedPayment(buyer, { to = TREASURY, value = 5000n, validAfter = 0n, validBefore = BigInt(Math.floor(Date.now() / 1000) + 300), nonce = keccak256(toHex(`${Math.random()}`)), permit2From = null } = {}) {
  const message = { from: buyer.address, to, value, validAfter, validBefore, nonce };
  const signature = await buyer.signTypedData({ domain: DOMAIN, types: AUTH_TYPES, primaryType: "TransferWithAuthorization", message });
  const requirements = { scheme: "exact", network: INK, asset: TOKEN, amount: String(5000n), payTo: TREASURY, maxTimeoutSeconds: 300, extra: { name: DOMAIN.name, version: DOMAIN.version } };
  const inner = { signature, authorization: { from: buyer.address, to, value: String(value), validAfter: String(validAfter), validBefore: String(validBefore), nonce } };
  if (permit2From) inner.permit2Authorization = { from: permit2From };
  return { payload: { x402Version: 2, accepted: requirements, payload: inner }, requirements };
}
function sharedLease() {
  const rows = new Map();
  const names = [];
  return {
    names,
    withLease: async (name, _opts, fn) => {
      names.push(name);
      if (rows.has(name)) return { ran: false, reason: "held" };
      rows.set(name, true);
      try { return { ran: true, result: await fn({ stillHeld: () => true, signal: new AbortController().signal }) }; }
      finally { rows.delete(name); }
    },
  };
}
// A settle-failure hook registered with `chain` as Ink's fallback list.
function hookWith(chain) {
  const hooks = {};
  const s = { onVerifyFailure(fn) { hooks.vf = fn; return this; }, onAfterSettle(fn) { hooks.as = fn; return this; }, onSettleFailure(fn) { hooks.sf = fn; return this; } };
  return { hooks, s, chain };
}

console.log("own Ink relayer");
const { st, server } = stubEip3009Chain({ chainId: CHAIN_ID, token: TOKEN, domain: DOMAIN });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const RPC = `http://127.0.0.1:${server.address().port}`;
const relayerKey = generatePrivateKey();
const relayer = privateKeyToAccount(relayerKey);
st.ethBalance.set(relayer.address.toLowerCase(), 10n ** 16n);
const buyer = privateKeyToAccount(generatePrivateKey());
st.balances.set(buyer.address.toLowerCase(), 10_000_000n);
const LISTED_PAYER = privateKeyToAccount(generatePrivateKey());
st.balances.set(LISTED_PAYER.address.toLowerCase(), 1_000_000n);
const PERMIT2_LISTED = getAddress("0x00000000000000000000000000000000000Bad02");
const screen = async (a) => (a && [LISTED_PAYER.address, PERMIT2_LISTED].some((x) => x.toLowerCase() === String(a).toLowerCase()) ? "listed" : "clear");

const mod = await import("../src/robinhood-relayer.js");
const lease = sharedLease();
const settings = { maxFeeGwei: 5, gasLimitCap: 200_000, receiptTimeoutMs: 3_000, lockWaitMs: 10_000 };
const mk = (extra = {}) => mod.createOwnRelayerClient({ key: relayerKey, network: INK, asset: TOKEN, payTo: TREASURY, rpcUrl: RPC, settings, leaseImpl: lease.withLease, log: () => {}, screen, ...extra });
const A = mk();
const { registerFacilitatorFailureHooks, markGracefulRefusals, inkRelayerKeySafe, ownRelayerCoversLowestPrice } = await import("../src/payments.js");
const { withOwnRefusalMemo } = await import("../src/robinhood-order.js");

await check("the client settles Ink, names our relayer, and refuses any other chain", () => {
  assert.equal(A.address, relayer.address);
  assert.throws(() => mod.createOwnRelayerClient({ key: relayerKey, network: "eip155:8453", asset: TOKEN, payTo: TREASURY, rpcUrl: RPC }), /eip155:4663 or eip155:57073 only/);
  assert.throws(() => mod.createOwnRelayerClient({ key: relayerKey, network: INK, asset: TOKEN, payTo: TREASURY, rpcUrl: "" }), /no RPC for eip155:57073/);
});

await check("Ink reads its own caps and minimum; Robinhood's are untouched", async () => {
  const env = { INK_RELAYER_MAX_GWEI: "0.5", INK_RELAYER_GAS_CAP: "150000", INK_RELAYER_RECEIPT_MS: "9000", INK_RELAYER_LOCK_WAIT_MS: "4000", ROBINHOOD_RELAYER_MAX_GWEI: "7" };
  assert.deepEqual(mod.relayerSettings(env, INK), { maxFeeGwei: 0.5, gasLimitCap: 150_000, receiptTimeoutMs: 9_000, lockWaitMs: 4_000 });
  assert.equal(mod.relayerSettings(env).maxFeeGwei, 7, "the default chain stays Robinhood's");
  assert.equal(mod.relayerSettings({}, INK).maxFeeGwei, 5);
  const { inkRelayerMinPriceUsd, inkRelayerMinUnits, ownRelayerMinPriceUsd, INK_RELAYER_MIN_PRICE_DEFAULT_USD } = await import("../src/network-floors.js");
  assert.equal(inkRelayerMinPriceUsd({}), INK_RELAYER_MIN_PRICE_DEFAULT_USD);
  assert.equal(inkRelayerMinPriceUsd({ INK_RELAYER_MIN_PRICE_USD: "0" }), 0, "0 settles any price");
  assert.equal(inkRelayerMinPriceUsd({ INK_RELAYER_MIN_PRICE_USD: "-1" }), INK_RELAYER_MIN_PRICE_DEFAULT_USD, "a negative value reads the default");
  assert.equal(inkRelayerMinUnits({ INK_RELAYER_MIN_PRICE_USD: "0.006" }), 6000n);
  assert.equal(ownRelayerMinPriceUsd(INK, { INK_RELAYER_MIN_PRICE_USD: "0.002", ROBINHOOD_RELAYER_MIN_PRICE_USD: "0.009" }), 0.002);
  assert.equal(ownRelayerMinPriceUsd("eip155:4663", { INK_RELAYER_MIN_PRICE_USD: "0.002", ROBINHOOD_RELAYER_MIN_PRICE_USD: "0.009" }), 0.009);
  assert.equal(ownRelayerMinPriceUsd("eip155:8453", {}), null);
  await withEnv({ INK_RELAYER_MIN_PRICE_USD: "0.007" }, () => {
    const c = mod.createOwnRelayerClient({ key: relayerKey, network: INK, asset: TOKEN, payTo: TREASURY, rpcUrl: RPC });
    assert.equal(c.minUnits, 7000n, "the client's default minimum is INK_RELAYER_MIN_PRICE_USD");
  });
});

await check("settle submits once under an Ink lease of its own; the buyer pays our treasury; a replay sends nothing", async () => {
  const before = st.balances.get(TREASURY.toLowerCase()) || 0n;
  const p = await signedPayment(buyer);
  const r = await A.settle(p.payload, p.requirements);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(st.sends.length, 1);
  assert.equal(st.sends[0].hash, r.transaction);
  assert.equal((st.balances.get(TREASURY.toLowerCase()) || 0n) - before, 5000n);
  assert.ok(lease.names.length > 0 && lease.names.every((n) => n === `ink-relayer-${relayer.address.toLowerCase()}`), `lease ${lease.names}`);
  const again = await A.settle(p.payload, p.requirements);
  assert.equal(again.success, false);
  assert.equal(st.sends.length, 1, "a used authorization is refused before sending");
});

await check("settle refuses another network, token or recipient with nothing sent", async () => {
  const p = await signedPayment(buyer);
  for (const req of [{ ...p.requirements, network: "eip155:4663" }, { ...p.requirements, asset: OTHER }, { ...p.requirements, payTo: OTHER }]) {
    const r = await A.settle(p.payload, req);
    assert.equal(r.errorReason, "own_relayer_refused");
    assert.equal(r.nothingSent, true);
  }
  assert.equal(st.sends.length, 1);
});

await check("a sale under the Ink minimum is refused before any chain call, naming INK_RELAYER_MIN_PRICE_USD; at the minimum it settles", async () => {
  const low = mk({ minUnits: 6000n });
  const p = await signedPayment(buyer);
  const sends = st.sends.length, attempts = st.sendAttempts;
  const r = await low.settle(p.payload, p.requirements);
  assert.equal(r.errorReason, "own_relayer_below_minimum");
  assert.match(r.errorMessage, /INK_RELAYER_MIN_PRICE_USD/);
  assert.equal(r.nothingSent, true);
  assert.equal(st.sendAttempts, attempts);
  const ok = await mk({ minUnits: 5000n }).settle(p.payload, p.requirements);
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(st.sends.length, sends + 1);
});

await check("a listed payer (EIP-3009 from, or a Permit2 from) is refused with nothing sent; a clean payer settles (control)", async () => {
  const { __resetSettleComplianceForTests, settleComplianceView, OWN_SETTLER_SCREEN_REFUSED } = await import("../src/settle-compliance.js");
  __resetSettleComplianceForTests();
  const attempts = st.sendAttempts;
  const listed = await signedPayment(LISTED_PAYER);
  const r1 = await A.settle(listed.payload, listed.requirements);
  assert.equal(r1.errorReason, OWN_SETTLER_SCREEN_REFUSED);
  assert.equal(r1.nothingSent, true);
  assert.equal(r1.payer, LISTED_PAYER.address);
  const viaPermit2 = await signedPayment(buyer, { permit2From: PERMIT2_LISTED });
  const r2 = await A.settle(viaPermit2.payload, viaPermit2.requirements);
  assert.equal(r2.errorReason, OWN_SETTLER_SCREEN_REFUSED);
  assert.equal(r2.payer, PERMIT2_LISTED);
  assert.equal(st.sendAttempts, attempts, "nothing signed or sent for a listed payer");
  assert.equal(settleComplianceView().byNetwork[INK], 2, "counted on Ink");
  const clean = await signedPayment(buyer);
  assert.equal((await A.settle(clean.payload, clean.requirements)).success, true, "control: a clean payer settles");
});

// ---------------------------------------------------------------- the order
const revertErr = () => new SettleError(200, { success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: REVERTED, transaction: "", network: INK });
async function runChain(primaryErr, { listedAnswer = "revert", own = null, tail = false, beforeHook = null } = {}) {
  return withEnv({ PAYMENT_SETTLE_FALLBACK: "true" }, async () => {
    const asked = [];
    const listed = { name: "Ink fallback (listed)", revertRetry: true, confirmed: true, client: { settle: async () => {
      asked.push("listed");
      if (listedAnswer === "throw502") throw Object.assign(new Error("Facilitator settle failed (502): bad gateway"), { status: 502 });
      return { success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: REVERTED, transaction: "" };
    } } };
    const ownClient = own || withOwnRefusalMemo(mk());
    const ownEntry = { name: "own relayer", revertRetry: true, confirmed: true, own: true, client: { settle: async (pp, rq) => { asked.push("own"); return ownClient.settle(pp, rq); } } };
    const after = { name: "after own", revertRetry: true, client: { settle: async () => { asked.push("after"); return { success: true, transaction: "0x" + "77".repeat(32) }; } } };
    const h = hookWith();
    registerFacilitatorFailureHooks(h.s, null, null, { [INK]: () => [listed, ownEntry, ...(tail ? [after] : [])] });
    const p = await signedPayment(beforeHook?.payer || buyer);
    const ctx = { requirements: p.requirements, paymentPayload: p.payload, error: typeof primaryErr === "function" ? primaryErr() : primaryErr };
    if (beforeHook?.graceful) {
      const primary = markGracefulRefusals({ settle: async () => ({ success: false, errorReason: beforeHook.graceful, transaction: "" }) });
      await primary.settle(p.payload, p.requirements);
    }
    const sends = st.sends.length, attempts = st.sendAttempts;
    const r = await h.hooks.sf(ctx);
    return { r, asked, ctx, ownSends: st.sends.length - sends, ownAttempts: st.sendAttempts - attempts };
  });
}

await check("a reverted primary: the listed fallback first, our relayer last, and nothing after a settle", async () => {
  const o = await runChain(revertErr, { tail: true });
  assert.deepEqual(o.asked, ["listed", "own"]);
  assert.equal(o.r?.recovered, true);
  assert.equal(o.ownSends, 1);
});

await check("a pre-broadcast refusal (HTTP 402) and a known nothing-sent node refusal reach our relayer after the listed one", async () => {
  const pre = await runChain(() => Object.assign(new Error("Facilitator settle failed (402): payment required"), { status: 402 }));
  assert.deepEqual(pre.asked, ["listed", "own"]);
  assert.equal(pre.r?.recovered, true);
  const nodeRefusal = await runChain(() => new SettleError(500, { success: false, errorReason: "unexpected_settle_error", errorMessage: "insufficient funds for gas * price + value", transaction: "", network: INK }));
  assert.deepEqual(nodeRefusal.asked, ["listed", "own"]);
  assert.equal(nodeRefusal.r?.recovered, true);
});

await check("an ambiguous primary failure (502, timeout) asks nobody: no outage read on Ink, our relayer sends nothing", async () => {
  for (const err of [() => Object.assign(new Error("Facilitator settle failed (502): bad gateway"), { status: 502 }), () => Object.assign(new Error("timed out"), { name: "TimeoutError" })]) {
    const o = await runChain(err);
    assert.deepEqual(o.asked, []);
    assert.equal(o.r, undefined);
    assert.equal(o.ownAttempts, 0);
  }
});

await check("a passed-on refusal (graceful, no verdict) goes to the listed fallback only, never to our relayer", async () => {
  const o = await runChain(() => new SettleError(500, { success: false, errorReason: "relay_unavailable", errorMessage: "Relay temporarily unavailable", transaction: "", network: INK }), { beforeHook: { graceful: "relay_unavailable" } });
  assert.deepEqual(o.asked, ["listed"]);
  assert.equal(o.ownAttempts, 0);
  assert.notEqual(o.r?.recovered, true);
});

await check("a buyer verdict, a used authorization and a compliance refusal go to no other settler", async () => {
  for (const [label, reason, message] of [
    ["buyer verdict", "invalid_exact_evm_payload_signature", "invalid signature"],
    ["used authorization", "invalid_exact_evm_nonce_already_used", "authorization is used or canceled"],
    ["compliance", "sanctioned_address", "payer is on a sanctions list"],
  ]) {
    const o = await runChain(() => new SettleError(500, { success: false, errorReason: reason, errorMessage: message, transaction: "", network: INK }));
    assert.deepEqual(o.asked, [], label);
    assert.equal(o.ownAttempts, 0, label);
  }
});

await check("a listed fallback's ambiguous answer stops the chain before our relayer (unconfirmed)", async () => {
  const o = await runChain(revertErr, { listedAnswer: "throw502" });
  assert.deepEqual(o.asked, ["listed"]);
  assert.equal(o.ownAttempts, 0);
  assert.ok(o.ctx.__a402UnconfirmedStop, "the chain ended unconfirmed");
});

await check("our relayer's screen refusal is final: nothing after it, the compliance answer, nothing sent", async () => {
  const o = await runChain(revertErr, { tail: true, beforeHook: { payer: LISTED_PAYER } });
  assert.deepEqual(o.asked, ["listed", "own"]);
  assert.equal(o.ownAttempts, 0);
  // complianceStop ends the settle with a failed result (never a success).
  assert.equal(o.r?.result?.success, false, `answer ${JSON.stringify(o.r)}`);
  assert.equal(o.r?.result?.errorReason, "settle_compliance_refused");
  assert.equal(o.r?.result?.transaction, "");
  assert.ok(!o.ctx.__a402UnconfirmedStop, "a final refusal is not an unconfirmed stop");
});

await check("our relayer's nothing-sent refusal (empty wallet, under the minimum) leaves the primary's refusal standing", async () => {
  const saved = st.ethBalance.get(relayer.address.toLowerCase());
  st.ethBalance.set(relayer.address.toLowerCase(), 0n);
  try {
    const o = await runChain(revertErr, { tail: true });
    assert.deepEqual(o.asked, ["listed", "own"]);
    assert.equal(o.r, undefined);
    assert.equal(o.ownAttempts, 0);
    assert.ok(!o.ctx.__a402UnconfirmedStop, "nothing of ours can land: not unconfirmed");
  } finally { st.ethBalance.set(relayer.address.toLowerCase(), saved); }
  const below = await runChain(revertErr, { tail: true, own: withOwnRefusalMemo(mk({ minUnits: 6000n })) });
  assert.deepEqual(below.asked, ["listed", "own"]);
  assert.equal(below.r, undefined);
  assert.equal(below.ownAttempts, 0);
  assert.ok(!below.ctx.__a402UnconfirmedStop);
});

// ---------------------------------------------------------------- gas and keys
await check("the gas check reads our Ink relayer as a facilitator of its own, low when its runway is short", async () => {
  const { createRelayerGasCheck } = await import("../src/facilitator-gas.js");
  const g = createRelayerGasCheck({ urls: [], network: INK, rpcUrl: RPC, settings: { minRunway: 500, gasPerSettlement: 100_000, failAfter: 3, intervalMs: 60_000 }, ownSigners: [{ label: "own relayer", signer: relayer.address, coversLowestPrice: () => true }], log: () => {} });
  const full = await g.check();
  assert.equal(full.length, 1);
  assert.equal(full[0].network, INK);
  assert.equal(full[0].own, true);
  assert.equal(full[0].status, "ok");
  const saved = st.ethBalance.get(relayer.address.toLowerCase());
  st.ethBalance.set(relayer.address.toLowerCase(), 100_000n * st.gasPrice * 10n);
  try { assert.equal((await g.check())[0].status, "low"); } finally { st.ethBalance.set(relayer.address.toLowerCase(), saved); }
});

await check("a dry listed Ink facilitator is covered only while our relayer reads ok and its minimum covers the lowest price", async () => {
  const catalog = { a: { price: "$0.001" }, b: { price: "$0.01" } };
  await withEnv({ INK_RELAYER_MIN_PRICE_USD: undefined, NETWORK_PRICE_FLOORS: undefined }, () => {
    assert.equal(ownRelayerCoversLowestPrice(catalog, INK), true, "the default Ink minimum covers a $0.001 sale");
  });
  await withEnv({ INK_RELAYER_MIN_PRICE_USD: "0.002", NETWORK_PRICE_FLOORS: undefined }, () => {
    assert.equal(ownRelayerCoversLowestPrice(catalog, INK), false, "INK_RELAYER_MIN_PRICE_USD is the one read on Ink");
    assert.equal(ownRelayerCoversLowestPrice(catalog, "eip155:4663", { relayerMinUsd: 0.001 }), true);
  });
  const { createToolFailureMonitor } = await import("../src/tool-failure-monitor.js");
  const now = Date.now();
  for (const coversLowestPrice of [true, false]) {
    const mon = createToolFailureMonitor();
    mon.noteRelayerGas([
      { network: INK, facilitator: "listed.example", signer: OTHER, runway: 0, status: "empty", at: now },
      { network: INK, facilitator: "own relayer", signer: relayer.address, own: true, runway: 9000, status: "ok", coversLowestPrice, at: now },
    ], { network: INK });
    const row = mon.evaluate().relayerGas.find((r) => r.facilitator === "listed.example");
    assert.equal(row.coveredByOwnRelayer === true, coversLowestPrice, `coversLowestPrice ${coversLowestPrice}`);
  }
});

await check("INK_RELAYER_KEY is Ink's own: the Robinhood key and a malformed key turn the Ink relayer off", () => {
  const warn = console.warn; const lines = []; console.warn = (l) => lines.push(String(l));
  try {
    const k = relayerKey;
    assert.equal(inkRelayerKeySafe({ INK_RELAYER_KEY: k }), k);
    assert.equal(inkRelayerKeySafe({ INK_RELAYER_KEY: k.slice(2) }), k, "a key without 0x is normalized");
    assert.equal(inkRelayerKeySafe({}), "");
    assert.equal(inkRelayerKeySafe({ INK_RELAYER_KEY: "0x1234" }), "");
    assert.equal(inkRelayerKeySafe({ INK_RELAYER_KEY: k, ROBINHOOD_RELAYER_KEY: k.slice(2).toUpperCase() }), "", "the same key in another spelling is refused");
    assert.equal(inkRelayerKeySafe({ INK_RELAYER_KEY: k, ROBINHOOD_RELAYER_KEY: generatePrivateKey() }), k, "a different Robinhood key is fine");
    assert.ok(lines.every((l) => !l.includes(k.slice(2)) && !l.toLowerCase().includes(k.slice(2).toLowerCase())), "a key never reaches the log");
  } finally { console.warn = warn; }
});

// ---------------------------------------------------------------- paid-mode boot
async function bootAndPay({ withKey, sameAsRobinhood = false, env: extraEnv = {} }) {
  const json = (res, s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const stub = (h) => createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { let body = {}; try { body = JSON.parse(b || "{}"); } catch { /* empty */ } h(req, res, body); }); });
  const asked = { settle: 0, second: 0 };
  const listedInk = (onSettle) => stub((q, r, b) => {
    if (q.url === "/supported") return json(r, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: INK }], extensions: [], signers: {} });
    if (q.url === "/verify") return json(r, 200, { isValid: true, payer: b?.paymentPayload?.payload?.authorization?.from });
    if (q.url === "/settle") { onSettle(); return json(r, 200, { success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: REVERTED, transaction: "", network: INK }); }
    return json(r, 404, {});
  });
  const servers = [
    stub((q, r) => q.url === "/supported" ? json(r, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }) : q.url === "/rpc" ? json(r, 200, { jsonrpc: "2.0", id: 1, result: "0x0" }) : json(r, 404, {})),
    listedInk(() => { asked.settle++; }),
    // The second listed Ink facilitator: a settle fallback that reverts too.
    listedInk(() => { asked.second++; }),
  ];
  await Promise.all(servers.map((srv) => new Promise((r) => srv.listen(0, "127.0.0.1", r))));
  const [BASE_FAC, INK1, INK2] = servers.map((srv) => srv.address().port);
  const tmp = mkdtempSync(join(tmpdir(), "a402-inkrelayer-"));
  const lifted = ["STATE_DATABASE_URL", "REDIS_URL", "SOLVADOR_KEY", "ROBINHOOD_RELAYER_KEY", "INK_RELAYER_KEY", "INK_RELAYER_MIN_PRICE_USD", "INK_FACILITATOR_URL", "NETWORK_PRICE_FLOORS", "NETWORK_PRICE_PREMIUMS", "FACILITATOR_PUBLIC_INDEX_CHAINS"].filter((k) => k in process.env).map((k) => [k, process.env[k]]);
  for (const [k] of lifted) delete process.env[k];
  let booting;
  try {
    booting = bootServer({ stores: false, timeoutMs: 60_000, env: { FREE_MODE: "",
      WALLET_ADDRESS: TREASURY, NETWORK: "base", FACILITATOR_URL: `http://127.0.0.1:${BASE_FAC}`, AGENT402_BASE_RPC: `http://127.0.0.1:${BASE_FAC}/rpc`,
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", PAYAI_FACILITATOR_URL: `http://127.0.0.1:${BASE_FAC}`, MPP_SECRET_KEY: "", PAYMENT_NETWORKS: "base,ink",
      INK_FACILITATOR_URL: `http://127.0.0.1:${INK1},http://127.0.0.1:${INK2}`, EVM_RPC_57073: RPC, ...(withKey ? { INK_RELAYER_KEY: relayerKey } : {}), ...(sameAsRobinhood ? { ROBINHOOD_RELAYER_KEY: relayerKey } : {}),
      PAYMENT_SETTLE_FALLBACK: "true", SALES_LEDGER_DB: join(tmp, "sales.db"), REFUND_DB_DIR: tmp, FACILITATOR_GAS_CHECK: "off", STATS_ALLOW_EPHEMERAL: "true",
      LATE_SETTLE_FILE: join(tmp, "late.json"), X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", ...extraEnv } })
      .catch((e) => { console.error(e.message); return null; });
  } finally { for (const [k, v] of lifted) process.env[k] = v; }
  let proc = null;
  try {
    const srv = await booting;
    proc = srv?.child ?? null;
    assert.ok(srv, "server booted");
    const B = srv.url, PATH = "/api/demand-radar?limit=1";
    const r402 = await fetch(`${B}${PATH}`);
    const accepted = JSON.parse(Buffer.from(r402.headers.get("payment-required"), "base64").toString()).accepts.find((a) => a.network === INK);
    assert.ok(accepted, "USDC on Ink is offered");
    const message = { from: buyer.address, to: getAddress(accepted.payTo), value: BigInt(accepted.amount), validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: keccak256(toHex(`ink-boot-${withKey}-${Date.now()}-${Math.random()}`)) };
    const signature = await buyer.signTypedData({ domain: { name: accepted.extra.name, version: accepted.extra.version, chainId: CHAIN_ID, verifyingContract: getAddress(accepted.asset) }, types: AUTH_TYPES, primaryType: "TransferWithAuthorization", message });
    const cred = Buffer.from(JSON.stringify({ x402Version: 2, resource: accepted.resource, accepted, payload: { signature, authorization: { from: message.from, to: message.to, value: String(message.value), validAfter: "0", validBefore: String(message.validBefore), nonce: message.nonce } } })).toString("base64");
    const sends = st.sends.length, attempts = st.sendAttempts, treasuryBefore = st.balances.get(TREASURY.toLowerCase()) || 0n;
    const res = await fetch(`${B}${PATH}`, { headers: { "payment-signature": cred } });
    await res.text();
    await sleep(200);
    return { status: res.status, ownSends: st.sends.length - sends, ownAttempts: st.sendAttempts - attempts, treasuryGain: (st.balances.get(TREASURY.toLowerCase()) || 0n) - treasuryBefore, primarySettles: asked.settle, secondSettles: asked.second, log: srv.log(), amount: BigInt(accepted.amount) };
  } finally {
    proc?.kill("SIGKILL");
    for (const srv of servers) srv.close();
  }
}

await check("paid server WITH INK_RELAYER_KEY: the listed facilitator reverts, our relayer settles once, 200", async () => {
  const r = await bootAndPay({ withKey: true });
  assert.ok(/Ink: own relayer 0x[0-9a-fA-F]{40} enabled as the last settle fallback/.test(r.log), "boot names the relayer by address");
  assert.ok(!r.log.toLowerCase().includes(relayerKey.slice(2).toLowerCase()), "the key never reaches the log");
  assert.equal(r.primarySettles, 1, "the listed facilitator is asked first");
  assert.equal(r.secondSettles, 1, "then the second listed one, before ours");
  assert.equal(r.ownSends, 1, r.log.slice(-1500));
  assert.equal(r.status, 200, r.log.slice(-1500));
  assert.equal(r.treasuryGain, r.amount, "the treasury received the signed amount once");
});

await check("paid server WITH the key, sale under INK_RELAYER_MIN_PRICE_USD: 402, our relayer sends nothing", async () => {
  const r = await bootAndPay({ withKey: true, env: { INK_RELAYER_MIN_PRICE_USD: "1" } });
  assert.equal(r.primarySettles, 1);
  assert.equal(r.ownAttempts, 0, r.log.slice(-1500));
  assert.equal(r.status, 402, r.log.slice(-1500));
  assert.equal(r.treasuryGain, 0n);
  assert.ok(/own_relayer_below_minimum/.test(r.log));
});

await check("paid server WITHOUT the key, or with the Robinhood key reused: 402, our relayer sends nothing (as before)", async () => {
  for (const opts of [{ withKey: false }, { withKey: true, sameAsRobinhood: true }]) {
    const r = await bootAndPay(opts);
    assert.equal(r.primarySettles, 1);
    assert.equal(r.ownAttempts, 0, r.log.slice(-1500));
    assert.equal(r.status, 402, r.log.slice(-1500));
    assert.equal(r.treasuryGain, 0n);
    assert.ok(!/Ink: own relayer .* enabled/.test(r.log));
    if (opts.sameAsRobinhood) assert.ok(/INK_RELAYER_KEY is the same key as ROBINHOOD_RELAYER_KEY/.test(r.log), "the refusal is logged");
  }
});

server.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall own Ink relayer checks passed");
process.exit(failures ? 1 : 0);

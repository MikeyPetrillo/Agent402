#!/usr/bin/env node
// The gateway response cache serves a paid answer free only to the payer who
// paid for it (src/gateway-cache-scope.js).
//
// Drives the gate the server mounts (gatewayCacheGate) on a real Express app,
// with the gateway kit's own key and store functions, and real EIP-3009
// signatures from throwaway keys:
//   - a stored answer is read back by its payer on a NEW signed payment;
//   - a header that only decodes (the old bar), a header naming the payer's
//     address but signed by another key, another wallet's valid payment, a
//     payment to another payee, an expired or not-yet-valid one: no hit, the
//     request goes on to the paywall;
//   - credits keys and verified Tempo senders are scoped the same way;
//   - the writer stores under the settling payer only, and stores nothing for
//     a trial, a first-call allowance grant, an unverified rail or FREE_MODE,
//     nor for a payer the reader could not prove (x402 v1, Permit2, a
//     contract wallet's signature): one predicate for both;
//   - an authorization the replay guard holds (settled, or in flight) reads no
//     scope, through the guard's own key and store (local and a shared-store
//     stand-in), and the read claims nothing;
//   - a body no payer holds an entry for runs no signature recovery (the
//     presence marker the commit writes beside each entry);
//   - the proof reads the network in the one spelling the replay guard keys
//     on, and a validity window no longer than the guard's settled hold;
//   - recoveries are memoized on everything the signature covers (bounded,
//     least recently used out), and the guard's read is one MGET;
//   - server.js mounts the gate and commits deferred writes through the scope.
// Offline: no facilitator, no upstream.
//
//   node scripts/test-gateway-cache-scope.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import express from "express";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { gatewayCacheGate, scopedCacheKey, writerCacheScope, readerCacheScope, provenX402Signer, presenceCacheKey, commitGatewayCacheWrites, proofRecoveryCount, proofMemoSize, PROOF_MEMO_MAX, __setProofMemoMax } from "../src/gateway-cache-scope.js";
import { carriesPaymentAttempt } from "../src/payment-attempt.js";
import { stableStringify, promptCacheGetShared, promptCacheStore, EMBEDDINGS_PATH } from "../src/tools/llm-gateway-kit.js";
import { ALLOWANCE_STATE } from "../src/allowance-state.js";
import { identityPayerOf } from "../src/payer.js";
import { createReplayGuard, paymentReplayKey, paymentReplayKeyAsync, SETTLED_HOLD_MS } from "../src/replay-guard.js";
import { __setTestClient } from "../src/shared-limit.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.log(`FAIL - ${m}`); } };

const PAY_TO = "0x00000000000000000000000000000000000a4020";
const OTHER_PAY_TO = "0x00000000000000000000000000000000000b4020";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const now = () => Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (h) => JSON.parse(Buffer.from(h, "base64").toString());
// The same signed bytes under another spelling of the accept's network.
const respelled = (h, network) => { const p = unb64(h); p.accepted.network = network; return b64(p); };

async function signedHeader(account, { to = PAY_TO, from = account.address, validAfter = now() - 60, validBefore = now() + 300, name = "USD Coin", network = "eip155:8453" } = {}) {
  const authorization = { from, to, value: "2000", validAfter: String(validAfter), validBefore: String(validBefore), nonce: `0x${randomBytes(32).toString("hex")}` };
  const signature = await account.signTypedData({
    domain: { name, version: "2", chainId: 8453, verifyingContract: USDC_BASE },
    types: { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: 2000n, validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
  });
  return b64({
    x402Version: 2,
    accepted: { scheme: "exact", network, asset: USDC_BASE, amount: "2000", payTo: to, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } },
    payload: { signature, authorization },
  });
}
const fakeReq = (headers = {}, extra = {}) => ({ headers, header: (n) => headers[String(n).toLowerCase()], ...extra });
// The replay guard the server mounts, read the way server.js reads it in the
// gate's paymentHeld.
let guard = createReplayGuard();
const paymentHeld = async (req) => {
  const key = await paymentReplayKeyAsync(req);
  return !key || (await guard.held(key)) !== null;
};
const notHeld = async () => false;
// The reader then the writer on one request: what the gate and the route
// binder's finish hook do in turn.
const readThenWrite = async (req, env = {}) => { await readerCacheScope(req, { payTo: PAY_TO, paymentHeld: notHeld }); return writerCacheScope(req, null, env, { payTo: PAY_TO }); };
const W = (req, res = null, env = {}) => writerCacheScope(req, res, env, { payTo: PAY_TO });
// What the binder's commit stores: the scoped entry and its presence marker.
const storeFor = (scope, key, body = ANSWER) => { promptCacheStore(scopedCacheKey(key, scope), body); promptCacheStore(presenceCacheKey(key), { present: true }); };

const alice = privateKeyToAccount(generatePrivateKey());
const mallory = privateKeyToAccount(generatePrivateKey());
const BODY = { input: `cache scope ${randomBytes(6).toString("hex")}`, model: "text-embedding-3-small" };
const ANSWER = { object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }], model: "text-embedding-3-small" };
// The payer-neutral key of a body (the server uses embeddingsCacheKey, which
// prices the body and so needs the private cost table; the scope under test
// wraps whatever key it is handed).
const keyOfBody = (body) => `test-embeddings\n${stableStringify(body)}`;
const baseKey = keyOfBody(BODY);

// ---- writer --------------------------------------------------------------
{
  const aliceReq = fakeReq({ "payment-signature": await signedHeader(alice) });
  ok((await W(fakeReq({ "payment-signature": await signedHeader(alice) }))) === `evm:${alice.address.toLowerCase()}`, "writer: with no read on the request (no entry for the body yet), the writer runs the reader's proof itself");
  ok((await writerCacheScope(fakeReq({ "payment-signature": await signedHeader(alice, { to: OTHER_PAY_TO }) }), null, {}, { payTo: PAY_TO })) === null && (await writerCacheScope(fakeReq({ "payment-signature": await signedHeader(alice) }), null, {}, {})) === null,
    "writer: a payment to another payee, or no payee configured, stores nothing");
  ok((await W(fakeReq({ "payment-signature": await signedHeader(alice, { validBefore: now() - 1, validAfter: now() - 600 }) }))) === `evm:${alice.address.toLowerCase()}`, "writer: the validity window binds a read, not an entry (a long call settles near its end)");
  ok((await readThenWrite(aliceReq)) === `evm:${alice.address.toLowerCase()}`, "writer: a settled EVM x402 payment the reader proved stores under its signer");
  ok((await writerCacheScope(aliceReq, null, { FREE_MODE: "true" })) === null, "writer: FREE_MODE (nothing verified) stores nothing");
  ok((await writerCacheScope(aliceReq, { getHeader: (h) => (h === "X-Trial-Accepted" ? "true" : undefined) }, {}, { payTo: PAY_TO })) === null, "writer: a trial answer stores nothing");
  const granted = fakeReq({ "payment-signature": await signedHeader(alice) }); granted[ALLOWANCE_STATE] = { state: "served" };
  ok((await writerCacheScope(granted, null, {}, { payTo: PAY_TO })) === null, "writer: a first-call allowance grant (never settled) stores nothing");
  ok((await writerCacheScope(fakeReq({}, { creditsSettled: true, creditsKeyId: "k1" }), null, {})) === "credits:k1", "writer: a credits debit stores under its key id");
  ok((await writerCacheScope(fakeReq({}, { mppTempoCredential: true, tempoSettled: true, mppTempoSender: alice.address }), null, {})) === `tempo:${alice.address.toLowerCase()}`, "writer: a settled Tempo call stores under its verified sender");
  ok((await writerCacheScope(fakeReq({}, { mppTempoCredential: true, tempoSettled: true, mppTempoSender: null }), null, {})) === null, "writer: a Tempo call with no verified sender stores nothing");
  ok((await writerCacheScope(fakeReq({ "x-payment": b64({ x402Version: 2, accepted: { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, payload: { transaction: "AAAA" } }) }), null, {}, { payTo: PAY_TO })) === null, "writer: a non-EVM x402 payment (no signed payer before settle) stores nothing");
  // Payers the facilitator verifies but the reader cannot prove: their entry
  // could never be read, so it is never stored (identityPayerOf names each).
  const v2 = JSON.parse(Buffer.from(await signedHeader(alice), "base64").toString());
  const v1Req = fakeReq({ "x-payment": b64({ x402Version: 1, scheme: "exact", network: "base", payload: v2.payload }) });
  const p2Req = fakeReq({ "payment-signature": b64({ ...v2, payload: { ...v2.payload, permit2Authorization: { from: alice.address, nonce: "1" } } }) });
  const contractWallet = "0x00000000000000000000000000000000c0ffee01";
  const cwReq = fakeReq({ "payment-signature": await signedHeader(alice, { from: contractWallet }) });
  const uptoReq = fakeReq({ "payment-signature": b64({ ...v2, accepted: { ...v2.accepted, scheme: "upto" } }) });
  for (const [label, r, payer] of [["an x402 v1", v1Req, alice.address], ["a Permit2", p2Req, alice.address], ["a contract-wallet signature", cwReq, contractWallet], ["an upto", uptoReq, alice.address]]) {
    const w = await readThenWrite(r);
    ok(identityPayerOf(r, {}) === payer.toLowerCase() && w === null, `writer: ${label} payment (verified payer, unprovable to the reader) stores nothing`);
  }
  ok(scopedCacheKey(baseKey, null) === null && scopedCacheKey(baseKey, "evm:a") !== scopedCacheKey(baseKey, "evm:b") && scopedCacheKey(baseKey, "evm:a") !== baseKey, "keys: no scope no key; two payers two keys; never the bare key");
  // Alice paid for BODY: the binder's commit, through the same functions.
  storeFor(await readThenWrite(aliceReq), baseKey);
  storeFor("credits:k1", baseKey);
  storeFor(`tempo:${alice.address.toLowerCase()}`, baseKey);
}

// A shared-store stand-in with the calls the replay guard makes.
function fakeRedis() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async set(k, v, o = {}) { if (o.NX && m.has(k)) return null; m.set(k, v); return "OK"; },
    async del(k) { return m.delete(k) ? 1 : 0; },
    async expire() { return 1; },
  };
}

// ---- reader, through the gate on a real app ------------------------------
const app = express();
app.use(express.json());
// Stand-ins for the gates mounted ahead of the cache: they set what the real
// credits and Tempo gates set on acceptance.
app.use((req, res, next) => {
  const c = req.header("x-test-credits"); if (c) { req.creditsSettled = true; req.creditsKeyId = c; }
  const t = req.header("x-test-tempo"); if (t !== undefined) { req.mppTempoCredential = true; req.mppTempoSender = t || null; }
  next();
});
const gateOpts = { carriesPaymentAttempt: (req) => carriesPaymentAttempt(req) || !!req.creditsSettled || !!req.mppTempoCredential, payTo: PAY_TO, get: promptCacheGetShared, keyOf: (req) => (req.path === EMBEDDINGS_PATH ? keyOfBody(req.body) : null) };
app.use((req, res, next) => (req.header("x-test-no-held-reader") ? gatewayCacheGate(gateOpts)(req, res, next) : gatewayCacheGate({ ...gateOpts, paymentHeld })(req, res, next)));
app.post(EMBEDDINGS_PATH, (req, res) => res.status(402).json({ paywall: true }));
const srv = app.listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const url = `http://127.0.0.1:${srv.address().port}${EMBEDDINGS_PATH}`;
const call = async (headers, body = BODY) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, cache: r.headers.get("x-cache"), body: await r.json() };
};
try {
  const own = await call({ "payment-signature": await signedHeader(alice) });
  ok(own.status === 200 && own.cache === "hit" && own.body.data?.[0]?.embedding?.length === 3, "reader: the payer's own repeat, on a fresh signed payment, is a hit");
  const shapeOnly = b64({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload: {} });
  const r1 = await call({ "payment-signature": shapeOnly });
  ok(r1.status === 402 && r1.cache === null, "reader: a header that only decodes (no signature) is not served the paid answer");
  const forgedFrom = await signedHeader(mallory, { from: alice.address });
  const r2 = await call({ "payment-signature": forgedFrom });
  ok(r2.status === 402, "reader: a header naming the payer's address but signed by another key is not served");
  const r3 = await call({ "payment-signature": await signedHeader(mallory) });
  ok(r3.status === 402, "reader: another wallet's valid payment for the same body is not served the first payer's answer");
  const r4 = await call({ "x-payment": await signedHeader(alice, { to: OTHER_PAY_TO }) });
  ok(r4.status === 402, "reader: the payer's signature on a payment to another payee proves nothing here");
  ok((await call({ "payment-signature": await signedHeader(alice, { validBefore: now() - 1, validAfter: now() - 600 }) })).status === 402, "reader: an expired authorization is not served");
  ok((await call({ "payment-signature": await signedHeader(alice, { validAfter: now() + 600, validBefore: now() + 900 }) })).status === 402, "reader: a not-yet-valid authorization is not served");
  ok((await call({ "payment-signature": await signedHeader(alice, { name: "USDC" }) })).status === 402, "reader: a signature under another token domain than the accept names is not served");
  ok((await call({ "payment-signature": await signedHeader(alice) }, { ...BODY, input: BODY.input + "!" })).status === 402, "reader: another body under the payer's own payment is a miss");
  ok((await call({ "x-test-credits": "k1" })).status === 200 && (await call({ "x-test-credits": "k2" })).status === 402, "reader: a credits key reads its own entry, another key does not");
  ok((await call({ "x-test-tempo": alice.address })).status === 200 && (await call({ "x-test-tempo": mallory.address })).status === 402 && (await call({ "x-test-tempo": "" })).status === 402,
    "reader: a verified Tempo sender reads its own entry; another sender, or none verified, does not");
  ok((await call({})).status === 402, "reader: an unpaid request gets the paywall");
  // Direct reads of the proof.
  ok((await provenX402Signer(await signedHeader(alice), { payTo: PAY_TO })) === alice.address.toLowerCase() && (await provenX402Signer("not base64 json", { payTo: PAY_TO })) === null && (await provenX402Signer(await signedHeader(alice), { payTo: "" })) === null,
    "proof: recovers the signer of a well-formed authorization, null for junk or with no payee configured");
  ok((await readerCacheScope(fakeReq({ "payment-signature": await signedHeader(alice) }), { payTo: PAY_TO, paymentHeld: notHeld })) === `evm:${alice.address.toLowerCase()}`, "proof: the reader scope of a signed payment equals the writer scope of its settled twin");
  ok((await readerCacheScope(fakeReq({ "payment-signature": await signedHeader(alice) }), { payTo: PAY_TO })) === null && (await call({ "payment-signature": await signedHeader(alice), "x-test-no-held-reader": "1" })).status === 402,
    "proof: with no replay-guard reader an x402 payment proves nothing");
  ok((await readerCacheScope(fakeReq({ "payment-signature": await signedHeader(alice) }), { payTo: PAY_TO, paymentHeld: async () => { throw new Error("store down"); } })) === null, "proof: a replay-guard read that throws proves nothing");
  // The proof's network is the replay guard's: the key the gate looks up for
  // a proven payment is the key the paywall path claims under.
  {
    const h = await signedHeader(alice);
    ok(paymentReplayKey(fakeReq({ "payment-signature": h })) === paymentReplayKey(fakeReq({ "payment-signature": respelled(h, "eip155:8453") })) && paymentReplayKey(fakeReq({ "payment-signature": h })) !== paymentReplayKey(fakeReq({ "payment-signature": respelled(h, "eip155:08453") })),
      "proof: the guard keys a payment on its network as spelled (why the proof reads one spelling)");
    for (const net of ["eip155:08453", "eip155:0", "eip155:", "eip155:1234567890123"]) ok((await provenX402Signer(respelled(h, net), { payTo: PAY_TO })) === null, `proof: network ${JSON.stringify(net)} proves nothing`);
  }

  // ---- recovery memo --------------------------------------------------------
  {
    const h = await signedHeader(alice);
    const before = proofRecoveryCount();
    const a = await provenX402Signer(h, { payTo: PAY_TO });
    const b = await provenX402Signer(h, { payTo: PAY_TO });
    const c = await provenX402Signer(h, { payTo: PAY_TO, anyTime: true });
    ok(a === alice.address.toLowerCase() && b === a && c === a && proofRecoveryCount() === before + 1, `memo: one header proved three times runs one recovery (${proofRecoveryCount() - before})`);
    // The signature copied onto another message is another memo key.
    const p = unb64(h); p.payload.authorization.nonce = `0x${randomBytes(32).toString("hex")}`;
    const moved = await provenX402Signer(b64(p), { payTo: PAY_TO });
    ok(moved === null && proofRecoveryCount() === before + 2, "memo: the same signature on another nonce is recovered again and proves nothing");
    const q = unb64(h); q.payload.authorization.value = "1";
    ok((await provenX402Signer(b64(q), { payTo: PAY_TO })) === null && proofRecoveryCount() === before + 3, "memo: the same signature on another value is recovered again and proves nothing");
    ok((await provenX402Signer(await signedHeader(mallory, { from: alice.address }), { payTo: PAY_TO })) === null, "memo: a forged header is not served from another header's entry");
    // Bounded, least recently used first out.
    ok(PROOF_MEMO_MAX === 2000 && proofMemoSize() <= PROOF_MEMO_MAX, `memo: bounded at ${PROOF_MEMO_MAX}`);
    __setProofMemoMax(5);
    const junk = (i) => { const r = unb64(h); r.payload.signature = `0x${randomBytes(65).toString("hex")}`; r.payload.authorization.nonce = `0x${i.toString(16).padStart(64, "0")}`; return b64(r); };
    for (let i = 0; i < 12; i++) await provenX402Signer(junk(i), { payTo: PAY_TO });
    ok(proofMemoSize() === 5, `memo: twelve distinct headers past a bound of five keep five (${proofMemoSize()})`);
    const keep = await signedHeader(alice);
    await provenX402Signer(keep, { payTo: PAY_TO });
    const n = proofRecoveryCount();
    for (let i = 100; i < 108; i++) { await provenX402Signer(keep, { payTo: PAY_TO }); await provenX402Signer(junk(i), { payTo: PAY_TO }); }
    await provenX402Signer(keep, { payTo: PAY_TO });
    ok(proofRecoveryCount() === n + 8, `memo: an entry read between eight newer ones is kept over them (${proofRecoveryCount() - n} recoveries for 8 new headers)`);
    __setProofMemoMax();
  }

  // ---- the guard's read is one round trip ----------------------------------
  {
    const calls = [];
    const m = new Map();
    __setTestClient({
      async get(k) { calls.push("get"); return m.has(k) ? m.get(k) : null; },
      async mGet(ks) { calls.push("mGet"); return ks.map((k) => (m.has(k) ? m.get(k) : null)); },
      async set(k, v, o = {}) { calls.push("set"); if (o.NX && m.has(k)) return null; m.set(k, v); return "OK"; },
      async del(k) { calls.push("del"); return m.delete(k) ? 1 : 0; },
      async expire() { return 1; },
    });
    const g = createReplayGuard();
    const key = await paymentReplayKeyAsync(fakeReq({ "payment-signature": await signedHeader(alice) }));
    calls.length = 0;
    ok((await g.held(key)) === null && calls.join() === "mGet", `held: nothing held reads in one round trip (${calls.join()})`);
    await g.begin(key); calls.length = 0;
    ok((await g.held(key)) === "inflight" && calls.join() === "mGet", "held: in flight, one round trip");
    await g.settle(key); calls.length = 0;
    ok((await g.held(key)) === "consumed" && calls.join() === "mGet", "held: consumed, one round trip");
    // A legacy-name entry an earlier build wrote (untagged) is held; our own
    // tagged entry for another payment there is not.
    const legacyName = `replay:c:n:${key.split(":")[2]}`;
    const g2 = createReplayGuard();
    const key2 = await paymentReplayKeyAsync(fakeReq({ "payment-signature": await signedHeader(alice) }));
    m.set(`replay:c:n:${key2.split(":")[2]}`, String(Date.now()));
    ok((await g2.held(key2)) === "consumed", "held: an earlier build's untagged consumed mark at the legacy name is held");
    const key3 = await paymentReplayKeyAsync(fakeReq({ "payment-signature": await signedHeader(alice) }));
    m.set(`replay:f:n:${key3.split(":")[2]}`, "v2|n2:someone-else");
    ok((await g2.held(key3)) === null, "held: another payment's tagged claim at the legacy name is not held");
    ok(m.has(legacyName), "held: settle wrote the tagged legacy mark");
    __setTestClient(null);
  }

  // ---- no entry for the body: no signature recovery before the paywall -------
  {
    const empty = { ...BODY, input: `${BODY.input} nobody paid for this` };
    const header = await signedHeader(alice);
    const before = proofRecoveryCount();
    const r = await call({ "payment-signature": header }, empty);
    ok(r.status === 402 && proofRecoveryCount() === before, `presence: a body no payer holds an entry for runs no recovery (${proofRecoveryCount() - before})`);
    const many = proofRecoveryCount();
    await Promise.all(Array.from({ length: 20 }, async (_, i) => call({ "payment-signature": await signedHeader(mallory) }, { ...empty, input: `${empty.input} ${i}` })));
    ok(proofRecoveryCount() === many, "presence: twenty self-signed headers on fresh bodies run no recovery");
    const withEntry = proofRecoveryCount();
    const hit = await call({ "payment-signature": await signedHeader(alice) });
    ok(hit.status === 200 && hit.cache === "hit" && proofRecoveryCount() === withEntry + 1, "presence: with an entry for the body, the payer's proof runs once and is a hit");
    // The binder's commit writes the marker beside the scoped entry.
    const committed = { ...BODY, input: `${BODY.input} committed` };
    const req = fakeReq({ "payment-signature": await signedHeader(alice) });
    await commitGatewayCacheWrites(req, null, [{ key: keyOfBody(committed), body: ANSWER }], { payTo: PAY_TO, store: promptCacheStore, env: {} });
    ok((await promptCacheGetShared(presenceCacheKey(keyOfBody(committed))))?.present === true && (await promptCacheGetShared(scopedCacheKey(keyOfBody(committed), `evm:${alice.address.toLowerCase()}`))) != null,
      "presence: the commit stores the scoped entry and its marker");
    ok((await call({ "payment-signature": await signedHeader(alice) }, committed)).cache === "hit", "presence: a committed entry reads back for its payer");
    const none = { ...BODY, input: `${BODY.input} unproven` };
    await commitGatewayCacheWrites(fakeReq({ "x-payment": b64({ x402Version: 1, scheme: "exact", network: "base", payload: JSON.parse(Buffer.from(await signedHeader(alice), "base64").toString()).payload }) }), null, [{ key: keyOfBody(none), body: ANSWER }], { payTo: PAY_TO, store: promptCacheStore, env: {} });
    ok((await promptCacheGetShared(presenceCacheKey(keyOfBody(none)))) == null, "presence: a payer the writer cannot prove leaves no marker either");
  }

  // ---- an authorization the replay guard holds reads no scope ---------------
  // The writer's request: the gate misses (a new body), then the guard claims
  // and settles it as the paywall path does, and the binder stores under it.
  async function settleOnce(headerValue, body, store = true) {
    const req = fakeReq({ "payment-signature": headerValue });
    const scope = await readerCacheScope(req, { payTo: PAY_TO, paymentHeld });
    const key = await paymentReplayKeyAsync(req);
    const verdict = await guard.begin(key);
    if (verdict !== "ok") return { verdict };
    await guard.settle(key);
    const w = await W(req);
    if (store) await commitGatewayCacheWrites(req, null, [{ key: keyOfBody(body), body: ANSWER }], { payTo: PAY_TO, store: promptCacheStore, env: {} });
    return { verdict, scope, w };
  }
  for (const [label, fake] of [["local", null], ["shared", fakeRedis()]]) {
    __setTestClient(fake);
    guard = createReplayGuard();
    const body = { ...BODY, input: `${BODY.input} ${label}` };
    const settled = await signedHeader(alice);
    const s1 = await settleOnce(settled, body);
    ok(s1.verdict === "ok" && s1.scope === `evm:${alice.address.toLowerCase()}` && s1.w === s1.scope, `replay (${label}): the writer settles once and stores under its proven payer`);
    const again = await call({ "payment-signature": settled }, body);
    ok(again.status === 402 && again.cache === null, `replay (${label}): the same settled authorization again is not served the cached answer`);
    // A copy of the settled authorization under another spelling of the same
    // chain (the signature still verifies under chainId 8453): the replay
    // guard keys the payment on the network string, so the proof reads the
    // canonical spelling only.
    for (const net of ["eip155:08453", "eip155:008453", "eip155:8453 ", " eip155:8453", "EIP155:8453", "eip155:+8453", "eip155:8453.0"]) {
      const copy = await call({ "payment-signature": respelled(settled, net) }, body);
      ok(copy.status === 402 && copy.cache === null, `replay (${label}): the settled authorization re-sent as network ${JSON.stringify(net)} is not served`);
    }
    const fresh = await call({ "payment-signature": await signedHeader(alice) }, body);
    ok(fresh.status === 200 && fresh.cache === "hit", `replay (${label}): a fresh authorization from the same payer is a hit`);
    // In flight: claimed by the guard, not yet settled.
    const flying = await signedHeader(alice);
    const fk = await paymentReplayKeyAsync(fakeReq({ "payment-signature": flying }));
    ok((await guard.begin(fk)) === "ok", `replay (${label}): an authorization claimed in flight`);
    ok((await call({ "payment-signature": flying }, body)).status === 402, `replay (${label}): an authorization the guard holds in flight is not served`);
    await guard.release(fk);
    // The gate's read claims nothing: after a hit the same authorization is
    // still the guard's to claim.
    const unclaimed = await signedHeader(alice);
    ok((await call({ "payment-signature": unclaimed }, body)).cache === "hit", `replay (${label}): a fresh authorization reads its hit`);
    const uk = await paymentReplayKeyAsync(fakeReq({ "payment-signature": unclaimed }));
    ok((await guard.held(uk)) === null && (await guard.begin(uk)) === "ok", `replay (${label}): the cache read claimed nothing`);
    await guard.release(uk);
  }
  // An authorization valid for longer than the guard keeps a settled payment's
  // consumed mark: once the mark lapses the guard no longer holds it, so the
  // proof refuses any validity span past the hold (less a clock margin).
  {
    __setTestClient(null);
    guard = createReplayGuard({ ttlMs: 1 }); // the hold lapsed
    const body = { ...BODY, input: `${BODY.input} long validity` };
    storeFor(`evm:${alice.address.toLowerCase()}`, keyOfBody(body));
    const holdSec = Math.floor(SETTLED_HOLD_MS / 1000);
    const long = await signedHeader(alice, { validBefore: now() + holdSec + 60 });
    const lk = await paymentReplayKeyAsync(fakeReq({ "payment-signature": long }));
    ok((await guard.begin(lk)) === "ok", "long validity: claimed");
    await guard.settle(lk);
    await new Promise((r) => setTimeout(r, 5));
    ok((await guard.held(lk)) === null, "long validity: the guard's settled hold has lapsed");
    ok((await call({ "payment-signature": long }, body)).status === 402, "long validity: a settled authorization valid past the hold is not served after the hold lapses");
    const spanned = await signedHeader(alice, { validAfter: now() - holdSec + 120, validBefore: now() + 600 });
    ok((await call({ "payment-signature": spanned }, body)).status === 402, "long validity: a window that ends inside the hold from now but spans more than the hold is not served");
    ok((await call({ "payment-signature": await signedHeader(alice, { validAfter: now() - 600, validBefore: now() + 300 }) }, body)).cache === "hit", "long validity: a stock window (ten minutes back, five ahead) is a hit");
    ok((await provenX402Signer(long, { payTo: PAY_TO, anyTime: true })) === alice.address.toLowerCase(), "long validity: the writer's proof (no window) still names the payer");
    guard = createReplayGuard();
  }
  // A configured shared store that does not answer holds everything.
  __setTestClient({ get: async () => { throw new Error("down"); }, set: async () => { throw new Error("down"); }, del: async () => { throw new Error("down"); }, expire: async () => 0 });
  guard = createReplayGuard();
  ok((await call({ "payment-signature": await signedHeader(alice) })).status === 402, "replay: an unreadable shared store serves no hit");
  __setTestClient(null);
  guard = createReplayGuard();
} finally {
  srv.close();
}

// ---- wiring --------------------------------------------------------------
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/app\.use\(gatewayCacheGate\(\{\s*carriesPaymentAttempt,\s*payTo: WALLET_ADDRESS,\s*get: promptCacheGetShared,/.test(src), "server.js mounts the gate with the receiving wallet and the shared store");
  const gate = src.slice(src.indexOf("app.use(gatewayCacheGate({"), src.indexOf("app.use(gatewayCacheGate({") + 900);
  ok(/paymentHeld: async \(req\) => \{\s*const key = await paymentReplayKeyAsync\(req\);\s*return !key \|\| \(await replayGuard\.held\(key\)\) !== null;/.test(gate), "server.js gives the gate the replay guard's own key and store");
  ok(src.indexOf("const replayGuard = createReplayGuard();") > 0 && src.indexOf("const replayGuard = createReplayGuard();") < src.indexOf("app.use(gatewayCacheGate({"), "the replay guard the gate reads is the one the paywall path claims with");
  ok(/const deferred = req\.__deferredCache \|\| \[\];\s*if \(deferred\.length\) commitGatewayCacheWrites\(req, res, deferred, \{ payTo: WALLET_ADDRESS, store: promptCacheStore \}\)/.test(src), "the route binder commits deferred cache writes through the writer scope, to the receiving wallet");
  ok(!/promptCacheStore\(w\.key, w\.body\)/.test(src), "no unscoped commit of a deferred write remains in server.js");
}
console.log(`\n${failed ? "FAILED" : "OK"}: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

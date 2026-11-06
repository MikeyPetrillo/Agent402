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
//     a trial, a first-call allowance grant, an unverified rail or FREE_MODE;
//   - server.js mounts the gate and commits deferred writes through the scope.
// Offline: no facilitator, no upstream.
//
//   node scripts/test-gateway-cache-scope.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import express from "express";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { gatewayCacheGate, scopedCacheKey, writerCacheScope, readerCacheScope, provenX402Signer } from "../src/gateway-cache-scope.js";
import { carriesPaymentAttempt } from "../src/payment-attempt.js";
import { stableStringify, promptCacheGetShared, promptCacheStore, EMBEDDINGS_PATH } from "../src/tools/llm-gateway-kit.js";
import { ALLOWANCE_STATE } from "../src/allowance-state.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.log(`FAIL - ${m}`); } };

const PAY_TO = "0x00000000000000000000000000000000000a4020";
const OTHER_PAY_TO = "0x00000000000000000000000000000000000b4020";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const now = () => Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

async function signedHeader(account, { to = PAY_TO, from = account.address, validAfter = now() - 60, validBefore = now() + 300, name = "USD Coin" } = {}) {
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
    accepted: { scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "2000", payTo: to, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } },
    payload: { signature, authorization },
  });
}
const fakeReq = (headers = {}, extra = {}) => ({ headers, header: (n) => headers[String(n).toLowerCase()], ...extra });

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
  ok(writerCacheScope(aliceReq, null, {}) === `evm:${alice.address.toLowerCase()}`, "writer: a settled EVM x402 payment stores under its signer");
  ok(writerCacheScope(aliceReq, null, { FREE_MODE: "true" }) === null, "writer: FREE_MODE (nothing verified) stores nothing");
  ok(writerCacheScope(aliceReq, { getHeader: (h) => (h === "X-Trial-Accepted" ? "true" : undefined) }, {}) === null, "writer: a trial answer stores nothing");
  const granted = fakeReq({ "payment-signature": await signedHeader(alice) }); granted[ALLOWANCE_STATE] = { state: "served" };
  ok(writerCacheScope(granted, null, {}) === null, "writer: a first-call allowance grant (never settled) stores nothing");
  ok(writerCacheScope(fakeReq({}, { creditsSettled: true, creditsKeyId: "k1" }), null, {}) === "credits:k1", "writer: a credits debit stores under its key id");
  ok(writerCacheScope(fakeReq({}, { mppTempoCredential: true, tempoSettled: true, mppTempoSender: alice.address }), null, {}) === `tempo:${alice.address.toLowerCase()}`, "writer: a settled Tempo call stores under its verified sender");
  ok(writerCacheScope(fakeReq({}, { mppTempoCredential: true, tempoSettled: true, mppTempoSender: null }), null, {}) === null, "writer: a Tempo call with no verified sender stores nothing");
  ok(writerCacheScope(fakeReq({ "x-payment": b64({ x402Version: 2, accepted: { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, payload: { transaction: "AAAA" } }) }), null, {}) === null, "writer: a non-EVM x402 payment (no signed payer before settle) stores nothing");
  ok(scopedCacheKey(baseKey, null) === null && scopedCacheKey(baseKey, "evm:a") !== scopedCacheKey(baseKey, "evm:b") && scopedCacheKey(baseKey, "evm:a") !== baseKey, "keys: no scope no key; two payers two keys; never the bare key");
  // Alice paid for BODY: the binder's commit, through the same functions.
  promptCacheStore(scopedCacheKey(baseKey, writerCacheScope(aliceReq, null, {})), ANSWER);
  promptCacheStore(scopedCacheKey(baseKey, "credits:k1"), ANSWER);
  promptCacheStore(scopedCacheKey(baseKey, `tempo:${alice.address.toLowerCase()}`), ANSWER);
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
app.use(gatewayCacheGate({ carriesPaymentAttempt: (req) => carriesPaymentAttempt(req) || !!req.creditsSettled || !!req.mppTempoCredential, payTo: PAY_TO, get: promptCacheGetShared, keyOf: (req) => (req.path === EMBEDDINGS_PATH ? keyOfBody(req.body) : null) }));
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
  ok((await readerCacheScope(fakeReq({ "payment-signature": await signedHeader(alice) }), { payTo: PAY_TO })) === `evm:${alice.address.toLowerCase()}`, "proof: the reader scope of a signed payment equals the writer scope of its settled twin");
} finally {
  srv.close();
}

// ---- wiring --------------------------------------------------------------
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/app\.use\(gatewayCacheGate\(\{\s*carriesPaymentAttempt,\s*payTo: WALLET_ADDRESS,\s*get: promptCacheGetShared,/.test(src), "server.js mounts the gate with the receiving wallet and the shared store");
  ok(/const scope = deferred\.length \? writerCacheScope\(req, res\) : null;[\s\S]{0,200}scopedCacheKey\(w\.key, scope\);\s*if \(k\) promptCacheStore\(k, w\.body\)/.test(src), "the route binder commits deferred cache writes under the writer scope only");
  ok(!/promptCacheStore\(w\.key, w\.body\)/.test(src), "no unscoped commit of a deferred write remains in server.js");
}
console.log(`\n${failed ? "FAILED" : "OK"}: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

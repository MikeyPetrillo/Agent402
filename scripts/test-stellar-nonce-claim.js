// One signed Stellar payment, one answer (src/settlement-claims.js,
// src/stellar-confirm.js stellarAuthorizationsOf, src/replay-guard.js
// paymentReplayKeyAsync, the Stellar settle wiring in src/payments.js).
//
// The shape this guards: one signed Soroban authorization entry sent twice,
// the second copy re-encoded (another envelope around the same signed entry),
// so a key on the raw header bytes tells them apart. Request A lands; B's
// settle fails fast (the entry's nonce is used) and its on-chain confirmation
// finds A's transaction. Without a claim on the entry itself, both A and B
// would be answered for one payment.
//
// Offline: per-process claim and replay stores, no Horizon, no facilitator.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createHash } from "node:crypto";

const sdk = await import("@stellar/stellar-sdk");
const claims = await import("../src/settlement-claims.js");
const { stellarAuthorizationsOf, stellarSignedPaymentOf, confirmStellarPayment } = await import("../src/stellar-confirm.js");
const { paymentReplayKey, paymentReplayKeyAsync, createReplayGuard } = await import("../src/replay-guard.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const NET = sdk.Networks.PUBLIC;
const NETWORK = "stellar:pubnet";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const SAC = new sdk.Asset("USDC", ISSUER).contractId(NET);
const buyer = sdk.Keypair.random().publicKey();
const otherBuyer = sdk.Keypair.random().publicKey();
const ours = sdk.Keypair.random().publicKey();
const REQ = { scheme: "exact", network: NETWORK, asset: SAC, payTo: ours, amount: "10000" };

// The payer's signed transfer call and authorization entry.
const signedOp = ({ from = buyer, nonce, amount = 10000n }) => {
  const args = [new sdk.Address(from).toScVal(), new sdk.Address(ours).toScVal(), sdk.nativeToScVal(amount, { type: "i128" })];
  const call = new sdk.xdr.InvokeContractArgs({ contractAddress: new sdk.Address(SAC).toScAddress(), functionName: "transfer", args });
  const entry = new sdk.xdr.SorobanAuthorizationEntry({
    credentials: sdk.xdr.SorobanCredentials.sorobanCredentialsAddress(new sdk.xdr.SorobanAddressCredentials({
      address: new sdk.Address(from).toScAddress(), nonce: sdk.xdr.Int64.fromString(String(nonce)),
      signatureExpirationLedger: 1000, signature: sdk.xdr.ScVal.scvBytes(Buffer.alloc(64, Number(BigInt(nonce) % 251n))),
    })),
    rootInvocation: new sdk.xdr.SorobanAuthorizedInvocation({ function: sdk.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call), subInvocations: [] }),
  });
  return sdk.Operation.invokeContractFunction({ contract: SAC, function: "transfer", args, auth: [entry] });
};
// An envelope around operations; another source account or sequence is
// another encoding of the same signed entry.
const envelope = (ops, { source = sdk.Keypair.random().publicKey(), seq = "1" } = {}) => {
  const b = new sdk.TransactionBuilder(new sdk.Account(source, seq), { fee: "100", networkPassphrase: NET });
  for (const op of ops) b.addOperation(op);
  return b.setTimeout(300).build().toXDR();
};
const payloadOf = (x) => ({ x402Version: 2, accepted: { ...REQ }, payload: { transaction: x } });
const header = (x) => Buffer.from(JSON.stringify(payloadOf(x))).toString("base64");
const fakeReq = (headers) => { const lower = {}; for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v; return { header: (n) => lower[String(n).toLowerCase()], headers: lower }; };

let seq = 9_000_000_000n + BigInt(Math.floor(Math.random() * 1e6));
const nextNonce = () => String(++seq);

// ---- The signed entry is the identity ---------------------------------------
{
  const nonce = nextNonce();
  const op = signedOp({ nonce });
  const a = envelope([op], { seq: "1" });
  const b = envelope([op], { seq: "77" });
  ok(a !== b, "the two copies are different encodings");
  const ea = await stellarAuthorizationsOf(payloadOf(a));
  const eb = await stellarAuthorizationsOf(payloadOf(b));
  ok(ea?.length === 1 && ea[0].signer === buyer && ea[0].nonce === nonce, `the payer's signed entry is read from the payload (${ea?.[0]?.nonce})`);
  ok(JSON.stringify(ea) === JSON.stringify(eb), "a re-encoded copy of the same signed entry reads the same (signer, nonce)");
  const ec = await stellarAuthorizationsOf(payloadOf(envelope([signedOp({ nonce: nextNonce() })])));
  ok(ec && ec[0].nonce !== nonce, "another signed entry reads another nonce");

  // The single-operation rule: a second operation makes the payload unreadable
  // for the claim and for the confirmation alike.
  const two = envelope([op, signedOp({ nonce: nextNonce() })]);
  ok((await stellarAuthorizationsOf(payloadOf(two))) === null, "an envelope with two operations names no authorization (ops.length !== 1)");
  ok((await stellarSignedPaymentOf(payloadOf(two), REQ)) === null, "an envelope with two operations is not a signed payment (ops.length !== 1)");
  ok((await stellarSignedPaymentOf(payloadOf(a), REQ)) !== null, "the same operation alone is a signed payment");
  ok((await stellarAuthorizationsOf(payloadOf("AAAA"))) === null && (await stellarAuthorizationsOf({ payload: {} })) === null, "a malformed or missing envelope names no authorization");

  // Replay key: (network, signer, nonce), not the header bytes.
  const ka = await paymentReplayKeyAsync(fakeReq({ "payment-signature": header(a) }));
  const kb = await paymentReplayKeyAsync(fakeReq({ "payment-signature": header(b) }));
  const kc = await paymentReplayKeyAsync(fakeReq({ "payment-signature": header(envelope([signedOp({ nonce: nextNonce() })])) }));
  const kd = await paymentReplayKeyAsync(fakeReq({ "payment-signature": header(envelope([signedOp({ from: otherBuyer, nonce })])) }));
  ok(/^s2:[0-9a-f]{64}:[0-9a-f]{64}$/.test(String(ka)), `a Stellar payment keys on its signed entry (${String(ka).slice(0, 8)})`);
  ok(ka.split(":")[1] === kb.split(":")[1], "a re-encoded copy keys to the same replay identity");
  ok(ka.split(":")[1] !== kc.split(":")[1] && ka.split(":")[1] !== kd.split(":")[1], "another nonce, or the same nonce from another signer, is another identity");
  ok(ka.split(":")[2] === createHash("sha256").update(header(a)).digest("hex") && ka.split(":")[2] === paymentReplayKey(fakeReq({ "payment-signature": header(a) })).split(":")[2], "the key carries the earlier build's raw-header key as its legacy part");
  const evm = Buffer.from(JSON.stringify({ network: "eip155:8453", payload: { authorization: { nonce: "0xabc", from: "0x" + "1".repeat(40) } } })).toString("base64");
  ok((await paymentReplayKeyAsync(fakeReq({ "x-payment": evm }))) === paymentReplayKey(fakeReq({ "x-payment": evm })), "an EVM payment keys exactly as before");
  const guard = createReplayGuard();
  ok((await guard.begin(ka)) === "ok" && (await guard.begin(kb)) === "inflight", "the replay guard refuses the re-encoded copy while the first runs");
}

// ---- The s2: replay key in ONE process, no shared store ----------------------
// offline-stores cleared REDIS_URL, so every verdict below is the per-process
// path (src/replay-guard.js localKeyOf: a Stellar key on its identity alone).
{
  const { sharedLimitEnabled } = await import("../src/shared-limit.js");
  ok(!sharedLimitEnabled(), "no shared store: the replay guard runs on per-process state");
  const keyOf = async (xdr) => paymentReplayKeyAsync(fakeReq({ "payment-signature": header(xdr) }));
  const nonce = nextNonce();
  const op = signedOp({ nonce });
  const xdr = envelope([op], { seq: "1" });
  const first = await keyOf(xdr);
  const same = await keyOf(xdr);
  const reencoded = await keyOf(envelope([op], { seq: "41" }));
  const other = await keyOf(envelope([signedOp({ nonce: nextNonce() })]));
  const otherSigner = await keyOf(envelope([signedOp({ from: otherBuyer, nonce })]));
  ok(first === same && first !== reencoded && first.split(":")[1] === reencoded.split(":")[1], "the same payment keys alike; a re-encoded copy shares its identity, not its legacy part");
  const g = createReplayGuard();
  ok((await g.begin(first)) === "ok", "the first presentation of a signed Stellar payment runs");
  ok((await g.begin(same)) === "inflight" && (await g.begin(reencoded)) === "inflight", "presented again while the first runs: refused (byte-identical and re-encoded)");
  ok((await g.begin(other)) === "ok" && (await g.begin(otherSigner)) === "ok", "two different payments do not collide (another nonce; the same nonce from another signer)");
  await g.settle(first);
  ok((await g.begin(same)) === "consumed" && (await g.begin(reencoded)) === "consumed", "presented again after it was served: refused as consumed (byte-identical and re-encoded)");
  await g.release(other);
  ok((await g.begin(other)) === "ok", "another payment released unserved runs again, untouched by the served one");
  const g2 = createReplayGuard();
  ok((await g2.begin(reencoded)) === "ok" && (await g2.begin(first)) === "inflight", "a re-encoded copy presented first holds the payment against the original");
  await g2.release(reencoded);
  ok((await g2.begin(first)) === "ok", "a released payment can be presented again");
}

// ---- The claim hooks on a fake resource server ------------------------------
const hooks = { beforeVerify: [], beforeSettle: [], afterSettle: [], settleFailure: [] };
claims.registerSettlementClaimHooks({
  onBeforeVerify: (f) => hooks.beforeVerify.push(f), onBeforeSettle: (f) => hooks.beforeSettle.push(f),
  onAfterSettle: (f) => hooks.afterSettle.push(f), onSettleFailure: (f) => hooks.settleFailure.push(f),
});
claims.registerSettlementClaimRelease({ onSettleFailure: (f) => hooks.settleFailure.push(f) });
const run = async (list, ctx) => { let out; for (const f of list) { const r = await f(ctx); if (r !== undefined) out = r; } return out; };
const ctxFor = (envXdr) => ({ transportContext: { request: { adapter: { req: {} } } }, requirements: { ...REQ }, paymentPayload: payloadOf(envXdr) });

// Horizon stub over landed transactions (hash -> envelope).
const horizonFor = (landed) => async (url) => {
  const tm = url.match(/\/transactions\/([0-9a-f]{64})$/);
  if (tm && landed.has(tm[1])) return { ok: true, json: async () => ({ hash: tm[1], successful: true, envelope_xdr: landed.get(tm[1]) }) };
  return { ok: false, status: 404, json: async () => ({}) };
};
// What lands for a payload: the facilitator's own envelope around the signed op.
const landedOf = (payloadXdr) => {
  const op = sdk.TransactionBuilder.fromXDR(payloadXdr, NET).operations[0];
  const ch = sdk.Keypair.random();
  const t = new sdk.TransactionBuilder(new sdk.Account(ch.publicKey(), "7"), { fee: "100", networkPassphrase: NET })
    .addOperation(sdk.Operation.invokeHostFunction({ func: op.func, auth: op.auth })).setTimeout(60).build();
  t.sign(ch);
  return { hash: t.hash().toString("hex"), envelope_xdr: t.toXDR() };
};

// One request's settle as src/payments.js wires it: a per-settle holder, the
// confirmation on failure, and the success-path claim (ownSettledStellarTx).
// Returns true when the request is answered (a settled 200).
const chain = new Map();
async function settleRequest(ctx, { lands, between = null }) {
  const refusal = await run(hooks.beforeSettle, ctx);
  if (refusal?.abort) { await run(hooks.settleFailure, { ...ctx, error: { errorReason: refusal.reason } }); return false; }
  const holder = `stellar-settle:${Math.random()}`;
  const claimTx = async (tx) => !(await claims.txServedElsewhere(NETWORK, tx, holder));
  const xdr = ctx.paymentPayload.payload.transaction;
  let res;
  const l = landedOf(xdr);
  if (lands && ![...chain.values()].some((e) => e === l.envelope_xdr)) {
    chain.set(l.hash, l.envelope_xdr);
    res = { success: true, transaction: l.hash, network: NETWORK, payer: buyer };
  } else {
    // The entry's nonce is used (or nothing landed): fails fast, then asks the chain.
    const found = await confirmStellarPayment({ signed: await stellarSignedPaymentOf(ctx.paymentPayload, REQ), sinceMs: Date.now() - 60_000, txHash: [...chain.keys()].at(-1) || null, claimTx, waitMs: 0, stepMs: 1, fetchImpl: horizonFor(chain) });
    res = found ? { success: true, transaction: found.transaction, network: NETWORK } : { success: false, errorReason: "nonce_already_used", network: NETWORK };
  }
  // Another request's whole run, after this one landed and before its
  // settle call returned.
  if (between) await between();
  res = await claims.ownSettledStellarTx(res, { network: NETWORK, claimTx, log: () => {} });
  if (res.success === true) { await run(hooks.afterSettle, { ...ctx, result: res }); return true; }
  await run(hooks.settleFailure, { ...ctx, error: res });
  return false;
}

// The reviewer's scenario: one entry sent twice, re-encoded; both reach settle.
{
  claims.__resetSettlementClaims(); chain.clear();
  const op = signedOp({ nonce: nextNonce() });
  const A = ctxFor(envelope([op], { seq: "1" })), B = ctxFor(envelope([op], { seq: "2" }));
  await run(hooks.beforeVerify, A); await run(hooks.beforeVerify, B);
  // A lands; B's settle would fail fast (nonce used) and its confirmation
  // would find A's transaction, all before A's settle call returns.
  let b = null;
  const a = await settleRequest(A, { lands: true, between: async () => { b = await settleRequest(B, { lands: false }); } });
  ok(a === true && b === false, `a re-encoded duplicate of one signed entry gets one answer (A=${a}, B=${b})`);
  const refusal = await run(hooks.beforeSettle, ctxFor(envelope([op], { seq: "3" })));
  ok(refusal?.abort === true && refusal.reason === claims.DUPLICATE_AUTHORIZATION, "after the payment settled, another copy is still refused before the facilitator");
}

// A normal single Stellar payment settles once and is answered.
{
  claims.__resetSettlementClaims(); chain.clear();
  const A = ctxFor(envelope([signedOp({ nonce: nextNonce() })]));
  await run(hooks.beforeVerify, A);
  ok((await settleRequest(A, { lands: true })) === true && chain.size === 1, "a single Stellar payment settles once and is answered");
}

// A definite refusal (nothing landed) releases the claim: a retry proceeds.
{
  claims.__resetSettlementClaims(); chain.clear();
  const op = signedOp({ nonce: nextNonce() });
  const A = ctxFor(envelope([op]));
  await run(hooks.beforeVerify, A);
  ok((await settleRequest(A, { lands: false })) === false, "a settle that lands nothing is not answered");
  const R = ctxFor(envelope([op], { seq: "9" }));
  await run(hooks.beforeVerify, R);
  ok((await settleRequest(R, { lands: true })) === true, "after a definite refusal the claim is released and a retry of the same entry settles");
}

// A settle the settle-sent mark refused (src/hangup-settlement.js, wired in
// src/payments.js through releasingClaimsOnRefusal) was cancelled before the
// facilitator call: the entry claims it took are given back at once, so the
// buyer's retry with the same signed entry is not refused as a duplicate. A
// settle already sent keeps its claims.
{
  const { _setHookFaultsForTest, HOOK_NAMES, SETTLE_MARK_FAILED } = await import("../src/x402-hook-guard.js");
  const hangup = await import("../src/hangup-settlement.js");
  const h = { beforeVerify: [], beforeSettle: [], afterSettle: [], settleFailure: [] };
  const fake = {
    onBeforeVerify: (f) => h.beforeVerify.push(f), onBeforeSettle: (f) => h.beforeSettle.push(f),
    onAfterSettle: (f) => h.afterSettle.push(f), onSettleFailure: (f) => h.settleFailure.push(f),
  };
  claims.registerSettlementClaimHooks(fake);
  hangup.registerSettleSentHook(claims.releasingClaimsOnRefusal(fake, { sentBefore: hangup.settleSentWhileConnected }));
  claims.registerSettlementClaimRelease(fake);
  // @x402/core stops the chain at the first abort.
  const chainRun = async (ctx) => { for (const f of h.beforeSettle) { const r = await f(ctx); if (r?.abort) return r; } return null; };
  const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

  claims.__resetSettlementClaims();
  const op = signedOp({ nonce: nextNonce() });
  const A = ctxFor(envelope([op], { seq: "1" }));
  _setHookFaultsForTest([HOOK_NAMES.settleSent]);
  const refused = await quiet(() => chainRun(A));
  _setHookFaultsForTest(null);
  ok(refused?.abort === true && refused.reason === SETTLE_MARK_FAILED, `the settle-sent mark's throw refuses the settle (${refused?.reason})`);
  const st = claims.settleClaimStateOf(A.transportContext.request.adapter.req);
  ok(st && !st.nonceKey && st.nonceKeys.length === 0, "the refused request holds no entry claim");
  const retry = ctxFor(envelope([op], { seq: "2" }));
  const r2 = await chainRun(retry);
  ok(r2 === null && hangup.settleSentWhileConnected(retry.transportContext.request.adapter.req), `a retry with the same signed entry reaches the settle at once (${r2?.reason || "settles"})`);
  const r3 = await chainRun(ctxFor(envelope([op], { seq: "3" })));
  ok(r3?.abort === true && r3.reason === claims.DUPLICATE_AUTHORIZATION, "while the retry holds the entry, a third copy is still refused");

  // A request whose settle was already sent once keeps its claims, even if a
  // later pass through the mark refuses.
  claims.__resetSettlementClaims();
  const op2 = signedOp({ nonce: nextNonce() });
  const S = ctxFor(envelope([op2]));
  ok((await chainRun(S)) === null, "a first settle pass is sent");
  _setHookFaultsForTest([HOOK_NAMES.settleSent]);
  const again = await quiet(() => chainRun(S));
  _setHookFaultsForTest(null);
  ok(again?.abort === true, "a later refused pass on the same request");
  const held = await chainRun(ctxFor(envelope([op2], { seq: "5" })));
  ok(held?.abort === true && held.reason === claims.DUPLICATE_AUTHORIZATION, "a settle that may have been sent keeps its entry claims");
}

// The success-path claim: a transaction another request already serves is not
// answered again. Here B's confirmation took A's transaction first (as when B
// reached settle outside A's claim), so A's own success must not answer.
{
  claims.__resetSettlementClaims(); chain.clear();
  const xdr = envelope([signedOp({ nonce: nextNonce() })]);
  const l = landedOf(xdr);
  ok(await claims.txServedElsewhere(NETWORK, l.hash, "request-B") === false, "request B holds the transaction");
  const res = await claims.ownSettledStellarTx({ success: true, transaction: l.hash, network: NETWORK, payer: buyer }, { network: NETWORK, claimTx: async (tx) => !(await claims.txServedElsewhere(NETWORK, tx, "request-A")), log: () => {} });
  ok(res.success === false && res.errorReason === claims.TX_SERVED_ELSEWHERE && !res.transaction, `a settled transaction another request already serves answers as a failed settle (${res.errorReason})`);
  const mine = await claims.ownSettledStellarTx({ success: true, transaction: l.hash, network: NETWORK }, { network: NETWORK, claimTx: async (tx) => !(await claims.txServedElsewhere(NETWORK, tx, "request-B")), log: () => {} });
  ok(mine.success === true, "the request that holds the transaction is answered");
  const flaky = await claims.ownSettledStellarTx({ success: true, transaction: "ab".repeat(32), network: NETWORK }, { network: NETWORK, claimTx: async () => { throw new Error("store down"); }, log: () => {} });
  ok(flaky.success === true, "a claim store that throws leaves the sale standing");
}

// The caller path: src/payments.js runs the success-path claim on its settle.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/payments.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("class StellarConfirmingFacilitatorClient"), src.indexOf("if (stellarEnabled)"));
  ok(/const owned = await ownSettledStellarTx\(res, \{ network, claimTx \}\);\s*if \(owned !== res\) return owned;/.test(body), "the Stellar settle in src/payments.js answers through the success-path claim");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/const replayKey = await paymentReplayKeyAsync\(req\);/.test(server), "src/server.js keys the replay guard with paymentReplayKeyAsync");
  ok(/registerSettleSentHook\(releasingClaimsOnRefusal\(server, \{ sentBefore: settleSentWhileConnected \}\)\);/.test(src), "src/payments.js registers the settle-sent mark through releasingClaimsOnRefusal");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

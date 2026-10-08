// tempo-confirm (src/tempo-confirm.js) — chain-truth fallback for relay
// broadcast failures, the stellar-confirm doctrine on the MPP rail.
//
// Built from a LIVE incident (2026-08-20): Tempo's relay reported
// `invalid_payment: "Broadcast transaction hash does not match the signed
// transaction"` for two payments that had SETTLED on-chain — the buyer
// (AgentCore/Privy) signs with a yParity-style v byte the node normalizes,
// so the canonical txid stops matching keccak(submitted bytes). The buyer
// was told 402 and retried into a double charge.
//
// The fixture below is REAL: the on-chain raw form of
// 0x753f5655f3823e1a2cea84c9afca8d39b63669059b27120953e2da0cb78abc4f (Tempo
// mainnet, one of that incident's two landed payments, public chain data).
// Its submitted form ended v=0x01; the node stored v=0x1c. candidateTxIds
// must recover the REAL txid from the reconstructed submitted bytes — the
// whole fix hangs on that derivation, so it is pinned against chain truth,
// not a synthetic vector.
import express from "express";
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";
import { Challenge, Credential } from "mppx";
import { candidateTxIds, confirmTempoSettlement, tempoPushSender } from "../src/tempo-confirm.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

// Real on-chain raw tx (normalized form, ends 1c). Public data.
const ONCHAIN_RAW = "0x76f90110821079808447868c008306b9c2f87ef87c9420c000000000000000000000b9537d11c60e8b5080b86495777d59000000000000000000000000abf4fabd7c416fb67202e5f9002389fc75e2a9d000000000000000000000000000000000000000000000000000000000000003e8ef1ed71201faae27dd2de7e4657aff0000000000000000000055f3b3923b81d7c0a0da0e157163014a9f525ee19dca60039586bc2cc0fd5eda90326cd4c891ba57c080846a866f63809420c000000000000000000000b9537d11c60e8b5080c0b8419e35bf47532bcce30d028b13020ca217c47f348468d6a6bb129f851672eac35b337ed106315204c48b6daac0eac04bb34e03b7964c1ce4294b1b76c4a1ddf78a1c";
const REAL_TXID = keccak256(ONCHAIN_RAW);
const SUBMITTED = ONCHAIN_RAW.slice(0, -2) + "01"; // what a yParity signer submits

// ---------------------------------------------------------------------------
// candidateTxIds
// ---------------------------------------------------------------------------
{
  const c = candidateTxIds(SUBMITTED);
  ok(c.length === 2, "candidates: yParity-tailed tx yields identity + v-swapped twin");
  ok(c[0] === keccak256(SUBMITTED), "candidates: first is keccak of the submitted bytes");
  ok(c[1] === REAL_TXID, "candidates: v-swap (01 -> 1c) recovers the REAL on-chain txid of the incident tx");

  const c2 = candidateTxIds(ONCHAIN_RAW);
  ok(c2.length === 2 && c2[0] === REAL_TXID && c2[1] === keccak256(SUBMITTED), "candidates: the reverse swap (1c -> 01) also works — direction-agnostic");

  ok(candidateTxIds("0x02f8" + ONCHAIN_RAW.slice(6)).length === 0, "candidates: a non-0x76 envelope yields nothing (never hash foreign tx types)");
  const weirdV = ONCHAIN_RAW.slice(0, -2) + "ff";
  const c3 = candidateTxIds(weirdV);
  ok(c3.length === 1 && c3[0] === keccak256(weirdV), "candidates: an unrecognisable v byte gets only the identity candidate (no blind byte edits)");
  ok(candidateTxIds("0x76").length === 0 && candidateTxIds(null).length === 0 && candidateTxIds("garbage").length === 0, "candidates: junk input yields nothing, never throws");
}

// ---------------------------------------------------------------------------
// confirmTempoSettlement — stubbed RPC, real credential codec
// ---------------------------------------------------------------------------
const SECRET = "test-confirm-secret";
const CURRENCY = "0x20C000000000000000000000b9537d11c60E8b50";
const TREASURY = "0xAbF4FABd7C416fb67202e5F9002389fc75E2a9d0";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad32 = (addr) => "0x" + addr.slice(2).toLowerCase().padStart(64, "0");

// The challenge id of the most recent buildCredential(): arguments evaluate
// left to right, so a receiptFor() written after buildCredential() in the same
// call is bound to that credential's challenge.
let lastChallengeId = null;
const { encode: encodeMemo } = await import("../node_modules/mppx/dist/tempo/Attribution.js");
const memoFor = (challengeId) => encodeMemo({ challengeId, serverId: "agent402.tools", clientId: "buyer" });
const TRANSFER_WITH_MEMO_TOPIC = "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0";
function buildCredential(o = {}) {
  const challenge = Challenge.from({
    realm: o.realm ?? "agent402.tools",
    method: "tempo",
    intent: "charge",
    expires: new Date(Date.now() + (o.ttlMs ?? 60_000)),
    request: { amount: o.amount ?? "1000", currency: o.currency ?? CURRENCY, decimals: 6, recipient: o.recipient ?? TREASURY, methodDetails: { chainId: 4217 } },
    secretKey: SECRET,
  });
  lastChallengeId = challenge.id;
  return Credential.serialize({ challenge, payload: o.payload ?? { type: "transaction", signature: SUBMITTED } });
}

// A TIP-20 transferWithMemo emits Transfer and TransferWithMemo; the confirm
// reads the memo event. `memo` defaults to one bound to the last credential.
function receiptFor(txId, { status = "0x1", token = CURRENCY, to = TREASURY, amount = 1000n, memo = memoFor(lastChallengeId), withMemoEvent = true, blockNumber = "0x10" } = {}) {
  const from = pad32("0x24E6A249111aE0CC8ea09f487A114f7e7Ef15e12");
  const data = "0x" + amount.toString(16).padStart(64, "0");
  return {
    status,
    blockNumber,
    transactionHash: txId,
    logs: [
      { address: token, topics: [TRANSFER_TOPIC, from, pad32(to)], data },
      ...(withMemoEvent ? [{ address: token, topics: [TRANSFER_WITH_MEMO_TOPIC, from, pad32(to), memo], data }] : []),
    ],
  };
}

/** Stub RPC: `receipts` maps txId -> receipt (or a function for per-call behavior). */
function stubFetch(receipts, log = []) {
  return async (url, init) => {
    const req = JSON.parse(init.body);
    log.push(req.method);
    const r = receipts[req.params?.[0]];
    const result = typeof r === "function" ? r() : (r ?? null);
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
}

{
  const found = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID) }), attempts: 1 });
  ok(found?.txId === REAL_TXID, "confirm: settled tx found via the v-swapped candidate (the incident's exact shape)");
  ok(found?.amountAtomic === 1000n, "confirm: the on-chain transfer amount is reported");

  const none = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({}), attempts: 1 });
  ok(none === null, "confirm: no receipt anywhere -> null (the relay failure stands, buyer not served)");

  const reverted = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID, { status: "0x0" }) }), attempts: 1 });
  ok(reverted === null, "confirm: a REVERTED transaction never confirms (status must be 0x1)");

  const wrongTo = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID, { to: "0x1111111111111111111111111111111111111111" }) }), attempts: 1 });
  ok(wrongTo === null, "confirm: a transfer to someone else's address never confirms");

  const wrongToken = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID, { token: "0x2222222222222222222222222222222222222222" }) }), attempts: 1 });
  ok(wrongToken === null, "confirm: a transfer in a different token never confirms (anyone can emit Transfer events)");

  const underpaid = await confirmTempoSettlement(buildCredential({ amount: "5000" }), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID, { amount: 1000n }) }), attempts: 1 });
  ok(underpaid === null, "confirm: an on-chain amount below the challenge amount never confirms");

  // Bound to THIS challenge: a settled transfer made for another purchase
  // must not vouch for a fresh challenge (its bytes can be re-attached).
  const otherCred = buildCredential({ ttlMs: 120_000 }); const otherMemo = memoFor(lastChallengeId);
  const stolen = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID, { memo: otherMemo }) }), attempts: 1 });
  ok(otherCred && stolen === null, "confirm: a settled transfer whose memo is bound to a DIFFERENT challenge never confirms");
  const noMemo = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID, { withMemoEvent: false }) }), attempts: 1 });
  ok(noMemo === null, "confirm: a plain Transfer with no MPP memo never confirms");
  const untagged = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID, { memo: "0x" + "00".repeat(25) + memoFor(lastChallengeId).slice(-14) }) }), attempts: 1 });
  ok(untagged === null, "confirm: a memo carrying the right nonce but no MPP tag never confirms");

  const rpcDown = await confirmTempoSettlement(buildCredential(), { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), attempts: 1 });
  ok(rpcDown === null, "confirm: RPC failure -> null, fails closed, never throws");

  const notTx = await confirmTempoSettlement(buildCredential({ payload: { type: "hash", hash: `0x${"ab".repeat(32)}` } }), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID) }), attempts: 1 });
  ok(notTx === null, "confirm: a non-transaction payload has no bytes to derive from -> null");

  // Poll: not indexed on the first attempt, found on the second.
  let calls = 0;
  const late = await confirmTempoSettlement(buildCredential(), {
    fetchImpl: stubFetch({ [REAL_TXID]: () => (++calls >= 2 ? receiptFor(REAL_TXID) : null) }),
    attempts: 3, delayMs: 1,
  });
  ok(late?.txId === REAL_TXID, "confirm: a tx the RPC has not indexed yet is found by the short poll");
}

// ---------------------------------------------------------------------------
// Gate integration: broadcast fails -> confirm decides served vs 402.
// ---------------------------------------------------------------------------
process.env.TEMPO_API_KEY = "test-key";
process.env.TEMPO_RECIPIENT_ADDRESS = TREASURY;
process.env.TEMPO_CURRENCY = CURRENCY;
const { createTempoGate } = await import("../src/mpp-tempo.js");

const GATE = { secretKey: SECRET, realm: "agent402.tools", priceFor: () => ({ priceUsd: 0.001, identityBound: false }) };
async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

{
  // Confirmed on-chain -> the buyer is SERVED despite the relay's verdict.
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => ({ ok: false, error: "Broadcast transaction hash does not match the signed transaction", reason: "invalid_payment" }),
    confirmSettlement: async () => ({ txId: REAL_TXID, amountAtomic: 1000n }),
  }));
  app.get("/paid", (req, res) => res.status(200).json({ result: "ok" }));
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildCredential() } });
  const body = await res.json();
  ok(res.status === 200, "gate: relay-failed but chain-confirmed -> 200, buyer served");
  ok(body.result === "ok", "gate: the handler's original body is delivered");
  const receiptHeader = res.headers.get("payment-receipt");
  ok(!!receiptHeader && receiptHeader.includes(REAL_TXID.slice(2, 10)) || !!receiptHeader, "gate: Payment-Receipt attached on the confirmed path");
  server.close();
}

{
  // NOT confirmed -> exactly the pre-fix behavior: 402 problem, body discarded.
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => ({ ok: false, error: "relay temporarily unavailable", reason: "relay temporarily unavailable" }),
    confirmSettlement: async () => null,
  }));
  app.get("/paid", (req, res) => res.status(200).json({ result: "ok" }));
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildCredential() } });
  const body = await res.json();
  ok(res.status === 402, "gate: broadcast failed and chain says nothing landed -> 402 (unchanged pre-fix behavior)");
  ok(body.result === undefined, "gate: the handler body is discarded on the unconfirmed path");
  server.close();
}

{
  // A confirm that THROWS must not change the verdict (fail closed).
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => ({ ok: false, error: "boom", reason: "boom" }),
    confirmSettlement: async () => { throw new Error("rpc exploded"); },
  }));
  app.get("/paid", (req, res) => res.status(200).json({ result: "ok" }));
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildCredential() } });
  ok(res.status === 402, "gate: a throwing confirm fails closed to the 402");
  server.close();
}

{
  // Broadcast SUCCESS must never invoke confirm at all (no wasted RPC).
  let confirmCalled = false;
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => ({ ok: true, receipt: { method: "tempo", status: "success", reference: "0xdeadbeef", timestamp: new Date().toISOString() } }),
    confirmSettlement: async () => { confirmCalled = true; return null; },
  }));
  app.get("/paid", (req, res) => res.status(200).json({ result: "ok" }));
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildCredential() } });
  ok(res.status === 200 && confirmCalled === false, "gate: a successful broadcast never consults the chain fallback");
  server.close();
}

// ---------------------------------------------------------------------------
// Early confirm: the chain proves the payment before the relay replies.
// ---------------------------------------------------------------------------
{
  // Chain first: the buyer is answered without waiting for the relay.
  let relayDone = false;
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: () => new Promise((r) => setTimeout(() => { relayDone = true; r({ ok: true, receipt: { method: "tempo", status: "success", reference: "0xrelay", timestamp: new Date().toISOString() } }); }, 1500)),
    earlyConfirm: async () => { await new Promise((r) => setTimeout(r, 50)); return { txId: REAL_TXID, amountAtomic: 1000n }; },
  }));
  app.get("/paid", (req, res) => res.status(200).json({ result: "ok" }));
  const { server, url } = await listen(app);
  const t0 = Date.now();
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildCredential() } });
  const ms = Date.now() - t0;
  const body = await res.json();
  ok(res.status === 200 && body.result === "ok" && ms < 1200 && !relayDone, `early: a chain-confirmed payment is answered before the relay replies (${ms} ms)`);
  ok(String(res.headers.get("payment-receipt") || "").length > 0, "early: the answer carries a Payment-Receipt");
  await new Promise((r) => setTimeout(r, 1600));
  server.close();
}
{
  // Relay first: its receipt answers, and the watcher is told to stop.
  let stopSeen = null;
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => ({ ok: true, receipt: { method: "tempo", status: "success", reference: "0xrelay", timestamp: new Date().toISOString() } }),
    earlyConfirm: async (auth, relayAnswered) => { await new Promise((r) => setTimeout(r, 100)); stopSeen = relayAnswered(); return null; },
  }));
  app.get("/paid", (req, res) => res.status(200).json({ result: "ok" }));
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildCredential() } });
  await new Promise((r) => setTimeout(r, 150));
  ok(res.status === 200 && stopSeen === true, "early: when the relay answers first its verdict stands and the watcher sees it should stop");
  server.close();
}
{
  // Neither proves it: relay failed, early watcher found nothing, fallback confirm finds nothing -> 402.
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => { await new Promise((r) => setTimeout(r, 50)); return { ok: false, error: "relay temporarily unavailable", reason: "relay temporarily unavailable" }; },
    earlyConfirm: async () => null,
    confirmSettlement: async () => null,
  }));
  app.get("/paid", (req, res) => res.status(200).json({ result: "ok" }));
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildCredential() } });
  const body = await res.json();
  ok(res.status === 402 && body.result === undefined, "early: no proof from relay or chain is still a 402 with the body discarded");
  server.close();
}
{
  // A throwing watcher never decides anything.
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => { await new Promise((r) => setTimeout(r, 50)); return { ok: false, error: "boom", reason: "boom" }; },
    earlyConfirm: async () => { throw new Error("rpc exploded"); },
    confirmSettlement: async () => null,
  }));
  app.get("/paid", (req, res) => res.status(200).json({ result: "ok" }));
  const { server, url } = await listen(app);
  const res = await fetch(`${url}/paid`, { headers: { Authorization: buildCredential() } });
  ok(res.status === 402, "early: a throwing watcher fails closed to the relay's verdict");
  server.close();
}
{
  // The watcher's own knobs: it stops before reading once the relay answered, and waits before its first read.
  let reads = 0;
  const counting = async (url, init) => { reads++; return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: null }) }; };
  const stopped = await confirmTempoSettlement(buildCredential(), { fetchImpl: counting, attempts: 5, delayMs: 1, stop: () => true });
  ok(stopped === null && reads === 0, "early: a watcher told to stop makes no RPC read");
  const t0 = Date.now();
  await confirmTempoSettlement(buildCredential(), { fetchImpl: counting, attempts: 1, initialDelayMs: 120 });
  ok(Date.now() - t0 >= 110 && reads > 0, "early: the first read waits initialDelayMs");
}

{
  // Finality: the early watcher answers only once the payment's block is finalized.
  const fin = (n) => ({ number: "0x" + n.toString(16) });
  const notYet = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID), finalized: fin(0x0f) }), attempts: 1, requireFinalized: true });
  ok(notYet === null, "finality: a payment in a block past the finalized head is not yet settled");
  const done = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID), finalized: fin(0x10) }), attempts: 1, requireFinalized: true });
  ok(done?.txId === REAL_TXID, "finality: a payment in a finalized block is settled");
  let head = 0x0f;
  const later = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID), finalized: () => fin(head++) }), attempts: 3, delayMs: 1, requireFinalized: true });
  ok(later?.txId === REAL_TXID, "finality: the watcher answers once finality catches up with the payment's block");
  const blind = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID) }), attempts: 1, requireFinalized: true });
  ok(blind === null, "finality: an unreadable finalized head never counts as settled");
  const legacy = await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID) }), attempts: 1 });
  ok(legacy?.txId === REAL_TXID, "finality: the post-failure check keeps its original behavior");
}

{
  // Diagnostics: the trace records reads, when the payment was seen, the finality lag and the first error.
  const fin = (n) => ({ number: "0x" + n.toString(16) });
  const t1 = {};
  await confirmTempoSettlement(buildCredential(), { fetchImpl: stubFetch({ [REAL_TXID]: receiptFor(REAL_TXID), finalized: fin(0x0f) }), attempts: 1, requireFinalized: true, trace: t1 });
  ok(t1.reads >= 1 && typeof t1.seenAt === "number" && t1.finalizedLag === 1 && !t1.error, `trace: reads, seen time and a one-block finality lag are recorded (${JSON.stringify(t1)})`);
  const t2 = {};
  await confirmTempoSettlement(buildCredential(), { fetchImpl: async () => { throw new Error("rpc 403"); }, attempts: 1, requireFinalized: true, trace: t2 });
  ok(t2.reads >= 1 && /rpc 403/.test(t2.error || "") && t2.seenAt == null, "trace: a failing read is recorded as the error, nothing seen");
}
{
  // The settle line says what the watcher saw when the relay answered first.
  const logs = []; const orig = console.log; console.log = (...a) => { logs.push(a.join(" ")); };
  const app = express();
  app.use(createTempoGate({
    ...GATE,
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => { await new Promise((r) => setTimeout(r, 60)); return { ok: true, receipt: { method: "tempo", status: "success", reference: "0xrelay", timestamp: new Date().toISOString() } }; },
    earlyConfirm: async (auth, relayAnswered, trace) => { trace.reads = 2; trace.error = "rpc 403"; return null; },
  }));
  app.get("/paid", (req, res) => res.status(200).json({ result: "ok" }));
  const { server, url } = await listen(app);
  await fetch(`${url}/paid`, { headers: { Authorization: buildCredential() } });
  console.log = orig; server.close();
  ok(logs.some((l) => /settled GET \/paid .* watch=reads:2 err:rpc 403/.test(l)), "trace: the settle log names the watcher's reads and error when the relay answered first");
}

// ---------------------------------------------------------------------------
// Wiring pin: server.js must actually pass confirmSettlement to the gate —
// the gate's default is null (so offline tests never hit the network), which
// means the protection exists ONLY if server.js wires it. A green suite with
// the wiring dropped is the dead-fix class this repo keeps getting bitten by.
// ---------------------------------------------------------------------------
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/confirmSettlement:\s*confirmTempoSettlement/.test(src), "wiring: server.js passes confirmSettlement: confirmTempoSettlement to createTempoGate");
  ok(/earlyConfirm:[\s\S]{0,300}confirmTempoSettlement\(auth, \{[^}]*stop: relayAnswered, requireFinalized: true, trace/.test(src), "wiring: server.js passes an earlyConfirm that reads the chain, waits for finality, stops when the relay answers and reports what it saw");
  ok(/earlyConfirm: String\(process\.env\.TEMPO_EARLY_CONFIRM \|\| ""\)\.toLowerCase\(\) !== "on" \? null/.test(src), "wiring: the early watcher is off unless TEMPO_EARLY_CONFIRM=on");
  ok(/from "\.\/tempo-confirm\.js"/.test(src), "wiring: server.js imports tempo-confirm.js");
}

// ---------------------------------------------------------------------------
// tempoPushSender: the sender of a PUSH credential's transfer, read from the
// chain. The credential's `source` is client-written; the ledger and refund
// rows name this instead, or nobody.
// ---------------------------------------------------------------------------
{
  const CUR = "0x20c000000000000000000000b9537d11c60e8b50";
  const TO = "0x000000000000000000000000000000000000dead";
  const FROM = "0x7777777777777777777777777777777777777777";
  const ch = Challenge.from({ realm: "r.example", method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000), request: { amount: "1000", currency: CUR, decimals: 6, recipient: TO, methodDetails: { chainId: 4217 } }, secretKey: "k" });
  const HASH = `0x${"cd".repeat(32)}`;
  const cred = (o = {}) => Credential.serialize({ challenge: ch, payload: o.payload ?? { hash: HASH, type: "hash" }, source: "did:pkh:eip155:4217:0x1111111111111111111111111111111111111111" });
  const tag = keccak256(new TextEncoder().encode("mpp")).slice(2, 10);
  const memoFor = (id) => `0x${tag}01${"0".repeat(40)}${keccak256(new TextEncoder().encode(id)).slice(2, 16)}`;
  const pad = (a) => `0x${"0".repeat(24)}${a.slice(2)}`;
  const log = (o = {}) => ({ address: o.address ?? CUR, topics: [TRANSFER_WITH_MEMO_TOPIC, pad(o.from ?? FROM), pad(o.to ?? TO), o.memo ?? memoFor(ch.id)], data: `0x${(o.value ?? 1000n).toString(16).padStart(64, "0")}` });
  let answer = null; const asked = [];
  const fetchImpl = async (_url, init) => { const b = JSON.parse(init.body); asked.push(b.params[0]); if (answer instanceof Error) throw answer; return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answer })); };
  const run = (c = cred()) => tempoPushSender(c, { rpcUrl: "http://stub", fetchImpl });
  answer = { status: "0x1", logs: [log()] };
  ok(await run() === FROM && asked.at(-1) === HASH, "push sender: the TransferWithMemo sender of the named transaction, not the credential's source");
  answer = { status: "0x1", logs: [log({ memo: memoFor("another-challenge") })] };
  ok(await run() === null, "push sender: a transfer bound to another challenge names nobody");
  answer = { status: "0x1", logs: [log({ to: "0x000000000000000000000000000000000000beef" })] };
  ok(await run() === null, "push sender: a transfer to another recipient names nobody");
  answer = { status: "0x1", logs: [log({ value: 999n })] };
  ok(await run() === null, "push sender: an underpaying transfer names nobody");
  answer = { status: "0x1", logs: [log({ address: "0x20c0000000000000000000000000000000000001" })] };
  ok(await run() === null, "push sender: a transfer in another token names nobody");
  answer = { status: "0x0", logs: [log()] };
  ok(await run() === null, "push sender: a reverted transaction names nobody");
  answer = null;
  ok(await run() === null, "push sender: no receipt names nobody");
  answer = new Error("down");
  ok(await run() === null, "push sender: an RPC failure names nobody (never throws)");
  const n = asked.length;
  ok(await run(cred({ payload: { signature: "0x76ab", type: "transaction" } })) === null && await tempoPushSender("Payment junk", { fetchImpl }) === null && asked.length === n, "push sender: a pull credential or junk is not read at all");
}

console.log(`\n${pass} passed, 0 failed`);
process.exit(0);

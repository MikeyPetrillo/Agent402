// The stored answer of a payment whose settle chain ended unconfirmed
// (src/idempotency.js keepUnconfirmed), driven through the real middleware:
//   - kept under the payment's identity (network, signed payer, nonce), so the
//     same authorization re-encoded or naming another `resource` gets it back
//     with nothing run; another nonce runs;
//   - kept until the authorization's validBefore plus a minute when that is
//     later than a day (at most 30 days), a day when it names none;
//   - replayed only under the payer's own signature: a header naming the same
//     identity with no signature or another one takes the normal path and
//     leaves the payer's answer in place; for a signed transaction, its
//     decoded bytes;
//   - on the shared store (a real Redis, REDIS_URL; required under CI): the
//     entry carries that TTL in Redis, another container replays it, and it
//     is gone once the TTL has passed.
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { randomBytes } from "node:crypto";
import express from "express";
import { createIdempotency, unconfirmedKeyOf, unconfirmedReplayMs, unconfirmedSignatureOf } from "../src/idempotency.js";
import { createLocalIdempotencyStore, createIdempotencyStore } from "../src/idempotency-store.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const NET = "eip155:8453";
const PAYER = `0x${randomBytes(20).toString("hex")}`;

const GOOD_SIG = `0x${"ab".repeat(65)}`;
const payloadOf = ({ nonce, validBefore, resource = "https://agent402.tools/api/memory" }) => ({
  x402Version: 2, resource: { url: resource }, accepted: { scheme: "exact", network: NET, amount: "1000", payTo: `0x${"bb".repeat(20)}`, asset: `0x${"cc".repeat(20)}` },
  payload: { signature: GOOD_SIG, authorization: { from: PAYER, to: `0x${"bb".repeat(20)}`, value: "1000", validAfter: "0", validBefore: String(validBefore), nonce } },
});
const enc = (o, space = 0) => Buffer.from(JSON.stringify(o, null, space)).toString("base64");
const newNonce = () => `0x${randomBytes(32).toString("hex")}`;

// One server: the middleware, then a stand-in for the paywall that answers
// the unconfirmed 402 the way src/payments.js leaves it on the request.
async function serve(store) {
  const runs = { n: 0 };
  const app = express();
  app.use(express.json());
  app.use(createIdempotency({ isCatalogRoute: () => true, store }));
  app.post("/api/memory", (req, res) => {
    runs.n++;
    const p = JSON.parse(Buffer.from(req.header("payment-signature"), "base64").toString("utf8"));
    // The verify step: a payment without the payer's signature is refused.
    // It leaves an unconfirmed answer of its own on the request, so a store
    // step that let another signature replace the payer's would show.
    if (String(p.payload?.signature || "").toLowerCase() !== GOOD_SIG) {
      req.__a402UnconfirmedAnswer = { body: { reason: "settlement-unconfirmed", impostor: true }, validBefore: p.payload?.authorization?.validBefore };
      return res.status(402).json({ error: "invalid_payment", reason: "invalid_exact_evm_payload_signature" });
    }
    const body = { reason: "settlement-unconfirmed", retry: "check-wallet", hint: "Do not sign a new authorization." };
    req.__a402UnconfirmedAnswer = { body, receipt: enc({ success: false, errorReason: "settlement_unconfirmed" }), validBefore: p.payload.authorization.validBefore };
    res.status(402).json(body);
  });
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  const send = async (header, body = { key: "k" }) => {
    const r = await fetch(`${url}/api/memory`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": header }, body: JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, replayed: r.headers.get("x-replayed-answer"), receipt: r.headers.get("payment-response"), text };
  };
  return { runs, send, close: () => new Promise((r) => srv.close(r)) };
}
// Let the finish-time write land.
const settle = () => sleep(50);
const unsignedOf = (p) => { const { signature, ...rest } = p.payload; void signature; return { ...p, payload: rest }; };
const resignedOf = (p) => ({ ...p, payload: { ...p.payload, signature: `0x${"22".repeat(65)}` } });

const realNow = Date.now;
// ---- per process -----------------------------------------------------------
{
  const local = createLocalIdempotencyStore({ maxEntries: 100 });
  const s = await serve(local);
  try {
    const vb = Math.floor(realNow() / 1000) + 10 * 86_400;
    const p = payloadOf({ nonce: newNonce(), validBefore: vb });
    const header = enc(p);
    const first = await s.send(header);
    await settle();
    ok(first.status === 402 && s.runs.n === 1, "the first send runs and is answered unconfirmed");
    const again = [await s.send(header), await s.send(enc(p, 2)), await s.send(enc({ payload: p.payload, ...p })), await s.send(enc({ ...p, resource: { url: "https://agent402.tools/api/other?x=1" } }), { key: "other" })];
    ok(again.every((r) => r.status === 402 && r.replayed === "1" && /settlement-unconfirmed/.test(r.text) && r.receipt) && s.runs.n === 1,
      `the same authorization as sent, re-spaced, re-ordered, and with another resource and body: the stored answer, nothing run (${again.map((r) => `${r.status}/${r.replayed}`).join(" ")}; ${s.runs.n} runs)`);
    const upper = await s.send(enc({ ...p, payload: { ...p.payload, signature: GOOD_SIG.toUpperCase().replace("0X", "0x") } }));
    ok(upper.replayed === "1" && s.runs.n === 1, "the same signature in upper-case hex replays");
    // Another header naming the same (network, payer, nonce) without the payer's signature.
    const unsigned = await s.send(enc(unsignedOf(p)));
    await settle();
    ok(unsigned.status === 402 && unsigned.replayed !== "1" && !/settlement-unconfirmed/.test(unsigned.text) && /invalid_exact_evm_payload_signature/.test(unsigned.text) && s.runs.n === 2,
      `an unsigned header naming the payment's identity: not the stored answer, the normal refusal (${unsigned.status}/${unsigned.replayed}; ${s.runs.n} runs)`);
    const wrong = await s.send(enc(resignedOf(p)));
    await settle();
    ok(wrong.replayed !== "1" && /invalid_exact_evm_payload_signature/.test(wrong.text) && s.runs.n === 3, "a header with another signature for the same identity: the normal refusal");
    const own = await s.send(enc(p, 4));
    ok(own.status === 402 && own.replayed === "1" && /settlement-unconfirmed/.test(own.text) && !/impostor/.test(own.text) && s.runs.n === 3, "the payer's own re-send still gets its stored answer after those");
    // An unsigned header that arrives first keeps nothing, so the payer's own
    // payment that follows keeps and replays its answer.
    const first2 = payloadOf({ nonce: newNonce(), validBefore: vb });
    await s.send(enc(unsignedOf(first2))); await settle();
    await s.send(enc(first2)); await settle();
    const own2 = await s.send(enc(first2, 1));
    ok(own2.replayed === "1" && !/impostor/.test(own2.text), "an unsigned header sent first stores nothing; the payer's answer is kept and replayed");
    s.runs.n = 1;
    const other = await s.send(enc(payloadOf({ nonce: newNonce(), validBefore: vb })));
    await settle();
    ok(other.status === 402 && other.replayed !== "1" && s.runs.n === 2, "control: another nonce is another payment and runs");
    const otherPayer = enc({ ...p, payload: { ...p.payload, authorization: { ...p.payload.authorization, from: `0x${"ee".repeat(20)}` } } });
    const op = await s.send(otherPayer);
    await settle();
    ok(op.replayed !== "1" && s.runs.n === 3, "control: the same nonce signed by another payer is another payment");
    // A day and an hour later, before validBefore: still kept.
    Date.now = () => realNow() + DAY + 3_600_000;
    const later = await s.send(enc(p, 1));
    ok(later.status === 402 && later.replayed === "1" && s.runs.n === 3, `a re-send after a day, before validBefore: the stored answer (${later.status}/${later.replayed})`);
    // A short validBefore is gone a day later; past validBefore plus a minute the long one is too.
    Date.now = realNow;
    const short = payloadOf({ nonce: newNonce(), validBefore: Math.floor(realNow() / 1000) + 300 });
    await s.send(enc(short)); await settle();
    const runsShort = s.runs.n;
    Date.now = () => realNow() + DAY + 3_600_000;
    const shortLater = await s.send(enc(short));
    ok(shortLater.replayed !== "1" && s.runs.n === runsShort + 1, "control: an authorization that expired long ago is not kept past its validBefore plus a minute");
    Date.now = () => realNow() + 10 * DAY + 120_000;
    const expired = await s.send(enc(p));
    ok(expired.replayed !== "1", "past the authorization's validBefore plus a minute the answer is no longer kept");
    Date.now = realNow;
    ok(unconfirmedReplayMs(Math.floor(realNow() / 1000) + 90 * 86_400) === 30 * DAY && unconfirmedReplayMs(null) === DAY, "at most 30 days; a day when no validBefore is named");
    const fake = (h) => ({ header: (n) => (String(n).toLowerCase() === "payment-signature" ? h : undefined) });
    ok(unconfirmedKeyOf(fake(enc(p)), enc(p)) === unconfirmedKeyOf(fake(enc(p, 3)), enc(p, 3)) && unconfirmedKeyOf(fake("not-a-payment"), "not-a-payment") !== unconfirmedKeyOf(fake("other-text"), "other-text"),
      "the key is the payment's identity; an unreadable credential keys on its text");
    // A signed transaction: the digest is of its decoded bytes. A legacy
    // Solana transaction (one signature, then its message): B is A's message
    // under another signature, one payment to the replay guard.
    const message = Buffer.concat([Buffer.from([1, 0, 1, 2]), randomBytes(64), randomBytes(32), Buffer.from([0])]);
    const txA = Buffer.concat([Buffer.from([1]), randomBytes(64), message]);
    const txB = Buffer.concat([Buffer.from([1]), randomBytes(64), message]);
    const svm = (tx, url = false) => { const t = tx.toString("base64"); return enc({ x402Version: 2, accepted: { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, payload: { transaction: url ? t.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : t } }); };
    const sigOf = (h) => unconfirmedSignatureOf(fake(h), h);
    ok(unconfirmedKeyOf(fake(svm(txA)), svm(txA)) === unconfirmedKeyOf(fake(svm(txB)), svm(txB)), "control: the same message under another signature is one payment's key");
    ok(sigOf(svm(txA)) === sigOf(svm(txA, true)) && sigOf(svm(txA)) !== sigOf(svm(txB)) && typeof sigOf(svm(txA)) === "string",
      "a signed transaction binds on its decoded bytes: re-encoded matches, other signature bytes do not");
    const avm = (tx) => enc({ x402Version: 2, accepted: { scheme: "exact", network: "algorand:mainnet" }, payload: { paymentGroup: [tx.toString("base64")], paymentIndex: 0 } });
    ok(sigOf(avm(txA)) !== sigOf(avm(txB)) && sigOf(avm(txA)) === sigOf(avm(txA)), "an Algorand payment binds on its signed transaction bytes");
    ok(sigOf(enc(unsignedOf(p))) === null && sigOf(enc(p)) === sigOf(enc(p, 2)) && sigOf(enc(p)) !== sigOf(enc(resignedOf(p))), "an EVM payment binds on its signature; none named binds nothing");
  } finally { Date.now = realNow; await s.close(); local.stop?.(); }
}

// ---- hostile payment headers -----------------------------------------------
// Every parse of a payment here (identity key, signature digest, the kept
// answer's life) reads a malformed header as a payment with no identity: no
// throw, the normal path and its 402. A field whose own toString or valueOf
// is not a function is what String() and Number() throw on.
{
  const TRAP = { toString: 1 };
  const TRAP2 = { toString: 1, valueOf: 1 };
  const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const base = payloadOf({ nonce: newNonce(), validBefore: Math.floor(realNow() / 1000) + 600 });
  const huge = "A".repeat(200_000);
  const hostile = [
    ["network trap", { ...base, accepted: { ...base.accepted, network: TRAP } }],
    ["network trap with valueOf", { ...base, accepted: { ...base.accepted, network: TRAP2 } }],
    ["top-level network trap", { x402Version: 1, network: TRAP, payload: { signature: GOOD_SIG } }],
    ["inner network trap", { x402Version: 1, payload: { network: TRAP2, signature: GOOD_SIG } }],
    ["accepted a string", { ...base, accepted: "eip155:8453" }],
    ["network a number", { ...base, accepted: { ...base.accepted, network: 8453 } }],
    ["network an array", { ...base, accepted: { ...base.accepted, network: ["solana:x"] } }],
    ["payer trap", { ...base, payload: { ...base.payload, authorization: { ...base.payload.authorization, from: TRAP } } }],
    ["nonce trap", { ...base, payload: { ...base.payload, authorization: { ...base.payload.authorization, nonce: TRAP } } }],
    ["validBefore trap", { ...base, payload: { ...base.payload, authorization: { ...base.payload.authorization, validBefore: TRAP2 } } }],
    ["signature trap", { ...base, payload: { ...base.payload, signature: TRAP } }],
    ["signature a number", { ...base, payload: { ...base.payload, signature: 7 } }],
    ["payload a string", { ...base, payload: "x" }],
    ["payload missing", { x402Version: 2, accepted: base.accepted }],
    ["accepted missing", { x402Version: 2, payload: base.payload }],
    ["svm transaction trap", { x402Version: 2, accepted: { scheme: "exact", network: SOL }, payload: { transaction: TRAP } }],
    ["svm transaction not base64", { x402Version: 2, accepted: { scheme: "exact", network: SOL }, payload: { transaction: "!!!not~base58~or~64!!!" } }],
    ["svm transaction huge", { x402Version: 2, accepted: { scheme: "exact", network: SOL }, payload: { transaction: huge } }],
    ["svm transaction missing", { x402Version: 2, accepted: { scheme: "exact", network: SOL }, payload: {} }],
    ["svm wrong network", { x402Version: 2, accepted: { scheme: "exact", network: "solana:nope" }, payload: { transaction: TRAP } }],
    ["stellar transaction trap", { x402Version: 2, accepted: { scheme: "exact", network: "stellar:pubnet" }, payload: { transaction: TRAP2 } }],
    ["algorand index trap", { x402Version: 2, accepted: { scheme: "exact", network: "algorand:mainnet" }, payload: { paymentGroup: [TRAP], paymentIndex: TRAP } }],
    ["algorand group trap", { x402Version: 2, accepted: { scheme: "exact", network: "algorand:mainnet" }, payload: { paymentGroup: [TRAP2], paymentIndex: 0 } }],
    ["algorand group not an array", { x402Version: 2, accepted: { scheme: "exact", network: "algorand:mainnet" }, payload: { paymentGroup: TRAP, paymentIndex: 0 } }],
  ];
  const fake = (h) => ({ header: (n) => (String(n).toLowerCase() === "payment-signature" ? h : undefined) });
  const threw = [];
  for (const [label, obj] of hostile) {
    const h = enc(obj);
    try {
      const k = unconfirmedKeyOf(fake(h), h);
      const sg = unconfirmedSignatureOf(fake(h), h);
      if (typeof k !== "string" || !(sg === null || typeof sg === "string")) threw.push(`${label}: ${typeof k}/${typeof sg}`);
    } catch (e) { threw.push(`${label}: ${e.message}`); }
  }
  for (const h of ["", "not base64 !!", huge, Buffer.from("[1,2]").toString("base64"), Buffer.from("null").toString("base64")]) {
    try { unconfirmedKeyOf(fake(h), h); unconfirmedSignatureOf(fake(h), h); } catch (e) { threw.push(`raw ${h.slice(0, 12)}: ${e.message}`); }
  }
  for (const c of [TRAP, TRAP2, 5, null, undefined, ["a"]]) {
    try { unconfirmedKeyOf(fake(c), c); unconfirmedSignatureOf(fake(c), c); } catch (e) { threw.push(`credential ${typeof c}: ${e.message}`); }
  }
  ok(threw.length === 0, `every hostile header is read without a throw (${threw.join("; ") || "none"})`);
  const lives = [TRAP, TRAP2, ["1"], {}, "  ", "abc", -5, Infinity, NaN, 10n ** 30n].map((v) => { try { return unconfirmedReplayMs(v); } catch { return "threw"; } });
  ok(lives.every((ms) => ms === DAY || (Number.isFinite(ms) && ms >= 60_000 && ms <= 30 * DAY)), `an unreadable validBefore keeps the answer a day, never a throw (${lives.join(",")})`);
  const sgTrap = (() => { const h = enc(hostile[0][1]); return unconfirmedSignatureOf(fake(h), h); })();
  ok(sgTrap === null || typeof sgTrap === "string", "control: a network trap reads as a payment with no rail");

  // Through the middleware: each answers the paywall's 402, and a kept answer
  // whose validBefore cannot be read does not break the response's finish.
  const app = express();
  let runs = 0;
  app.use(express.json());
  app.use(createIdempotency({ isCatalogRoute: () => true, store: createLocalIdempotencyStore({ maxEntries: 100 }) }));
  app.post("/api/memory", (req, res) => {
    runs++;
    req.__a402UnconfirmedAnswer = { body: { reason: "settlement-unconfirmed" }, validBefore: TRAP2 };
    res.status(402).json({ error: "invalid_payment" });
  });
  const srv = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
  try {
    const statuses = [];
    for (const [, obj] of hostile.filter(([l]) => !/huge/.test(l))) {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/memory`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": enc(obj) }, body: "{}" });
      await r.arrayBuffer();
      statuses.push(r.status);
    }
    // (One that names a readable EVM identity and signature is kept, and its
    // re-send under that signature is that kept 402: the same payment.)
    ok(statuses.every((st) => st === 402) && runs >= 1, `through the middleware every hostile header is answered 402, never a 500 (${statuses.join(",")}; ${runs} runs)`);
  } finally { await new Promise((r) => srv.close(r)); }
}

// ---- settle-first credit: the body is read only when a credit is stored ------
// A request carrying a payment header has its body hashed here only when a
// credit for that payment is stored (or an idempotency key binds it, once):
// a large body whose payment holds no credit is never serialized before the
// paywall. The credit still binds the body it paid for: the same payment
// under another body is not run on it and never replaces it.
{
  const local = createLocalIdempotencyStore({ maxEntries: 100 });
  const counts = { stringify: 0, resends: 0, runs: 0 };
  const TX = `0x${randomBytes(32).toString("hex")}`;
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req, _res, next) => {
    if (req.body && typeof req.body === "object") {
      const plain = { ...req.body };
      Object.defineProperty(req.body, "toJSON", { enumerable: false, value: () => { counts.stringify++; return plain; } });
    }
    next();
  });
  app.use(createIdempotency({
    isCatalogRoute: () => true, store: local,
    settledFirstCredit: (req) => (req.header("x-test-settled") === "1" ? { tx: TX, network: NET, note: "settle-first-failed" } : null),
    onSettledFirstResend: async () => { counts.resends++; return { serve: true }; },
  }));
  app.post("/v1/images/edits", (req, res) => {
    counts.runs++;
    if (req.header("x-test-fail") === "1") return res.status(502).json({ error: "upstream_failed" });
    res.json({ ok: true });
  });
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const send = async (header, body, extra = {}) => {
    const r = await fetch(`${base}/v1/images/edits`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": header, ...extra }, body: JSON.stringify(body) });
    await r.text();
    return r.status;
  };
  try {
    const big = { image: "A".repeat(8 * 1024 * 1024), prompt: "x" };
    const other = enc(payloadOf({ nonce: newNonce(), validBefore: 9_999_999_999 }));
    counts.stringify = 0;
    await send(other, big);
    ok(counts.stringify === 0, `a large body whose payment holds no credit is never serialized here (serialized ${counts.stringify}x)`);
    counts.stringify = 0;
    await send(enc(payloadOf({ nonce: newNonce(), validBefore: 9_999_999_999 })), big, { "idempotency-key": "k-big" });
    ok(counts.stringify === 1, `an idempotency key reads the body once (serialized ${counts.stringify}x)`);

    const header = enc(payloadOf({ nonce: newNonce(), validBefore: 9_999_999_999 }));
    ok(await send(header, { q: "a" }, { "x-test-settled": "1", "x-test-fail": "1" }) === 502, "a settled-first run fails");
    await settle();
    const runs0 = counts.runs;
    ok(await send(header, { q: "b" }, { "x-test-settled": "1", "x-test-fail": "1" }) === 502 && counts.resends === 0 && counts.runs === runs0 + 1,
      "the same payment under another body is not run on the credit");
    await settle();
    ok(await send(header, { q: "a" }) === 200 && counts.resends === 1, "the same payment and body is run again on its credit (another body's failure did not replace it)");
    await settle();
    ok(await send(header, { q: "a" }) === 200 && counts.resends === 1, "a spent credit is not run on again");
  } finally { await new Promise((r) => srv.close(r)); local.stop?.(); }
}

// ---- shared, real Redis ------------------------------------------------------
const url = String(process.env.REDIS_URL || "").trim();
if (!url) {
  if (process.env.CI) { console.error("FAIL - CI needs REDIS_URL for the shared half"); process.exit(1); }
  console.log("SKIP - shared half: no REDIS_URL");
} else {
  const { createClient } = await import("redis");
  const c = createClient({ url }); await c.connect();
  const redis = async () => c;
  const A = createIdempotencyStore({ redis, local: createLocalIdempotencyStore() });
  const sa = await serve(A);
  try {
    const vb = Math.floor(realNow() / 1000) + 10 * 86_400;
    const p = payloadOf({ nonce: newNonce(), validBefore: vb });
    // One that expires at once: kept the one-minute minimum.
    const q = payloadOf({ nonce: newNonce(), validBefore: Math.floor(realNow() / 1000) - 5 });
    await sa.send(enc(p)); await sa.send(enc(q)); await settle();
    const fake = (h) => ({ header: (n) => (String(n).toLowerCase() === "payment-signature" ? h : undefined) });
    const kp = `idem:b:${unconfirmedKeyOf(fake(enc(p)), enc(p))}`;
    const kq = `idem:b:${unconfirmedKeyOf(fake(enc(q)), enc(q))}`;
    const ttlP = await c.pTTL(kp);
    const want = vb * 1000 - realNow() + 60_000;
    ok(ttlP > DAY && Math.abs(ttlP - want) < 10_000, `the Redis entry carries validBefore plus a minute, past a day (${Math.round(ttlP / 3_600_000)} h)`);
    const ttlQ = await c.pTTL(kq);
    ok(ttlQ > 0 && ttlQ <= 60_000, `an expired authorization's entry carries the one-minute minimum (${ttlQ} ms)`);
    // Another container (its own process-local store) replays from Redis.
    const B = createIdempotencyStore({ redis, local: createLocalIdempotencyStore() });
    const sb = await serve(B);
    try {
      const r = await sb.send(enc(p, 2));
      ok(r.status === 402 && r.replayed === "1" && sb.runs.n === 0, "another container replays the stored answer from Redis for a re-encoded send");
      const ru = await sb.send(enc(unsignedOf(p)));
      await settle();
      ok(ru.replayed !== "1" && /invalid_exact_evm_payload_signature/.test(ru.text) && sb.runs.n === 1, "on Redis, an unsigned header naming the identity takes the normal path");
      const rw = await sb.send(enc(resignedOf(p), 1));
      await settle();
      ok(rw.replayed !== "1" && sb.runs.n === 2, "on Redis, another signature for the identity takes the normal path");
      const rown = await sb.send(enc(p, 3));
      ok(rown.replayed === "1" && /settlement-unconfirmed/.test(rown.text) && !/impostor/.test(rown.text) && sb.runs.n === 2, "on Redis, the payer's own re-send still gets the stored answer");
      // Honored: once the TTL passes, a third container (empty local store) runs the call.
      await sleep(ttlQ + 1500);
      ok((await c.exists(kq)) === 0, "Redis dropped the entry at its TTL");
      const C = createIdempotencyStore({ redis, local: createLocalIdempotencyStore() });
      const sc = await serve(C);
      try {
        const rq = await sc.send(enc(q));
        ok(rq.replayed !== "1" && sc.runs.n === 1, "past the TTL the payment is not answered from the store");
      } finally { await sc.close(); C.stop?.(); }
    } finally { await sb.close(); B.stop?.(); }
    await c.del(kp);
  } finally { await sa.close(); A.stop?.(); await c.quit(); }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// The stored answer of a payment whose settle chain ended unconfirmed
// (src/idempotency.js keepUnconfirmed), driven through the real middleware:
//   - kept under the payment's identity (network, signed payer, nonce), so the
//     same authorization re-encoded or naming another `resource` gets it back
//     with nothing run; another nonce runs;
//   - kept until the authorization's validBefore plus a minute when that is
//     later than a day (at most 30 days), a day when it names none;
//   - on the shared store (a real Redis, REDIS_URL; required under CI): the
//     entry carries that TTL in Redis, another container replays it, and it
//     is gone once the TTL has passed.
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { randomBytes } from "node:crypto";
import express from "express";
import { createIdempotency, unconfirmedKeyOf, unconfirmedReplayMs } from "../src/idempotency.js";
import { createLocalIdempotencyStore, createIdempotencyStore } from "../src/idempotency-store.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const NET = "eip155:8453";
const PAYER = `0x${randomBytes(20).toString("hex")}`;

const payloadOf = ({ nonce, validBefore, resource = "https://agent402.tools/api/memory" }) => ({
  x402Version: 2, resource: { url: resource }, accepted: { scheme: "exact", network: NET, amount: "1000", payTo: `0x${"bb".repeat(20)}`, asset: `0x${"cc".repeat(20)}` },
  payload: { signature: `0x${"11".repeat(65)}`, authorization: { from: PAYER, to: `0x${"bb".repeat(20)}`, value: "1000", validAfter: "0", validBefore: String(validBefore), nonce } },
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
  } finally { Date.now = realNow; await s.close(); local.stop?.(); }
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

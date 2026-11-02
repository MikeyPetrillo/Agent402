// The first-call allowance's settle decision never depends on finding the
// request (src/first-call-allowance.js allowanceSettleDecision). The grant is
// keyed by the payment itself (network, signed payer, EIP-3009 nonce), which
// the onBeforeSettle hook reads from the payload it is handed, so a vendor
// change that moves transportContext.request.adapter.req cannot settle a call
// whose body already says charged:false. Driven in-process on REAL Redis
// (the claim script) with the hook context stubbed in each shape:
//   - the adapter path gone, or moved: a granted 200 is skipped (not
//     settled) and its body says charged:false;
//   - a payload with no readable identity falls back to the request, and a
//     request holding a grant is skipped;
//   - a call holding no grant settles, whatever the context shape;
//   - a granted call whose answer is not a 200 settles as today;
//   - a different request carrying the same payment settles as usual;
//   - once the response ended, the payment holds nothing.
// Requires REDIS_URL (under CI a missing one fails).
import { randomBytes } from "node:crypto";

const REDIS = String(process.env.REDIS_URL || "").trim();
if (!REDIS) {
  const msg = "test-first-call-allowance-hook: no REDIS_URL; start a local Redis and export REDIS_URL=redis://127.0.0.1:26379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing Redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`);
  process.exit(0);
}
const PREFIX = `fcah${process.pid}${Date.now().toString(36)}`;
Object.assign(process.env, {
  SHARED_LIMITS_PREFIX: PREFIX, FIRST_CALL_ALLOWANCE: "on", FIRST_CALL_ALLOWANCE_SLUGS: "hash",
  FIRST_CALL_ALLOWANCE_DAILY_USD: "1", FIRST_CALL_ALLOWANCE_IP_PER_DAY: "100", STATE_DATABASE_URL: "",
});
const m = await import("../src/first-call-allowance.js");
const { createClient } = await import("redis");

let pass = 0, failed = 0;
const ok = (c, msg) => { if (c) { pass++; console.log(`ok - ${msg}`); } else { failed++; console.error(`FAIL - ${msg}`); } };
const NET = "eip155:8453";
const DEF = { route: "POST /api/hash", slug: "hash", price: "$0.001" };
const RUN = randomBytes(8).toString("hex");
let n = 0;
const wallet = () => "0x" + RUN + (++n).toString(16).padStart(24, "0");

function payment(from, nonce = "0x" + randomBytes(32).toString("hex")) {
  const accepted = { scheme: "exact", network: NET, amount: "1000", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", payTo: "0x000000000000000000000000000000000000dead", maxTimeoutSeconds: 60 };
  const payload = { x402Version: 2, accepted, payload: { signature: "0x" + "11".repeat(65), authorization: { from, to: accepted.payTo, value: "1000", validAfter: "0", validBefore: "9999999999", nonce } } };
  return { payload, header: Buffer.from(JSON.stringify(payload)).toString("base64"), accepted };
}
function fakeCall(pay) {
  const headers = { "payment-signature": pay.header };
  const res = {
    statusCode: 200, sent: null, hdrs: {},
    setHeader(k, v) { this.hdrs[String(k).toLowerCase()] = v; return this; },
    getHeader(k) { return this.hdrs[String(k).toLowerCase()]; },
    json(b) { this.sent = b; return this; },
  };
  const req = { headers, header: (k) => headers[String(k).toLowerCase()], body: {}, method: "POST", path: "/api/hash", res };
  return { req, res };
}
const claim = (req, res) => m.claimFirstCallAllowance(req, res, DEF, { ip: "10.9.0.1", hasPaidSale: () => false, readBalance: async () => 10n ** 12n });
const ctxOf = (pay, transportContext) => ({ paymentPayload: pay.payload, requirements: pay.accepted, ...(transportContext === undefined ? {} : { transportContext }) });
const skipped = (d) => d?.skip === true && d?.result?.success === true && d?.result?.transaction === "";

const redis = createClient({ url: REDIS });
await redis.connect();
try {
  // 1. No transport context at all: the granted 200 is skipped.
  {
    const pay = payment(wallet()); const { req, res } = fakeCall(pay);
    const a = await claim(req, res);
    ok(a.granted === true, `a new wallet's call is granted (${a.reason || "granted"})`);
    res.json({ algo: "sha256" });
    ok(res.sent?.firstCallAllowance?.charged === false, "its body says charged:false");
    const d = m.allowanceSettleDecision(ctxOf(pay, undefined));
    ok(skipped(d), "with no transport context the hook still finds the grant and skips settlement");
    ok(res.getHeader("x-agent402-allowance") === "first-call" && m.allowanceServed(req), "the grant is marked served and the header set");
    ok(m.allowanceSettleDecision(ctxOf(pay, undefined)) === undefined, "a grant is skipped once: a second decision on it settles");
    ok(m._allowanceClaimsHeld() === 1, "the process holds the one claimed payment");
    await m.finishFirstCallAllowance(req);
    ok(m._allowanceClaimsHeld() === 0, "once the response ended, the payment holds nothing");
  }
  // 2. The adapter path moved (a vendor bump): still skipped.
  {
    const pay = payment(wallet()); const { req, res } = fakeCall(pay);
    await claim(req, res); res.json({ ok: 1 });
    const d = m.allowanceSettleDecision(ctxOf(pay, { request: { adapter: {} }, somewhereElse: { req } }));
    ok(skipped(d) && res.sent?.firstCallAllowance?.charged === false, "with the adapter path moved a granted 200 is skipped and says charged:false");
    await m.finishFirstCallAllowance(req);
  }
  // 3. No readable payment identity: the request is read, and a grant there is skipped.
  {
    const pay = payment(wallet()); const { req, res } = fakeCall(pay);
    await claim(req, res); res.json({ ok: 1 });
    const blind = { paymentPayload: { x402Version: 2, payload: {} }, requirements: pay.accepted, transportContext: { request: { adapter: { req } } } };
    ok(skipped(m.allowanceSettleDecision(blind)), "a payload without identity falls back to the request, and a granted request is skipped");
    await m.finishFirstCallAllowance(req);
  }
  // 4. No grant: settles, whatever the context shape.
  {
    const own = payment([...(await import("../src/revenue-live.js")).OUR_EVM_WALLETS][0]); const { req, res } = fakeCall(own);
    const a = await claim(req, res);
    ok(a.granted === false, `our own wallet holds no grant (${a.reason})`);
    ok(m.allowanceSettleDecision(ctxOf(own, undefined)) === undefined && m.allowanceSettleDecision(ctxOf(own, { request: { adapter: { req } } })) === undefined, "a call with no grant settles, with or without the request");
    const stranger = payment(wallet());
    ok(m.allowanceSettleDecision(ctxOf(stranger, undefined)) === undefined, "an unclaimed payment settles");
  }
  // 5. A granted call whose answer is not a 200 settles as today; its grant is given back.
  {
    const pay = payment(wallet()); const { req, res } = fakeCall(pay);
    await claim(req, res); res.statusCode = 201; res.json({ ok: 1 });
    ok(!res.sent?.firstCallAllowance && m.allowanceSettleDecision(ctxOf(pay, undefined)) === undefined, "a granted call answering 201 carries no allowance field and settles");
    await m.finishFirstCallAllowance(req);
    ok(m.allowanceOf(req)?.state === "released", "and its grant is released");
  }
  // 6. Another request carrying the same signed payment settles as usual.
  {
    const pay = payment(wallet()); const first = fakeCall(pay); const copy = fakeCall(pay);
    await claim(first.req, first.res); first.res.json({ ok: 1 });
    const c = await claim(copy.req, copy.res);
    ok(c.granted === false, `the copy holds no grant (${c.reason})`);
    ok(m.allowanceSettleDecision(ctxOf(pay, { request: { adapter: { req: copy.req } } })) === undefined, "the copy's settle is not skipped under the first request's grant");
    ok(skipped(m.allowanceSettleDecision(ctxOf(pay, { request: { adapter: { req: first.req } } }))), "the first request's own settle is skipped");
    await m.finishFirstCallAllowance(first.req);
  }
} catch (e) {
  failed++;
  console.error("FAIL -", e?.stack || e);
} finally {
  try { const keys = await redis.keys(`*${PREFIX}*`); if (keys.length) await redis.del(keys); } catch { /* best effort */ }
  await redis.quit().catch(() => {});
}
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

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
//   - once the response ended, the payment holds nothing;
//   - an inherited (prototype) allowance state is never read;
//   - a call asking for a share link (query, body or envelope) takes no grant;
//   - a claimed wallet key expires within the claim TTL, a served one is kept
//     for the long TTL;
//   - a granted wallet and a spent daily cap cost no balance read; the read is
//     bounded, and a short or late balance gives the claim back;
//   - with the store hung, the status and a claim answer within the op bound.
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
// A bound the test holds itself: an unbounded wait reads as a failure, not a hang.
const HUNG = { reason: "hung", status: "hung" };
const capped = (p, ms = 2_000) => Promise.race([p, new Promise((r) => { const t = setTimeout(() => r(HUNG), ms); t.unref?.(); })]);
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
  // 7. Own property only: a request that inherits the allowance state (a
  // polluted prototype) is not granted and so never skips its settle.
  {
    const inherited = Object.create({ __a402Allowance: { granted: true, state: "served" } });
    ok(m.allowanceOf(inherited) === null && m.allowanceServed(inherited) === false, "an inherited allowance state is not read: the request is not served under a grant");
    const pay = payment(wallet());
    const proto = { __a402Allowance: { granted: true, state: "claimed", res: { statusCode: 200, setHeader() {} } } };
    const req = Object.assign(Object.create(proto), { headers: {} });
    ok(m.allowanceSettleDecision({ paymentPayload: { x402Version: 2, payload: {} }, requirements: pay.accepted, transportContext: { request: { adapter: { req } } } }) === undefined,
      "an inherited claimed state never skips a settle");
  }
  // 8. A call that asks for a share link is not granted (the link is written
  // only on a settled 200), whether share rides the query or the body.
  {
    for (const [where, set] of [["query", (req) => { req.query = { share: "true" }; }], ["body", (req) => { req.body = { text: "x", share: true }; }], ["envelope", (req) => { req.body = { input: { share: "1" } }; }]]) {
      const w = wallet(); const pay = payment(w); const { req, res } = fakeCall(pay); set(req);
      const a = await claim(req, res);
      ok(a.granted === false && a.reason === "share", `share in the ${where} takes no grant (${a.reason || "granted"})`);
      ok(await redis.exists(`sl:${PREFIX}:fca-w:${w}`) === 0, `and claims nothing for the wallet (${where})`);
    }
    const { req, res } = fakeCall(payment(wallet())); req.body = { text: "x", share: false };
    const a = await claim(req, res);
    ok(a.granted === true, `share=false is granted as usual (${a.reason || "granted"})`);
    await m.finishFirstCallAllowance(req);
  }
  // 9. The wallet key expires: a claim holds it for the claim TTL (a crash
  // leaves nothing forever); a served grant keeps it for the long TTL.
  {
    const w = wallet(); const pay = payment(w); const { req, res } = fakeCall(pay);
    await claim(req, res);
    const k = `sl:${PREFIX}:fca-w:${w}`;
    const tClaim = await redis.ttl(k);
    ok(tClaim > 0 && tClaim <= 30 * 60, `a claimed wallet key expires within the claim TTL (${tClaim} s)`);
    res.json({ ok: 1 });
    ok(skipped(m.allowanceSettleDecision(ctxOf(pay, undefined))), "the claim is served");
    await m.finishFirstCallAllowance(req);
    const tServed = await redis.ttl(k);
    ok(String(await redis.get(k)).startsWith("granted:") && tServed > 399 * 86_400 && tServed <= 400 * 86_400, `a served grant's wallet key is kept for the long TTL (${Math.round(tServed / 86_400)} days)`);
    // A served grant whose claim key already expired still marks the wallet.
    const w2 = wallet(); const pay2 = payment(w2); const c2 = fakeCall(pay2);
    await claim(c2.req, c2.res); c2.res.json({ ok: 1 });
    ok(skipped(m.allowanceSettleDecision(ctxOf(pay2, undefined))), "a second claim is served");
    await redis.del(`sl:${PREFIX}:fca-w:${w2}`);
    await m.finishFirstCallAllowance(c2.req);
    ok(String(await redis.get(`sl:${PREFIX}:fca-w:${w2}`)).startsWith("granted:"), "a served grant whose claim key expired is still marked granted");
    const again = fakeCall(payment(w2));
    ok((await claim(again.req, again.res)).reason === "wallet already granted", "and the wallet takes no second grant");
  }
  // 10. The caps come before the balance read: a granted wallet and a spent
  // daily cap cost no RPC.
  {
    let reads = 0;
    const counting = async () => { reads++; return 10n ** 12n; };
    const w = wallet(); const first = fakeCall(payment(w));
    await m.claimFirstCallAllowance(first.req, first.res, DEF, { ip: "10.9.0.2", hasPaidSale: () => false, readBalance: counting });
    ok(reads === 1, `a new wallet's grant reads its balance once (${reads})`);
    const second = fakeCall(payment(w));
    const a2 = await m.claimFirstCallAllowance(second.req, second.res, DEF, { ip: "10.9.0.2", hasPaidSale: () => false, readBalance: counting });
    ok(a2.reason === "wallet already granted" && reads === 1, `a wallet holding a claim is refused with no balance read (${a2.reason}, reads ${reads})`);
    await m.finishFirstCallAllowance(first.req);
    const prev = process.env.FIRST_CALL_ALLOWANCE_DAILY_USD;
    process.env.FIRST_CALL_ALLOWANCE_DAILY_USD = "0.000001";
    try {
      const c = fakeCall(payment(wallet()));
      const a = await m.claimFirstCallAllowance(c.req, c.res, DEF, { ip: "10.9.0.3", hasPaidSale: () => false, readBalance: counting });
      ok(a.reason === "daily cap" && reads === 1, `past the daily cap a new wallet is refused with no balance read (${a.reason}, reads ${reads})`);
    } finally { process.env.FIRST_CALL_ALLOWANCE_DAILY_USD = prev; }
  }
  // 11. The balance read is bounded, and a short or late balance gives the
  // claim back.
  {
    const usdKey = `sl:${PREFIX}:fca-usd:${new Date().toISOString().slice(0, 10)}`;
    const usdBefore = Number(await redis.get(usdKey)) || 0;
    process.env.FIRST_CALL_ALLOWANCE_BALANCE_MS = "200";
    try {
      const w = wallet(); const { req, res } = fakeCall(payment(w));
      const t0 = Date.now();
      const a = await capped(m.claimFirstCallAllowance(req, res, DEF, { ip: "10.9.0.4", hasPaidSale: () => false, readBalance: () => new Promise(() => {}) }));
      const took = Date.now() - t0;
      ok(a.reason === "balance" && took < 800, `a balance read that never answers is refused within its bound (${a.reason}, ${took} ms)`);
      ok(await redis.exists(`sl:${PREFIX}:fca-w:${w}`) === 0 && (Number(await redis.get(usdKey)) || 0) === usdBefore, "and the claim is given back: no wallet key, today's USD unchanged");
      const w2 = wallet(); const c2 = fakeCall(payment(w2));
      const a2 = await m.claimFirstCallAllowance(c2.req, c2.res, DEF, { ip: "10.9.0.4", hasPaidSale: () => false, readBalance: async () => 1n });
      ok(a2.reason === "balance" && await redis.exists(`sl:${PREFIX}:fca-w:${w2}`) === 0 && (Number(await redis.get(usdKey)) || 0) === usdBefore, `a balance below the price is refused and the claim given back (${a2.reason})`);
    } finally { delete process.env.FIRST_CALL_ALLOWANCE_BALANCE_MS; }
  }
  // 12. A hung store: the status and a claim answer within the op bound.
  {
    const sl = await import("../src/shared-limit.js");
    const hang = () => new Promise(() => {});
    process.env.SHARED_LIMITS_OP_MS = "200";
    sl.__setTestClient({ isReady: true, get: hang, eval: hang });
    try {
      let t0 = Date.now();
      const st = await capped(m.firstCallAllowanceStatus());
      const tookStatus = Date.now() - t0;
      ok(st.status === "unavailable" && tookStatus < 800, `with the store hung the status reads "unavailable" within the bound (${st.status}, ${tookStatus} ms)`);
      const { req, res } = fakeCall(payment(wallet()));
      t0 = Date.now();
      const a = await capped(claim(req, res));
      const tookClaim = Date.now() - t0;
      ok(a.reason === "store unavailable" && tookClaim < 800, `and a claim is refused within the bound (${a.reason}, ${tookClaim} ms)`);
    } finally { sl.__setTestClient(null); delete process.env.SHARED_LIMITS_OP_MS; }
    const st = await m.firstCallAllowanceStatus();
    ok(st.status === "on" || st.status === "spent", `with the store back the status reads it (${st.status})`);
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

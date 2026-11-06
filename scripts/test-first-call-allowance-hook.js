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
//   - with the store hung, the status and a claim answer within the op bound;
//   - refusals are counted for new wallets only, by reason and slug: a
//     returning payer or our own wallet is never counted, an async ledger
//     seam is never called on a refusal, and a grant makes one ledger call.
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

// A first-call grant is never booked as a hang-up debt: recordHangupDebt in
// src/server.js returns before it reads any settle receipt. (The receipt header
// is already dropped for a grant, so no booted call can reach this branch; the
// source is the instrument.)
{
  const src = (await import("node:fs")).readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function recordHangupDebt("), src.indexOf("function recordHangupDebt(") + 1600);
  const guard = fn.indexOf("if (allowanceServed(req)) return null;");
  ok(guard > 0 && guard < fn.indexOf("PAYMENT-RESPONSE"), "recordHangupDebt returns for a grant before it reads a settle receipt");
}

// A share request blocks a grant only while sharing is on.
{
  const { shareBlocksGrant } = await import("../src/first-call-allowance.js");
  const was = process.env.ANSWER_SHARE;
  process.env.ANSWER_SHARE = "";
  ok(shareBlocksGrant({ share: true }) === false && shareBlocksGrant({ share: "true" }) === false, "sharing off: asking for a share link does not block a grant");
  process.env.ANSWER_SHARE = "on";
  ok(shareBlocksGrant({ share: true }) === true && shareBlocksGrant({ share: "true" }) === true && shareBlocksGrant({}) === false, "sharing on: asking for a share link blocks a grant");
  if (was === undefined) delete process.env.ANSWER_SHARE; else process.env.ANSWER_SHARE = was;
}
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
  // 8. While sharing is on, a call that asks for a share link is not granted
  // (the link is written only on a settled 200), whether share rides the
  // query or the body. With sharing off the same call is granted.
  {
    const shareWas = process.env.ANSWER_SHARE;
    process.env.ANSWER_SHARE = "";
    {
      const { req, res } = fakeCall(payment(wallet())); req.query = { share: "true" };
      const a = await claim(req, res);
      ok(a.granted === true, `sharing off: share=true is granted as usual (${a.reason || "granted"})`);
      await m.finishFirstCallAllowance(req);
    }
    process.env.ANSWER_SHARE = "on";
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
    if (shareWas === undefined) delete process.env.ANSWER_SHARE; else process.env.ANSWER_SHARE = shareWas;
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
  // 13. Refusal counts for NEW wallets: a returning buyer refused on an
  // ineligible route is not counted there; a new one is, by reason and slug.
  // The ledger read on a refusal is the synchronous one only, and a grant
  // makes the same single ledger call as before.
  {
    m._resetFirstCallAllowance();
    const OTHER = { route: "POST /api/word-count", slug: "word-count", price: "$0.001" };
    const counting = (v) => { const f = () => { f.calls++; return v; }; f.calls = 0; return f; };
    const refuse = async (def, from, hasPaidSale, ip = "10.9.3.1") => {
      const { req, res } = fakeCall(payment(from));
      return m.claimFirstCallAllowance(req, res, def, { ip, hasPaidSale, readBalance: async () => 10n ** 12n });
    };
    const returning = wallet(), fresh = wallet();
    const paidYes = counting(true), paidNo = counting(false);
    const r1 = await refuse(OTHER, returning, paidYes);
    const r2 = await refuse(OTHER, fresh, paidNo);
    let st = await m.firstCallAllowanceStatus();
    ok(r1.reason === "route not eligible" && r2.reason === "route not eligible", `both refused as route not eligible (${r1.reason}, ${r2.reason})`);
    ok(st.deniedToday["route not eligible"] === 2, `deniedToday still counts every refusal (${st.deniedToday["route not eligible"]})`);
    const row = st.newWalletDeniedToday?.["route not eligible"];
    ok(row?.total === 1, `a returning payer on an ineligible route is not counted as a new wallet (${JSON.stringify(row)})`);
    ok(row?.bySlug?.["word-count"] === 1 && Object.keys(row.bySlug).length === 1, `a new payer on an ineligible route is counted under its slug (${JSON.stringify(row?.bySlug)})`);
    ok(paidYes.calls === 1 && paidNo.calls === 1, `a route refusal makes one synchronous ledger read (${paidYes.calls}, ${paidNo.calls})`);
    // An async ledger seam is never called on a refusal: the payer is unclassified.
    let asyncCalls = 0;
    const asyncPaid = async () => { asyncCalls++; return false; };
    await refuse(OTHER, wallet(), asyncPaid);
    st = await m.firstCallAllowanceStatus();
    ok(asyncCalls === 0 && st.newWalletDeniedToday["route not eligible"].total === 1 && st.unclassifiedDeniedToday["route not eligible"] === 1, `an async ledger seam is not called on a refusal and the payer reads unclassified (${asyncCalls}, ${JSON.stringify(st.unclassifiedDeniedToday)})`);
    // Our own wallet is never a new wallet.
    const ours = [...(await import("../src/revenue-live.js")).OUR_EVM_WALLETS][0];
    const paidOurs = counting(false);
    await refuse(OTHER, ours, paidOurs);
    st = await m.firstCallAllowanceStatus();
    ok(st.newWalletDeniedToday["route not eligible"].total === 1 && paidOurs.calls === 0, "our own wallet refused on an ineligible route is not counted and costs no ledger read");
    // A grant on an eligible route: one ledger call, as before; a returning
    // payer on it is refused "paid before" with one call and not counted.
    const grantPaid = counting(false);
    const g = fakeCall(payment(wallet()));
    const ga = await m.claimFirstCallAllowance(g.req, g.res, DEF, { ip: "10.9.3.2", hasPaidSale: grantPaid, readBalance: async () => 10n ** 12n });
    ok(ga.granted === true && grantPaid.calls === 1, `a grant on an eligible route still grants with one ledger call (${ga.reason || "granted"}, ${grantPaid.calls})`);
    const before = counting(true);
    const pb = await refuse(DEF, wallet(), before, "10.9.3.3");
    st = await m.firstCallAllowanceStatus();
    ok(pb.reason === "paid before" && before.calls === 1 && !st.newWalletDeniedToday["paid before"], `a returning payer on an eligible route: one ledger call, not counted as new (${pb.reason}, ${before.calls})`);
    // The same wallet again: the store's wallet key refuses it, not as new.
    const again = fakeCall(payment(ga.payer));
    const aa = await m.claimFirstCallAllowance(again.req, again.res, DEF, { ip: "10.9.3.2", hasPaidSale: () => false, readBalance: async () => 10n ** 12n });
    st = await m.firstCallAllowanceStatus();
    ok(aa.reason === "wallet already granted" && !st.newWalletDeniedToday["wallet already granted"], `a wallet granted before is not counted as new (${aa.reason})`);
    // A new wallet refused after the ledger check (here: the balance) is counted with its slug.
    const low = fakeCall(payment(wallet()));
    const la = await m.claimFirstCallAllowance(low.req, low.res, DEF, { ip: "10.9.3.4", hasPaidSale: () => false, readBalance: async () => 1n });
    st = await m.firstCallAllowanceStatus();
    ok(la.reason === "balance" && st.newWalletDeniedToday.balance?.bySlug?.hash === 1, `a new wallet refused on the balance is counted under its slug (${la.reason}, ${JSON.stringify(st.newWalletDeniedToday.balance)})`);
    await m.finishFirstCallAllowance(g.req);
    // Slug cardinality is bounded per reason ("word-count" already holds one
    // of the NEW_WALLET_SLUG_CAP places, so eleven of the sixty fold).
    for (let i = 0; i < m.NEW_WALLET_SLUG_CAP + 10; i++) await refuse({ route: `POST /api/x${i}`, slug: `x-${i}`, price: "$0.001" }, wallet(), () => false);
    st = await m.firstCallAllowanceStatus();
    const slugs = st.newWalletDeniedToday["route not eligible"].bySlug;
    ok(Object.keys(slugs).length === m.NEW_WALLET_SLUG_CAP + 1 && slugs.other === 11, `slugs per reason are capped and the rest fold into "other" (${Object.keys(slugs).length}, ${slugs.other})`);
    ok(!/0x[0-9a-f]{40}/i.test(JSON.stringify(st.newWalletDeniedToday) + JSON.stringify(st.unclassifiedDeniedToday)), "no payer address appears in the counts");
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

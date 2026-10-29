// Prepaid card credits - offline test with a stubbed Stripe. Proves the money
// discipline: a key is minted only for a PAID session and exactly once (a
// second claim never re-shows it); balances are exact sub-cent micro-dollars;
// the gate authorizes before the handler and debits ONLY on a final 200; an
// insufficient/unknown/disabled key gets a 402 with the balance; a non-credits
// request passes through untouched; accounting hooks fire; state survives a
// reload; operator status never exposes key material.
import { createCredits, CREDIT_PACKS, KEY_RE, usdToMicro, microToUsd } from "../src/credits.js";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import express from "express";
import { paymentRequiredBodyMiddleware, PAYMENT_REQUIRED_OFFER_KEYS } from "../src/payment-required-body.js";

const DIR = join("/tmp", `test-credits-${process.pid}`);
try { rmSync(DIR, { recursive: true, force: true }); } catch { /* first run */ }
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "ok" : "NOT OK") + " - " + m); };

const sessions = {
  cs_paid: { id: "cs_paid", mode: "payment", payment_status: "paid", payment_intent: "pi_1", customer_details: { email: "c@x.com" }, metadata: { credits_pack: "credits-20" } },
  cs_unpaid: { id: "cs_unpaid", mode: "payment", payment_status: "unpaid", metadata: { credits_pack: "credits-20" } },
  cs_other: { id: "cs_other", mode: "payment", payment_status: "paid", metadata: { product: "dossier" } },
};
const stripe = { checkout: { sessions: { create: async (a) => { stripe._last = a; return { id: "cs_new", url: "https://checkout.stripe.com/c/cs_new" }; }, retrieve: async (id) => { const s = sessions[id]; if (!s) throw new Error("no"); return s; } } } };
const debits = [], loads = [];
const mk = () => createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR, onDebit: (d) => debits.push(d), onLoad: (l) => loads.push(l), log: () => {} });
let cr = mk();

ok(Object.values(CREDIT_PACKS).every((p) => p.cents >= 2000), "every pack is >= $20");
ok(usdToMicro(0.001) === 1000 && microToUsd(1000) === 0.001 && usdToMicro(19) === 19_000_000, "micro-dollar math is exact for sub-cent prices");

// checkout
const c = await cr.createCheckout("credits-50");
ok(c.url && stripe._last.mode === "payment" && stripe._last.metadata.credits_pack === "credits-50" && stripe._last.line_items[0].price_data.unit_amount === 5000, "createCheckout: payment-mode session for the pack with the pack in metadata");
let threw = false; try { await cr.createCheckout("constructor"); } catch { threw = true; }
ok(threw, "unknown / inherited pack key is refused");

// claim: paid once -> minted; again -> claimed (no key); unpaid/other/unknown
const m1 = await cr.claim("cs_paid");
ok(m1.status === "minted" && KEY_RE.test(m1.key) && m1.balanceUsd === 20 && loads.length === 1 && loads[0].priceUsd === 20, "a PAID session mints a key once with the pack balance (accounting hook fires)");
const KEY = m1.key;
const m2 = await cr.claim("cs_paid");
ok(m2.status === "claimed" && !m2.key && m2.keyId === m1.keyId, "SECURITY: a second claim of the same session never re-shows the key");
ok((await cr.claim("cs_unpaid")).status === "unpaid", "an unpaid session mints nothing");
ok((await cr.claim("cs_other")).status === "invalid", "a paid session that is not a credits pack mints nothing");
ok((await cr.claim("cs_nope")).status === "not_found" && (await cr.claim("garbage")).status === "invalid", "unknown / malformed session ids mint nothing");

// authorize RESERVES, settle converts the hold to spend
const a = cr.authorize(KEY, 0.001);
ok(a.ok && a.balanceUsd === 19.999 && a.heldMicro === 1000 && cr.balance(KEY).heldUsd === 0.001, "authorize: a funded key covers a $0.001 call and the price is HELD (balance drops, held rises)");
const ch = cr.settle(a.hash, a.heldMicro, "whois");
ok(ch.chargedUsd === 0.001 && ch.balanceUsd === 19.999 && cr.balance(KEY).heldUsd === 0 && debits.length === 1 && debits[0].slug === "whois", "settle converts exactly the held amount to spend and fires the accounting hook");
// concurrency: holds bound the total - two calls cannot both pass on a balance that covers one
const b1 = cr.authorize(KEY, 19.5), b2 = cr.authorize(KEY, 19.5);
ok(b1.ok && !b2.ok && b2.reason === "insufficient", "CONCURRENCY: a second authorize while the first is held is refused (no collective overspend)");
cr.release(b1.hash, b1.heldMicro);
ok(cr.balance(KEY).balanceUsd === 19.999 && cr.balance(KEY).heldUsd === 0, "release returns the hold to the balance");
ok(!cr.authorize("a402_nope", 0.001).ok && cr.authorize("a402_nope", 0.001).reason === "malformed", "a malformed key is refused");
ok(cr.authorize("a402_" + "x".repeat(32), 0.001).reason === "unknown", "an unknown (well-formed) key is refused");
ok(cr.authorize(KEY, 25).reason === "insufficient" && cr.authorize(KEY, 25).balanceUsd === 19.999, "a call priced above the balance is refused with the balance");
const b = cr.balance(KEY);
ok(b.balanceUsd === 19.999 && b.spentUsd === 0.001 && b.calls === 1 && b.keyId === m1.keyId, "balance reports balance/spent/calls");

// the Express gate: authorize before, debit only on a 200, pass-through otherwise
const priceFor = (method, path) => (path === "/api/whois" ? { priceUsd: 0.001, slug: "whois" } : path === "/v1/dossier" ? { priceUsd: 19, slug: "dossier" } : null);
const gate = cr.gate(priceFor);
function fakeRes() { const r = new EventEmitter(); r.statusCode = 200; r.headersSent = false; r.end = () => r; r.headers = {}; r.setHeader = (k, v) => { r.headers[k] = v; }; r.getHeader = (k) => r.headers[k]; r.status = (c) => { r.statusCode = c; return r; }; r.json = (j) => { r.body = j; r.emit("finish"); return r; }; return r; }
let nexted = false; let res = fakeRes();
gate({ method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}` } }, res, () => { nexted = true; });
ok(nexted && res.headers["X-Credits-Balance"] === "19.998", "gate: a funded key on a priced route is authorized (next called, balance header shows the post-hold balance)");
res.statusCode = 200; res.emit("finish");
ok(cr.balance(KEY).balanceUsd === 19.998, "gate: a 200 is debited on finish");
nexted = false; res = fakeRes();
gate({ method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}` } }, res, () => { nexted = true; });
res.statusCode = 502; res.emit("finish");
ok(nexted && cr.balance(KEY).balanceUsd === 19.998 && cr.balance(KEY).heldUsd === 0, "gate: a non-200 (upstream 502) is NOT debited (hold released)");
// client abort BEFORE the first byte (socket closed, finish never fires). The
// close alone decides nothing: the hold is decided when the abandoned response
// ENDS, by the same rule every rail follows (src/hangup-settlement.js). With
// no hang-up forgiveness ticket (the budget is spent, or the route reserved
// none) the hold SETTLES, as before the rule - an abort must not be a free
// expensive call (2026-08-28) - and is flagged so the hang-up hook books it as
// owed. Node's default statusCode is 200 before anything is written, which is
// exactly why the close itself cannot be read as a served 200.
nexted = false; res = fakeRes();
const areq = { method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}` } };
gate(areq, res, () => { nexted = true; });
res.emit("close");
ok(cr.balance(KEY).heldUsd === 0.001 && cr.balance(KEY).calls === 2, `gate: a close before the first byte alone decides nothing (the handler may still be running) [held=${cr.balance(KEY).heldUsd}]`);
res.statusCode = 200; res.end();
ok(nexted && cr.balance(KEY).balanceUsd === 19.997 && cr.balance(KEY).heldUsd === 0 && cr.balance(KEY).calls === 3 && areq.creditsChargedOnClose === 0.001, `gate: an abandoned run with NO forgiveness ticket settles the hold and flags it for the refund ledger [bal=${cr.balance(KEY).balanceUsd} held=${cr.balance(KEY).heldUsd} calls=${cr.balance(KEY).calls} onClose=${areq.creditsChargedOnClose}]`);
res.emit("close"); res.end();
ok(cr.balance(KEY).balanceUsd === 19.997 && cr.balance(KEY).calls === 3, "gate: a second close or end never debits twice");
// ... a >= 400 on the abandoned request (the dispatcher refusing to start a
// handler for a client already gone, or a handler that failed) is never charged.
nexted = false; res = fakeRes();
gate({ method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}` } }, res, () => { nexted = true; });
res.emit("close"); res.statusCode = 499; res.end();
ok(nexted && cr.balance(KEY).balanceUsd === 19.997 && cr.balance(KEY).heldUsd === 0 && cr.balance(KEY).calls === 3, `gate: an abandoned request that ends >= 400 is not charged [bal=${cr.balance(KEY).balanceUsd} calls=${cr.balance(KEY).calls}]`);
// ... and a run holding a granted forgiveness ticket is not charged either.
{
  const { reserveHangupForgiveness, _resetHangupForgiveness } = await import("../src/hangup-forgiveness.js");
  _resetHangupForgiveness();
  nexted = false; res = fakeRes();
  const treq = { method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}` } };
  gate(treq, res, () => { nexted = true; });
  reserveHangupForgiveness(treq, { keys: ["credits:x", "ip:203.0.113.1"], priceUsd: 0.001 });
  treq.__a402ClientGoneAt = Date.now(); // what the hang-up hook marks on the close
  res.emit("close"); res.statusCode = 200; res.end();
  ok(nexted && cr.balance(KEY).balanceUsd === 19.997 && cr.balance(KEY).heldUsd === 0 && cr.balance(KEY).calls === 3 && treq.creditsChargedOnClose === undefined, `gate: an abandoned run holding a forgiveness ticket releases the hold [bal=${cr.balance(KEY).balanceUsd} calls=${cr.balance(KEY).calls}]`);
  _resetHangupForgiveness();
}
// ... a hold nobody ends is released after CREDITS_ABANDONED_HOLD_MS.
{
  process.env.CREDITS_ABANDONED_HOLD_MS = "30";
  res = fakeRes();
  gate({ method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}` } }, res, () => {});
  res.emit("close");
  await new Promise((r) => setTimeout(r, 120));
  ok(cr.balance(KEY).heldUsd === 0 && cr.balance(KEY).balanceUsd === 19.997, `gate: an abandoned hold that nothing ends is released after the bound [held=${cr.balance(KEY).heldUsd}]`);
  res.statusCode = 200; res.end();
  ok(cr.balance(KEY).balanceUsd === 19.997 && cr.balance(KEY).calls === 3, "gate: ... and a late end after that never debits");
  delete process.env.CREDITS_ABANDONED_HOLD_MS;
}
// idempotent REPLAY of a call this key already paid for: the replay middleware
// answers 200 with X-Idempotent-Replay: true and no handler runs, so the hold
// is released and the balance is unchanged (a keyed retry never pays twice).
nexted = false; res = fakeRes();
gate({ method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}` } }, res, () => { nexted = true; });
res.setHeader("X-Idempotent-Replay", "true"); res.statusCode = 200; res.emit("finish");
ok(nexted && cr.balance(KEY).balanceUsd === 19.997 && cr.balance(KEY).heldUsd === 0 && cr.balance(KEY).calls === 3, "gate: an idempotent replay (X-Idempotent-Replay: true) releases the hold - a keyed retry is never debited twice");
// an x-pow-solution riding beside the Bearer is stripped on acceptance, so the
// idempotency key can never bind a paid entry to that public string
{ const req = { method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}`, "x-pow-solution": "public-string" } }; res = fakeRes();
  gate(req, res, () => {}); res.statusCode = 502; res.emit("finish");
  ok(!("x-pow-solution" in req.headers), "gate: x-pow-solution is stripped on acceptance (same as the unsigned payment headers)"); }
nexted = false; res = fakeRes();
const priceFor2 = (m, p) => (p === "/v1/big" ? { priceUsd: 25, slug: "big" } : priceFor(m, p));
cr.gate(priceFor2)({ method: "POST", path: "/v1/big", headers: { authorization: `Bearer ${KEY}` } }, res, () => { nexted = true; });
ok(!nexted && res.statusCode === 402 && res.body.reason === "insufficient" && res.body.balanceUsd === 19.997 && res.body.topup === null && /\/api\/pricing$/.test(res.body.pay) && /not on sale/.test(res.body.topupNote), "gate: insufficient balance -> 402 with balance; credits not on sale -> no top-up link, points at per-call pay, handler never runs");
{
  const prev = process.env.CREDITS_SALES; process.env.CREDITS_SALES = "on";
  const { creditsTopupFields } = await import("../src/credits-sales.js");
  ok(/\/credits$/.test(creditsTopupFields("https://x.test").topup), "on sale -> the refusal carries the /credits top-up link");
  if (prev === undefined) delete process.env.CREDITS_SALES; else process.env.CREDITS_SALES = prev;
}
// A credits 402 is not a paywall 402: it sets no PAYMENT-REQUIRED header, so
// the 402 body mirror (src/payment-required-body.js) leaves it exactly as the
// gate wrote it - no x402 offer beside the balance.
ok(!res.headers["PAYMENT-REQUIRED"] && !res.headers["payment-required"] && PAYMENT_REQUIRED_OFFER_KEYS.every((k) => !(k in res.body)), "gate: a credits 402 sets no PAYMENT-REQUIRED header and carries no x402 offer");
{
  const app = express();
  app.use(paymentRequiredBodyMiddleware()); // prod order: the mirror is mounted before the credits gate
  app.use(cr.gate(priceFor2));
  app.use((req, r) => r.status(200).json({ served: true }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const r = await fetch(`http://127.0.0.1:${server.address().port}/v1/big`, { method: "POST", headers: { authorization: `Bearer ${KEY}` } });
  const body = await r.json();
  server.close();
  ok(r.status === 402 && !r.headers.get("payment-required") && body.reason === "insufficient" && body.balanceUsd === 19.997 && body.topup === null && /\/api\/pricing$/.test(body.pay) && PAYMENT_REQUIRED_OFFER_KEYS.every((k) => !(k in body)),
    `wire: behind the 402 body mirror, a credits 402 is unchanged: reason/balanceUsd/topup, no x402Version or accepts (keys: ${Object.keys(body).join(",")})`);
}
nexted = false; res = fakeRes();
gate({ method: "GET", path: "/api/whois", headers: { authorization: "Bearer a402_" + "y".repeat(32) } }, res, () => { nexted = true; });
ok(!nexted && res.statusCode === 402 && res.body.reason === "unknown", "gate: an unknown key -> 402, handler never runs");
nexted = false; res = fakeRes();
gate({ method: "GET", path: "/api/whois", headers: { authorization: "Bearer sometoken" } }, res, () => { nexted = true; });
ok(nexted && !res.headers["X-Credits-Balance"], "gate: a non-credits Bearer passes through untouched (other gates decide)");
nexted = false; res = fakeRes();
gate({ method: "GET", path: "/llms.txt", headers: { authorization: `Bearer ${KEY}` } }, res, () => { nexted = true; });
ok(nexted && !res.headers["X-Credits-Balance"], "gate: a credits key on a non-priced route passes through (no charge)");

// SECURITY: identity-bound routes are refused for credits, and accepted
// requests lose any unsigned x402 payment headers (wallet-identity forgery).
nexted = false; res = fakeRes();
cr.gate((m, p) => (p === "/api/memory" ? { priceUsd: 0.001, slug: "memory", identityBound: true } : null))({ method: "POST", path: "/api/memory", headers: { authorization: `Bearer ${KEY}` } }, res, () => { nexted = true; });
ok(!nexted && res.statusCode === 402 && res.body.reason === "identity-bound" && cr.balance(KEY).heldUsd === 0, "SECURITY: an identity-bound route refuses credits (402, no hold, handler never runs)");
// Credits are spent only on our own services: a route that buys from an
// outside seller with our wallet is refused before any hold.
nexted = false; res = fakeRes();
cr.gate((m, p) => (p === "/api/route/execute" ? { priceUsd: 0.01, slug: "route-execute", identityBound: false, paysThirdParty: true } : null))({ method: "POST", path: "/api/route/execute", headers: { authorization: `Bearer ${KEY}` } }, res, () => { nexted = true; });
ok(!nexted && res.statusCode === 402 && res.body.reason === "third-party-purchase" && res.headers["X-Credits-Error"] === "third-party-purchase" && cr.balance(KEY).heldUsd === 0, "a route that buys from an outside seller refuses credits (402, no hold, handler never runs)");
nexted = false; res = fakeRes();
const forged = { method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}`, "x-payment": "ZmFrZQ==", "payment-signature": "ZmFrZQ==", "payment-identifier": "x" } };
gate(forged, res, () => { nexted = true; });
ok(nexted && !("x-payment" in forged.headers) && !("payment-signature" in forged.headers) && !("payment-identifier" in forged.headers), "SECURITY: unsigned x402 payment headers are stripped when a credits request is accepted");
res.statusCode = 200; res.emit("finish");
// a pre-paywall prompt-cache hit (req.gatewayCacheHit) is not charged
nexted = false; res = fakeRes(); res.getHeader = (k) => (k === "X-Cache" ? "hit" : undefined);
const bal0 = cr.balance(KEY).balanceUsd;
{ const req = { method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}` } };
  gate(req, res, () => { nexted = true; req.gatewayCacheHit = true; }); }
res.statusCode = 200; res.emit("finish");
ok(cr.balance(KEY).balanceUsd === bal0 && cr.balance(KEY).heldUsd === 0, "a pre-paywall cache hit (req.gatewayCacheHit) releases the hold - credits buyers get cached answers free like x402 buyers");
// a route result cache inside the handler also says X-Cache: hit, after the
// paywall; x402 charges that answer, so credits debit it too
nexted = false; res = fakeRes(); res.getHeader = (k) => (k === "X-Cache" ? "hit" : undefined);
gate({ method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}` } }, res, () => { nexted = true; });
res.statusCode = 200; res.emit("finish");
ok(Math.abs(cr.balance(KEY).balanceUsd - (bal0 - 0.001)) < 1e-9 && cr.balance(KEY).heldUsd === 0, `a handler cache hit (X-Cache: hit alone) is debited like any served 200 [bal=${cr.balance(KEY).balanceUsd}]`);
// ... and the same holds for a client that left before the first byte
nexted = false; res = fakeRes(); res.getHeader = (k) => (k === "X-Cache" ? "hit" : undefined);
{ const bal1 = cr.balance(KEY).balanceUsd;
  gate({ method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}` } }, res, () => { nexted = true; });
  res.emit("close"); res.statusCode = 200; res.end();
  ok(Math.abs(cr.balance(KEY).balanceUsd - (bal1 - 0.001)) < 1e-9 && cr.balance(KEY).heldUsd === 0, `an abandoned handler cache hit is not released as a cache hit [bal=${cr.balance(KEY).balanceUsd}]`); }
// clawback: a refunded/disputed pack disables its key
ok(cr.disableByPaymentIntent("pi_1", "refunded") === m1.keyId && cr.authorize(KEY, 0.001).reason === "disabled", "a refunded pack payment disables its key (clawback by PaymentIntent)");
cr.setDisabled(m1.keyId, false);
ok(cr.disableByPaymentIntent("pi_nope") === null, "an unknown PaymentIntent disables nothing");

// disabled keys; operator status without key material; persistence across reload
ok(cr.setDisabled(m1.keyId, true) && cr.authorize(KEY, 0.001).reason === "disabled", "operator can disable a key; it then refuses");
cr.setDisabled(m1.keyId, false);
const st = cr.status();
ok(st.keys === 1 && st.loadedUsd === 20 && st.outstandingUsd === 19.994 && st.rows[0].keyId === m1.keyId && !JSON.stringify(st).includes(KEY) && !JSON.stringify(st).includes(a.hash), "operator status has totals + key ids and never the key or its hash");
cr = mk();
ok(cr.balance(KEY).balanceUsd === 19.994 && (await cr.claim("cs_paid")).status === "claimed", "a fresh instance reads balances and the claim-once index from disk");

// A $19 dossier on a $19.998 key IS covered (authorizes at balance >= price).
nexted = false; res = fakeRes();
cr.gate(priceFor)({ method: "POST", path: "/v1/dossier", headers: { authorization: `Bearer ${KEY}` } }, res, () => { nexted = true; });
ok(nexted, "gate: a $19 call on a $19.997 key is authorized (balance >= price)");

try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
// METERED: the response names actual usage x markup (X-Metered-Usd); the debit
// is that, the rest of the held quote returns to the balance.
{
  const gateM = cr.gate((m, p) => (p === "/v1/metered/chat/completions" ? { priceUsd: 0.001, slug: "v1-chat-metered" } : priceFor(m, p)));
  const before = cr.balance(KEY).balanceUsd, heldBefore = cr.balance(KEY).heldUsd;
  const r2 = fakeRes(); r2.getHeader = (k) => r2.headers[k];
  gateM({ method: "POST", path: "/v1/metered/chat/completions", headers: { authorization: `Bearer ${KEY}` }, body: {} }, r2, () => {});
  ok(Math.abs(cr.balance(KEY).balanceUsd - (before - 0.001)) < 1e-9, "gate (metered): the quote is held at authorize");
  r2.setHeader("X-Metered-Usd", "0.000400"); r2.statusCode = 200; r2.emit("finish");
  ok(Math.abs(cr.balance(KEY).balanceUsd - (before - 0.0004)) < 1e-9 && Math.abs(cr.balance(KEY).heldUsd - heldBefore) < 1e-9, `gate (metered): the debit is the metered actual, the rest of the hold is returned (balance ${cr.balance(KEY).balanceUsd})`);
  const d = debits[debits.length - 1];
  ok(Math.abs(d.priceUsd - 0.0004) < 1e-9, "gate (metered): the accounting hook books the metered amount, not the quote");
  const r3 = fakeRes(); r3.getHeader = (k) => r3.headers[k];
  const b3 = cr.balance(KEY).balanceUsd;
  gateM({ method: "POST", path: "/v1/metered/chat/completions", headers: { authorization: `Bearer ${KEY}` }, body: {} }, r3, () => {});
  r3.setHeader("X-Metered-Usd", "9.5"); r3.statusCode = 200; r3.emit("finish");
  ok(Math.abs(cr.balance(KEY).balanceUsd - (b3 - 0.001)) < 1e-9, "gate (metered): a reported amount above the hold can never take more than the hold");
  // STREAMED: the usage frame arrives after the 200 went out, so no header can
  // carry the amount; the stream writer records it on the request and the
  // gate debits that on finish (hold = quote, debit = usage). A stub upstream
  // stream drives the real writer (src/tools/llm-gateway-kit.js).
  {
    const { setUpstreamCostsForTest } = await import("../src/upstream-costs.js");
    const { meteredUsd } = await import("../src/gateway-meter.js");
    setUpstreamCostsForTest({ models: [["fake/", { prompt: 1, completion: 1 }]], meter: { markup: 1.2 } });
    const prevMeter = process.env.GATEWAY_METERED_BILLING, prevKey = process.env.OPENROUTER_API_KEY;
    process.env.GATEWAY_METERED_BILLING = "on"; process.env.OPENROUTER_API_KEY = "test-key";
    const { streamOpenRouterTo } = await import("../src/tools/llm-gateway-kit.js");
    const COST = 0.01, QUOTE = 0.05; // a quote the rail can settle under (the floor is tested in test-gateway-meter.js)
    const gateS = cr.gate((m, p) => (p === "/v1/metered/stream" ? { priceUsd: QUOTE, slug: "v1-chat-metered" } : priceFor(m, p)));
    const expected = meteredUsd({ upstreamUsd: COST, ceilingUsd: QUOTE });
    ok(expected > 0 && expected < QUOTE, `the stub cost meters under the quote (${expected})`);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, body: (async function* () {
      yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
      yield Buffer.from(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, cost: COST } })}\n\n`);
      yield Buffer.from("data: [DONE]\n\n");
    })() });
    const r4 = fakeRes(); r4.getHeader = (k) => r4.headers[k];
    r4.writeHead = (code) => { r4.statusCode = code; r4.headersSent = true; }; r4.write = () => true; r4.on = r4.addListener;
    const req4 = { method: "POST", path: "/v1/metered/stream", headers: { authorization: `Bearer ${KEY}` }, body: { stream: true } };
    r4.req = req4;
    const b4 = cr.balance(KEY).balanceUsd, held4 = cr.balance(KEY).heldUsd;
    gateS(req4, r4, () => {});
    ok(Math.abs(cr.balance(KEY).balanceUsd - (b4 - QUOTE)) < 1e-9 && req4.creditsPriceUsd === QUOTE, "gate (streamed): the quote is held at authorize");
    await streamOpenRouterTo({ model: "fake/model", messages: [], stream: true }, r4, { timeoutMs: 2000 });
    globalThis.fetch = realFetch;
    ok(Math.abs(req4.__meteredUsageUsd - expected) < 1e-9 && r4.headers["X-Metered-Usd"] === undefined, "the stream writer records the metered usage on the request (no header after the 200)");
    r4.statusCode = 200; r4.emit("finish");
    ok(Math.abs(cr.balance(KEY).balanceUsd - (b4 - expected)) < 1e-9 && Math.abs(cr.balance(KEY).heldUsd - held4) < 1e-9, `gate (streamed): the debit is the metered usage, the rest of the hold is returned (balance ${cr.balance(KEY).balanceUsd})`);
    ok(Math.abs(debits[debits.length - 1].priceUsd - expected) < 1e-9, "gate (streamed): the accounting hook books the metered amount");
    if (prevMeter === undefined) delete process.env.GATEWAY_METERED_BILLING; else process.env.GATEWAY_METERED_BILLING = prevMeter;
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey;
  }
}
// ---- keys cannot be guessed or made up, and guessing is bounded ----
{
  const minted = await cr.claim("cs_paid");
  ok(minted.status === "claimed" || minted.status === "minted", "guard: setup");
  // A key in the right format that we never issued is unknown, however it was made.
  const forged = "a402_" + "A".repeat(32);
  ok(KEY_RE.test(forged) && cr.balance(forged) === null, "a well-formed key we never issued holds nothing (keys are checked against stored hashes)");
  process.env.CREDITS_BAD_KEY_MAX = "3";
  const g = cr.gate(() => ({ priceUsd: 0.001, slug: "hash" }));
  const tryKey = (k, ip = "203.0.113.9") => { const r = fakeRes(); let next = false; g({ method: "GET", path: "/api/hash", ip, headers: { authorization: `Bearer ${k}` } }, r, () => { next = true; }); return { r, next }; };
  for (let i = 0; i < 3; i++) tryKey("a402_" + String(i).repeat(40));
  const after = tryKey(KEY);
  ok(after.r.statusCode !== 429 && after.next === true, "failed keys never block a valid key from the same client (a paying customer behind a shared address is served)");
  ok(cr.badKeyStats().failures >= 3 && cr.badKeyStats().clientsOverThreshold === 1, "a client past the threshold is counted for the operator view");
  for (let i = 0; i < 3; i++) tryKey("a402_" + String(i + 5).repeat(40), `2001:db8:1:2::${i + 1}`);
  ok(cr.badKeyStats().clientsOverThreshold === 2, "IPv6 addresses in one /64 count as one client");
  delete process.env.CREDITS_BAD_KEY_MAX;
}

// ---- daily purchase limit: one buyer, at most CREDITS_DAILY_MAX_USD in 24 hours ----
{
  const LDIR = join("/tmp", `test-credits-limit-${process.pid}`);
  try { rmSync(LDIR, { recursive: true, force: true }); } catch { /* first run */ }
  process.env.CREDITS_DAILY_MAX_USD = "250";
  const ls = {};
  const refunds = [];
  const fp = {}; // payment intent -> card fingerprint
  const refundedCents = {}; // payment intent -> what Stripe has refunded of it
  const lstripe = {
    checkout: { sessions: { retrieve: async (id) => { if (!ls[id]) throw new Error("no"); return ls[id]; } } },
    paymentIntents: { retrieve: async (id) => ({ id, latest_charge: { amount_refunded: refundedCents[id] || 0, payment_method_details: { card: { fingerprint: fp[id] || null } } } }) },
    refunds: { create: async (a) => { refunds.push(a); return { id: "re_" + refunds.length }; } },
  };
  let t = Date.parse("2026-10-28T12:00:00Z");
  const lc = createCredits({ stripe: lstripe, baseUrl: "https://agent402.tools", storeDir: LDIR, now: () => t, log: () => {} });
  const buy = (id, { email = "a@x.com", card = "fp_a", pack = "credits-100" } = {}) => {
    ls[id] = { id, mode: "payment", payment_status: "paid", payment_intent: "pi_" + id, customer_details: { email }, metadata: { credits_pack: pack } };
    fp["pi_" + id] = card;
    return lc.claim(id);
  };
  ok((await buy("cs_l1")).status === "minted" && (await buy("cs_l2")).status === "minted", "limit: purchases up to the limit are issued ($200 of $250)");
  const over = await buy("cs_l3");
  ok(over.status === "over_limit" && over.refunded === true && over.limitUsd === 250 && !over.key, "limit: the purchase that would pass $250 in 24 hours issues no key");
  ok(refunds.length === 1 && refunds[0].payment_intent === "pi_cs_l3", "limit: and is refunded in full to the card");
  const again = await lc.claim("cs_l3");
  ok(again.status === "over_limit" && refunds.length === 1, "limit: claiming the refused session again answers the same and refunds nothing twice");
  ok((await buy("cs_l4", { email: "other@x.com", card: "fp_a" })).status === "over_limit", "limit: the same card under another email is the same buyer");
  ok((await buy("cs_l5", { email: "A@X.com", card: "fp_z" })).status === "over_limit", "limit: the same email in another case, with another card, is the same buyer");
  ok((await buy("cs_l6", { email: "b@x.com", card: "fp_b" })).status === "minted", "limit: a different buyer is unaffected");
  // ---- a payment Stripe refunded before the claim, and refunds after it ----
  {
    const refundsBefore = refunds.length;
    refundedCents.pi_cs_rf1 = CREDIT_PACKS["credits-100"].cents;
    const r1 = await buy("cs_rf1", { email: "rf@x.com", card: "fp_rf" });
    ok(r1.status === "refunded" && !r1.key && !r1.keyId, "a pack refunded in full before its claim mints no key and answers refunded");
    ok((await lc.claim("cs_rf1")).status === "refunded" && refunds.length === refundsBefore && !(await lc.refusalsToRefund()).includes("cs_rf1"), "claiming it again answers the same; nothing is refunded twice and nothing is owed");
    ok(JSON.parse(readFileSync(join(LDIR, "_sessions.json"), "utf8")).cs_rf1 === "refused-refunded:refunded", "the refusal is claimed with its outcome, never through a pending marker");
    // The claim-once write carries the outcome when it is known: such a
    // refusal is never owed, where one left pending is owed after five minutes.
    ok((await lc._internals.refuseSession("cs_rf_final", "refused-refunded", "refunded")) && (await lc._internals.refuseSession("cs_rf_pending", "refused-refunded")), "setup: one refusal claimed with its outcome, one left pending");
    t += 6 * 60_000;
    const owedNow = await lc.refusalsToRefund();
    ok(!owedNow.includes("cs_rf_final") && owedNow.includes("cs_rf_pending"), `a refusal claimed with its outcome is never owed; a pending one is after five minutes (${JSON.stringify(owedNow)})`);
    refundedCents.pi_cs_rf2 = 2500;
    const r2 = await buy("cs_rf2", { email: "rf@x.com", card: "fp_rf" });
    ok(r2.status === "minted" && r2.balanceUsd === 75, `a pack partly refunded before its claim is minted net of the refund (${r2.balanceUsd})`);
    // charge.refunded carries the charge's running refunded total: a partial
    // refund lowers the balance and keeps the key; a full one disables it.
    ok(lc.disableByPaymentIntent("pi_cs_rf2", "refunded", { amountRefundedCents: 5000, fullyRefunded: false }) === r2.keyId && lc.balance(r2.key).balanceUsd === 50,
      `a partial refund after minting takes only the new part off the balance (${lc.balance(r2.key).balanceUsd})`);
    const held = lc.authorize(r2.key, 0.001);
    ok(held.ok, "...and leaves the key usable");
    lc.release(held.hash, held.heldMicro);
    ok(lc.disableByPaymentIntent("pi_cs_rf2", "refunded", { amountRefundedCents: 5000, fullyRefunded: false }) === r2.keyId && lc.balance(r2.key).balanceUsd === 50,
      "the same refund delivered again takes nothing more");
    ok(lc.disableByPaymentIntent("pi_cs_rf2", "refunded", { amountRefundedCents: 10000, fullyRefunded: true }) === r2.keyId && lc.authorize(r2.key, 0.001).reason === "disabled" && lc.balance(r2.key).balanceUsd === 0,
      "a full refund takes the rest and disables the key");
    const r3 = await buy("cs_rf3", { email: "rf2@x.com", card: "fp_rf2" });
    ok(lc.disableByPaymentIntent("pi_cs_rf3", "disputed", { amountRefundedCents: null, fullyRefunded: true }) === r3.keyId && lc.authorize(r3.key, 0.001).reason === "disabled", "a dispute disables the key outright");
    // The dispute closing in our favor gives the key back; a key disabled
    // because its payment was refunded is not touched by a dispute closing.
    ok(lc.enableByPaymentIntent("pi_cs_rf3", "disputed") === r3.keyId, "a dispute closed in our favor enables the key it disabled");
    const back = lc.authorize(r3.key, 0.001);
    ok(back.ok === true, "...and it authorizes again");
    lc.release(back.hash, back.heldMicro);
    ok(lc.enableByPaymentIntent("pi_cs_rf3", "disputed") === null && lc.enableByPaymentIntent("pi_cs_rf2", "disputed") === null && lc.authorize(r2.key, 0.001).reason === "disabled", "an enabled key, and a key disabled for a refund, are left as they are");
  }
  ok((await buy("cs_l7", { email: "c@x.com", card: "fp_c", pack: "credits-20" })).status === "minted", "limit: a small purchase by a new buyer is issued");
  t += 86_400_001;
  ok((await buy("cs_l8")).status === "minted", "limit: after 24 hours the same buyer can buy again");
  // The webhook and the thanks page claiming one session at once, with the
  // buyer one pack below the limit: one key, the other answers claimed, no refund.
  t += 86_400_001;
  ok((await buy("cs_r1")).status === "minted", "race: setup ($100 of $250)");
  ls.cs_r2 = { id: "cs_r2", mode: "payment", payment_status: "paid", payment_intent: "pi_cs_r2", customer_details: { email: "a@x.com" }, metadata: { credits_pack: "credits-100" } };
  fp.pi_cs_r2 = "fp_a";
  const before = refunds.length;
  const both = await Promise.all([lc.claim("cs_r2"), lc.claim("cs_r2"), lc.claim("cs_r2")]);
  ok(both.filter((x) => x.status === "minted").length === 1 && both.every((x) => x.status === "minted" || x.status === "claimed") && refunds.length === before, `race: one session claimed three times at once issues one key and refunds nothing (${both.map((x) => x.status).join(", ")})`);
  // Many sessions at once never pass the limit.
  const many = await Promise.all([3, 4, 5, 6].map((i) => buy(`cs_r${i + 10}`)));
  ok(many.filter((x) => x.status === "minted").length === 0 && many.every((x) => x.status === "over_limit"), "race: concurrent purchases past the limit are all refused");
  // A refund that fails is recorded, answered truthfully and listed to refund by hand.
  const failing = lstripe.refunds.create;
  lstripe.refunds.create = async () => { throw new Error("card closed"); };
  const f1 = await buy("cs_rf");
  const f2 = await lc.claim("cs_rf");
  ok(f1.status === "over_limit" && f1.refunded === false && f2.refunded === false, "a failed refund answers refunded:false, and a re-read says the same");
  ok((await lc.refusalsToRefund()).includes("cs_rf"), "the failed refund is listed for a refund by hand");
  await lc.markRefusalRefunded("cs_rf");
  ok(!(await lc.refusalsToRefund()).includes("cs_rf") && (await lc.claim("cs_rf")).refunded === true, "marking it refunded clears the list and the answer");
  lstripe.refunds.create = failing;
  // The guards behind the buyer lock, tested directly (another server, or a
  // lock that is unavailable, reaches them without the lock):
  // a session's own key never counts against it ...
  const own = lc._internals;
  const buyerA = { email: "a@x.com", cardFingerprint: "fp_a" };
  const withOwn = await own.boughtInDayCents(buyerA, t, "cs_r2");
  const withoutExclusion = await own.boughtInDayCents(buyerA, t, null);
  ok(withoutExclusion - withOwn === 10000, `a session's own key is left out of its buyer's daily total (${withOwn} vs ${withoutExclusion} cents)`);
  // ... and a claim that did not record the refusal never refunds.
  const rBefore = refunds.length;
  const lost = await own.refuseAndRefund("cs_r2", "pi_cs_r2", "refused", "daily_purchase_limit");
  ok(lost.status === "claimed" && refunds.length === rBefore, "a claim that finds the session already issued answers claimed and refunds nothing");
  // A refusal whose refund never finished (a crash between refusing and
  // refunding) is listed as owed once it has been pending past five minutes.
  ok(await own.refuseSession("cs_stuck", "refused"), "setup: a refusal recorded and left pending");
  ok(!(await lc.refusalsToRefund()).includes("cs_stuck"), "a fresh pending refusal is not yet owed");
  t += 6 * 60_000;
  ok((await lc.refusalsToRefund()).includes("cs_stuck"), "a refusal pending past five minutes is listed as owed");
  await lc.markRefusalRefunded("cs_stuck");
  ok(!(await lc.refusalsToRefund()).includes("cs_stuck") && (await lc.claim("cs_stuck")).refunded === true, "marking it refunded clears it");
  // An EU or UK billing address needs a business tax ID.
  const euBuy = (id, { country, taxIds = [] }) => {
    ls[id] = { id, mode: "payment", payment_status: "paid", payment_intent: "pi_" + id, customer_details: { email: `${id}@x.com`, address: { country }, tax_ids: taxIds }, metadata: { credits_pack: "credits-20" } };
    fp["pi_" + id] = "fp_" + id;
    return lc.claim(id);
  };
  const r0 = refunds.length;
  const de = await euBuy("cs_de", { country: "DE" });
  ok(de.status === "tax_id_required" && de.refunded === true && refunds.length === r0 + 1 && !de.key, "an EU billing address with no tax ID issues no key and is refunded");
  ok((await lc.claim("cs_de")).status === "tax_id_required", "re-claiming it answers the same");
  ok((await euBuy("cs_gb", { country: "GB" })).status === "tax_id_required", "the UK is included");
  ok((await euBuy("cs_de2", { country: "DE", taxIds: [{ type: "eu_vat", value: "DE123456789" }] })).status === "minted", "an EU business with a VAT ID is issued a key");
  ok((await euBuy("cs_de3", { country: "DE", taxIds: [{ type: "us_ein", value: "12-3456789" }] })).status === "tax_id_required", "a tax ID that is not an EU or UK VAT number does not count");
  ok((await euBuy("cs_us", { country: "US" })).status === "minted" && (await euBuy("cs_ch", { country: "CH" })).status === "minted", "other countries are unaffected");
  process.env.CREDITS_EU_UK_REQUIRE_TAX_ID = "off";
  ok((await euBuy("cs_fr", { country: "FR" })).status === "minted", "CREDITS_EU_UK_REQUIRE_TAX_ID=off lifts the rule");
  delete process.env.CREDITS_EU_UK_REQUIRE_TAX_ID;
  delete process.env.CREDITS_DAILY_MAX_USD;
  try { rmSync(LDIR, { recursive: true, force: true }); } catch { /* cleanup */ }
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

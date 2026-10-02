// Prepaid card credits - offline test with a stubbed Stripe. Proves the money
// discipline: a key is minted only for a PAID session and exactly once (a
// second claim never re-shows it); balances are exact sub-cent micro-dollars;
// the gate authorizes before the handler and debits ONLY on a final 200; an
// insufficient/unknown/disabled key gets a 402 with the balance; a non-credits
// request passes through untouched; accounting hooks fire; state survives a
// reload; operator status never exposes key material.
import { createCredits, CREDIT_PACKS, KEY_RE, usdToMicro, microToUsd } from "../src/credits.js";
import { rmSync } from "node:fs";
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
nexted = false; res = fakeRes();
const forged = { method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}`, "x-payment": "ZmFrZQ==", "payment-signature": "ZmFrZQ==", "payment-identifier": "x" } };
gate(forged, res, () => { nexted = true; });
ok(nexted && !("x-payment" in forged.headers) && !("payment-signature" in forged.headers) && !("payment-identifier" in forged.headers), "SECURITY: unsigned x402 payment headers are stripped when a credits request is accepted");
res.statusCode = 200; res.emit("finish");
// a prompt-cache hit is not charged
nexted = false; res = fakeRes(); res.getHeader = (k) => (k === "X-Cache" ? "hit" : undefined);
const bal0 = cr.balance(KEY).balanceUsd;
gate({ method: "GET", path: "/api/whois", headers: { authorization: `Bearer ${KEY}` } }, res, () => { nexted = true; });
res.statusCode = 200; res.emit("finish");
ok(cr.balance(KEY).balanceUsd === bal0 && cr.balance(KEY).heldUsd === 0, "a cache hit (X-Cache: hit) releases the hold - credits buyers get cached answers free like x402 buyers");
// clawback: a refunded/disputed pack disables its key
ok(cr.disableByPaymentIntent("pi_1", "refunded") === m1.keyId && cr.authorize(KEY, 0.001).reason === "disabled", "a refunded pack payment disables its key (clawback by PaymentIntent)");
cr.setDisabled(m1.keyId, false);
ok(cr.disableByPaymentIntent("pi_nope") === null, "an unknown PaymentIntent disables nothing");

// disabled keys; operator status without key material; persistence across reload
ok(cr.setDisabled(m1.keyId, true) && cr.authorize(KEY, 0.001).reason === "disabled", "operator can disable a key; it then refuses");
cr.setDisabled(m1.keyId, false);
const st = cr.status();
ok(st.keys === 1 && st.loadedUsd === 20 && st.outstandingUsd === 19.996 && st.rows[0].keyId === m1.keyId && !JSON.stringify(st).includes(KEY) && !JSON.stringify(st).includes(a.hash), "operator status has totals + key ids and never the key or its hash");
cr = mk();
ok(cr.balance(KEY).balanceUsd === 19.996 && (await cr.claim("cs_paid")).status === "claimed", "a fresh instance reads balances and the claim-once index from disk");

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
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

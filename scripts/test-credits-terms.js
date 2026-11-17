// The terms prepaid credits are sold on, enforced by the code (src/credits.js,
// src/credits-sales.js) and stated by /terms and /privacy only while sales are
// on: a cap on one key's balance (checked at checkout and at mint; nothing adds
// to a key after it is issued), no expiry, no fees, the unspent balance
// refunded to the card on request, and spending only on our own services
// (a route that buys from an outside seller refuses a key). Offline, file
// backend, stubbed Stripe; the switch is read at call time, so one process
// renders both states.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

delete process.env.CREDITS_SALES;
delete process.env.CREDITS_BALANCE_MAX_USD;
const { createCredits, sellablePacks, CREDIT_PACKS, hashKey } = await import("../src/credits.js");
const { creditsBalanceMaxCents, creditsTermsVersion, creditsLegalDate, CREDITS_SALES_TERMS_DATE, TERMS_VERSION } = await import("../src/credits-sales.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = join(tmpdir(), `test-credits-terms-${process.pid}`);
rmSync(DIR, { recursive: true, force: true });

// ---- a Stripe stub that records every refund and can fail or lose replies --
const charges = {}; // pi -> { amount, amount_refunded }
const refunds = [];
let refundMode = "ok"; // ok | fail | lost (lands, then the reply is lost)
let refundStatus = "succeeded"; // the status Stripe answers a refund with
const made = {}; // re_id -> the refund object Stripe holds
let clock = Date.now();
const sessions = {};
const paid = (id, pack, pi, email) => {
  sessions[id] = { id, mode: "payment", payment_status: "paid", payment_intent: pi, customer_details: { email }, metadata: { credits_pack: pack } };
  charges[pi] = { amount: CREDIT_PACKS[pack].cents, amount_refunded: 0 };
};
const stripe = {
  checkout: { sessions: { create: async (a) => { stripe._last = a; return { id: "cs_new", url: "https://checkout.stripe.com/c/cs_new" }; }, retrieve: async (id) => { if (!sessions[id]) throw new Error("no"); return sessions[id]; } } },
  paymentIntents: { retrieve: async (pi) => { if (stripe._readFails) throw new Error("read down"); const c = charges[pi]; return { id: pi, latest_charge: c ? { amount: c.amount, amount_refunded: c.amount_refunded, payment_method_details: { card: { fingerprint: `fp_${pi}` } } } : null }; } },
  refunds: { create: async (a, opts = {}) => {
    refunds.push({ ...a, idem: opts.idempotencyKey || null });
    if (refundMode === "fail") throw new Error("card network down");
    const c = charges[a.payment_intent];
    const amt = a.amount ?? (c.amount - c.amount_refunded);
    if (c.amount_refunded + amt > c.amount) throw new Error("amount exceeds charge");
    c.amount_refunded += amt;
    const r = { id: `re_${refunds.length}`, amount: amt, status: refundStatus, payment_intent: a.payment_intent, metadata: a.metadata || {} };
    made[r.id] = r;
    if (refundStatus === "failed" || refundStatus === "canceled") c.amount_refunded -= amt;
    if (refundMode === "lost") throw new Error("socket hang up");
    return { ...r };
  },
  retrieve: async (id) => { if (!made[id]) throw new Error("no such refund"); return { ...made[id] }; },
  list: async ({ payment_intent }) => ({ data: Object.values(made).filter((r) => r.payment_intent === payment_intent).map((r) => ({ ...r })) }) },
};
const cr = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: () => {}, now: () => clock });

// ---- the cap on one key's balance --------------------------------------------
ok(creditsBalanceMaxCents() === 10_000, "the cap on one key's balance defaults to $100");
ok(Object.keys(sellablePacks()).join() === Object.keys(CREDIT_PACKS).join(), "every pack is on offer at the default cap");
process.env.CREDITS_BALANCE_MAX_USD = "50";
ok(!("credits-100" in sellablePacks()) && "credits-50" in sellablePacks(), "a pack above a lowered cap is not on offer");
let err = null;
try { await cr.createCheckout("credits-100"); } catch (e) { err = e; }
ok(err?.statusCode === 400 && err.buyerSafe && /\$50/.test(err.message) && !err.validPacks.includes("credits-100"), `a checkout for a pack above the cap is refused before Stripe ("${String(err?.message).slice(0, 60)}...")`);
stripe._last = null;
await cr.createCheckout("credits-50");
ok(stripe._last?.line_items?.[0]?.price_data?.unit_amount === 5000, "a pack at the cap still checks out");
// The cap lowered between checkout and claim: refunded in full, no key.
paid("cs_big", "credits-100", "pi_big", "big@x.com");
const big = await cr.claim("cs_big");
ok(big.status === "over_balance_cap" && big.refunded === true && big.capUsd === 50 && !big.key, "a paid session above the cap is refunded in full and issues no key");
ok(refunds.length === 1 && refunds[0].payment_intent === "pi_big" && refunds[0].amount === undefined, "...with one full refund of that payment");
const big2 = await cr.claim("cs_big");
ok(big2.status === "over_balance_cap" && refunds.length === 1, "a second claim answers the same and refunds nothing more");
delete process.env.CREDITS_BALANCE_MAX_USD;

// ---- no top-up: nothing adds to a key after it is issued ----------------------
const src = readFileSync(new URL("../src/credits.js", import.meta.url), "utf8");
const loadedWrites = src.match(/loadedMicro\s*(\+=|=[^=])/g) || [];
ok(loadedWrites.length === 1 && /const loadedMicro = p\.cents \* 10_000;/.test(src), "loadedMicro is set once, at mint, from the pack");
const api = Object.keys(cr);
ok(!api.some((k) => /top.?up|add|credit(?!s)|load(?!ed)/i.test(k)), `the credits API has no way to add to an issued key (${api.length} methods)`);

// ---- no expiry -----------------------------------------------------------------
ok(!/expir/i.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/never expire/g, "")), "nothing in credits.js expires a key or a balance");
paid("cs_a", "credits-20", "pi_a", "a@x.com");
const A = await cr.claim("cs_a");
ok(A.status === "minted" && A.balanceUsd === 20, "a $20 key is minted");
{
  const recPath = join(DIR, `k_${hashKey(A.key)}.json`);
  const rec = JSON.parse(readFileSync(recPath, "utf8"));
  rec.createdAt = "2016-01-01T00:00:00.000Z";
  (await import("node:fs")).writeFileSync(recPath, JSON.stringify(rec));
}
const crAged = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: () => {}, now: () => clock });
const aged = crAged.authorize(A.key, 0.5);
ok(aged.ok, "a key issued ten years ago still authorizes");
crAged.settle(aged.hash, aged.heldMicro, "whois");
ok(crAged.balance(A.key).balanceUsd === 19.5, "and is debited exactly the list price, no fee");

// ---- spent only on our own services ---------------------------------------------
{
  const gate = crAged.gate((m, p) => (p === "/api/route/execute" ? { priceUsd: 0.05, slug: "route-execute", paysThirdParty: true } : null));
  const res = new EventEmitter(); res.headers = {}; res.statusCode = 200;
  res.setHeader = (k, v) => { res.headers[k] = v; }; res.getHeader = (k) => res.headers[k]; res.status = (c) => { res.statusCode = c; return res; }; res.json = (j) => { res.body = j; return res; };
  let nexted = false;
  gate({ method: "POST", path: "/api/route/execute", headers: { authorization: `Bearer ${A.key}` } }, res, () => { nexted = true; });
  ok(!nexted && res.statusCode === 402 && res.body?.reason === "third-party-purchase" && crAged.balance(A.key).balanceUsd === 19.5 && crAged.balance(A.key).heldUsd === 0, "a route that buys from an outside seller refuses a key and holds nothing");
}

// ---- refund on request -------------------------------------------------------------
ok((await crAged.requestRefund("a402_nope")).status === "malformed" && (await crAged.requestRefund(`a402_${"z".repeat(40)}`)).status === "unknown", "a malformed or unknown key moves nothing");
const held = crAged.authorize(A.key, 1);
const inflight = await crAged.requestRefund(A.key);
ok(inflight.status === "in_flight" && crAged.balance(A.key).balanceUsd === 18.5 && refunds.length === 1, "a request while a call holds part of the balance moves nothing");
crAged.release(held.hash, held.heldMicro);
const r1 = await crAged.requestRefund(A.key);
const sent = refunds[refunds.length - 1];
ok(r1.status === "refunded" && r1.refundedUsd === 19.5 && sent.payment_intent === "pi_a" && sent.amount === 1950 && /^credits-refund-/.test(sent.idem), `the whole unspent balance goes back to the card that bought the key, no fee (${sent.amount} cents)`);
ok(charges.pi_a.amount_refunded === 1950, "the charge shows exactly that refund");
const b1 = crAged.balance(A.key);
ok(b1.balanceUsd === 0 && b1.disabled && b1.refund?.state === "refunded" && b1.refund.amountUsd === 19.5, "the key is disabled with nothing left, and its balance read says refunded");
ok(crAged.authorize(A.key, 0.001).reason === "disabled", "a refunded key cannot spend");
const again = await crAged.requestRefund(A.key);
ok(again.status === "refunded" && refunds.length === 2, "asking again answers refunded and sends nothing more");
// The Stripe webhook for that refund (partial: $0.50 was spent) keeps the key as it is.
ok(crAged.disableByPaymentIntent("pi_a", "refunded", { amountRefundedCents: 1950, fullyRefunded: false }) === b1.keyId && crAged.balance(A.key).balanceUsd === 0 && crAged.balance(A.key).disabled, "the webhook for the same refund takes nothing more");

// Sub-cent balance: rounded up to the cent, never more than the charge has left.
paid("cs_c", "credits-20", "pi_c", "c@x.com");
const C = await crAged.claim("cs_c");
const hc = crAged.authorize(C.key, 0.0015); crAged.settle(hc.hash, hc.heldMicro, "whois");
const rc = await crAged.requestRefund(C.key);
ok(rc.status === "refunded" && refunds[refunds.length - 1].amount === 2000 && charges.pi_c.amount_refunded === 2000, "a sub-cent remainder rounds up, capped at the charge ($19.9985 -> 2000 cents)");
// A full refund's webhook keeps the requester's cause in the operator-free ranks.
crAged.disableByPaymentIntent("pi_c", "refunded", { amountRefundedCents: 2000, fullyRefunded: true });
const rcRec = JSON.parse(readFileSync(join(DIR, `k_${hashKey(C.key)}.json`), "utf8"));
ok(rcRec.disabled && rcRec.disabledReason !== "operator", `a full-refund webhook never turns the cause into an operator disable (${rcRec.disabledReason})`);

// A key with nothing left.
paid("cs_d", "credits-20", "pi_d", "d@x.com");
const D = await crAged.claim("cs_d");
const hd = crAged.authorize(D.key, 20); crAged.settle(hd.hash, hd.heldMicro, "dossier");
const before = refunds.length;
ok((await crAged.requestRefund(D.key)).status === "nothing_to_refund" && refunds.length === before && !crAged.balance(D.key).disabled, "a key with no balance answers nothing_to_refund, sends nothing and stays as it was");

// A send that fails: owed, and asking again retries under the same idempotency key.
paid("cs_e", "credits-20", "pi_e", "e@x.com");
const E = await crAged.claim("cs_e");
refundMode = "fail";
const e1 = await crAged.requestRefund(E.key);
ok(e1.status === "pending" && e1.refundUsd === 20 && crAged.balance(E.key).disabled && crAged.balance(E.key).balanceUsd === 0, "a failed send answers pending; the key is already disabled and empty");
ok((await crAged.refundRequestsOwed()).includes(E.keyId), "the failed request is owed (creditsRefunds)");
refundMode = "ok";
const e2 = await crAged.requestRefund(E.key);
const eSends = refunds.filter((r) => r.payment_intent === "pi_e");
ok(e2.status === "refunded" && eSends.length === 2 && eSends[0].idem === eSends[1].idem && charges.pi_e.amount_refunded === 2000, "asking again sends it once more under the same idempotency key, and it lands once");
ok(!(await crAged.refundRequestsOwed()).includes(E.keyId), "...and nothing is owed after");

// A send that landed but whose reply was lost is never sent twice.
paid("cs_f", "credits-20", "pi_f", "f@x.com");
const F = await crAged.claim("cs_f");
refundMode = "lost";
ok((await crAged.requestRefund(F.key)).status === "pending" && charges.pi_f.amount_refunded === 2000, "a lost reply reads as pending though the refund landed");
refundMode = "ok";
const fSendsBefore = refunds.filter((r) => r.payment_intent === "pi_f").length;
const f2 = await crAged.requestRefund(F.key);
ok(f2.status === "refunded" && refunds.filter((r) => r.payment_intent === "pi_f").length === fSendsBefore && charges.pi_f.amount_refunded === 2000, "asking again reads the charge, records the refund and sends nothing");
// While the charge cannot be read, a later send is not made.
paid("cs_g", "credits-20", "pi_g", "g@x.com");
const G = await crAged.claim("cs_g");
refundMode = "fail";
await crAged.requestRefund(G.key);
refundMode = "ok"; stripe._readFails = true;
const gSends = refunds.filter((r) => r.payment_intent === "pi_g").length;
ok((await crAged.requestRefund(G.key)).status === "pending" && refunds.filter((r) => r.payment_intent === "pi_g").length === gSends, "a retry whose charge cannot be read sends nothing");
stripe._readFails = false;
// Refunded by hand in Stripe: the webhook records the request as done.
crAged.disableByPaymentIntent("pi_g", "refunded", { amountRefundedCents: 2000, fullyRefunded: true });
ok(!(await crAged.refundRequestsOwed()).includes(G.keyId) && crAged.balance(G.key).refund?.state === "refunded", "a refund made by hand is recorded by the charge.refunded webhook");

// ---- a refund is done only when Stripe says it succeeded --------------------------
const rrOf = (key) => JSON.parse(readFileSync(join(DIR, `k_${hashKey(key)}.json`), "utf8")).refundRequest;
const refundEvent = (id, status) => ({ ...made[id], status });
const setStatus = (id, status) => { const r = made[id]; const c = charges[r.payment_intent]; if ((status === "failed" || status === "canceled") && r.status !== "failed" && r.status !== "canceled") c.amount_refunded -= r.amount; r.status = status; };
// Pending: answered pending, recorded with Stripe's id, not owed while Stripe
// holds it; the refund.updated webhook settles it, once.
paid("cs_h", "credits-20", "pi_h", "h@x.com");
const H = await crAged.claim("cs_h");
refundStatus = "pending";
const h1 = await crAged.requestRefund(H.key);
const hId = rrOf(H.key).refundId;
ok(h1.status === "pending" && rrOf(H.key).state === "pending" && /^re_/.test(hId) && crAged.balance(H.key).refund?.state === "pending", "a refund Stripe answers pending is not recorded as refunded");
clock += 60 * 60_000;
ok(!(await crAged.refundRequestsOwed()).includes(H.keyId), "a refund pending at Stripe is not owed while it waits for its webhook");
const hSends = refunds.length;
ok((await crAged.requestRefund(H.key)).status === "pending" && refunds.length === hSends, "asking again reads the pending refund and sends nothing");
ok(crAged.disableByPaymentIntent("pi_h", "refunded", { amountRefundedCents: 2000, fullyRefunded: true }) === H.keyId && rrOf(H.key).state === "pending", "the charge.refunded webhook does not settle a refund we sent (its charge counts a pending refund)");
setStatus(hId, "succeeded");
ok(crAged.settleRefund(refundEvent(hId, "succeeded")) === H.keyId && rrOf(H.key).state === "done" && crAged.balance(H.key).refund?.state === "refunded", "refund.updated succeeded marks the request done");
ok(crAged.settleRefund(refundEvent(hId, "succeeded")) === null && rrOf(H.key).state === "done", "a retried delivery changes nothing");
ok(crAged.settleRefund({ ...refundEvent(hId, "succeeded"), metadata: { credits_refund_request: "k_other" } }) === null && crAged.settleRefund({ ...refundEvent(hId, "succeeded"), payment_intent: "pi_other" }) === null, "an event naming another key or payment changes nothing");
// Pending, then failed at Stripe: owed (creditsRefunds), and asking again sends anew under a new idempotency key.
paid("cs_i", "credits-20", "pi_i", "i@x.com");
const I = await crAged.claim("cs_i");
await crAged.requestRefund(I.key);
const iId = rrOf(I.key).refundId;
setStatus(iId, "failed");
ok(crAged.settleRefund(refundEvent(iId, "failed")) === I.keyId && rrOf(I.key).state === "failed", "refund.failed moves a pending request to failed");
ok((await crAged.refundRequestsOwed()).includes(I.keyId), "...and it is owed (creditsRefunds)");
ok(crAged.settleRefund(refundEvent(iId, "failed")) === null && crAged.settleRefund(refundEvent(iId, "canceled")) === null && rrOf(I.key).failedIds.length === 1, "a retried failure event changes nothing");
refundStatus = "succeeded";
const i2 = await crAged.requestRefund(I.key);
const iSends = refunds.filter((r) => r.payment_intent === "pi_i");
ok(i2.status === "refunded" && iSends.length === 2 && iSends[0].idem !== iSends[1].idem && charges.pi_i.amount_refunded === 2000, "asking again after a failure sends a new refund under a new idempotency key, and it lands once");
ok(!(await crAged.refundRequestsOwed()).includes(I.keyId), "...and nothing is owed after");
ok(crAged.settleRefund(refundEvent(iId, "failed")) === null && rrOf(I.key).state === "done", "a late event for the failed refund leaves the done request alone");
// Stripe answers the send itself with failed (or canceled): owed at once.
for (const st of ["failed", "canceled"]) {
  paid(`cs_j${st}`, "credits-20", `pi_j${st}`, `j${st}@x.com`);
  const J = await crAged.claim(`cs_j${st}`);
  refundStatus = st;
  const j1 = await crAged.requestRefund(J.key);
  ok(j1.status === "pending" && rrOf(J.key).state === "failed" && (await crAged.refundRequestsOwed()).includes(J.keyId) && charges[`pi_j${st}`].amount_refunded === 0, `a refund Stripe answers ${st} is owed, never recorded as refunded`);
  // The charge can still count it for a while: the refunds themselves decide.
  charges[`pi_j${st}`].amount_refunded = 2000;
  refundStatus = "succeeded";
  const j2 = await crAged.requestRefund(J.key);
  ok(j2.status === "pending" && rrOf(J.key).state === "failed" && (await crAged.refundRequestsOwed()).includes(J.keyId), `after a ${st} refund, a charge that still counts it does not read as refunded; it stays owed`);
  charges[`pi_j${st}`].amount_refunded = 0;
  const j3 = await crAged.requestRefund(J.key);
  const jSends = refunds.filter((r) => r.payment_intent === `pi_j${st}`);
  ok(j3.status === "refunded" && jSends.length === 3 && jSends[0].idem !== jSends[2].idem && charges[`pi_j${st}`].amount_refunded === 2000, `...and once the charge drops it, asking again sends a new refund under a new idempotency key (${jSends.length} sends)`);
}
// Succeeded, then failed later at Stripe: owed again.
paid("cs_k", "credits-20", "pi_k", "k@x.com");
const K = await crAged.claim("cs_k");
await crAged.requestRefund(K.key);
const kId = rrOf(K.key).refundId;
ok(rrOf(K.key).state === "done", "a refund Stripe answers succeeded is done");
setStatus(kId, "failed");
ok(crAged.settleRefund(refundEvent(kId, "failed")) === K.keyId && rrOf(K.key).state === "failed" && (await crAged.refundRequestsOwed()).includes(K.keyId) && crAged.balance(K.key).refund?.state === "pending", "a refund that fails after it succeeded is owed again");
// Pending at Stripe past a week: owed, so it pages.
paid("cs_l", "credits-20", "pi_l", "l@x.com");
const L = await crAged.claim("cs_l");
refundStatus = "pending";
await crAged.requestRefund(L.key);
refundStatus = "succeeded";
clock += 8 * 86_400_000;
ok((await crAged.refundRequestsOwed()).includes(L.keyId), "a refund still pending at Stripe after a week is owed");
setStatus(rrOf(L.key).refundId, "succeeded");
crAged.settleRefund(refundEvent(rrOf(L.key).refundId, "succeeded"));
ok(!(await crAged.refundRequestsOwed()).includes(L.keyId), "...and clears once it succeeds");

// ---- a key the operator switched off keeps its balance refundable --------------------
paid("cs_m", "credits-20", "pi_m", "m@x.com");
const M = await crAged.claim("cs_m");
crAged.setDisabled(M.keyId, true);
const m1 = await crAged.requestRefund(M.key);
const mRec = JSON.parse(readFileSync(join(DIR, `k_${hashKey(M.key)}.json`), "utf8"));
ok(m1.status === "refunded" && m1.refundedUsd === 20 && charges.pi_m.amount_refunded === 2000 && mRec.disabled && mRec.disabledReason === "operator", "an operator-disabled key gets its unspent balance back, and the operator's cause stays on the key");
paid("cs_n", "credits-20", "pi_n", "n@x.com");
const N = await crAged.claim("cs_n");
crAged.disableByPaymentIntent("pi_n", "disputed");
const nBefore = refunds.length;
ok((await crAged.requestRefund(N.key)).status === "disputed" && refunds.length === nBefore, "a key under an open dispute answers disputed and sends nothing");
crAged.setDisabled(N.keyId, true);
ok((await crAged.requestRefund(N.key)).status === "disputed" && refunds.length === nBefore, "...also when the operator switched it off after the dispute");

// ---- the checkout states the terms it sells on -----------------------------------
process.env.CREDITS_SALES = "on";
stripe._last = null;
await cr.createCheckout("credits-20");
const msg = stripe._last.custom_text.submit.message, desc = stripe._last.line_items[0].price_data.product_data.description;
ok(/refunded to this card on request/.test(msg) && /no fees/.test(msg) && /never expire/.test(msg) && /only on Agent402's own services/.test(msg) && !/not refundable/.test(msg), "the pay button's text states refund on request, no fees, no expiry, own services only");
ok(/refunded to this card on request/.test(desc) && /no fees/.test(desc) && /never expire/.test(desc), "the product description says the same");
ok(stripe._last.metadata.terms === creditsTermsVersion(), `the checkout records the terms version (${stripe._last.metadata.terms})`);

// ---- /terms and /privacy: switch-on text matches the code, switch-off unchanged ---
const { termsPage } = await import("../src/terms.js");
const { privacyPage } = await import("../src/privacy.js");
const dateOf = (html) => (html.match(/last updated (\d{4}-\d{2}-\d{2})\./) || [])[1];
const strip = (html) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
const tOn = termsPage("https://agent402.tools"), pOn = privacyPage("https://agent402.tools");
delete process.env.CREDITS_SALES;
const tOff = termsPage("https://agent402.tools"), pOff = privacyPage("https://agent402.tools");
const tOnText = strip(tOn), tOffText = strip(tOff);
ok(tOnText.includes("the unspent balance on a key is refundable on request, with no fee") && tOnText.includes("POST /api/credits/refund"), "/terms (on) offers refund on request through the route the server serves");
ok(/app\.post\("\/api\/credits\/refund"/.test(readFileSync(new URL("../src/server.js", import.meta.url), "utf8")), "...and that route exists");
ok(/A key we switched off keeps its unspent balance refundable the same way; while a dispute of the payment that bought the key is open, the dispute settles what goes back to the card instead/.test(tOnText) && /or that Stripe reports as failed, stays owed to you/.test(tOnText), "/terms (on) states the rule for a switched-off or disputed key and for a refund Stripe fails");
ok(tOnText.includes(`no key holds more than $${creditsBalanceMaxCents() / 100}`), "/terms (on) states the cap the code enforces");
ok(/Credits never expire and carry no fees/.test(tOnText) && /Routes that buy from an outside seller with our wallet are paid with a wallet, not with credits/.test(tOnText), "/terms (on) states no expiry, no fees and own services only");
ok(!tOnText.includes("unspent balance under $10") && !/non-refundable/.test(tOnText.slice(tOnText.indexOf("Prepaid credits are consumed"), tOnText.indexOf("Prepaid credits are consumed") + 300)), "/terms (on) drops the $10 exception and the non-refundable rule");
ok(tOffText.includes("non-refundable except where required by law, with one exception: an unspent balance under $10") && !tOffText.includes("/api/credits/refund") && !/no key holds more than/.test(tOffText), "/terms (off) keeps the sentence issued keys were sold under and offers no refund route");
ok(dateOf(tOff) === TERMS_VERSION && dateOf(pOff) === TERMS_VERSION, `with sales off both pages keep their own date (${TERMS_VERSION})`);
const today = new Date().toISOString().slice(0, 10);
const want = CREDITS_SALES_TERMS_DATE <= today ? CREDITS_SALES_TERMS_DATE : TERMS_VERSION;
ok(dateOf(tOn) === want && dateOf(pOn) === want, `with sales on both pages print the date the on-sale text was written (${dateOf(tOn)})`);
process.env.CREDITS_SALES = "on";
ok(creditsTermsVersion() === dateOf(tOn), "the version a checkout records is the date /terms prints with sales on");
ok(creditsLegalDate("2099-01-01") === "2099-01-01" && creditsLegalDate("2026-01-01", "2026-11-16") === "2026-01-01", "control: a later page date wins, and the on-sale date never prints before its day");
delete process.env.CREDITS_SALES;
ok(/the key's record also keeps the amount refunded, when you asked, and Stripe's id for the refund/.test(strip(pOn)) && !/amount refunded, when you asked/.test(strip(pOff)), "/privacy states the refund record only while sales are on");

// ---- copy that cannot be true in both states reads the switch -----------------
{
  const { skillMd } = await import("../src/skill-md.js");
  process.env.CREDITS_SALES = "on";
  const on = skillMd("https://agent402.tools", {});
  delete process.env.CREDITS_SALES;
  const off = skillMd("https://agent402.tools", {});
  ok(/\(new keys are sold by card at https:\/\/agent402\.tools\/credits\)/.test(on) && !/new credits are not on sale/.test(on), "SKILL.md (on) says new keys are sold at /credits");
  ok(/\(new credits are not on sale\)/.test(off) && !/new keys are sold by card/.test(off), "SKILL.md (off) keeps saying new credits are not on sale");
  // The on-sale lines that name where a key pays name the routes that refuse one.
  const learnSrc = readFileSync(new URL("../src/learn.js", import.meta.url), "utf8"), pagesSrc = readFileSync(new URL("../src/pages.js", import.meta.url), "utf8");
  ok(/creditsSalesEnabled\(\) \? "For most of the rest, a prepaid card-credits key works on any paid tool except the wallet-scoped ones \(memory, usage\) and the routes that buy from an outside seller/.test(learnSrc), "/learn (on) names the routes a key does not pay");
  ok(/creditsOnSale \? ' Prepaid credits at <a href="\/credits">\/credits<\/a> pay any paid tool except the wallet-scoped ones and the routes that buy from an outside seller[^']*refunded to your card on request\.'/.test(pagesSrc), "/faq (on) names the routes a key does not pay and the refund on request");
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

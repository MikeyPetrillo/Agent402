// The checks around buying and holding prepaid credits (src/credits.js,
// src/credits-sales.js, src/stripe-subscriptions.js): card authentication and
// neutral tags on every checkout, the checkout and purchase counts, payments
// that did not go through, a flagged charge, the freeze on a dispute or an
// early fraud warning and its refund, the holder's spending limits, revoking
// a key by presenting it, and the key format. Offline: file backend, stubbed
// Stripe, the shared store in process memory. Every threshold and review
// signal comes from a private table drawn at random for this run
// (scripts/lib/credits-guards-table.js) and is read back from it, never typed.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { looseCreditsChecks } from "./lib/credits-loose-checks.js"; // wide purchase checks (see the file)
import { makeGuardsTable, useGuardsTable, guardsTable } from "./lib/credits-guards-table.js";
import { rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

delete process.env.CREDITS_SALES;
delete process.env.CREDITS_EFW_AUTO_REFUND;
const { createCredits, CREDIT_PACKS, sellablePacks, KEY_RE, KEY_PREFIX, KEY_SCAN_RE, chargeFlagged } = await import("../src/credits.js");
const { PURCHASE_REFUSED, creditsDailyMaxCents } = await import("../src/credits-sales.js");
const { createStripeSubscriptions } = await import("../src/stripe-subscriptions.js");
const { urlCarriesCreditsKey } = await import("../src/credits-key-url.js");
const { redactSecrets } = await import("../src/tools/redact.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = join(tmpdir(), `test-credits-checks-${process.pid}`);
rmSync(DIR, { recursive: true, force: true });

// ---- a Stripe stub ---------------------------------------------------------------
const sessions = {}, charges = {}, refunds = [], made = {}, creates = [];
let seq = 0;
const stripe = {
  checkout: { sessions: { create: async (a) => { creates.push(a); seq++; return { id: `cs_new${seq}`, url: `https://checkout.stripe.com/c/cs_new${seq}` }; }, retrieve: async (id) => { if (!sessions[id]) throw new Error("no"); return sessions[id]; } } },
  paymentIntents: { retrieve: async (pi) => { const c = charges[pi]; return { id: pi, latest_charge: c ? { amount: c.amount, amount_refunded: c.amount_refunded, outcome: c.outcome || { type: "authorized", risk_level: "normal" }, payment_method_details: { card: { fingerprint: c.fp || `fp_${pi}` } } } : null }; } },
  refunds: {
    create: async (a, opts = {}) => {
      const c = charges[a.payment_intent];
      const amt = a.amount ?? (c.amount - c.amount_refunded);
      if (c.amount_refunded + amt > c.amount) throw new Error("amount exceeds charge");
      c.amount_refunded += amt;
      const r = { id: `re_${refunds.length + 1}`, amount: amt, status: "succeeded", payment_intent: a.payment_intent, metadata: a.metadata || {} };
      refunds.push({ ...a, idem: opts.idempotencyKey || null }); made[r.id] = r;
      return { ...r };
    },
    retrieve: async (id) => ({ ...made[id] }),
    list: async ({ payment_intent }) => ({ data: Object.values(made).filter((r) => r.payment_intent === payment_intent) }),
  },
};
// A run's table with the counts under test drawn fresh (the rest kept).
const strict = () => { const t = { ...guardsTable(), purchase: makeGuardsTable().purchase }; useGuardsTable(t); return t.purchase; };
const paid = (id, pack, pi, email, { fp = null, outcome = null, meta = {}, customer = null } = {}) => {
  sessions[id] = { id, mode: "payment", payment_status: "paid", payment_intent: pi, customer, customer_details: { email }, metadata: { credits_pack: pack, ...meta } };
  charges[pi] = { amount: CREDIT_PACKS[pack].cents, amount_refunded: 0, fp, outcome };
};
let clock = Date.parse("2026-11-22T12:00:00Z");
const limitNotices = [];
const cr = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: () => {}, now: () => clock, tagSecret: Buffer.from("test-tag-secret"), onSpendLimit: (n) => limitNotices.push(n) });
function fakeRes() { const r = new EventEmitter(); r.statusCode = 200; r.headersSent = false; r.end = () => r; r.headers = {}; r.setHeader = (k, v) => { r.headers[k] = v; }; r.getHeader = (k) => r.headers[k]; r.status = (c) => { r.statusCode = c; return r; }; r.json = (j) => { r.body = j; r.emit("finish"); return r; }; return r; }

// ---- keys: the format, shown once, stored only as a hash ----------------------------
paid("cs_k1", "credits-10", "pi_k1", "k1@x.com");
const K1 = await cr.claim("cs_k1");
ok(K1.status === "minted" && K1.key.startsWith(KEY_PREFIX) && K1.key.length === KEY_PREFIX.length + 43 && KEY_RE.test(K1.key), `a new key carries the prefix and 32 random bytes (${K1.key.slice(0, 8)}...)`);
ok(KEY_RE.test(`a402_${"A".repeat(32)}`), "a key issued before the prefix still matches the key format");
ok((await cr.claim("cs_k1")).key === undefined, "the key is shown once");
const files = readdirSync(DIR).map((f) => readFileSync(join(DIR, f), "utf8")).join("\n");
ok(!files.includes(K1.key) && !files.includes(K1.key.slice(8)), "no stored record holds the key");
ok([...`x ${K1.key} y`.matchAll(KEY_SCAN_RE)].length === 1, "the scan pattern finds a key in text");
ok(!redactSecrets(`auth failed for Bearer ${K1.key}`).includes(K1.key.slice(8)) && redactSecrets(`Bearer ${K1.key}`).includes("a402_[redacted]"), "log redaction removes a key's secret");
// A key in a URL is refused wherever it sits, encoded or not.
for (const u of [`/api/credits/balance?key=${K1.key}`, `/x/${K1.key}`, `/api/x?k=${encodeURIComponent(K1.key).replace(/_/g, "%5F")}`, `/api/x?k=${encodeURIComponent(encodeURIComponent(K1.key))}`]) ok(urlCarriesCreditsKey(u), `a URL carrying a key is caught (${u.slice(0, 24)}...)`);
ok(!urlCarriesCreditsKey("/credits/low-balance/off?key=0123456789ab&k=abc") && !urlCarriesCreditsKey("/api/credits/claim?session=cs_123"), "a key id or a session id is not a key");

// ---- every checkout asks for card authentication and carries neutral tags ----------------
creates.length = 0;
await cr.createCheckout("credits-5", { email: "Buyer@Example.com", ip: "203.0.113.5" });
const c1 = creates.at(-1);
ok(c1.payment_method_options?.card?.request_three_d_secure === "any", "a pack checkout asks for card authentication on every payment");
ok(c1.customer_email === "Buyer@Example.com" && c1.metadata.credits_account === "buyer@example.com", "a signed-in purchase is bound to the account's email");
const md = c1.payment_intent_data?.metadata || {};
ok(md.credits_pack === "credits-5" && md.ref_pack_usd === "5" && /^[0-9a-f]{24}$/.test(md.ref_buyer) && /^[0-9a-f]{24}$/.test(md.ref_source), "the payment carries the pack and neutral buyer and source tags for Stripe's rules");
ok(!JSON.stringify(c1).includes("203.0.113.5") && !JSON.stringify(md).toLowerCase().includes("buyer@example.com") && !/a402_/.test(JSON.stringify(c1)), "no address, email or key in the payment's tags");
creates.length = 0;
await cr.createTopupCheckout(K1.keyId, "k1@x.com", "credits-5", { ip: "203.0.113.5" });
const t1 = creates.at(-1);
ok(t1.payment_method_options?.card?.request_three_d_secure === "any" && /^[0-9a-f]{24}$/.test(t1.payment_intent_data?.metadata?.ref_balance) && t1.payment_intent_data.metadata.ref_balance !== K1.keyId, "a top-up checkout asks for authentication and tags the balance by a digest");

// ---- the daily purchase limit, starting low --------------------------------------------
{
  const prev = process.env.CREDITS_DAILY_MAX_USD;
  delete process.env.CREDITS_DAILY_MAX_USD;
  const dflt = creditsDailyMaxCents();
  ok(Object.values(sellablePacks()).every((p) => p.cents <= dflt) && Object.keys(sellablePacks()).length < Object.keys(CREDIT_PACKS).length, "a pack above the default daily purchase limit is not offered");
  let e = null; try { await cr.createCheckout("credits-100", { email: "d@x.com" }); } catch (x) { e = x; }
  ok(e?.statusCode === 400 && e.buyerSafe && !e.validPacks.includes("credits-100"), "a checkout for a pack above the daily limit is refused before any payment");
  process.env.CREDITS_DAILY_MAX_USD = prev;
}

// ---- checkout counts per client and per account ------------------------------------------
{
  const P = strict();
  const ip = "198.51.100.20";
  for (let i = 1; i <= P.sourcePerHour; i++) await cr.createCheckout("credits-5", { email: `s${i}@x.com`, ip });
  let e = null; try { await cr.createCheckout("credits-5", { email: "s-over@x.com", ip }); } catch (x) { e = x; }
  ok(e?.statusCode === 429 && e.message === PURCHASE_REFUSED, "a client past the checkout count is refused with the plain answer");
  ok(!/\d/.test(PURCHASE_REFUSED.replace(/agent402/gi, "")) && !/hour|day|limit|decline|fraud|velocity/i.test(PURCHASE_REFUSED), "the refusal names no check, count or window");
  let ok2 = true; try { await cr.createCheckout("credits-5", { email: "s4@x.com", ip: "198.51.100.21" }); } catch { ok2 = false; }
  ok(ok2, "another client is not affected");
  // s1 started one checkout above; it may start the rest of its count from other clients.
  e = null; try { for (let i = 1; i < P.sourcePerHour; i++) await cr.createCheckout("credits-5", { email: "s1@x.com", ip: `198.51.100.${30 + i}` }); } catch (x) { e = x; }
  let e2 = null; try { await cr.createCheckout("credits-5", { email: "s1@x.com", ip: "198.51.100.99" }); } catch (x) { e2 = x; }
  ok(!e && e2?.message === PURCHASE_REFUSED, "an account is counted too, from any client");
}
looseCreditsChecks();

// ---- payments that did not go through --------------------------------------------------
{
  const P = strict();
  const ip = "192.0.2.50";
  creates.length = 0;
  await cr.createCheckout("credits-5", { email: "f@x.com", ip });
  const src = creates.at(-1).payment_intent_data.metadata.ref_source;
  for (let i = 0; i < P.failedMax; i++) await cr.notePaymentFailed({ source: src, cardFingerprint: "fp_bad" });
  let e = null; try { await cr.createCheckout("credits-5", { email: "f2@x.com", ip }); } catch (x) { e = x; }
  ok(e?.message === PURCHASE_REFUSED, "a source past the failed-payment count starts no new checkout");
  // A paid session on the card that failed repeatedly is refunded and issues no key.
  paid("cs_fp", "credits-5", "pi_fp", "fp@x.com", { fp: "fp_bad" });
  const r = await cr.claim("cs_fp");
  ok(r.status === "not_completed" && r.refunded === true && !r.key && r.error === PURCHASE_REFUSED, "a payment from a held card is refunded in full and issues no key");
  ok(refunds.some((x) => x.payment_intent === "pi_fp" && x.amount === undefined), "...refunded on its own payment");
  clock += P.failedHoldMs + 1;
  useGuardsTable({ ...guardsTable(), purchase: { ...P, sourcePerDay: P.sourcePerDay + 1 } });
  let later = true; try { await cr.createCheckout("credits-5", { email: "f3@x.com", ip }); } catch { later = false; }
  ok(later, "the hold ends after its window");
}
looseCreditsChecks();

// ---- purchases per buyer -----------------------------------------------------------------
{
  const P = strict();
  const n = P.buyerPerHour;
  for (let i = 0; i <= n; i++) paid(`cs_v${i}`, "credits-5", `pi_v${i}`, i === 0 ? "v@x.com" : `v${i}@x.com`, { fp: "fp_same" });
  let inside = true; for (let i = 0; i < n; i++) inside = inside && (await cr.claim(`cs_v${i}`)).status === "minted";
  ok(inside, `purchases inside the count are issued (${n} this run)`);
  const vOver = await cr.claim(`cs_v${n}`);
  ok(vOver.status === "not_completed" && vOver.refunded === true, "a purchase past the count (the same card under another email) is refunded with no key");
  for (let i = 0; i <= n; i++) paid(`cs_c${i}`, "credits-5", `pi_c${i}`, `c${i}@x.com`, { customer: "cus_same" });
  for (let i = 0; i < n; i++) await cr.claim(`cs_c${i}`);
  ok((await cr.claim(`cs_c${n}`)).status === "not_completed", "the same Stripe customer under other emails and cards is one buyer");
  clock += 2 * 3600_000;
  paid("cs_vlater", "credits-5", "pi_vlater", "v@x.com");
  ok((await cr.claim("cs_vlater")).status === "minted", "the count is per window");
}
looseCreditsChecks();

// ---- a flagged charge issues nothing ---------------------------------------------------
const F = guardsTable().flagged;
ok(chargeFlagged({ outcome: { type: F.outcomeTypes[0] } }) && chargeFlagged({ outcome: { risk_level: F.riskLevels[0] } }) && !chargeFlagged({ outcome: { type: "authorized", risk_level: "normal" } }) && !chargeFlagged(null), "a charge whose review outcome the table lists is flagged; others are not");
{
  const keep = process.env.CREDITS_GUARDS_JSON;
  delete process.env.CREDITS_GUARDS_JSON;
  ok(chargeFlagged({ outcome: { type: "authorized", risk_level: "normal" } }), "without the table every charge counts as flagged (nothing is issued unchecked)");
  process.env.CREDITS_GUARDS_JSON = keep;
}
paid("cs_flag", "credits-5", "pi_flag", "flag@x.com", { outcome: { type: F.outcomeTypes[0], risk_level: "normal" } });
{
  const r = await cr.claim("cs_flag");
  ok(r.status === "not_completed" && !r.key && charges.pi_flag.amount_refunded === 500, "a flagged charge is refunded in full and issues no key");
}

// ---- the holder's spending limits --------------------------------------------------------
{
  paid("cs_lim", "credits-10", "pi_lim", "lim@x.com");
  const L = await cr.claim("cs_lim");
  const set = await cr.setLimits(L.keyId, "lim@x.com", { dailyUsd: 0.05, perCallUsd: 0.03 });
  ok(set.status === "set" && set.limits.dailyUsd === 0.05 && set.limits.perCallUsd === 0.03, "the holder sets a daily and a per-call limit");
  ok((await cr.setLimits(L.keyId, "someone@else.com", { dailyUsd: 1 })).status === "unknown", "only the balance's own account sets its limits");
  const big = cr.authorize(L.key, 0.04);
  ok(!big.ok && big.reason === "over_call_limit", "a call above the per-call limit is refused, nothing held");
  const a1 = cr.authorize(L.key, 0.03); cr.settle(a1.hash, a1.heldMicro, "t");
  const a2 = cr.authorize(L.key, 0.02); cr.settle(a2.hash, a2.heldMicro, "t");
  const a3 = cr.authorize(L.key, 0.001);
  ok(a1.ok && a2.ok && !a3.ok && a3.reason === "over_daily_limit", "calls up to the daily limit run; the next is refused");
  ok(cr.balance(L.key).balanceUsd === 9.95 && cr.balance(L.key).limits?.dailyUsd === 0.05, "a refused call holds nothing and the limits show on the balance");
  cr.authorize(L.key, 0.001);
  ok(limitNotices.length === 1 && limitNotices[0].keyId === L.keyId, "the daily-limit notice is sent once a day");
  clock += 24 * 3600_000;
  ok(cr.authorize(L.key, 0.001).ok, "the daily limit resets the next UTC day");
  const g = cr.gate(() => ({ priceUsd: 0.04, slug: "t" }));
  const res = fakeRes(); let nexted = false;
  g({ method: "POST", path: "/api/t", ip: "10.0.0.1", headers: { authorization: `Bearer ${L.key}` } }, res, () => { nexted = true; });
  ok(!nexted && res.statusCode === 402 && res.body.reason === "over_call_limit" && /balance page/.test(res.body.error), "the gate answers the limit with where to change it");
}

// ---- revoking a key by presenting it -------------------------------------------------------
{
  paid("cs_rv", "credits-5", "pi_rv", "rv@x.com");
  const R = await cr.claim("cs_rv");
  const live = await cr.revokeByKey(R.key), unknown = await cr.revokeByKey(`a402_ck_${"Z".repeat(43)}`), junk = await cr.revokeByKey("nonsense");
  ok(JSON.stringify(live) === JSON.stringify(unknown) && JSON.stringify(live) === JSON.stringify(junk), "a live, an unknown and a malformed key get the same answer");
  const a = cr.authorize(R.key, 0.001);
  ok(!a.ok && a.reason === "disabled" && cr.balance(R.key).balanceUsd === 5 && cr.balance(R.key).revoked === true, "a revoked key stops working and nothing is spent");
  const rf = await cr.requestRefund(R.key);
  ok(rf.status === "refunded" && charges.pi_rv.amount_refunded === 500, "the revoked balance is still refunded to its card on request");
  paid("cs_rv2", "credits-5", "pi_rv2", "rv2@x.com");
  const R2 = await cr.claim("cs_rv2");
  ok((await cr.revokeFor(R2.keyId, "someone@else.com")).status === "unknown" && (await cr.revokeFor(R2.keyId, "rv2@x.com")).status === "revoked" && !cr.authorize(R2.key, 0.001).ok, "the holder revokes from the balance page; nobody else can");
}

// ---- a dispute freezes the key, and a running call takes nothing ------------------------------
{
  paid("cs_dp", "credits-5", "pi_dp", "dp@x.com");
  const D = await cr.claim("cs_dp");
  const h = cr.authorize(D.key, 0.5);
  cr.disableByPaymentIntent("pi_dp", "disputed");
  ok(!cr.authorize(D.key, 0.001).ok, "a dispute freezes the key");
  const s = cr.settle(h.hash, h.heldMicro, "t");
  ok(s.chargedUsd === 0 && cr.balance(D.key).balanceUsd === 5 && cr.balance(D.key).heldUsd === 0, "a call running when the key froze is released, not charged");
}

// ---- an early fraud warning ----------------------------------------------------------------------
{
  // On by default: the whole unspent balance goes back to the warned payment.
  paid("cs_ef1", "credits-10", "pi_ef1", "ef1@x.com");
  const E1 = await cr.claim("cs_ef1");
  const sp = cr.authorize(E1.key, 1); cr.settle(sp.hash, sp.heldMicro, "t");
  const r1 = await cr.fraudWarning("pi_ef1", { warningId: "issfr_1" });
  ok(r1.auto === true && charges.pi_ef1.amount_refunded === 900 && !cr.authorize(E1.key, 0.001).ok, "a fraud warning freezes the key and refunds the unspent balance to that payment automatically");
  ok(refunds.filter((x) => x.payment_intent === "pi_ef1").length === 1, "...one refund, on the warned payment");
  const again = await cr.fraudWarning("pi_ef1", { warningId: "issfr_1" });
  ok(again.status === "frozen" && refunds.filter((x) => x.payment_intent === "pi_ef1").length === 1, "a second warning on the same payment refunds nothing more");
  ok((await cr.fraudReviews()).some((f) => f.keyId === E1.keyId && f.state === "sent-on-warning" && f.cents === 900), "the automatic refund is on the operator view");
  // A call running when the warning lands: try again later, and the call takes nothing.
  paid("cs_ef2", "credits-5", "pi_ef2", "ef2@x.com");
  const E2 = await cr.claim("cs_ef2");
  const run = cr.authorize(E2.key, 0.25);
  ok((await cr.fraudWarning("pi_ef2")).status === "in_flight" && charges.pi_ef2.amount_refunded === 0, "a warning with a call running refunds once it ends (the webhook is delivered again)");
  ok(cr.settle(run.hash, run.heldMicro, "t").chargedUsd === 0, "...and that call takes nothing");
  await cr.fraudWarning("pi_ef2");
  ok(charges.pi_ef2.amount_refunded === 500, "the next delivery refunds the whole balance");
  // At the day's automatic total: frozen, and owed for a person to approve.
  // The day so far sent the two refunds above; the next one would pass this total.
  const sentToday = charges.pi_ef1.amount_refunded + charges.pi_ef2.amount_refunded;
  const dayTable = guardsTable();
  useGuardsTable({ ...dayTable, efw: { warningRefundDayMaxUsd: (sentToday + CREDIT_PACKS["credits-10"].cents - 1) / 100 } });
  paid("cs_ef3", "credits-10", "pi_ef3", "ef3@x.com");
  const E3 = await cr.claim("cs_ef3");
  const r3 = await cr.fraudWarning("pi_ef3");
  ok(r3.status === "frozen" && r3.owed === true && charges.pi_ef3.amount_refunded === 0 && !cr.authorize(E3.key, 0.001).ok, "past the day's automatic total the key is frozen and nothing is sent");
  ok((await cr.refundRequestsOwed()).includes(E3.keyId) && (await cr.refundsOwedWord(0)) === "owed", "...and the balance is listed as owed (the status word reads owed)");
  const ap = await cr.approveFraudRefund(E3.keyId);
  ok(ap.status === "refunded" && charges.pi_ef3.amount_refunded === 1000 && !(await cr.refundRequestsOwed()).includes(E3.keyId), "a person's approval sends it");
  useGuardsTable(dayTable);
  // Switched off: frozen and owed.
  process.env.CREDITS_EFW_AUTO_REFUND = "off";
  paid("cs_ef4", "credits-5", "pi_ef4", "ef4@x.com");
  const E4 = await cr.claim("cs_ef4");
  const r4 = await cr.fraudWarning("pi_ef4");
  ok(r4.owed === true && charges.pi_ef4.amount_refunded === 0 && (await cr.refundRequestsOwed()).includes(E4.keyId), "with the switch off the key is frozen and its balance owed for approval");
  delete process.env.CREDITS_EFW_AUTO_REFUND;
  // A balance topped up from another payment: only the warned payment's own charge is refunded automatically.
  paid("cs_ef5", "credits-5", "pi_ef5", "ef5@x.com");
  const E5 = await cr.claim("cs_ef5");
  paid("cs_ef5t", "credits-5", "pi_ef5t", "ef5@x.com", { meta: { credits_topup: E5.keyId, credits_account: "ef5@x.com" } });
  ok((await cr.claim("cs_ef5t")).status === "topped_up", "guard: the balance was topped up from a second payment");
  const r5 = await cr.fraudWarning("pi_ef5");
  ok(r5.owed === true && charges.pi_ef5.amount_refunded === 0 && charges.pi_ef5t.amount_refunded === 0, "a balance that spans other payments is owed for approval, never refunded to another charge automatically");
}

// ---- a dispute, then a fraud warning on the same payment ---------------------------------------
{
  paid("cs_dw", "credits-10", "pi_dw", "dw@x.com");
  const W = await cr.claim("cs_dw");
  cr.disableByPaymentIntent("pi_dw", "disputed");
  const before = refunds.length;
  const day = `d${new Date(clock).toISOString().slice(0, 10)}`;
  const { shared } = await import("../src/shared-limits.js");
  const dayBefore = Number((await shared.counterGet("credits-efw-auto", day))?.value) || 0;
  // Room in the day for this refund, so only the dispute stands in its way.
  useGuardsTable({ ...guardsTable(), efw: { warningRefundDayMaxUsd: (dayBefore + CREDIT_PACKS["credits-10"].cents) / 100 } });
  const r = await cr.fraudWarning("pi_dw", { warningId: "issfr_dw" });
  ok(r.status === "disputed" && r.auto !== true && refunds.length === before && charges.pi_dw.amount_refunded === 0, "a fraud warning on a disputed payment sends no refund (the dispute decides it)");
  ok((Number((await shared.counterGet("credits-efw-auto", day))?.value) || 0) === dayBefore, "...and gives back the day's automatic total");
  ok((await cr.status()).rows.find((x) => x.keyId === W.keyId)?.disabledReason === "disputed", "...and keeps the dispute as the key's cause");
  ok((await cr.fraudReviews()).find((f) => f.keyId === W.keyId)?.state === "disputed" && !(await cr.refundRequestsOwed()).includes(W.keyId), "the review waits on the dispute; nothing is listed as owed while it runs");
  cr.enableByPaymentIntent("pi_dw", "disputed");
  ok(cr.authorize(W.key, 0.001).reason === "frozen" && (await cr.status()).rows.find((x) => x.keyId === W.keyId)?.disabledReason === "fraud-warning", "a dispute won keeps the key frozen, now for the fraud warning");
  ok((await cr.fraudReviews()).find((f) => f.keyId === W.keyId)?.state === "owed" && (await cr.refundRequestsOwed()).includes(W.keyId), "...and its refund is owed for approval");
  const ap = await cr.approveFraudRefund(W.keyId);
  ok(ap.status === "refunded" && charges.pi_dw.amount_refunded === CREDIT_PACKS["credits-10"].cents, "a person's approval then sends it");
  // A dispute won with no fraud warning lifts the freeze.
  paid("cs_dl", "credits-5", "pi_dl", "dl@x.com");
  const L = await cr.claim("cs_dl");
  cr.disableByPaymentIntent("pi_dl", "disputed");
  cr.enableByPaymentIntent("pi_dl", "disputed");
  ok(cr.authorize(L.key, 0.001).ok, "a dispute won with no fraud warning lifts the freeze");
}

// ---- a fraud warning, then a dispute on the same payment ---------------------------------------
{
  process.env.CREDITS_EFW_AUTO_REFUND = "off";
  const reasonOf = async (keyId) => (await cr.status()).rows.find((x) => x.keyId === keyId)?.disabledReason;
  const reviewOf = async (keyId) => (await cr.fraudReviews()).find((f) => f.keyId === keyId)?.state;
  paid("cs_wd", "credits-10", "pi_wd", "wd@x.com");
  const K = await cr.claim("cs_wd");
  ok((await cr.fraudWarning("pi_wd", { warningId: "issfr_wd" })).owed === true && charges.pi_wd.amount_refunded === 0, "guard: the warning's refund is owed for approval");
  cr.disableByPaymentIntent("pi_wd", "disputed");
  ok(await reasonOf(K.keyId) === "fraud-warning", "a dispute after the warning keeps the warning as the key's cause");
  ok(!(await cr.refundRequestsOwed()).includes(K.keyId), "nothing is listed as owed while the dispute runs");
  const during = await cr.approveFraudRefund(K.keyId);
  ok(during.status === "disputed" && charges.pi_wd.amount_refunded === 0 && await reviewOf(K.keyId) === "disputed", `an approval during the dispute sends nothing and leaves the review open (${await reviewOf(K.keyId)})`);
  cr.enableByPaymentIntent("pi_wd", "disputed");
  ok(cr.authorize(K.key, 0.001).reason === "frozen" && await reasonOf(K.keyId) === "fraud-warning", "the dispute won keeps the key frozen for the warning");
  ok(await reviewOf(K.keyId) === "owed" && (await cr.refundRequestsOwed()).includes(K.keyId) && (await cr.refundsOwedWord(0)) === "owed", "...and its refund is owed again");
  const ap = await cr.approveFraudRefund(K.keyId);
  ok(ap.status === "refunded" && charges.pi_wd.amount_refunded === CREDIT_PACKS["credits-10"].cents && await reviewOf(K.keyId) === "approved" && !(await cr.refundRequestsOwed()).includes(K.keyId), "a person's approval then sends the whole balance and closes the review");
  // The same order, and the dispute lost: the card network took the payment back; nothing is owed.
  paid("cs_wl", "credits-5", "pi_wl", "wl@x.com");
  const KL = await cr.claim("cs_wl");
  await cr.fraudWarning("pi_wl");
  cr.disableByPaymentIntent("pi_wl", "disputed");
  await cr.disputeClosed("pi_wl", { won: false, status: "lost" });
  ok(cr.balance(KL.key).balanceUsd === 0 && cr.authorize(KL.key, 0.001).ok === false && charges.pi_wl.amount_refunded === 0, "the dispute lost takes the payment off the balance; the key stays frozen and nothing is refunded");
  ok(!(await cr.refundRequestsOwed()).includes(KL.keyId) && await reviewOf(KL.keyId) !== "owed", "...and nothing is listed as owed");
  delete process.env.CREDITS_EFW_AUTO_REFUND;
}

// ---- a dispute lost --------------------------------------------------------------------------------
{
  const reasonOf = async (keyId) => (await cr.status()).rows.find((x) => x.keyId === keyId)?.disabledReason;
  // A balance topped up from a second payment, the top-up disputed and lost:
  // the purchase's own share is the buyer's to use or to have refunded.
  paid("cs_lA", "credits-10", "pi_lA", "la@x.com");
  const A = await cr.claim("cs_lA");
  paid("cs_lB", "credits-10", "pi_lB", "la@x.com", { meta: { credits_topup: A.keyId, credits_account: "la@x.com" } });
  ok((await cr.claim("cs_lB")).status === "topped_up", "guard: the balance was topped up from a second payment");
  const sp = cr.authorize(A.key, 3); cr.settle(sp.hash, sp.heldMicro, "t");
  cr.disableByPaymentIntent("pi_lB", "disputed");
  ok(cr.authorize(A.key, 0.001).reason === "frozen", "guard: the dispute froze the key");
  await cr.disputeClosed("pi_lB", { won: false, status: "lost", amountCents: CREDIT_PACKS["credits-10"].cents });
  ok(cr.balance(A.key).balanceUsd === 7 && await reasonOf(A.keyId) == null, `a dispute lost takes the disputed payment off the balance and lifts the freeze (${cr.balance(A.key).balanceUsd})`);
  const use = cr.authorize(A.key, 0.001);
  ok(use.ok === true, "...so the share the other payment funded is usable again");
  cr.release(use.hash, use.heldMicro);
  ok(!(await cr.refundRequestsOwed()).includes(A.keyId), "...and nothing is listed as owed");
  await cr.disputeClosed("pi_lB", { won: false, status: "lost", amountCents: CREDIT_PACKS["credits-10"].cents });
  ok(cr.balance(A.key).balanceUsd === 7, "the same outcome delivered again takes nothing more");
  const rf = await cr.requestRefund(A.key);
  ok(rf.status === "refunded" && charges.pi_lA.amount_refunded === 700 && charges.pi_lB.amount_refunded === 0, `a refund on request goes to the payment not disputed, never to the one the card network took back (${charges.pi_lA.amount_refunded}/${charges.pi_lB.amount_refunded})`);
  // One payment, disputed and lost: nothing is left, the key stays disabled, nothing owed.
  paid("cs_lS", "credits-5", "pi_lS", "ls@x.com");
  const S = await cr.claim("cs_lS");
  cr.disableByPaymentIntent("pi_lS", "disputed");
  await cr.disputeClosed("pi_lS", { won: false, status: "lost" });
  ok(cr.balance(S.key).balanceUsd === 0 && cr.authorize(S.key, 0.001).ok === false && !(await cr.refundRequestsOwed()).includes(S.keyId), "a dispute lost on a key's only payment leaves it disabled with nothing owed");
  const before = refunds.length;
  await cr.requestRefund(S.key);
  ok(refunds.length === before, "...and a refund request sends nothing");
  // A fraud warning on the payment the dispute took: the rest is refunded on approval, to the other payment.
  process.env.CREDITS_EFW_AUTO_REFUND = "off";
  paid("cs_lW", "credits-10", "pi_lW", "lw@x.com");
  const WK = await cr.claim("cs_lW");
  paid("cs_lWt", "credits-10", "pi_lWt", "lw@x.com", { meta: { credits_topup: WK.keyId, credits_account: "lw@x.com" } });
  await cr.claim("cs_lWt");
  await cr.fraudWarning("pi_lWt");
  cr.disableByPaymentIntent("pi_lWt", "disputed");
  await cr.disputeClosed("pi_lWt", { won: false, status: "lost" });
  ok(cr.authorize(WK.key, 0.001).reason === "frozen" && await reasonOf(WK.keyId) === "fraud-warning" && cr.balance(WK.key).balanceUsd === 10, "a dispute lost on a warned payment keeps the key frozen for the warning, holding the other payment's share");
  ok((await cr.refundRequestsOwed()).includes(WK.keyId), "...and that share is owed for approval");
  const ap = await cr.approveFraudRefund(WK.keyId);
  ok(ap.status === "refunded" && charges.pi_lW.amount_refunded === 1000 && charges.pi_lWt.amount_refunded === 0, "the approval refunds it to the payment not disputed");
  delete process.env.CREDITS_EFW_AUTO_REFUND;
  // Through the webhook, wired as the server wires it (src/server.js onDisputeClosed).
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const wh = createStripeSubscriptions({ stripe: { ...stripe, webhooks: { constructEvent: (body, sig) => { if (sig !== "goodsig") throw new Error("bad signature"); return JSON.parse(body.toString()); } } }, baseUrl: "https://agent402.tools", storePath: join(DIR, "subs-dl.json"),
    onChargeReversed: (pi, type, reversal) => cr.disableByPaymentIntent(pi, type === "charge.dispute.created" ? "disputed" : "refunded", reversal), onDisputeClosed: (pi, o) => cr.disputeClosed(pi, o) });
  const ev = (id, type, object) => Buffer.from(JSON.stringify({ id, type, data: { object } }));
  paid("cs_hA", "credits-10", "pi_hA", "ha@x.com");
  const H = await cr.claim("cs_hA");
  paid("cs_hB", "credits-10", "pi_hB", "ha@x.com", { meta: { credits_topup: H.keyId, credits_account: "ha@x.com" } });
  await cr.claim("cs_hB");
  await wh.handleWebhook(ev("evt_dl_c", "charge.dispute.created", { id: "dp_h", charge: "ch_h", payment_intent: "pi_hA", amount: 1000 }), "goodsig");
  ok(cr.authorize(H.key, 0.001).reason === "frozen", "webhook: the dispute freezes the key");
  // A dispute for part of the payment: only that part went back to the card.
  await wh.handleWebhook(ev("evt_dl_x", "charge.dispute.closed", { id: "dp_h", charge: "ch_h", payment_intent: "pi_hA", status: "lost", amount: 400 }), "goodsig");
  const hBal = cr.balance(H.key).balanceUsd, hu = cr.authorize(H.key, 0.001);
  ok(hu.ok === true && hBal === 16, `webhook: a dispute lost for part of a payment takes that part off and keeps the rest usable (${hBal})`);
  if (hu.ok) cr.release(hu.hash, hu.heldMicro);
  delete process.env.STRIPE_WEBHOOK_SECRET;
}

// ---- two disputes on one key, a close before its create, an outcome not recognized ----------------
// Dispute state is kept per payment: a second dispute never overwrites the
// first, a lost dispute takes only its own payment, a won one restores only
// what it held, and the key thaws only when no dispute on it is open. A store
// of its own, so the owed word reads only these keys.
{
  const cr = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: join(DIR, "two-disputes"), log: () => {}, now: () => clock, tagSecret: Buffer.from("test-tag-secret") });
  const reasonOf = async (keyId) => (await cr.status()).rows.find((x) => x.keyId === keyId)?.disabledReason;
  const P = CREDIT_PACKS["credits-10"].cents;
  const usd = P / 100;
  // A key loaded by two payments, both disputed.
  const twoPaid = async (tag) => {
    paid(`cs_2${tag}a`, "credits-10", `pi_2${tag}a`, `two${tag}@x.com`);
    const K = await cr.claim(`cs_2${tag}a`);
    paid(`cs_2${tag}b`, "credits-10", `pi_2${tag}b`, `two${tag}@x.com`, { meta: { credits_topup: K.keyId, credits_account: `two${tag}@x.com` } });
    ok((await cr.claim(`cs_2${tag}b`)).status === "topped_up", `guard: key ${tag} holds two payments`);
    cr.disableByPaymentIntent(`pi_2${tag}a`, "disputed");
    cr.disableByPaymentIntent(`pi_2${tag}b`, "disputed");
    ok(cr.authorize(K.key, 0.001).reason === "frozen", `guard: both disputes froze key ${tag}`);
    return K;
  };
  const owed = async (K) => (await cr.refundRequestsOwed()).includes(K.keyId);
  // lost, then lost: both payments leave the balance; nothing is left, the key stays off.
  const LL = await twoPaid("ll");
  await cr.disputeClosed("pi_2lla", { won: false, status: "lost" });
  ok(cr.balance(LL.key).balanceUsd === usd && cr.authorize(LL.key, 0.001).reason === "frozen", `lost+lost: the first loss takes its payment and the key stays frozen for the dispute still open (${cr.balance(LL.key).balanceUsd})`);
  await cr.disputeClosed("pi_2llb", { won: false, status: "lost" });
  ok(cr.balance(LL.key).balanceUsd === 0 && cr.authorize(LL.key, 0.001).ok === false && await reasonOf(LL.keyId) === "disputed" && !(await owed(LL)), `lost+lost: the second loss takes its own payment; nothing is left, the key stays disabled and nothing is owed (${cr.balance(LL.key).balanceUsd})`);
  // lost, then won: only the lost payment leaves; the won one's share is usable again.
  const LW = await twoPaid("lw");
  await cr.disputeClosed("pi_2lwa", { won: false, status: "lost" });
  ok(cr.authorize(LW.key, 0.001).reason === "frozen", "lost+won: the key stays frozen while the second dispute is open");
  await cr.disputeClosed("pi_2lwb", { won: true, status: "won" });
  const lwBal = cr.balance(LW.key).balanceUsd, lwUse = cr.authorize(LW.key, 0.001);
  ok(lwUse.ok === true && lwBal === usd && await reasonOf(LW.keyId) == null && !(await owed(LW)), `lost+won: the win restores only what its dispute held (${lwBal})`);
  if (lwUse.ok) cr.release(lwUse.hash, lwUse.heldMicro);
  // won, then lost: the win thaws nothing while the other dispute is open; the loss takes only its payment.
  const WL = await twoPaid("wl");
  await cr.disputeClosed("pi_2wla", { won: true, status: "won" });
  ok(cr.authorize(WL.key, 0.001).reason === "frozen" && cr.balance(WL.key).balanceUsd === 2 * usd, "won+lost: a win on one payment keeps the key frozen while the other dispute is open");
  await cr.disputeClosed("pi_2wlb", { won: false, status: "lost" });
  const wlBal = cr.balance(WL.key).balanceUsd, wlUse = cr.authorize(WL.key, 0.001);
  ok(wlUse.ok === true && wlBal === usd && !(await owed(WL)), `won+lost: the loss takes only its payment and the key thaws (${wlBal})`);
  if (wlUse.ok) cr.release(wlUse.hash, wlUse.heldMicro);
  // The later dispute closes first: the earlier one, still open, keeps the key frozen.
  const RV = await twoPaid("rv");
  await cr.disputeClosed("pi_2rvb", { won: true, status: "won" });
  ok(cr.authorize(RV.key, 0.001).reason === "frozen" && cr.balance(RV.key).balanceUsd === 2 * usd, "the second dispute won first keeps the key frozen while the first is open");
  await cr.disputeClosed("pi_2rva", { won: false, status: "lost" });
  const rvBal = cr.balance(RV.key).balanceUsd, rvUse = cr.authorize(RV.key, 0.001);
  ok(rvUse.ok === true && rvBal === usd, `...and the first one lost then takes only its payment and the key thaws (${rvBal})`);
  if (rvUse.ok) cr.release(rvUse.hash, rvUse.heldMicro);
  // A fraud review held while both disputes ran is owed only once neither is open.
  process.env.CREDITS_EFW_AUTO_REFUND = "off";
  const FR = await twoPaid("fr");
  await cr.fraudWarning("pi_2fra");
  ok((await cr.approveFraudRefund(FR.keyId)).status === "disputed" && (await cr.fraudReviews()).find((f) => f.keyId === FR.keyId)?.state === "disputed", "guard: an approval while the disputes run sends nothing and holds the review");
  await cr.disputeClosed("pi_2fra", { won: true, status: "won" });
  ok(!(await owed(FR)) && cr.authorize(FR.key, 0.001).reason === "frozen", "a review is not listed as owed while another dispute on the key is open");
  await cr.disputeClosed("pi_2frb", { won: false, status: "lost" });
  ok(await owed(FR) && await reasonOf(FR.keyId) === "fraud-warning" && cr.balance(FR.key).balanceUsd === usd, `...and is owed once no dispute is open, for the share left (${cr.balance(FR.key).balanceUsd})`);
  const frAp = await cr.approveFraudRefund(FR.keyId);
  ok(frAp.status === "refunded" && charges.pi_2fra.amount_refunded === P && charges.pi_2frb.amount_refunded === 0 && !(await owed(FR)), "...and the approval refunds it to the payment not lost");
  delete process.env.CREDITS_EFW_AUTO_REFUND;
  ok((await cr.refundsOwedWord(0)) === "ok", "guard: nothing is owed before the webhook cases");

  // Through the webhook, wired as the server wires it, with each dispute's id.
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const wh = createStripeSubscriptions({ stripe: { ...stripe, webhooks: { constructEvent: (body, sig) => { if (sig !== "goodsig") throw new Error("bad signature"); return JSON.parse(body.toString()); } } }, baseUrl: "https://agent402.tools", storePath: join(DIR, "subs-two.json"),
    onChargeReversed: (pi, type, reversal) => cr.disableByPaymentIntent(pi, type === "charge.dispute.created" ? "disputed" : "refunded", reversal), onDisputeClosed: (pi, o) => cr.disputeClosed(pi, o) });
  const ev = (id, type, object) => Buffer.from(JSON.stringify({ id, type, data: { object } }));
  const pair = async (tag) => {
    paid(`cs_e${tag}a`, "credits-10", `pi_e${tag}a`, `e${tag}@x.com`);
    const K = await cr.claim(`cs_e${tag}a`);
    paid(`cs_e${tag}b`, "credits-10", `pi_e${tag}b`, `e${tag}@x.com`, { meta: { credits_topup: K.keyId, credits_account: `e${tag}@x.com` } });
    await cr.claim(`cs_e${tag}b`);
    return K;
  };
  // The close arrives before its create: the outcome is applied and the late create freezes nothing.
  const CL = await pair("cl");
  await wh.handleWebhook(ev("evt_cl_x", "charge.dispute.closed", { id: "dp_cl", charge: "ch_cl", payment_intent: "pi_ecla", status: "lost", amount: P }), "goodsig");
  const clBal0 = cr.balance(CL.key).balanceUsd, clUse0 = cr.authorize(CL.key, 0.001);
  ok(clBal0 === usd && clUse0.ok === true, `a loss that arrives before its dispute's create takes its payment (${clBal0})`);
  if (clUse0.ok) cr.release(clUse0.hash, clUse0.heldMicro);
  await wh.handleWebhook(ev("evt_cl_c", "charge.dispute.created", { id: "dp_cl", charge: "ch_cl", payment_intent: "pi_ecla", amount: P }), "goodsig");
  const clBal = cr.balance(CL.key).balanceUsd, clUse = cr.authorize(CL.key, 0.001);
  ok(clUse.ok === true && clBal === usd && !(await owed(CL)) && (await cr.refundsOwedWord(0)) === "ok", "...and its create, arriving after, leaves the key usable and nothing owed");
  if (clUse.ok) cr.release(clUse.hash, clUse.heldMicro);
  const CW = await pair("cw");
  await wh.handleWebhook(ev("evt_cw_x", "charge.dispute.closed", { id: "dp_cw", charge: "ch_cw", payment_intent: "pi_ecwb", status: "won" }), "goodsig");
  await wh.handleWebhook(ev("evt_cw_c", "charge.dispute.created", { id: "dp_cw", charge: "ch_cw", payment_intent: "pi_ecwb", amount: P }), "goodsig");
  const cwBal = cr.balance(CW.key).balanceUsd, cwUse = cr.authorize(CW.key, 0.001);
  ok(cwUse.ok === true && cwBal === 2 * usd, "a win that arrives before its create leaves the key usable when the create comes");
  if (cwUse.ok) cr.release(cwUse.hash, cwUse.heldMicro);
  // A closed status that is neither won nor lost: the hold lifts, the dispute is listed for a person, and refunds wait on it.
  const UN = await pair("un");
  await wh.handleWebhook(ev("evt_un_c", "charge.dispute.created", { id: "dp_un", charge: "ch_un", payment_intent: "pi_eunb", amount: P }), "goodsig");
  ok(cr.authorize(UN.key, 0.001).reason === "frozen", "guard: the dispute froze the key");
  await wh.handleWebhook(ev("evt_un_x", "charge.dispute.closed", { id: "dp_un", charge: "ch_un", payment_intent: "pi_eunb", status: "status-not-known" }), "goodsig");
  const unBal = cr.balance(UN.key).balanceUsd, unUse = cr.authorize(UN.key, 0.001);
  ok(unUse.ok === true && unBal === 2 * usd, "a dispute closed with a status not recognized lifts the hold and takes nothing");
  if (unUse.ok) cr.release(unUse.hash, unUse.heldMicro);
  const toReview = await cr.disputesToReview();
  ok(toReview.some((d) => d.keyId === UN.keyId && d.paymentIntent === "pi_eunb") && (await cr.refundsOwedWord(0)) === "owed", "...is listed for review and the status word reads owed");
  const unRefunds = refunds.length;
  ok((await cr.requestRefund(UN.key)).status === "disputed" && refunds.length === unRefunds, "...and a refund on request waits on it (nothing sent)");
  ok((await cr.resolveDispute(UN.keyId, "pi_eunb", "lost")) === UN.keyId && cr.balance(UN.key).balanceUsd === usd, `a person's resolution as lost takes that payment (${cr.balance(UN.key).balanceUsd})`);
  ok(!(await cr.disputesToReview()).some((d) => d.keyId === UN.keyId) && (await cr.refundsOwedWord(0)) === "ok", "...and the word clears");
  ok((await cr.resolveDispute(UN.keyId, "pi_eunb", "lost")) === null && cr.balance(UN.key).balanceUsd === usd, "a second resolution takes nothing more");
  // The same status, closed before its create.
  const UE = await pair("ue");
  await wh.handleWebhook(ev("evt_ue_x", "charge.dispute.closed", { id: "dp_ue", charge: "ch_ue", payment_intent: "pi_euea", status: "status-not-known" }), "goodsig");
  await wh.handleWebhook(ev("evt_ue_c", "charge.dispute.created", { id: "dp_ue", charge: "ch_ue", payment_intent: "pi_euea", amount: P }), "goodsig");
  const ueUse = cr.authorize(UE.key, 0.001);
  ok(ueUse.ok === true && (await cr.disputesToReview()).some((d) => d.keyId === UE.keyId) && (await cr.refundsOwedWord(0)) === "owed", "an unrecognized close before its create freezes nothing and is listed for review");
  if (ueUse.ok) cr.release(ueUse.hash, ueUse.heldMicro);
  ok((await cr.resolveDispute(UE.keyId, "pi_euea", "won")) === UE.keyId && cr.balance(UE.key).balanceUsd === 2 * usd && (await cr.refundsOwedWord(0)) === "ok", "a resolution as won takes nothing and clears the word");
  // prevented: the network stopped the dispute; the hold lifts with nothing to review.
  const PV = await pair("pv");
  await wh.handleWebhook(ev("evt_pv_c", "charge.dispute.created", { id: "dp_pv", charge: "ch_pv", payment_intent: "pi_epva", amount: P }), "goodsig");
  await wh.handleWebhook(ev("evt_pv_x", "charge.dispute.closed", { id: "dp_pv", charge: "ch_pv", payment_intent: "pi_epva", status: "prevented" }), "goodsig");
  const pvUse = cr.authorize(PV.key, 0.001);
  ok(pvUse.ok === true && !(await cr.disputesToReview()).some((d) => d.keyId === PV.keyId), "a prevented dispute lifts the hold with nothing to review");
  if (pvUse.ok) cr.release(pvUse.hash, pvUse.heldMicro);
  delete process.env.STRIPE_WEBHOOK_SECRET;
}

// ---- a fraud warning before the key is minted -----------------------------------------------------------
{
  paid("cs_pre", "credits-5", "pi_pre", "pre@x.com");
  const w = await cr.fraudWarning("pi_pre", { warningId: "issfr_pre" });
  ok(w.status === "unknown" && w.remembered === true, "a warning on a payment with no key yet is remembered");
  // Read by a store opened again on the same directory (a restart).
  const cr2 = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: () => {}, now: () => clock, tagSecret: Buffer.from("test-tag-secret") });
  const c = await cr2.claim("cs_pre");
  ok(c.status === "not_completed" && !c.key && c.error === PURCHASE_REFUSED && charges.pi_pre.amount_refunded === 500, `a later claim on the warned payment issues no key and refunds it in full (${c.status})`);
  ok((await cr2.balancesForEmail("pre@x.com")).length === 0, "...and no key record exists for it");
  const r0 = refunds.length;
  ok((await cr.claim("cs_pre")).status === "not_completed" && refunds.length === r0, "a second claim answers the same and refunds nothing more");
  // A top-up warned before it lands adds nothing and is refunded.
  paid("cs_pt", "credits-5", "pi_pt", "pt@x.com");
  const T = await cr.claim("cs_pt");
  paid("cs_ptt", "credits-5", "pi_ptt", "pt@x.com", { meta: { credits_topup: T.keyId, credits_account: "pt@x.com" } });
  ok((await cr.fraudWarning("pi_ptt")).remembered === true, "guard: the top-up's warning is remembered");
  const tt = await cr.claim("cs_ptt");
  ok(tt.status === "not_completed" && charges.pi_ptt.amount_refunded === 500 && cr.balance(T.key).balanceUsd === 5 && cr.authorize(T.key, 0.001).ok === true, `a warned top-up is refunded in full and the balance it named is unchanged (${tt.status})`);
  // A warning remembered while the key was being minted (it found no key; the
  // claim had already looked): the claim looks again once the key exists.
  // (The file store is one process's: the checks read through the same store.)
  const warnNow = (pi) => { const f = join(DIR, "_warned.json"); let o = {}; try { o = JSON.parse(readFileSync(f, "utf8")); } catch { /* none yet */ } o[pi] = { at: clock }; writeFileSync(f, JSON.stringify(o)); };
  const racing = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: () => {}, now: () => clock, tagSecret: Buffer.from("test-tag-secret"), onLoad: (l) => warnNow(l.paymentIntent) });
  paid("cs_race", "credits-5", "pi_race", "race@x.com");
  const rc = await racing.claim("cs_race");
  ok(rc.status === "minted" && racing.authorize(rc.key, 0.001).ok === false && (await racing.fraudReviews()).some((f) => f.keyId === rc.keyId), "a key minted as its payment's warning was remembered is frozen under that warning");
  paid("cs_race2", "credits-5", "pi_race2", "race2@x.com");
  const RB = await cr.claim("cs_race2");
  paid("cs_race2t", "credits-5", "pi_race2t", "race2@x.com", { meta: { credits_topup: RB.keyId, credits_account: "race2@x.com" } });
  ok((await racing.claim("cs_race2t")).status === "topped_up" && racing.authorize(RB.key, 0.001).ok === false && (await racing.fraudReviews()).some((f) => f.keyId === RB.keyId), "...and so is a balance a top-up landed on as its warning was remembered");
}

// ---- the webhook: signed, once per event, fixture events --------------------------------------------
{
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const wstripe = { ...stripe, webhooks: { constructEvent: (body, sig, secret) => { if (sig !== "goodsig" || secret !== "whsec_test") throw new Error("bad signature"); return JSON.parse(body.toString()); } }, subscriptions: { retrieve: async (id) => ({ id, status: "active" }) } };
  const warned = [], failed = [], reversed = [];
  const subs = createStripeSubscriptions({ stripe: wstripe, baseUrl: "https://agent402.tools", storePath: join(DIR, "subs.json"),
    onChargeReversed: (pi, type) => reversed.push([pi, type]), onFraudWarning: async (pi, o) => { warned.push([pi, o.warningId]); return { status: "frozen" }; }, onPaymentFailed: (f) => failed.push(f) });
  const ev = (id, type, object) => Buffer.from(JSON.stringify({ id, type, data: { object } }));
  let bad = null; try { await subs.handleWebhook(ev("evt_pc_bad", "radar.early_fraud_warning.created", { id: "issfr_x", payment_intent: "pi_x" }), "badsig"); } catch (e) { bad = e; }
  ok(bad?.statusCode === 400 && warned.length === 0, "an unsigned fraud warning is refused and changes nothing");
  await subs.handleWebhook(ev("evt_pc_efw", "radar.early_fraud_warning.created", { id: "issfr_9", charge: "ch_9", payment_intent: "pi_9" }), "goodsig");
  await subs.handleWebhook(ev("evt_pc_efw", "radar.early_fraud_warning.created", { id: "issfr_9", charge: "ch_9", payment_intent: "pi_9" }), "goodsig");
  ok(warned.length === 1 && warned[0][0] === "pi_9" && warned[0][1] === "issfr_9", "a fraud warning reaches the credits store once per event id");
  const retry = createStripeSubscriptions({ stripe: wstripe, baseUrl: "https://agent402.tools", storePath: join(DIR, "subs2.json"), onFraudWarning: async () => ({ status: "in_flight" }) });
  let unacked = null; try { await retry.handleWebhook(ev("evt_pc_efw2", "radar.early_fraud_warning.created", { payment_intent: "pi_10" }), "goodsig"); } catch (e) { unacked = e; }
  ok(unacked?.statusCode === 503, "a warning whose refund must wait is left unacknowledged, so it is delivered again");
  // The redelivery of an event whose handling threw is applied, never dropped as a duplicate.
  {
    const sub = createStripeSubscriptions({ stripe: wstripe, baseUrl: "https://agent402.tools", storePath: join(DIR, "subs3.json") });
    const broken = Buffer.from(JSON.stringify({ id: "evt_pc_sub1", type: "customer.subscription.updated", data: {} }));
    let threw = null; try { await sub.handleWebhook(broken, "goodsig"); } catch (e) { threw = e; }
    const second = await sub.handleWebhook(ev("evt_pc_sub1", "customer.subscription.updated", { id: "sub_pc1", status: "active", customer: "cus_pc1", metadata: {} }), "goodsig").catch((e) => ({ error: e }));
    ok(threw && !second.duplicate && !second.error && second.received === true, `a delivery whose handling threw is applied when Stripe sends it again (duplicate=${Boolean(second.duplicate)})`);
  }
  const unackedAgain = await retry.handleWebhook(ev("evt_pc_efw2", "radar.early_fraud_warning.created", { payment_intent: "pi_10" }), "goodsig").catch((e) => e);
  ok(unackedAgain?.statusCode === 503, "an unacknowledged warning delivered again is handled again (not answered as a duplicate)");
  await subs.handleWebhook(ev("evt_pc_pf1", "payment_intent.payment_failed", { id: "pi_f1", metadata: { credits_pack: "credits-5", ref_source: "abc123" }, last_payment_error: { payment_method: { card: { fingerprint: "fp_z" } } } }), "goodsig");
  await subs.handleWebhook(ev("evt_pc_pf2", "payment_intent.payment_failed", { id: "pi_f2", metadata: { product: "dossier" } }), "goodsig");
  ok(failed.length === 1 && failed[0].source === "abc123" && failed[0].cardFingerprint === "fp_z", "a credits payment that did not go through is counted; other payments are not read");
  await subs.handleWebhook(ev("evt_pc_dp", "charge.dispute.created", { id: "dp_9", charge: "ch_9", payment_intent: "pi_9" }), "goodsig");
  ok(reversed.length === 1 && reversed[0][1] === "charge.dispute.created", "a dispute reaches the credits store");
  delete process.env.STRIPE_WEBHOOK_SECRET;
}

// ---- the closed loop holds ---------------------------------------------------------------------------
{
  paid("cs_cl", "credits-5", "pi_cl", "cl@x.com");
  const C = await cr.claim("cs_cl");
  for (const [item, reason] of [[{ priceUsd: 0.01, slug: "route-execute", paysThirdParty: true }, "third-party-purchase"], [{ priceUsd: 0.001, slug: "memory", identityBound: true }, "identity-bound"]]) {
    const res = fakeRes(); let nexted = false;
    cr.gate(() => item)({ method: "POST", path: "/api/x", ip: "10.0.0.9", headers: { authorization: `Bearer ${C.key}` } }, res, () => { nexted = true; });
    ok(!nexted && res.statusCode === 402 && res.body.reason === reason && cr.balance(C.key).heldUsd === 0, `credits refuse a ${reason} route`);
  }
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

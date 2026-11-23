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
import { rmSync, readFileSync, readdirSync } from "node:fs";
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
  useGuardsTable({ ...dayTable, efw: { autoRefundDayMaxUsd: (sentToday + CREDIT_PACKS["credits-10"].cents - 1) / 100 } });
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
  useGuardsTable({ ...guardsTable(), efw: { autoRefundDayMaxUsd: (dayBefore + CREDIT_PACKS["credits-10"].cents) / 100 } });
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

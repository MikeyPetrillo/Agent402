// stripe-subscriptions - the recurring engine. Sells
// MONITORING subscriptions (re-run a report on a cadence, alert on change) via
// Stripe Checkout in subscription mode, tracks subscribers in a durable store,
// keeps the store in sync through a signature-verified webhook, and hands
// subscribers the Stripe Customer Portal to self-manage.
//
// Design:
// - Checkout uses inline price_data with recurring:{interval:"month"}, so no
//   pre-created Price objects are needed (matches the one-shot flow).
// - Provisioning is belt-and-suspenders: the success page records the sub
//   immediately (so it works even before the webhook secret is set), AND the
//   webhook keeps status/renewals/cancellations in sync (the reliable path).
// - The webhook is only VERIFIED when STRIPE_WEBHOOK_SECRET is set; until then
//   it refuses unverified events (never trusts an unsigned body).
// Rollout switch = STRIPE_SECRET_KEY (same key as the one-shot checkout).
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

// The monitoring products. Each subscribes to a `target` (a domain, a fund,
// etc.) and re-runs a report kind on a cadence (src/monitor-scheduler.js).
// `slug` = the paid report handler the scheduler runs; price in cents, monthly.
export const MONITOR_PRODUCTS = {
  "domain-monitor": {
    label: "Domain security monitor", price: 500, kind: "domain", slug: "domain-audit",
    inputField: "domain", inputLabel: "a domain, e.g. example.com",
    blurb: "Monthly re-audit of your domain's email auth, TLS and security headers, with an alert the moment your certificate is expiring or your config drifts.",
  },
  "filing-monitor": {
    label: "SEC filing watch", price: 500, kind: "filing", slug: "filing-report",
    inputField: "ticker", inputLabel: "a US stock ticker",
    blurb: "We check this company's SEC filings index every day and email you a fresh cited report the moment anything new lands, an 8-K, a 10-Q, a 10-K, a proxy or a registration statement, with the new document read and explained in plain language.",
  },
  "token-monitor": {
    label: "Solana token safety watch", price: 500, kind: "token", slug: "token-brief",
    inputField: "mint", inputLabel: "a Solana token mint address",
    blurb: "We re-check this token's mint and freeze authorities, LP lock, holder concentration and risk flags every day, and email you a fresh cited brief the moment any of them changes.",
  },
  "fund-monitor": {
    label: "Fund 13F watch", price: 500, kind: "fund", slug: "fund-report",
    inputField: "manager", inputLabel: "a fund name, ticker, or CIK",
    blurb: "We watch this manager's SEC 13F filings and email you a fresh holdings + changes report each time they file.",
  },
  "recall-monitor": {
    label: "FDA recall watch", price: 500, kind: "recall", slug: "recall-report",
    inputField: "query", inputLabel: "a drug, food, brand or device, e.g. losartan",
    blurb: "We check the FDA drug, food and device recall feeds for your term every day and email you a fresh cited report the moment a new recall appears.",
  },
  "insider-monitor": {
    label: "Insider flow watch", price: 500, kind: "insider", slug: "insider-report",
    inputField: "ticker", inputLabel: "a US stock ticker",
    blurb: "We watch Form 4 filings against this company every day and email you a fresh insider-flow report - buys, sells, who and how much - each time a new filing lands.",
  },
  "research-monitor": {
    label: "Research question watch", price: 500, kind: "research", slug: "research",
    inputField: "query", inputLabel: "your research question",
    blurb: "Your question researched again every week from live sources: a fresh, fully cited deep-research report in your inbox, so you see what changed since last time. The same report sold at /reports, run on a schedule.",
  },
  "ipo-monitor": {
    label: "IPO pipeline watch", price: 500, kind: "ipo", slug: "ipo-report",
    inputField: "keyword", inputLabel: "a keyword in the filer's name, or \"all\"",
    blurb: "A weekly digest of every IPO that priced (424B4) and every new S-1 registration on SEC EDGAR, filtered to your keyword or the whole market. Filing facts only, no guessing.",
  },
};

export function subscriptionsEnabled() {
  return Boolean((process.env.STRIPE_SECRET_KEY || "").trim());
}
const webhookSecret = () => (process.env.STRIPE_WEBHOOK_SECRET || "").trim();

const STORE_PATH = () => join(existsSync("/data") ? "/data" : "/tmp", "stripe-subscriptions.json");
const MAX_STORE = 20000;

function loadStore(path) {
  try { return new Map(Object.entries(JSON.parse(readFileSync(path, "utf8")))); } catch { return new Map(); }
}
// Merge-on-save + atomic rename: re-read the file, apply OUR changed keys on
// top, write tmp + rename - so a second process's records are never dropped by
// a whole-map overwrite, and a crash mid-write never leaves a torn file.
function saveKeys(path, map, keys) {
  try {
    const disk = loadStore(path);
    for (const k of keys) if (map.has(k)) disk.set(k, map.get(k));
    const entries = [...disk.entries()];
    const keep = entries.length > MAX_STORE ? entries.slice(-MAX_STORE) : entries;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(keep)));
    renameSync(tmp, path);
  } catch { /* best-effort */ }
}

// Webhook receipt tally. The handler is otherwise silent on success, so
// nothing on our side could say whether Stripe is DELIVERING events at all
// (the restricted prod key deliberately lacks webhook_read, so the dashboard
// is the only other witness). Persisted beside the store so a deploy does not
// reset it to a reassuring-looking zero. Counts only, never event bodies.
const TALLY_SUFFIX = ".webhooks.json";
const emptyTally = () => ({ received: 0, verified: 0, rejected: 0, unconfigured: 0, byType: {}, lastAt: null, lastType: null, lastRejectAt: null, lastRejectReason: null, since: new Date().toISOString() });
function loadTally(path) {
  try { const t = JSON.parse(readFileSync(path, "utf8")); return { ...emptyTally(), ...t, byType: t.byType || {} }; } catch { return emptyTally(); }
}
function saveTally(path, t) {
  try { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(t)); renameSync(tmp, path); } catch { /* best-effort */ }
}

/**
 * @param {object} deps
 * @param {import("stripe")} deps.stripe
 * @param {string} deps.baseUrl
 * @param {string} [deps.storePath]  override for tests
 */
export function createStripeSubscriptions({ stripe, baseUrl, storePath, validateTarget = {}, onInvoicePaid, onPaymentSession, onChargeReversed }) {
  const path = storePath || STORE_PATH();
  const store = loadStore(path);          // subId -> record
  const tallyPath = path + TALLY_SUFFIX;
  const tally = loadTally(tallyPath);
  const MAX_TYPES = 64;
  // Verified events persist at once; the unauthenticated counters (received,
  // rejected, unconfigured) persist on a 5 s debounce so an unsigned flood costs
  // memory increments, not a disk write per hit (audit 2026-08-26).
  let saveTimer = null;
  function bump(kind, extra) {
    tally[kind] += 1;
    Object.assign(tally, extra);
    if (kind === "verified") { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } saveTally(tallyPath, tally); return; }
    if (!saveTimer) { saveTimer = setTimeout(() => { saveTimer = null; saveTally(tallyPath, tally); }, 5000); saveTimer.unref?.(); }
  }

  function upsert(subId, patch) {
    if (!subId) return;
    const prev = store.get(subId) || {};
    store.set(subId, { ...prev, ...patch, updatedAt: new Date().toISOString() });
    saveKeys(path, store, [subId]);
  }

  // Create a subscription Checkout Session for a monitor product + target.
  async function createCheckout(productKey, targetValue) {
    const p = Object.hasOwn(MONITOR_PRODUCTS, String(productKey)) ? MONITOR_PRODUCTS[productKey] : null;
    if (!p) { const e = new Error("Unknown monitor product"); e.statusCode = 400; throw e; }
    let target = String(targetValue ?? "").trim();
    if (!target) { const e = new Error(`Please provide ${p.inputLabel}.`); e.statusCode = 400; throw e; }
    if (target.length > 200) { const e = new Error("Input is too long."); e.statusCode = 400; throw e; }
    // Validate (and normalize) the target BEFORE taking a recurring payment: a
    // domain that does not parse or a manager EDGAR cannot resolve would
    // otherwise be billed monthly for nothing. validateTarget[kind] returns the
    // canonical target or throws a 4xx with a buyer-facing message.
    const v = validateTarget[p.kind];  // errors from here may quote an upstream body - see the relay guard below
    if (typeof v === "function") {
      try { const t = await v(target); if (typeof t === "string" && t.trim()) target = t.trim().slice(0, 200); }
      // NEVER relay the validator's message verbatim: an EDGAR/upstream helper
      // puts a slice of the upstream BODY into it, and this route is
      // unauthenticated. Only a message we minted ourselves (buyerSafe) passes.
      catch (err) { const e = new Error(err?.buyerSafe ? String(err.message).slice(0, 200) : `We could not validate ${p.inputLabel}. Check it and try again.`); e.statusCode = err?.statusCode && err.statusCode < 500 ? err.statusCode : 400; throw e; }
    }
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      ...(String(process.env.STRIPE_AUTOMATIC_TAX || "").toLowerCase() === "true" ? { automatic_tax: { enabled: true } } : {}),
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: p.price,
          recurring: { interval: "month" },
          product_data: { name: p.label, description: `Monitoring: ${target.slice(0, 120)}` },
        },
      }],
      // metadata rides on BOTH the session and the subscription, so either the
      // success page or the webhook can recover product + target.
      metadata: { product: productKey, target: target.slice(0, 180) },
      subscription_data: { metadata: { product: productKey, target: target.slice(0, 180) } },
      success_url: `${baseUrl}/monitors/thanks?session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/monitors?canceled=1`,
      allow_promotion_codes: true,
    });
    return { id: session.id, url: session.url };
  }

  // Called by the success page: verify the session is a PAID subscription and
  // record it immediately (does not depend on the webhook being configured).
  // The Checkout Session stays paid/complete FOREVER, so it must never be the
  // source of the subscription's CURRENT status: a canceled subscriber reloading
  // the thanks page must not flip themselves back to active. Status comes from
  // the live Subscription object; if that read fails, an existing record keeps
  // its status and only a first-time provisioning assumes active.
  const negative = new Map();   // unknown ids are not re-asked of Stripe for 60s
  async function recordFromSession(sessionId) {
    if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return { status: "invalid" };
    const n = negative.get(sessionId);
    if (n && n > Date.now()) return { status: "not_found" };
    let session;
    try { session = await stripe.checkout.sessions.retrieve(sessionId); }
    catch { if (negative.size > 5000) negative.clear(); negative.set(sessionId, Date.now() + 60_000); return { status: "not_found" }; }
    if (!session || session.mode !== "subscription") return { status: "invalid" };
    if (session.payment_status !== "paid" && session.status !== "complete") return { status: "unpaid" };
    const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    if (!subId) return { status: "pending" };
    const existing = store.get(subId) || null;
    let status = existing?.status || "active";
    try {
      const sub = await stripe.subscriptions.retrieve(subId);
      if (sub?.status) status = sub.status;
    } catch { /* keep existing status (or first-time active) */ }
    const rec = {
      subId, customer: session.customer, status,
      product: existing?.product || session.metadata?.product || null,
      target: existing?.target || session.metadata?.target || null,
      email: session.customer_details?.email || session.customer_email || existing?.email || null,
      createdAt: existing?.createdAt || new Date().toISOString(),
    };
    upsert(subId, rec);
    const p = MONITOR_PRODUCTS[rec.product];
    return { status, subId, customer: rec.customer, product: rec.product, label: p?.label || "monitor", target: rec.target };
  }

  // Signature-verified webhook. Never trusts an unverified body: without the
  // secret it refuses (401), and a bad signature 400s.
  const seenEvents = new Map();
  async function handleWebhook(rawBody, signature) {
    const secret = webhookSecret();
    const now = new Date().toISOString();
    bump("received");
    if (!secret) { bump("unconfigured", { lastRejectAt: now, lastRejectReason: "unconfigured" }); const e = new Error("Webhook not configured (STRIPE_WEBHOOK_SECRET unset)"); e.statusCode = 401; throw e; }
    let event;
    try { event = stripe.webhooks.constructEvent(rawBody, signature, secret); }
    catch (err) { bump("rejected", { lastRejectAt: now, lastRejectReason: "bad-signature" }); const e = new Error(`Webhook signature verification failed: ${err.message}`); e.statusCode = 400; throw e; }
    const type = String(event.type || "unknown").slice(0, 64);
    if (Object.hasOwn(tally.byType, type) || Object.keys(tally.byType).length < MAX_TYPES) tally.byType[type] = (tally.byType[type] || 0) + 1;
    bump("verified", { lastAt: now, lastType: type });
    // Stripe's signature tolerance is 300 s: a captured delivery replays for
    // five minutes. Handlers are idempotent on their records, but a replayed
    // invoice.paid would book a second sale - remember event ids for a day.
    if (event.id) {
      if (seenEvents.has(event.id)) return { received: true, type, duplicate: true };
      seenEvents.set(event.id, Date.now());
      if (seenEvents.size > 5000) for (const [k, t] of seenEvents) { if (Date.now() - t > 86_400_000 || seenEvents.size > 5000) seenEvents.delete(k); else break; }
    }
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        // One-shot PAYMENT sessions (credit packs, reports) reach the optional
        // hook so a buyer whose success redirect never loaded still gets
        // fulfilled (credits: key minted + emailed) - claim is idempotent.
        if (s.mode === "payment" && typeof onPaymentSession === "function") { try { await onPaymentSession(s); } catch { /* never fail the webhook on a hook */ } }
        if (s.mode === "subscription" && s.subscription) {
          const id = typeof s.subscription === "string" ? s.subscription : s.subscription.id;
          // Stripe retries and reorders events: a completed-checkout event must
          // never overwrite a status the subscription lifecycle already set.
          const prev = store.get(id);
          upsert(id, {
            customer: s.customer, status: prev?.status || "active",
            product: s.metadata?.product || prev?.product || null, target: s.metadata?.target || prev?.target || null,
            email: s.customer_details?.email || s.customer_email || prev?.email || null,
          });
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object;
        upsert(sub.id, {
          customer: sub.customer, status: sub.status,
          product: sub.metadata?.product || store.get(sub.id)?.product || null,
          target: sub.metadata?.target || store.get(sub.id)?.target || null,
          currentPeriodEnd: sub.current_period_end || null,
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
        });
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        upsert(sub.id, { status: "canceled" });
        break;
      }
      case "invoice.paid": {
        // Recurring revenue lands here (the first invoice too). Hand it to the
        // accounting hook so /revenue and the operator surfaces see card
        // subscriptions, not only x402 settlements. Idempotent on invoice id.
        const inv = event.data.object;
        const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id || inv.parent?.subscription_details?.subscription || null;
        const rec = subId ? store.get(subId) : null;
        if (typeof onInvoicePaid === "function" && inv.amount_paid > 0) {
          try { onInvoicePaid({ invoiceId: inv.id, subId, product: rec?.product || null, amountUsd: inv.amount_paid / 100, customer: inv.customer }); } catch { /* accounting never breaks the webhook */ }
        }
        if (subId && rec) upsert(subId, { lastInvoiceId: inv.id, lastPaidAt: new Date().toISOString() });
        break;
      }
      case "charge.refunded":
      case "charge.dispute.created": {
        // Money went back (or is contested): let the credits store claw back.
        const obj = event.data.object;
        const pi = typeof obj?.payment_intent === "string" ? obj.payment_intent : obj?.payment_intent?.id || null;
        if (pi && typeof onChargeReversed === "function") { try { await onChargeReversed(pi, event.type); } catch { /* never fail the webhook on a hook */ } }
        break;
      }
      default: break; // ignore unrelated events
    }
    return { received: true, type: event.type };
  }

  // Re-read a subscription's CURRENT status from Stripe and store it. The
  // scheduler calls this before every PAID run so a cancellation/card failure
  // the webhook has not (yet) delivered still stops fulfilment. Returns the
  // status, or null when Stripe could not be read (caller decides).
  async function refreshStatus(subId) {
    if (!subId) return null;
    try {
      const sub = await stripe.subscriptions.retrieve(subId);
      if (sub?.status) { upsert(subId, { status: sub.status, currentPeriodEnd: sub.current_period_end || null, cancelAtPeriodEnd: !!sub.cancel_at_period_end }); return sub.status; }
    } catch { /* unreadable */ }
    return null;
  }

  // Stripe-hosted Customer Portal for self-serve manage/cancel.
  async function portalSession(customerId) {
    if (!customerId) { const e = new Error("No customer"); e.statusCode = 400; throw e; }
    const s = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${baseUrl}/monitors` });
    return { url: s.url };
  }

  // Active subscriptions for a given product kind (the scheduler in 2b reads these).
  function listActive(kind) {
    const out = [];
    for (const rec of store.values()) {
      if (rec.status === "active" && (!kind || MONITOR_PRODUCTS[rec.product]?.kind === kind)) out.push(rec);
    }
    return out;
  }
  const get = (subId) => store.get(subId) || null;

  // Operator surface: is Stripe delivering, and are we accepting? A snapshot
  // (never the live object), counts + timestamps only.
  function webhookStats() {
    return { ...tally, byType: { ...tally.byType }, configured: Boolean(webhookSecret()) };
  }

  return { createCheckout, recordFromSession, handleWebhook, portalSession, listActive, get, refreshStatus, webhookStats, _store: store };
}

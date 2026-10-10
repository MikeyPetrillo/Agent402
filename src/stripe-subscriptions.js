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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createJsonDocument } from "./json-document.js";
import { trackStoreReady } from "./state-db.js";
import { createDeadLetter, everyMs } from "./ledger-mirror.js";

// The monitoring products. Each subscribes to a `target` (a domain, a fund,
// etc.) and re-runs a report kind on a cadence (src/monitor-scheduler.js).
// `slug` = the paid report handler the scheduler runs; price in cents, monthly.
export const MONITOR_PRODUCTS = {
  "domain-monitor": {
    label: "Domain security monitor", price: 500, kind: "domain", slug: "domain-audit",
    inputField: "domain", inputLabel: "a domain, e.g. example.com",
    blurb: "Monthly re-audit of your domain's email auth, TLS and security headers, with an alert from the daily check when your certificate nears expiry or your config drifts.",
  },
  "filing-monitor": {
    label: "SEC filing watch", price: 500, kind: "filing", slug: "filing-report",
    inputField: "ticker", inputLabel: "a US stock ticker",
    blurb: "We check this company's SEC filings index every day and email you a fresh cited report when anything new lands, an 8-K, a 10-Q, a 10-K, a proxy or a registration statement, with the new document read and explained in plain language.",
  },
  "token-monitor": {
    label: "Solana token safety watch", price: 500, kind: "token", slug: "token-brief",
    inputField: "mint", inputLabel: "a Solana token mint address",
    blurb: "We re-check this token's mint and freeze authorities, LP lock, holder concentration and risk flags every day, and email you a fresh cited brief when any of them changes.",
  },
  "fund-monitor": {
    label: "Fund 13F watch", price: 500, kind: "fund", slug: "fund-report",
    inputField: "manager", inputLabel: "a fund name, ticker, or CIK",
    blurb: "We watch this manager's SEC 13F filings and email you a fresh holdings + changes report when they file.",
  },
  "recall-monitor": {
    label: "FDA recall watch", price: 500, kind: "recall", slug: "recall-report",
    inputField: "query", inputLabel: "a drug, food, brand or device, e.g. losartan",
    blurb: "We check the FDA drug, food and device recall feeds for your term every day and email you a fresh cited report when a new recall appears.",
  },
  "insider-monitor": {
    label: "Insider flow watch", price: 500, kind: "insider", slug: "insider-report",
    inputField: "ticker", inputLabel: "a US stock ticker",
    blurb: "We watch Form 4 filings against this company every day and email you a fresh insider-flow report - buys, sells, who and how much - when a new filing lands.",
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

const toMap = (j) => (j && typeof j === "object" && !Array.isArray(j) ? new Map(Object.entries(j)) : new Map());
// Merge-on-save: only OUR changed keys are written into the stored object, so
// a second process's records are never dropped by a whole-map overwrite. On
// the file this is tmp + rename; in the state database it is a key merge.
async function saveKeys(doc, map, keys) {
  const patch = {};
  for (const k of keys) if (map.has(k)) patch[k] = map.get(k);
  const merged = await doc.mergeKeys(patch);
  if (merged && Object.keys(merged).length > MAX_STORE) {
    const drop = Object.keys(merged).slice(0, Object.keys(merged).length - MAX_STORE);
    await doc.mergeKeys({}, drop);
  }
  return merged !== null;
}
// The newer of two records of one subscription (by updatedAt; ISO strings compare as strings).
const newer = (a, b) => (!a ? b : !b ? a : String(b.updatedAt || "") > String(a.updatedAt || "") ? b : a);

// Webhook receipt tally. The handler is otherwise silent on success, so
// nothing on our side could say whether Stripe is DELIVERING events at all
// (the restricted prod key deliberately lacks webhook_read, so the dashboard
// is the only other witness). Persisted beside the store so a deploy does not
// reset it to a reassuring-looking zero. Counts only, never event bodies.
const TALLY_SUFFIX = ".webhooks.json";
const emptyTally = () => ({ received: 0, verified: 0, rejected: 0, unconfigured: 0, byType: {}, lastAt: null, lastType: null, lastRejectAt: null, lastRejectReason: null, since: new Date().toISOString() });
const shapeTally = (t) => (t && typeof t === "object" ? { ...emptyTally(), ...t, byType: t.byType || {} } : emptyTally());

/**
 * @param {object} deps
 * @param {import("stripe")} deps.stripe
 * @param {string} deps.baseUrl
 * @param {string} [deps.storePath]  override for tests
 */
export function createStripeSubscriptions({ stripe, baseUrl, storePath, validateTarget = {}, onInvoicePaid, onPaymentSession, onChargeReversed }) {
  const path = storePath || STORE_PATH();
  const doc = createJsonDocument({ file: path, log: () => {} });
  const tallyDoc = createJsonDocument({ file: path + TALLY_SUFFIX, log: () => {} });
  const store = toMap(doc.loadSync(null));          // subId -> record
  const tally = shapeTally(tallyDoc.loadSync(null));
  // In the state database the first load is asynchronous: the maps fill when
  // the rows arrive (the file is imported once); the server awaits every
  // store before it listens.
  const ready = trackStoreReady(doc.backend === "pg"
    ? Promise.all([doc.load(null), tallyDoc.load(null)]).then(([j, t]) => {
      for (const [k, v] of toMap(j)) if (!store.has(k)) store.set(k, v);
      // Counts bumped before the row arrived are deltas on top of it.
      const row = shapeTally(t);
      for (const [k, v] of Object.entries(row)) {
        if (k === "byType") { for (const [ty, n] of Object.entries(v || {})) tally.byType[ty] = (tally.byType[ty] || 0) + (Number(n) || 0); }
        else if (typeof v === "number") tally[k] = (Number(tally[k]) || 0) + v;
        else if (tally[k] == null && v != null) tally[k] = v;
      }
    })
    : Promise.resolve());
  // With the database two containers count webhooks at once: each saves the
  // counts it added since its last save (a delta) onto the row, a versioned
  // read-modify-write, never its whole tally over the other's.
  const TPG = tallyDoc.backend === "pg";
  let delta = { counts: {}, byType: {}, fields: {} };
  const addDelta = (into, d) => {
    for (const [k, n] of Object.entries(d.counts)) into.counts[k] = (into.counts[k] || 0) + n;
    for (const [k, n] of Object.entries(d.byType)) into.byType[k] = (into.byType[k] || 0) + n;
    for (const [k, v] of Object.entries(d.fields)) if (!(k in into.fields)) into.fields[k] = v;
  };
  let tallySaving = null, tallyAgain = false;
  function saveTally() {
    if (!TPG) { void tallyDoc.save(tally); return; }
    if (tallySaving) { tallyAgain = true; return; }
    tallySaving = (async () => {
      do {
        tallyAgain = false;
        const sent = delta; delta = { counts: {}, byType: {}, fields: {} };
        const r = await tallyDoc.update((b) => {
          const t = shapeTally(b);
          for (const [k, n] of Object.entries(sent.counts)) t[k] = (Number(t[k]) || 0) + n;
          for (const [k, n] of Object.entries(sent.byType)) if (Object.hasOwn(t.byType, k) || Object.keys(t.byType).length < MAX_TYPES) t.byType[k] = (t.byType[k] || 0) + n;
          // The newest event wins the "last" fields (ISO times compare as strings).
          if (sent.fields.lastAt && (!t.lastAt || sent.fields.lastAt >= t.lastAt)) { t.lastAt = sent.fields.lastAt; t.lastType = sent.fields.lastType ?? t.lastType; }
          if (sent.fields.lastRejectAt && (!t.lastRejectAt || sent.fields.lastRejectAt >= t.lastRejectAt)) { t.lastRejectAt = sent.fields.lastRejectAt; t.lastRejectReason = sent.fields.lastRejectReason ?? t.lastRejectReason; }
          return t;
        }, { fallback: null });
        if (!r.ok) { const back = { counts: {}, byType: {}, fields: {} }; addDelta(back, delta); addDelta(back, sent); delta = back; break; }
        // The row now, plus what was counted here since this save began.
        const now = shapeTally(r.body);
        for (const [k, n] of Object.entries(delta.counts)) now[k] = (Number(now[k]) || 0) + n;
        for (const [k, n] of Object.entries(delta.byType)) now.byType[k] = (now.byType[k] || 0) + n;
        Object.assign(now, delta.fields);
        for (const k of Object.keys(tally)) delete tally[k];
        Object.assign(tally, now);
      } while (tallyAgain);
      tallySaving = null;
    })();
  }
  const MAX_TYPES = 64;
  // Verified events persist at once; the unauthenticated counters (received,
  // rejected, unconfigured) persist on a 5 s debounce so an unsigned flood costs
  // memory increments, not a disk write per hit (audit 2026-08-26).
  let saveTimer = null;
  function bump(kind, extra) {
    tally[kind] += 1;
    Object.assign(tally, extra);
    if (TPG) { delta.counts[kind] = (delta.counts[kind] || 0) + 1; Object.assign(delta.fields, extra); }
    if (kind === "verified") { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } saveTally(); return; }
    if (!saveTimer) { saveTimer = setTimeout(() => { saveTimer = null; saveTally(); }, 5000); saveTimer.unref?.(); }
  }

  // On the state database a record whose merge did not land (a paid
  // subscription, a cancellation) is kept on local disk beside the store
  // file and replayed on a timer, so a restart before the database answers
  // again loses none; the replay writes it only over an older copy of the
  // same subscription (by updatedAt), never over a newer one.
  const PG = doc.backend === "pg";
  const pending = PG ? createDeadLetter({ file: `${path}.pending.ndjson` }) : null;
  const unsaved = new Set(); // subIds whose latest record has not landed
  // Resolves false only in database mode when the record did not reach the
  // database (it waits in the local journal); the webhook then answers 503
  // so Stripe delivers the event again.
  async function upsert(subId, patch) {
    if (!subId) return true;
    if (PG && !store.has(subId)) {
      // A subscription another container recorded since this one loaded:
      // its stored record is the base, so a partial patch (a webhook's
      // status) never replaces the whole record.
      try { const r = await doc.read(); const v = r.ok && r.exists ? r.body?.[subId] : null; if (v && !store.has(subId)) store.set(subId, v); } catch { /* the patch alone */ }
    }
    const prev = store.get(subId) || {};
    store.set(subId, { ...prev, ...patch, updatedAt: new Date().toISOString() });
    if (!PG) { void saveKeys(doc, store, [subId]); return true; }
    let landed = false;
    try { landed = await saveKeys(doc, store, [subId]); } catch { landed = false; }
    if (landed) { unsaved.delete(subId); return true; }
    unsaved.add(subId);
    if (!pending.add("sub", { subId, rec: store.get(subId) })) console.error(`[subscriptions] the record of ${subId} could not be kept on local disk`);
    return false;
  }
  let replaying = false;
  async function replayPending() {
    if (!pending || replaying || !pending.size()) return 0;
    replaying = true;
    let landed = 0;
    try {
      for (const e of pending.list()) {
        const { subId, rec } = e.payload || {};
        if (!subId || !rec) { pending.remove(e.id); continue; }
        const mine = newer(rec, unsaved.has(subId) ? store.get(subId) : null);
        const r = await doc.update((b) => {
          const body = b && typeof b === "object" && !Array.isArray(b) ? b : {};
          body[subId] = newer(body[subId], mine);
          return body;
        }, { fallback: {} });
        if (!r.ok) break; // the database is still away: the next tick retries
        const stored = r.body?.[subId];
        if (stored) store.set(subId, newer(store.get(subId), stored));
        if (stored === mine || String(stored?.updatedAt || "") >= String(mine.updatedAt || "")) unsaved.delete(subId);
        pending.remove(e.id);
        landed++;
      }
    } finally { replaying = false; }
    if (landed) console.log(`[subscriptions] landed ${landed} record(s) kept on local disk`);
    return landed;
  }
  if (PG) {
    ready.then(() => replayPending()).catch(() => {});
    everyMs(() => replayPending(), Number(process.env.SUBSCRIPTIONS_REPLAY_MS) || 15_000);
  }
  // Reads the stored records again (database mode): a subscription another
  // container recorded since this one loaded is seen, and the newer copy of
  // each wins. The monitor scheduler calls it inside its lease, before a tick
  // reads listActive. Resolves how many records changed here.
  async function reload() {
    if (!PG) return 0;
    await replayPending().catch(() => 0);
    const r = await doc.read();
    if (!r.ok) return 0;
    let changed = 0;
    for (const [k, v] of toMap(r.exists ? r.body : null)) {
      const cur = store.get(k);
      const win = newer(cur, v);
      if (win !== cur) { store.set(k, win); changed++; }
    }
    return changed;
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
    await upsert(subId, rec);
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
    if (Object.hasOwn(tally.byType, type) || Object.keys(tally.byType).length < MAX_TYPES) { tally.byType[type] = (tally.byType[type] || 0) + 1; if (TPG) delta.byType[type] = (delta.byType[type] || 0) + 1; }
    bump("verified", { lastAt: now, lastType: type });
    // Stripe's signature tolerance is 300 s: a captured delivery replays for
    // five minutes. Handlers are idempotent on their records, but a replayed
    // invoice.paid would book a second sale - remember event ids for a day.
    if (event.id) {
      if (seenEvents.has(event.id)) return { received: true, type, duplicate: true };
      seenEvents.set(event.id, Date.now());
      if (seenEvents.size > 5000) for (const [k, t] of seenEvents) { if (Date.now() - t > 86_400_000 || seenEvents.size > 5000) seenEvents.delete(k); else break; }
    }
    let stored = true; // every record this event writes reached the database
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
          stored = stored && await upsert(id, {
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
        stored = stored && await upsert(sub.id, {
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
        stored = stored && await upsert(sub.id, { status: "canceled" });
        break;
      }
      case "invoice.paid": {
        // Recurring revenue lands here (the first invoice too). Hand it to the
        // accounting hook so /revenue and the operator surfaces see card
        // subscriptions, not only x402 settlements. Idempotent on invoice id.
        const inv = event.data.object;
        const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id || inv.parent?.subscription_details?.subscription || null;
        const rec = subId ? store.get(subId) : null;
        // The record first: an event answered 503 (its record not stored) is
        // delivered again, so the sale is booked on the delivery that stores
        // it, never once per delivery.
        if (subId && rec) stored = stored && await upsert(subId, { lastInvoiceId: inv.id, lastPaidAt: new Date().toISOString() });
        if (stored && typeof onInvoicePaid === "function" && inv.amount_paid > 0) {
          try { onInvoicePaid({ invoiceId: inv.id, subId, product: rec?.product || null, amountUsd: inv.amount_paid / 100, customer: inv.customer }); } catch { /* accounting never breaks the webhook */ }
        }
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
    if (!stored) {
      // Database mode: a record waits in the local journal (a backstop). The
      // event is not acknowledged until the record is in the database, so
      // Stripe delivers it again; its id is forgotten so that retry is applied.
      if (event.id) seenEvents.delete(event.id);
      const e = new Error("Webhook received; its record is not stored yet, retry later");
      e.statusCode = 503;
      throw e;
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
      if (sub?.status) { await upsert(subId, { status: sub.status, currentPeriodEnd: sub.current_period_end || null, cancelAtPeriodEnd: !!sub.cancel_at_period_end }); return sub.status; }
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

  return { createCheckout, recordFromSession, handleWebhook, portalSession, listActive, get, refreshStatus, webhookStats, reload, replayPending, _store: store };
}

// credits - PREPAID CARD CREDITS for the tool catalog: a person buys a $20/$50/$100 pack by card (Stripe
// Checkout), gets an `a402_...` key ONCE, and spends it across every paid tool
// with `Authorization: Bearer a402_...` - the card-native equivalent of the
// per-call x402 model, for buyers who will not hold a wallet.
//
// Money discipline (mirrors the x402 paywall):
// - A key is minted only for a Stripe-verified PAID session, exactly once per
//   session (the session id is indexed; a second claim returns "claimed" and
//   never re-shows the key).
// - The gate AUTHORIZES before the handler (balance >= the route's list price)
//   and DEBITS only on a final 200 (res "finish"); a 4xx/5xx is never charged.
//   Balances are integer micro-dollars (sub-cent prices like $0.001 are exact).
// - Keys are stored HASHED (sha256); the plaintext exists only in the claim
//   response / email. Per-key files under /data/credits, atomic tmp+rename.
// - Accounting: every debit is a sale on the "credits" rail (PAYING_RAILS) with
//   the key id as classification-grade payer; stats count it as viaCredits.
// Rollout switch = STRIPE_SECRET_KEY (shared with the human checkout).
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { sendEmail } from "./email.js";

export const CREDIT_PACKS = {
  "credits-20": { label: "Starter", cents: 2000 },
  "credits-50": { label: "Builder", cents: 5000 },
  "credits-100": { label: "Pro", cents: 10000 },
};
export const KEY_RE = /^a402_[A-Za-z0-9_-]{32,64}$/;
const SESSION_RE = /^cs_[A-Za-z0-9_]+$/;
const MICRO = 1_000_000;

const DATA_ROOT = () => (existsSync("/data") ? "/data" : "/tmp");
const DEFAULT_DIR = () => join(DATA_ROOT(), "credits");
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
function writeJsonAtomic(p, obj) {
  try { const tmp = `${p}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(obj)); renameSync(tmp, p); return true; } catch { return false; }
}
export const hashKey = (key) => createHash("sha256").update(String(key)).digest("hex");
export const usdToMicro = (usd) => Math.round(Number(usd) * MICRO);
export const microToUsd = (m) => Math.round(Number(m) / 100) / 10000; // 4 dp

/**
 * @param {object} deps
 * @param {import("stripe")} deps.stripe
 * @param {string} deps.baseUrl
 * @param {string} [deps.storeDir]
 * @param {(sale:object)=>void} [deps.onDebit]   accounting hook per charged call
 * @param {(sale:object)=>void} [deps.onLoad]    accounting hook per pack purchase
 * @param {()=>number} [deps.now]
 * @param {(s:string)=>void} [deps.log]
 */
export function createCredits({ stripe, baseUrl, storeDir, onDebit, onLoad, now = () => Date.now(), log = console.log, digestLinkFor = null }) {
  const dir = storeDir || DEFAULT_DIR();
  try { mkdirSync(dir, { recursive: true }); } catch { /* writes fail loudly below */ }
  const SESSIONS = join(dir, "_sessions.json"); // sessionId -> key hash (claim-once)
  const recPath = (hash) => join(dir, `k_${hash}.json`);
  const cache = new Map(); // hash -> record (write-through)

  const load = (hash) => cache.get(hash) || (() => { const r = readJson(recPath(hash)); if (r) cache.set(hash, r); return r; })();
  function save(hash, rec) { cache.set(hash, rec); writeJsonAtomic(recPath(hash), rec); }
  const sessionsIdx = () => readJson(SESSIONS) || {};

  async function createCheckout(packKey) {
    const p = Object.hasOwn(CREDIT_PACKS, String(packKey)) ? CREDIT_PACKS[packKey] : null;
    if (!p) {
      // Self-correcting: an agent cannot guess "credits-20" from a bare 20,
      // and /api/pricing used to publish the dollar amounts only (found by an
      // outside reviewer 2026-08-28, who brute-forced the id).
      const e = new Error(`Unknown credit pack. Valid packs: ${Object.keys(CREDIT_PACKS).join(", ")}`);
      e.statusCode = 400; e.validPacks = Object.keys(CREDIT_PACKS); e.buyerSafe = true; throw e;
    }
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      ...(String(process.env.STRIPE_AUTOMATIC_TAX || "").toLowerCase() === "true" ? { automatic_tax: { enabled: true } } : {}),
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: p.cents, product_data: { name: `Agent402 credits - ${p.label} ($${(p.cents / 100).toFixed(0)})`, description: "Prepaid credits for pay-per-call tools. Spent per request at list price; never expire." } } }],
      metadata: { credits_pack: packKey },
      success_url: `${baseUrl}/credits/thanks?session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/credits?canceled=1`,
      payment_intent_data: { description: `Agent402 credits ${p.label}` },
    });
    return { id: session.id, url: session.url };
  }

  // Claim the key for a paid session: mints ONCE; later claims say "claimed".
  async function claim(sessionId) {
    if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return { status: "invalid" };
    const idx = sessionsIdx();
    if (idx[sessionId]) { const rec = load(idx[sessionId]); return { status: "claimed", keyId: rec?.keyId || null, balanceUsd: rec ? microToUsd(rec.balanceMicro) : null }; }
    let session;
    try { session = await stripe.checkout.sessions.retrieve(sessionId); } catch { return { status: "not_found" }; }
    if (!session || session.mode !== "payment" || session.payment_status !== "paid") return { status: "unpaid" };
    const packKey = session.metadata?.credits_pack;
    const p = Object.hasOwn(CREDIT_PACKS, String(packKey)) ? CREDIT_PACKS[packKey] : null;
    if (!p) return { status: "invalid" };
    // Re-check the index right before minting (two tabs claiming at once).
    const again = sessionsIdx();
    if (again[sessionId]) { const rec = load(again[sessionId]); return { status: "claimed", keyId: rec?.keyId || null, balanceUsd: rec ? microToUsd(rec.balanceMicro) : null }; }
    const key = `a402_${randomBytes(24).toString("base64url")}`;
    const hash = hashKey(key);
    const keyId = hash.slice(0, 12);
    const email = session.customer_details?.email || session.customer_email || null;
    const loadedMicro = p.cents * 10_000;
    const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null;
    const rec = { keyId, balanceMicro: loadedMicro, loadedMicro, spentMicro: 0, calls: 0, createdAt: new Date(now()).toISOString(), email, sessions: [sessionId], paymentIntents: paymentIntent ? [paymentIntent] : [], pack: packKey, lastUsedAt: null };
    save(hash, rec);
    again[sessionId] = hash; writeJsonAtomic(SESSIONS, again);
    try { onLoad?.({ sessionId, pack: packKey, priceUsd: p.cents / 100, keyId, paymentIntent }); } catch { /* accounting never breaks minting */ }
    // Weekly spend digest (src/wallet-digest.js): the claim email carries a
    // signed confirm link for THIS key; the click is the consent.
    let digestUrl = null;
    try { digestUrl = typeof digestLinkFor === "function" && email ? digestLinkFor({ keyId, email }) : null; } catch { digestUrl = null; }
    const digestText = digestUrl ? `\n\nWant one email a week with what this key spent (calls, dollars, tools, balance)? Confirm here: ${digestUrl}` : "";
    const digestHtml = digestUrl ? `<p style="margin-top:18px;font-size:14px;color:#5C6963">Want one email a week with what this key spent (calls, dollars, tools, balance)? <a href="${digestUrl}">Confirm the weekly digest</a>. Nothing is sent for a quiet week.</p>` : "";
    if (email) {
      sendEmail({ to: email, subject: "Your Agent402 credits key",
        text: `Your prepaid credits are ready: $${(p.cents / 100).toFixed(2)} loaded.\n\nYour key (keep it secret, it is shown only here and on the thanks page):\n\n${key}\n\nUse it on any paid tool:\ncurl -H "Authorization: Bearer ${key}" ${baseUrl}/api/whois?domain=example.com\n\nBalance: GET ${baseUrl}/api/credits/balance with the same header.\nTop up: ${baseUrl}/credits${digestText}\n\nAgent402`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#14201b"><h2 style="font-weight:500">Your Agent402 credits key</h2><p>$${(p.cents / 100).toFixed(2)} loaded. Keep the key secret - it is shown only here and on the thanks page.</p><pre style="background:#0c0d0f;color:#e9eaec;padding:14px 16px;border-radius:10px;font-size:13px;overflow:auto">${key}</pre><p>Use it on any paid tool:</p><pre style="background:#f3f4f5;padding:12px 14px;border-radius:10px;font-size:12.5px;overflow:auto">curl -H "Authorization: Bearer ${key}" ${baseUrl}/api/whois?domain=example.com</pre><p style="color:#62696f;font-size:13px">Balance: <code>GET ${baseUrl}/api/credits/balance</code> with the same header · Top up at <a href="${baseUrl}/credits">${baseUrl}/credits</a></p>${digestHtml}</div>` }).catch(() => {});
    }
    log(`[credits] minted key ${keyId} ($${(p.cents / 100).toFixed(2)}) for session ${sessionId}`);
    return { status: "minted", key, keyId, balanceUsd: microToUsd(loadedMicro) };
  }

  // Pre-handler authorization WITH RESERVATION: the list price is moved from
  // the available balance into a hold before the handler runs, so N concurrent
  // calls on one key can never collectively exceed the balance (without the
  // hold, every call passed the balance check and only floor(balance/price)
  // debits landed - the rest were served free). settle() converts the hold to
  // spend on a final 200; release() returns it on any other outcome.
  function authorize(keyString, priceUsd) {
    if (typeof keyString !== "string" || !KEY_RE.test(keyString)) return { ok: false, reason: "malformed" };
    const hash = hashKey(keyString);
    const rec = load(hash);
    if (!rec) return { ok: false, reason: "unknown" };
    if (rec.disabled) return { ok: false, reason: "disabled", balanceUsd: microToUsd(rec.balanceMicro) };
    const need = usdToMicro(priceUsd);
    if (rec.balanceMicro < need) return { ok: false, reason: "insufficient", balanceUsd: microToUsd(rec.balanceMicro), priceUsd };
    rec.balanceMicro -= need; rec.heldMicro = (rec.heldMicro || 0) + need;
    save(hash, rec);
    return { ok: true, hash, keyId: rec.keyId, heldMicro: need, balanceUsd: microToUsd(rec.balanceMicro), priceUsd };
  }

  // Final 200: the hold becomes spend. `chargeUsd` (the meter's actual x
  // markup on a metered route) takes LESS than the hold and returns the rest
  // to the balance; it can never take more than was held.
  function settle(hash, heldMicro, slug, chargeUsd = null) {
    const rec = load(hash);
    if (!rec) return null;
    const held = Math.min(heldMicro, rec.heldMicro || 0);
    const want = Number.isFinite(Number(chargeUsd)) && Number(chargeUsd) > 0 ? usdToMicro(Number(chargeUsd)) : held;
    const taken = Math.min(held, want);
    const returned = held - taken;
    rec.heldMicro = (rec.heldMicro || 0) - held; rec.balanceMicro += returned; rec.spentMicro += taken; rec.calls += 1; rec.lastUsedAt = new Date(now()).toISOString();
    save(hash, rec);
    try { onDebit?.({ slug, priceUsd: microToUsd(taken), keyId: rec.keyId }); } catch { /* accounting never breaks serving */ }
    return { balanceUsd: microToUsd(rec.balanceMicro), chargedUsd: microToUsd(taken), heldUsd: microToUsd(held), returnedUsd: microToUsd(returned) };
  }
  // Any non-200 outcome (4xx/5xx, client abort before the response finished):
  // the hold goes back to the balance - nothing was charged.
  function release(hash, heldMicro) {
    const rec = load(hash);
    if (!rec) return null;
    const back = Math.min(heldMicro, rec.heldMicro || 0);
    rec.heldMicro = (rec.heldMicro || 0) - back; rec.balanceMicro += back;
    save(hash, rec);
    return { balanceUsd: microToUsd(rec.balanceMicro) };
  }
  // Kept for direct callers/tests: an immediate debit without a prior hold.
  function charge(hash, priceUsd, slug) {
    const a = load(hash); if (!a) return null;
    const need = usdToMicro(priceUsd);
    const taken = Math.min(need, a.balanceMicro);
    a.balanceMicro -= taken; a.spentMicro += taken; a.calls += 1; a.lastUsedAt = new Date(now()).toISOString();
    save(hash, a);
    try { onDebit?.({ slug, priceUsd: microToUsd(taken), keyId: a.keyId }); } catch { /* never breaks serving */ }
    return { balanceUsd: microToUsd(a.balanceMicro), chargedUsd: microToUsd(taken) };
  }

  function balance(keyString) {
    if (typeof keyString !== "string" || !KEY_RE.test(keyString)) return null;
    const rec = load(hashKey(keyString));
    if (!rec) return null;
    return { keyId: rec.keyId, balanceUsd: microToUsd(rec.balanceMicro), heldUsd: microToUsd(rec.heldMicro || 0), loadedUsd: microToUsd(rec.loadedMicro), spentUsd: microToUsd(rec.spentMicro), calls: rec.calls, createdAt: rec.createdAt, lastUsedAt: rec.lastUsedAt, disabled: !!rec.disabled };
  }

  // Operator: totals + per-key rows (key id only - never the key or its hash).
  function status() {
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.startsWith("k_") && f.endsWith(".json")); } catch { /* empty */ }
    const keys = files.map((f) => readJson(join(dir, f))).filter(Boolean);
    const tot = (k) => keys.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    return {
      keys: keys.length, loadedUsd: microToUsd(tot("loadedMicro")), spentUsd: microToUsd(tot("spentMicro")), outstandingUsd: microToUsd(tot("balanceMicro")), heldUsd: microToUsd(tot("heldMicro")), calls: tot("calls"),
      rows: keys.sort((a, b) => String(b.lastUsedAt || b.createdAt).localeCompare(String(a.lastUsedAt || a.createdAt))).slice(0, 200).map((r) => ({ keyId: r.keyId, balanceUsd: microToUsd(r.balanceMicro), spentUsd: microToUsd(r.spentMicro), calls: r.calls, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, disabled: !!r.disabled })),
    };
  }
  function setDisabled(keyId, disabled) {
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.startsWith("k_") && f.endsWith(".json")); } catch { return false; }
    for (const f of files) { const r = readJson(join(dir, f)); if (r?.keyId === keyId) { r.disabled = !!disabled; save(f.slice(2, -5), r); return true; } }
    return false;
  }

  // A refunded or disputed pack payment disables its key (clawback). Looked
  // up by PaymentIntent id from the Stripe webhook (charge.refunded /
  // charge.dispute.created). Returns the key id or null.
  function disableByPaymentIntent(paymentIntent, reason = "refunded") {
    if (!paymentIntent) return null;
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.startsWith("k_") && f.endsWith(".json")); } catch { return null; }
    for (const f of files) {
      const r = readJson(join(dir, f));
      if (r && Array.isArray(r.paymentIntents) && r.paymentIntents.includes(paymentIntent)) { r.disabled = true; r.disabledReason = reason; save(f.slice(2, -5), r); log(`[credits] key ${r.keyId} disabled (${reason}, ${paymentIntent})`); return r.keyId; }
    }
    return null;
  }

  // Express gate: mount BEFORE the x402 paywall. `priceFor(method, path)` ->
  // { priceUsd } for catalog routes, null otherwise. A Bearer a402_ key on a
  // priced route either authorizes (req.creditsSettling = true, debit on 200)
  // or answers 402 with the balance and a top-up link; non-credit requests
  // pass through untouched.
  function gate(priceFor) {
    return (req, res, next) => {
      const auth = String(req.headers?.authorization || "");
      if (!/^Bearer a402_/.test(auth)) return next();
      const key = auth.slice(7).trim();
      const item = priceFor(req.method, req.path, req);
      if (!item) return next(); // not a priced catalog route - let the site handle it
      // Identity-bound routes (wallet-keyed memory, my-usage) derive the caller
      // from a SIGNED x402 payer; a credits key carries no verified wallet, so
      // they are refused here (same rule as the Tempo and Stripe gates).
      if (item.identityBound) {
        res.setHeader("X-Credits-Error", "identity-bound");
        return res.status(402).json({ error: "This route is wallet-identity bound (the payment IS the identity); prepaid credits carry no verified wallet. Pay it over an x402 rail.", reason: "identity-bound" });
      }
      const a = authorize(key, item.priceUsd);
      if (!a.ok) {
        res.setHeader("X-Credits-Error", a.reason);
        return res.status(402).json({ error: a.reason === "insufficient" ? `Insufficient credits: this call costs $${item.priceUsd} and the key holds $${a.balanceUsd}.` : a.reason === "unknown" ? "Unknown credits key." : a.reason === "disabled" ? "This credits key is disabled." : "Malformed credits key.", reason: a.reason, balanceUsd: a.balanceUsd ?? null, priceUsd: item.priceUsd, topup: `${baseUrl}/credits` });
      }
      // Accepted: the x402 dispatcher is bypassed for this request, so any
      // UNSIGNED payment headers riding alongside must not survive to a handler
      // that reads authorization.from (payerFromRequest) - strip them, exactly
      // as the Tempo and Stripe gates do on acceptance.
      for (const h of ["payment-signature", "x-payment", "payment-identifier", "x-pow-solution"]) { if (req.headers && h in req.headers) delete req.headers[h]; }
      req.creditsSettling = true; req.creditsSettled = true; req.creditsKeyId = a.keyId; req.creditsPriceUsd = item.priceUsd;
      res.setHeader("X-Credits-Balance", String(a.balanceUsd));
      let done = false;
      // Debit ONLY when the response actually finished with a 200 (Node's default
      // statusCode is 200 before anything is written, so a client abort before
      // the first byte would otherwise read as a served 200 and be charged).
      res.on("finish", () => {
        if (done) return; done = true;
        // A prompt-cache hit (X-Cache: hit) cost nothing upstream and is served
        // free to x402 buyers pre-paywall - credits buyers get the same.
        // An idempotent REPLAY (X-Idempotent-Replay: true, server.js) served the
        // stored body of a call this key already paid for: no handler ran, no
        // upstream spend, so it is released like a cache hit. Before this the
        // replay middleware, mounted AFTER this gate, answered 200 into a live
        // hold and a credits buyer's keyed retry was debited a second time - on
        // a metered route at the FULL worst-case hold, since no X-Metered-Usd
        // header exists on a replay (found in the 2026-08-26 security review).
        const cacheHit = String(res.getHeader?.("X-Cache") || "").toLowerCase() === "hit"
          || String(res.getHeader?.("X-Idempotent-Replay") || "").toLowerCase() === "true";
        // A metered route reports actual usage x markup on X-Metered-Usd
        // (gateway-meter.js); the debit is that, never more than the hold.
        const metered = Number(res.getHeader?.("X-Metered-Usd"));
        if (res.statusCode === 200 && !cacheHit) { const c = settle(a.hash, a.heldMicro, item.slug || req.path, Number.isFinite(metered) && metered > 0 ? metered : null); if (c) req.creditsCharged = c.chargedUsd; }
        else release(a.hash, a.heldMicro);
      });
      // A client that drops the socket AFTER dispatch has bought the work: the
      // handler still runs to completion and the upstream is still paid, and
      // `finish` never fires on a destroyed socket - so `close` used to RELEASE
      // the hold, making credits the one rail where an abort was a free
      // expensive call (reproduced 2026-08-28: /v1/research ran, $0 spent).
      // Every other rail settles after the handler regardless of the socket;
      // credits now does the same, at the held amount (the quote ceiling on a
      // metered route, since no usage header exists for an aborted response).
      res.on("close", () => { if (done) return; done = true; settle(a.hash, a.heldMicro, item.slug || req.path); });
      return next();
    };
  }

  /** A presented key -> its id (null for an unknown key). Used by the digest signup: presenting the key is the proof. */
  function keyIdOf(keyString) {
    if (typeof keyString !== "string" || !KEY_RE.test(keyString)) return null;
    const rec = load(hashKey(keyString));
    return rec ? rec.keyId : null;
  }
  /** USD balance for a key id (the digest never holds the key itself). */
  function balanceById(keyId) {
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.startsWith("k_") && f.endsWith(".json")); } catch { return null; }
    for (const f of files) { const r = readJson(join(dir, f)); if (r && r.keyId === keyId) return microToUsd(r.balanceMicro); }
    return null;
  }
  return { createCheckout, claim, authorize, settle, release, charge, balance, status, setDisabled, disableByPaymentIntent, gate, keyIdOf, balanceById, _dir: dir };
}

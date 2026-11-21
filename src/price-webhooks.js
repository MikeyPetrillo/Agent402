// Price webhooks: a buyer registers an https URL and gets one signed POST when
// the list price of a watched tool changes.
//
// WHAT IS WATCHED. The catalog's own list price per slug (the `price` each
// tool publishes on /api/pricing). At boot the catalog is compared with the
// prices kept from the last boot; each slug whose price differs is a change. A
// first boot (nothing kept) records the prices and announces nothing. A tool
// that is added or removed is not a price change.
//
// WHAT IS SENT. One POST per subscription per set of changes, JSON:
//   { type: "price.changed", id, deliveryId, sentAt, changes: [{ slug, from, to }],
//     unsubscribe: { method, url, body } }
// signed with the subscription's secret:
//   X-Agent402-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>
// The secret is derived from this server's signing key and the subscription
// id (HMAC), so no secret is stored: the document holds the URL and the id.
//
// OUTBOUND RULES. Every delivery goes through the fetch guard
// (src/tools/fetch-guard.js probePublicUrl): the host is resolved and refused
// when it is private, the connection re-checks the address, and no redirect is
// followed. A delivery gets a fixed timeout and at most RETRY_DELAYS_MS.length
// + 1 attempts on a schedule; a 2xx ends it, a 410 removes the subscription,
// any other answer (or none) is retried and then dropped. Registration refuses
// a URL that is not https, carries credentials, or does not resolve to a
// public address.
//
// BOUNDS. At most PRICE_WEBHOOK_MAX subscriptions, at most
// PRICE_WEBHOOK_MAX_PER_HOST for one target host (the caller's cap: the host
// is what a registrant controls), at most MAX_SLUGS slugs per subscription.
// One queued delivery per subscription per boot, so the queue never outgrows
// the subscriptions.
//
// SWITCHES. No signing key (PRICE_WEBHOOK_SIGNING_KEY, else POW_SECRET): a
// registration is refused with 503 and nothing is stored. PRICE_WEBHOOK_DELIVERIES off
// (src/feature-flags.js): nothing is sent; registrations and removals work and
// queued deliveries wait.
//
// A documentation host (example.com, example.org, example.net, *.example) is
// accepted and answered in full, and nothing is stored or sent for it: the
// published example names one.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createJsonDocument, SKIP_UPDATE } from "./json-document.js";
import { leased } from "./state-db.js";
import { contained } from "./contained-turn.js";
import { flagEnabled } from "./feature-flags.js";
import { assertPublicUrl, probePublicUrl } from "./tools/fetch-guard.js";

export const PRICE_WEBHOOKS_DOC = "price-webhooks";
export const PRICE_WEBHOOK_SLUG = "price-webhook";
export const UNSUBSCRIBE_PATH = "/api/price-webhook/unsubscribe";
export const SIGNATURE_HEADER = "X-Agent402-Signature";
export const EVENT_HEADER = "X-Agent402-Event";
export const DELIVERY_HEADER = "X-Agent402-Delivery";
export const EVENT_PRICE_CHANGED = "price.changed";
export const MAX_SLUGS = 50;
export const MAX_URL_CHARS = 2048;
export const DELIVERY_TIMEOUT_MS = 10_000;
/** The wait before each further attempt; a delivery is dropped after the last. */
export const RETRY_DELAYS_MS = Object.freeze([60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000]);
export const DELIVERY_USER_AGENT = "agent402-price-webhook/1";
const DELIVERIES_PER_TURN = 25;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const DOC_HOST_RE = /^(?:example\.(?:com|org|net)|(?:[a-z0-9-]+\.)*example)$/i;

const envInt = (name, dflt, env = process.env) => { const n = Number(env[name]); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : dflt; };
export const maxSubscriptions = (env = process.env) => envInt("PRICE_WEBHOOK_MAX", 5000, env);
export const maxPerHost = (env = process.env) => envInt("PRICE_WEBHOOK_MAX_PER_HOST", 20, env);
export const deliveryIntervalMs = (env = process.env) => envInt("PRICE_WEBHOOK_DELIVERY_INTERVAL_MS", 60_000, env);
/** This server's signing key for webhook secrets, or "" when none is set. */
export const signingKeyOf = (env = process.env) => String(env.PRICE_WEBHOOK_SIGNING_KEY || env.POW_SECRET || "").trim();

function bad(message, statusCode = 400, extra = null) {
  return Object.assign(new Error(message), { statusCode }, extra || {});
}

/** The subscription's secret: derived, never stored. */
export function secretFor(signingKey, id) {
  return `whsec_${createHmac("sha256", String(signingKey)).update(`price-webhook-secret|${id}`).digest("hex")}`;
}
/** The signature header value for a body sent at `tSeconds`. */
export function signatureFor(secret, tSeconds, body) {
  return `t=${tSeconds},v1=${createHmac("sha256", String(secret)).update(`${tSeconds}.${body}`).digest("hex")}`;
}
/** Verify a signature header against a body (what a receiver does). */
export function verifySignature(secret, header, body, { toleranceSeconds = 300, now = Date.now() } = {}) {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(String(header || ""));
  if (!m) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(m[1])) > toleranceSeconds) return false;
  const want = Buffer.from(signatureFor(secret, m[1], body));
  const got = Buffer.from(String(header));
  return want.length === got.length && timingSafeEqual(want, got);
}
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export const isDocumentationHost = (host) => DOC_HOST_RE.test(String(host || ""));

/** { url, host } for a target a registrant may name, or a 400. No network. */
export function parseTarget(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) throw bad('"url" is required: the https URL that receives the signed POST');
  if (text.length > MAX_URL_CHARS) throw bad(`"url" is at most ${MAX_URL_CHARS} characters`);
  let u;
  try { u = new URL(text); } catch { throw bad('"url" is not a valid URL'); }
  if (u.protocol !== "https:") throw bad('"url" must be an https URL');
  if (u.username || u.password) throw bad('"url" must not carry credentials (user:pass@host); authenticate the delivery by its signature');
  u.hash = "";
  return { url: u.toString(), host: u.hostname.toLowerCase() };
}

/** The watched slugs: null for every tool, else a sorted list of known slugs. */
export function parseSlugs(raw, known) {
  if (raw === undefined || raw === null || raw === "*" || (Array.isArray(raw) && raw.length === 0)) return null;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
  if (!list) throw bad('"slugs" is a list of tool slugs (or omit it to watch every tool)');
  const out = [...new Set(list.map((s) => String(s ?? "").trim().toLowerCase()).filter(Boolean))];
  if (out.length > MAX_SLUGS) throw bad(`"slugs" lists at most ${MAX_SLUGS} tools; omit it to watch every tool`);
  for (const s of out) {
    if (!SLUG_RE.test(s)) throw bad(`"${s.slice(0, 80)}" is not a tool slug`);
    if (known && !known.has(s)) throw bad(`"${s}" is not a tool in this catalog; slugs are on /api/pricing`);
  }
  return out.sort();
}

const emptyBody = () => ({ v: 1, subs: {}, prices: null, queue: [] });
const bodyOf = (b) => (b && typeof b === "object" && b.subs && typeof b.subs === "object" && Array.isArray(b.queue) ? b : emptyBody());

/** The changes between two price maps: slugs present in both whose price differs. */
export function priceChanges(before, after) {
  const out = [];
  if (!before || !after) return out;
  for (const slug of Object.keys(after).sort()) {
    if (!Object.hasOwn(before, slug)) continue;
    if (String(before[slug]) !== String(after[slug])) out.push({ slug, from: String(before[slug]), to: String(after[slug]) });
  }
  return out;
}

/**
 * The store and its rules, with the document, clock, sender and URL check
 * injected (the default instance below wires the real ones).
 */
export function createPriceWebhooks({
  doc,
  now = () => Date.now(),
  env = process.env,
  baseUrl = () => String(process.env.BASE_URL || "").replace(/\/$/, ""),
  checkUrl = (url) => assertPublicUrl(url),
  send = (url, init) => probePublicUrl(url, { ...init, timeoutMs: DELIVERY_TIMEOUT_MS, userAgent: DELIVERY_USER_AGENT }),
  deliveriesOn = () => flagEnabled("PRICE_WEBHOOK_DELIVERIES", { env }),
  log = console.warn,
} = {}) {
  if (!doc) throw new Error("createPriceWebhooks needs a document");
  let processKey = null; // only for a documentation host's answer when no signing key is set
  const counts = { delivered: 0, retried: 0, dropped: 0, removedOn410: 0 };

  const describe = (id, sub, key) => ({
    id,
    url: sub.url,
    slugs: sub.slugs || "all",
    secret: secretFor(key, id),
    signature: { header: SIGNATURE_HEADER, scheme: "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}` with the secret>" },
    event: EVENT_PRICE_CHANGED,
    unsubscribe: { method: "POST", url: `${baseUrl()}${UNSUBSCRIBE_PATH}`, body: { id, secret: "<the secret above>" } },
  });

  /** Register a target. `known`: the catalog's slugs (a Set). */
  async function register(input, { known = null } = {}) {
    const key = signingKeyOf(env);
    const target = parseTarget(input?.url);
    const slugs = parseSlugs(input?.slugs, known);
    const id = `pw_${randomBytes(16).toString("hex")}`;
    if (isDocumentationHost(target.host)) {
      // Nothing is kept for it, so with no signing key set the secret shown is
      // derived from a key of this process's own: the answer has every field.
      return { ...describe(id, { url: target.url, slugs }, key || (processKey ||= randomBytes(32).toString("hex"))), registered: false, delivers: false, note: `${target.host} is a documentation host: the registration is answered as a real one would be, and nothing is stored or sent.` };
    }
    if (!key) throw bad("Price webhooks are not configured on this server (no signing key), so nothing was registered.", 503);
    // The host is resolved and refused when it is not public (a 400 from the guard).
    await checkUrl(target.url);
    let refusal = null;
    const r = await doc.update((b) => {
      const body = bodyOf(b);
      refusal = null;
      const subs = Object.values(body.subs);
      if (subs.length >= maxSubscriptions(env)) { refusal = bad("This server holds as many price webhooks as it is set to; nothing was registered.", 503, { retryAfterSeconds: 3600 }); return SKIP_UPDATE; }
      if (subs.filter((s) => s.host === target.host).length >= maxPerHost(env)) { refusal = bad(`${target.host} already has ${maxPerHost(env)} price webhooks registered, the most one host may hold. Remove one first (POST ${UNSUBSCRIBE_PATH}).`, 409); return SKIP_UPDATE; }
      body.subs[id] = { url: target.url, host: target.host, slugs, at: now() };
      return body;
    }, { fallback: emptyBody() });
    if (refusal) throw refusal;
    if (!r?.ok) throw bad("The registration could not be stored; nothing was registered.", 503, { retryAfterSeconds: 30 });
    return { ...describe(id, { url: target.url, slugs }, key), registered: true, delivers: true };
  }

  /** Remove a subscription. The same answer for an unknown id and a wrong secret. */
  async function unsubscribe(input) {
    const key = signingKeyOf(env);
    const id = typeof input?.id === "string" ? input.id.trim() : "";
    const secret = typeof input?.secret === "string" ? input.secret.trim() : "";
    if (!/^pw_[0-9a-f]{32}$/.test(id) || !secret) throw bad('Send "id" and "secret", as the registration returned them.');
    if (!key || !safeEqual(secret, secretFor(key, id))) return { removed: false };
    let removed = false;
    const r = await doc.update((b) => {
      const body = bodyOf(b);
      removed = false;
      if (!body.subs[id]) return SKIP_UPDATE;
      delete body.subs[id];
      body.queue = body.queue.filter((q) => q.sub !== id);
      removed = true;
      return body;
    }, { fallback: emptyBody() });
    if (!r?.ok) throw bad("The removal could not be stored; retry.", 503, { retryAfterSeconds: 30 });
    return { removed };
  }

  /**
   * Compare the catalog's prices ({ slug: price }) with the ones kept, queue
   * one delivery per subscription that watches a changed slug, and keep the
   * new prices. Resolves { first, changes, queued }.
   */
  async function notePrices(prices) {
    const after = {};
    for (const [slug, price] of Object.entries(prices || {})) if (SLUG_RE.test(slug) && typeof price === "string" && price) after[slug] = price;
    let out = { first: false, changes: 0, queued: 0 };
    const r = await doc.update((b) => {
      const body = bodyOf(b);
      out = { first: !body.prices, changes: 0, queued: 0 };
      const changes = priceChanges(body.prices, after);
      const same = body.prices && changes.length === 0 && Object.keys(body.prices).length === Object.keys(after).length && Object.keys(after).every((s) => Object.hasOwn(body.prices, s));
      if (same) return SKIP_UPDATE;
      out.changes = changes.length;
      if (changes.length) {
        const at = now();
        for (const [id, sub] of Object.entries(body.subs)) {
          const mine = sub.slugs ? changes.filter((c) => sub.slugs.includes(c.slug)) : changes;
          if (!mine.length) continue;
          // One queued delivery per subscription: a later set of changes is added to the one waiting.
          const waiting = body.queue.find((q) => q.sub === id);
          if (waiting) {
            const bySlug = new Map(waiting.changes.map((c) => [c.slug, c]));
            for (const c of mine) bySlug.set(c.slug, bySlug.has(c.slug) ? { slug: c.slug, from: bySlug.get(c.slug).from, to: c.to } : c);
            waiting.changes = [...bySlug.values()].filter((c) => c.from !== c.to);
            waiting.tries = 0; waiting.next = at;
          } else {
            body.queue.push({ k: `pwd_${randomBytes(12).toString("hex")}`, sub: id, at, changes: mine, tries: 0, next: at });
          }
          out.queued++;
        }
        body.queue = body.queue.filter((q) => q.changes.length > 0);
      }
      body.prices = after;
      return body;
    }, { fallback: emptyBody() });
    if (!r?.ok) { log("[price-webhooks] the price record could not be stored"); return { ...out, ok: false }; }
    return { ...out, ok: true };
  }

  /** The request a delivery sends: { url, body, headers }. */
  function buildDelivery(item, sub, key, at) {
    const payload = {
      type: EVENT_PRICE_CHANGED,
      id: item.sub,
      deliveryId: item.k,
      sentAt: new Date(at).toISOString(),
      attempt: (Number(item.tries) || 0) + 1,
      changes: item.changes,
      pricing: `${baseUrl()}/api/pricing`,
      unsubscribe: { method: "POST", url: `${baseUrl()}${UNSUBSCRIBE_PATH}`, body: { id: item.sub, secret: "<your secret>" } },
    };
    const body = JSON.stringify(payload);
    const t = Math.floor(at / 1000);
    return {
      url: sub.url, body,
      headers: { "Content-Type": "application/json", [SIGNATURE_HEADER]: signatureFor(secretFor(key, item.sub), t, body), [EVENT_HEADER]: EVENT_PRICE_CHANGED, [DELIVERY_HEADER]: item.k },
    };
  }

  /** Send what is due (at most DELIVERIES_PER_TURN). Never throws. */
  async function deliverDue() {
    const key = signingKeyOf(env);
    if (!key) return { skipped: "no-signing-key" };
    if (!deliveriesOn()) return { skipped: "deliveries-off" };
    const read = await doc.read({ quiet: true });
    if (!read?.ok) return { skipped: "unread" };
    const body = bodyOf(read.body);
    const at = now();
    const due = body.queue.filter((q) => Number(q.next) <= at).slice(0, DELIVERIES_PER_TURN);
    const outcomes = new Map(); // k -> "done" | "gone" | "retry"
    for (const item of due) {
      const sub = body.subs[item.sub];
      if (!sub) { outcomes.set(item.k, "done"); continue; }
      const req = buildDelivery(item, sub, key, now());
      let status = 0;
      try {
        const res = await send(req.url, { method: "POST", headers: req.headers, body: req.body });
        status = Number(res?.status) || 0;
        try { await res?.body?.cancel?.(); } catch { /* nothing to release */ }
      } catch { status = 0; /* refused by the guard, timed out, or no answer */ }
      outcomes.set(item.k, status >= 200 && status < 300 ? "done" : status === 410 ? "gone" : "retry");
    }
    if (!outcomes.size) return { sent: 0, left: body.queue.length };
    const tally = { delivered: 0, retried: 0, dropped: 0, removedOn410: 0 };
    const r = await doc.update((b) => {
      const cur = bodyOf(b);
      tally.delivered = tally.retried = tally.dropped = tally.removedOn410 = 0;
      const keep = [];
      for (const q of cur.queue) {
        const o = outcomes.get(q.k);
        if (!o) { keep.push(q); continue; }
        if (o === "done") { tally.delivered++; continue; }
        if (o === "gone") { if (cur.subs[q.sub]) { delete cur.subs[q.sub]; tally.removedOn410++; } continue; }
        const tries = (Number(q.tries) || 0) + 1;
        if (tries > RETRY_DELAYS_MS.length) { tally.dropped++; continue; }
        tally.retried++;
        keep.push({ ...q, tries, next: now() + RETRY_DELAYS_MS[tries - 1] });
      }
      cur.queue = keep.filter((q) => cur.subs[q.sub]);
      return cur;
    }, { fallback: emptyBody() });
    if (!r?.ok) return { skipped: "unsaved" };
    for (const k of Object.keys(tally)) counts[k] += tally[k];
    return { sent: outcomes.size, ...tally, left: bodyOf(r.body).queue.length };
  }

  /** Counts only, for the operator view. */
  async function status() {
    const read = await doc.read({ quiet: true });
    const body = bodyOf(read?.ok ? read.body : null);
    return { configured: Boolean(signingKeyOf(env)), deliveries: deliveriesOn() ? "on" : "off", subscriptions: Object.keys(body.subs).length, queued: body.queue.length, pricesKept: body.prices ? Object.keys(body.prices).length : 0, sinceBoot: { ...counts } };
  }

  return { register, unsubscribe, notePrices, deliverDue, status, buildDelivery };
}

// ---------------------------------------------------------------- the default instance
let instance = null;
let timer = null;
export function priceWebhooks() {
  return (instance ||= createPriceWebhooks({
    doc: createJsonDocument({ name: PRICE_WEBHOOKS_DOC, file: process.env.PRICE_WEBHOOKS_FILE || "/data/price-webhooks.json", log: () => {} }),
  }));
}

/**
 * Boot: record the catalog's prices (queueing deliveries for the changes) and
 * start the delivery turn. `prices` is a function returning { slug: price }.
 * Both run under a lease, so two replicas neither announce a change twice nor
 * send one delivery twice.
 */
export function startPriceWebhooks({ prices, intervalMs = deliveryIntervalMs() } = {}) {
  const pw = priceWebhooks();
  const note = leased("price-webhooks-note", { ttlMs: 60_000 }, () => pw.notePrices(typeof prices === "function" ? prices() : prices));
  const deliver = leased("price-webhooks-deliver", { ttlMs: 5 * 60_000 }, () => pw.deliverDue());
  const first = setTimeout(contained("price-webhooks-note", async () => { await note(); await deliver(); }), 0);
  first.unref?.();
  if (timer) clearInterval(timer);
  timer = setInterval(contained("price-webhooks-deliver", () => deliver()), intervalMs);
  timer.unref?.();
  return true;
}
export function stopPriceWebhooks() { if (timer) clearInterval(timer); timer = null; }
/** Tests only. */
export function __resetPriceWebhooksForTest() { stopPriceWebhooks(); instance = null; }

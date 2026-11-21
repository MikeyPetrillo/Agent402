// Price webhooks: a buyer registers an https URL and gets a signed POST when
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
//   X-Agent402-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
// The secret is derived from this server's signing key and the subscription
// id (HMAC), so no secret is stored: the document holds the URL, the id and a
// keyed digest of the registrant (never the wallet or the address itself).
//
// WHO REGISTERS. The registrant is the party that paid for the registration
// (src/tools/price-webhook-kit.js registrantOf: the signed payer, a credits
// key, a Tempo sender, the signer of a Solana, Algorand or Stellar payment;
// any other paid call is a registrant of its own; in FREE_MODE, where no
// payment is verified and there is no payer, the client address). A
// registrant holds at most PRICE_WEBHOOK_MAX_PER_PAYER subscriptions and its
// own next one is refused (409) with nothing charged: the only registration
// refused for what a party itself holds. Nothing is refused for the host a
// URL names, so many buyers may point at one shared receiver.
//
// A REGISTRATION IS KEPT ONLY WHEN ITS CALL SETTLES. The handler stores it as
// pending (never delivered to) and the dispatcher reports the final response
// (src/tools/price-webhook-kit.js, `req.__onSettled`): on a final 200 the
// subscription is confirmed, on anything else it is removed. One that is never
// reported (the process ended in between) is removed PENDING_MS after it was
// stored.
//
// LIFETIME. A subscription lasts PRICE_WEBHOOK_LIFETIME_DAYS (90) from its
// registration, then it is removed. Registering the same URL again from the
// same proven registrant renews it in place: the same id and secret, the
// slugs as sent, a new lifetime from that call (kept, like a registration,
// only when the call settles), and no second place against the registrant's
// cap. A subscription stored by a build that kept no expiry gets one lifetime
// from the first store write of this one.
//
// THE STORE'S BOUND. Expired subscriptions are removed at every registration
// and each time the prices are recorded (a boot); one that has expired is
// never delivered to in between. From PRICE_WEBHOOK_MAX on, a new registration first removes the
// subscriptions whose last delivery was dropped after every attempt (the most
// failures first, then the oldest) and is admitted all the same, up to twice
// that number, the hard bound (a 503 with Retry-After, nothing charged).
// Nothing a receiver still answers is ever removed for room.
//
// OUTBOUND RULES. Every delivery goes through the fetch guard
// (src/tools/fetch-guard.js probePublicUrl): the host is resolved and refused
// when it is private, the connection re-checks the address, and no redirect is
// followed. Registration refuses a URL that is not https, carries
// credentials, or does not resolve to a public address.
//
// A DELIVERY TURN (deliverDue, once a minute) is fair across receivers:
//   - one receiving host gets one request at a time (its due deliveries go in
//     a row), hosts run DELIVERY_LANES at a time;
//   - one attempt (resolve, connect, response headers) gets
//     DELIVERY_TIMEOUT_MS; a host that does not answer in that time gets no
//     more this turn, and a host that answers gets HOST_TURN_MS of the turn;
//   - deliveries to subscriptions whose last attempt got a 2xx (or that have
//     had none) go first, and among them one per registrant before anyone's
//     second; a delivery that failed is retried on RETRY_DELAYS_MS (per
//     subscription: one queued delivery each) and its subscription stands
//     behind those until an attempt gets a 2xx. A 2xx ends it, a 410 removes the subscription, any other
//     answer (or none) is retried and then dropped;
//   - a turn starts no attempt after TURN_BUDGET_MS, and never runs beside
//     itself: under the lease with a state database, and in this process
//     always.
// So a receiver that does not answer costs one lane DELIVERY_TIMEOUT_MS a
// turn and never holds another receiver's delivery past the next turn.
//
// CHANGE SETS. The changes one boot found are stored once (`sets`) and each
// queued delivery names the sets it carries; the payload's list is built from
// them for the subscription's slugs when it is sent. One queued delivery per
// subscription, so the queue never outgrows the subscriptions; at most
// MAX_CHANGE_SETS sets are kept (past it the two oldest are folded into one).
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
/** The header's value in words: v1 is the HMAC of the timestamp, a dot and the body as sent. Written with <t> and <body> (no template placeholder: published surfaces carry it as text). */
export const SIGNATURE_SCHEME = 't=<unix seconds>,v1=<hex HMAC-SHA256, with the secret, of "<t>.<body>": the timestamp, a dot, and the body as sent>';
export const EVENT_HEADER = "X-Agent402-Event";
export const DELIVERY_HEADER = "X-Agent402-Delivery";
export const EVENT_PRICE_CHANGED = "price.changed";
export const MAX_SLUGS = 50;
export const MAX_URL_CHARS = 2048;
/** One attempt, whole: the host's lookup, the connection and the response headers. */
export const DELIVERY_TIMEOUT_MS = 4_000;
/** The wait before each further attempt; a delivery is dropped after the last. */
export const RETRY_DELAYS_MS = Object.freeze([60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000]);
/** Receiving hosts in flight at once; each host gets one request at a time. */
export const DELIVERY_LANES = 16;
/** What one answering host gets of a turn before its remaining deliveries wait for the next. */
export const HOST_TURN_MS = 2 * DELIVERY_TIMEOUT_MS;
/** A turn starts no attempt this long after it began (the interval is a minute). */
export const TURN_BUDGET_MS = 40_000;
/** A registration whose call was never reported settled is removed after this long. */
export const PENDING_MS = 10 * 60_000;
/** Change sets kept at most; past it the two oldest are folded into one. */
export const MAX_CHANGE_SETS = 16;
export const DELIVERY_USER_AGENT = "agent402-price-webhook/1";
const DAY_MS = 86_400_000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const DOC_HOST_RE = /^(?:example\.(?:com|org|net)|(?:[a-z0-9-]+\.)*example)$/i;
/** Registrant keys that name a party a payment proved (the rest: an address, one payment, no request). */
const PROVEN_REGISTRANT_RE = /^(?:payer|credits|tempo|svm|avm|stellar):./;

const envInt = (name, dflt, env = process.env) => { const n = Number(env[name]); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : dflt; };
/** Where room is first made (failing subscriptions go); the hard bound is twice this. */
export const maxSubscriptions = (env = process.env) => envInt("PRICE_WEBHOOK_MAX", 5000, env);
export const hardMaxSubscriptions = (env = process.env) => 2 * maxSubscriptions(env);
export const maxPerRegistrant = (env = process.env) => envInt("PRICE_WEBHOOK_MAX_PER_PAYER", 25, env);
export const lifetimeMs = (env = process.env) => envInt("PRICE_WEBHOOK_LIFETIME_DAYS", 90, env) * DAY_MS;
export const deliveryIntervalMs = (env = process.env) => envInt("PRICE_WEBHOOK_DELIVERY_INTERVAL_MS", 60_000, env);
/** This server's signing key for webhook secrets, or "" when none is set. */
export const signingKeyOf = (env = process.env) => String(env.PRICE_WEBHOOK_SIGNING_KEY || env.POW_SECRET || "").trim();

function bad(message, statusCode = 400, extra = null) {
  return Object.assign(new Error(message), { statusCode }, extra || {});
}

/** The subscription's secret: derived, never stored. */
export function secretFor(signingKey, id) {
  return `a402whsec_${createHmac("sha256", String(signingKey)).update(`price-webhook-secret|${id}`).digest("hex")}`;
}
/** What is stored for a registrant: a keyed digest, so the document names no wallet and no address. */
export function ownerDigest(signingKey, registrant) {
  return `o_${createHmac("sha256", String(signingKey)).update(`price-webhook-owner|${registrant}`).digest("hex").slice(0, 32)}`;
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

const emptyBody = () => ({ v: 2, subs: {}, prices: null, sets: {}, queue: [] });
function bodyOf(b) {
  if (!(b && typeof b === "object" && b.subs && typeof b.subs === "object" && Array.isArray(b.queue))) return emptyBody();
  if (!b.sets || typeof b.sets !== "object") b.sets = {};
  return b;
}
/** When a subscription ends; one stored with no expiry has not ended. */
const expOf = (sub) => (Number.isFinite(sub?.exp) ? sub.exp : Infinity);
const liveAt = (sub, t) => Boolean(sub) && !sub.pending && expOf(sub) > t;

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

/** Lists of changes, oldest first, as one: a slug keeps its first `from` and
 *  takes its latest `to`, and one that is back where it began is left out. */
function foldChanges(lists) {
  const bySlug = new Map();
  for (const list of lists) {
    for (const c of Array.isArray(list) ? list : []) {
      const was = bySlug.get(c.slug);
      bySlug.set(c.slug, { slug: c.slug, from: was ? was.from : c.from, to: c.to });
    }
  }
  return [...bySlug.values()].filter((c) => c.from !== c.to).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** What a queued delivery announces to its subscription: the sets it names
 *  (and a list an earlier build stored inline), folded, for the watched slugs.
 *  `memo` (a Map) shares the fold between deliveries naming the same sets. */
export function changesOf(body, item, sub, memo = null) {
  const sets = Array.isArray(item?.sets) ? item.sets : [];
  const inline = Array.isArray(item?.changes) && item.changes.length ? item.changes : null;
  const memoKey = inline ? null : sets.join(",");
  let all = memo && memoKey !== null ? memo.get(memoKey) : undefined;
  if (!all) {
    all = foldChanges([inline, ...sets.map((id) => body.sets?.[id]?.changes)]);
    if (memo && memoKey !== null) memo.set(memoKey, all);
  }
  const watched = Array.isArray(sub?.slugs) ? new Set(sub.slugs) : null;
  return watched ? all.filter((c) => watched.has(c.slug)) : all;
}

/** `promise`, or a rejection after `ms`; a result that arrives later is released. */
function within(promise, ms) {
  let timer = null;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("no answer in time"), { timedOut: true })), ms); timer.unref?.(); });
  const guarded = Promise.resolve(promise);
  guarded.then((res) => { try { res?.body?.cancel?.()?.catch?.(() => {}); } catch { /* nothing to release */ } }, () => {});
  return Promise.race([guarded, late]).finally(() => clearTimeout(timer));
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
  attemptTimeoutMs = DELIVERY_TIMEOUT_MS,
  settleRetryDelaysMs = [1_000, 5_000, 30_000],
  deliveriesOn = () => flagEnabled("PRICE_WEBHOOK_DELIVERIES", { env }),
  log = console.warn,
} = {}) {
  if (!doc) throw new Error("createPriceWebhooks needs a document");
  let processKey = null; // only for a documentation host's answer when no signing key is set
  let turning = false; // a delivery turn is under way in this process
  let saidFullAt = -Infinity; // when the hard bound was last logged (one line an hour)
  const counts = { delivered: 0, retried: 0, dropped: 0, removedOn410: 0, expired: 0, unsettled: 0, removedForRoom: 0, refusedFull: 0, refusedOwn: 0 };

  const describe = (id, sub, key) => ({
    id,
    url: sub.url,
    slugs: sub.slugs || "all",
    secret: secretFor(key, id),
    signature: { header: SIGNATURE_HEADER, scheme: SIGNATURE_SCHEME },
    event: EVENT_PRICE_CHANGED,
    unsubscribe: { method: "POST", url: `${baseUrl()}${UNSUBSCRIBE_PATH}`, body: { id, secret: "<the secret above>" } },
    expiresAt: new Date(sub.exp).toISOString(),
  });

  /** Drop the sets no queued delivery names; past the cap fold the two oldest
   *  into one (a delivery that named only the newer then also lists the older
   *  one's changes for its slugs). */
  function tidySets(body) {
    const named = new Set();
    for (const q of body.queue) for (const id of Array.isArray(q.sets) ? q.sets : []) named.add(id);
    for (const id of Object.keys(body.sets)) if (!named.has(id)) delete body.sets[id];
    for (let ids = Object.keys(body.sets); ids.length > MAX_CHANGE_SETS; ids = Object.keys(body.sets)) {
      ids.sort((a, b) => (Number(body.sets[a].at) || 0) - (Number(body.sets[b].at) || 0));
      const [older, newer] = ids;
      body.sets[newer] = { at: body.sets[newer].at, changes: foldChanges([body.sets[older].changes, body.sets[newer].changes]) };
      delete body.sets[older];
      for (const q of body.queue) {
        if (!Array.isArray(q.sets) || !q.sets.includes(older)) continue;
        q.sets = [...new Set(q.sets.map((id) => (id === older ? newer : id)))];
      }
    }
  }

  /** What a registration and a price record do first: remove what has ended (an expired
   *  subscription, a registration or renewal never reported settled), give a
   *  subscription stored with no expiry its lifetime, drop what they leave
   *  behind. True when anything changed. */
  function sweep(body, t, tally) {
    let changed = false;
    const life = lifetimeMs(env);
    for (const [id, sub] of Object.entries(body.subs)) {
      if (!sub || typeof sub !== "object") { delete body.subs[id]; changed = true; continue; }
      if (!Number.isFinite(sub.exp)) { sub.exp = t + life; changed = true; }
      if (sub.exp <= t) { delete body.subs[id]; tally.expired++; changed = true; continue; }
      if (sub.pending && sub.pending <= t) { delete body.subs[id]; tally.unsettled++; changed = true; continue; }
      if (sub.renew && !(sub.renew.until > t)) { delete sub.renew; changed = true; }
    }
    const before = body.queue.length;
    body.queue = body.queue.filter((q) => body.subs[q.sub]);
    if (body.queue.length !== before) changed = true;
    const sets = Object.keys(body.sets).length;
    tidySets(body);
    return changed || Object.keys(body.sets).length !== sets;
  }

  /** Make room at the store's bound: the subscriptions whose last delivery was
   *  dropped after every attempt go, the most failures first, then the oldest. */
  function removeFailing(body, want, tally) {
    if (want <= 0) return 0;
    const failing = Object.entries(body.subs).filter(([, s]) => !s.pending && Number(s.fails) >= 1)
      .sort(([, a], [, b]) => (Number(b.fails) - Number(a.fails)) || ((Number(a.at) || 0) - (Number(b.at) || 0)));
    let gone = 0;
    for (const [id] of failing) {
      if (gone >= want) break;
      delete body.subs[id];
      gone++;
    }
    if (gone) { body.queue = body.queue.filter((q) => body.subs[q.sub]); tally.removedForRoom += gone; }
    return gone;
  }

  /**
   * Register a target and report its call's outcome later. `known`: the
   * catalog's slugs (a Set). `registrant`: the key of the party that paid
   * (null: no cap of its own). Resolves `{ answer, settle }`: the subscription
   * is stored pending, and `settle(true)` keeps it, `settle(false)` removes it
   * (a renewal: applies it, or leaves the subscription as it was).
   */
  async function registerPending(input, opts = {}) {
    return store(input, { ...opts, deferred: true });
  }
  /** Register a target, kept at once (a call with no response to wait for). */
  async function register(input, opts = {}) {
    return (await store(input, { ...opts, deferred: false })).answer;
  }

  async function store(input, { known = null, registrant = null, deferred = false } = {}) {
    const key = signingKeyOf(env);
    const target = parseTarget(input?.url);
    const slugs = parseSlugs(input?.slugs, known);
    if (isDocumentationHost(target.host)) {
      // Nothing is kept for it, so with no signing key set the secret shown is
      // derived from a key of this process's own: the answer has every field.
      const id = `pw_${randomBytes(16).toString("hex")}`;
      const answer = { ...describe(id, { url: target.url, slugs, exp: now() + lifetimeMs(env) }, key || (processKey ||= randomBytes(32).toString("hex"))), registered: false, delivers: false, note: `${target.host} is a documentation host: the registration is answered as a real one would be, and nothing is stored or sent.` };
      return { answer, settle: async () => true };
    }
    if (!key) throw bad("Price webhooks are not configured on this server (no signing key), so nothing was registered.", 503);
    // The host is resolved and refused when it is not public (a 400 from the guard).
    await checkUrl(target.url);
    const who = typeof registrant === "string" && registrant ? registrant : null;
    const owner = who ? ownerDigest(key, who) : null;
    const renewable = who !== null && PROVEN_REGISTRANT_RE.test(who);
    const cap = maxPerRegistrant(env), soft = maxSubscriptions(env), hard = hardMaxSubscriptions(env), life = lifetimeMs(env);
    let refusal = null, placed = null;
    const tally = { expired: 0, unsettled: 0, removedForRoom: 0 };
    const r = await doc.update((b) => {
      const body = bodyOf(b);
      refusal = null; placed = null;
      tally.expired = tally.unsettled = tally.removedForRoom = 0;
      const t = now();
      const swept = sweep(body, t, tally);
      const mine = owner ? Object.entries(body.subs).filter(([, s]) => s.owner === owner) : [];
      // The same URL again from the same proven registrant renews it in place.
      const same = renewable ? mine.find(([, s]) => s.url === target.url && !s.pending) : null;
      if (same) {
        const [id, sub] = same;
        if (deferred) sub.renew = { exp: t + life, slugs, until: t + PENDING_MS };
        else { sub.exp = t + life; sub.slugs = slugs; delete sub.renew; }
        placed = { id, exp: t + life, renewed: true };
        return body;
      }
      if (owner && mine.length >= cap) {
        refusal = bad(`This registrant already holds ${cap} price webhooks, the most one may hold, so this one was not registered. Remove one first (POST ${UNSUBSCRIBE_PATH}, free), or register a URL it already holds to renew that one.`, 409, { own: true });
        return swept ? body : SKIP_UPDATE;
      }
      let n = Object.keys(body.subs).length;
      if (n >= soft) n -= removeFailing(body, n - soft + 1, tally);
      if (n >= hard) {
        refusal = bad("This server holds as many price webhooks as it can keep; nothing was registered. Retry later.", 503, { retryAfterSeconds: 3600, full: true });
        return swept || tally.removedForRoom ? body : SKIP_UPDATE;
      }
      const id = `pw_${randomBytes(16).toString("hex")}`;
      body.subs[id] = { url: target.url, host: target.host, slugs, at: t, exp: t + life, ...(owner ? { owner } : {}), ...(deferred ? { pending: t + PENDING_MS } : {}) };
      placed = { id, exp: t + life, renewed: false };
      return body;
    }, { fallback: emptyBody() });
    if (r?.ok) for (const k of Object.keys(tally)) counts[k] += tally[k];
    if (refusal) {
      if (refusal.own) counts.refusedOwn++;
      else {
        counts.refusedFull++;
        if (now() - saidFullAt >= 3_600_000) { saidFullAt = now(); log(`[price-webhooks] the store is at its hard bound (${hard} subscriptions, none expired or failing): a registration was refused; PRICE_WEBHOOK_MAX raises it`); }
      }
      throw refusal;
    }
    if (!r?.ok || !placed) throw bad("The registration could not be stored; nothing was registered.", 503, { retryAfterSeconds: 30 });
    const { id, exp, renewed } = placed;
    const answer = { ...describe(id, { url: target.url, slugs, exp }, key), registered: true, delivers: true, ...(renewed ? { renewed: true } : {}) };
    return { answer, settle: deferred ? (ok) => settleStored(id, renewed, ok === true) : async () => true };
  }

  /** The outcome of a pending registration's call: keep it or remove it (a
   *  renewal: apply it or drop it). A store that does not answer is asked
   *  again on `settleRetryDelaysMs`; past that the pending mark's own expiry
   *  removes it. Resolves true when the store took it. Never throws. */
  async function settleStored(id, renewed, ok) {
    for (let attempt = 0; ; attempt++) {
      let r = null;
      try {
        r = await doc.update((b) => {
          const body = bodyOf(b);
          const sub = body.subs[id];
          if (!sub) return SKIP_UPDATE;
          if (renewed) {
            if (!sub.renew) return SKIP_UPDATE;
            if (ok) { sub.exp = sub.renew.exp; sub.slugs = sub.renew.slugs; }
            delete sub.renew;
            return body;
          }
          if (!sub.pending) return SKIP_UPDATE;
          if (ok) delete sub.pending;
          else { delete body.subs[id]; body.queue = body.queue.filter((q) => q.sub !== id); }
          return body;
        }, { fallback: emptyBody() });
      } catch { r = null; }
      if (r?.ok) { if (!ok && !renewed) counts.unsettled++; return true; }
      if (attempt >= settleRetryDelaysMs.length) { log(`[price-webhooks] a registration's outcome could not be stored; its pending mark ends it`); return false; }
      await new Promise((resolve) => { const timer = setTimeout(resolve, settleRetryDelaysMs[attempt]); timer.unref?.(); });
    }
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
      tidySets(body);
      removed = true;
      return body;
    }, { fallback: emptyBody() });
    if (!r?.ok) throw bad("The removal could not be stored; retry.", 503, { retryAfterSeconds: 30 });
    return { removed };
  }

  /**
   * Compare the catalog's prices ({ slug: price }) with the ones kept, store
   * the changes once as a set, name it on one queued delivery per subscription
   * that watches a changed slug, and keep the new prices. Resolves
   * { first, changes, queued }.
   */
  async function notePrices(prices) {
    const after = {};
    for (const [slug, price] of Object.entries(prices || {})) if (SLUG_RE.test(slug) && typeof price === "string" && price) after[slug] = price;
    let out = { first: false, changes: 0, queued: 0 };
    const tally = { expired: 0, unsettled: 0, removedForRoom: 0 };
    const r = await doc.update((b) => {
      const body = bodyOf(b);
      out = { first: !body.prices, changes: 0, queued: 0 };
      tally.expired = tally.unsettled = 0;
      const at = now();
      const swept = sweep(body, at, tally);
      const changes = priceChanges(body.prices, after);
      const same = body.prices && changes.length === 0 && Object.keys(body.prices).length === Object.keys(after).length && Object.keys(after).every((s) => Object.hasOwn(body.prices, s));
      if (same) return swept ? body : SKIP_UPDATE;
      out.changes = changes.length;
      if (changes.length) {
        const setId = `pws_${randomBytes(8).toString("hex")}`;
        body.sets[setId] = { at, changes };
        const changed = new Set(changes.map((c) => c.slug));
        const waitingBySub = new Map(body.queue.map((q) => [q.sub, q]));
        for (const [id, sub] of Object.entries(body.subs)) {
          if (sub.pending) continue; // a registration whose call has not settled is not delivered to
          if (sub.slugs && !sub.slugs.some((s) => changed.has(s))) continue;
          // One queued delivery per subscription: a later set joins the one waiting.
          const waiting = waitingBySub.get(id);
          if (waiting) {
            waiting.sets = [...(Array.isArray(waiting.sets) ? waiting.sets : []), setId];
            waiting.tries = 0; waiting.next = at;
          } else {
            body.queue.push({ k: `pwd_${randomBytes(12).toString("hex")}`, sub: id, at, sets: [setId], tries: 0, next: at });
          }
          out.queued++;
        }
        // A delivery with nothing left to announce (a price back where it began) is dropped.
        const memo = new Map();
        body.queue = body.queue.filter((q) => changesOf(body, q, body.subs[q.sub], memo).length > 0);
        tidySets(body);
      }
      body.prices = after;
      return body;
    }, { fallback: emptyBody() });
    if (!r?.ok) { log("[price-webhooks] the price record could not be stored"); return { ...out, ok: false }; }
    counts.expired += tally.expired; counts.unsettled += tally.unsettled;
    return { ...out, ok: true };
  }

  /** The request a delivery sends: { url, body, headers }. */
  function buildDelivery(item, sub, key, at, changes) {
    const payload = {
      type: EVENT_PRICE_CHANGED,
      id: item.sub,
      deliveryId: item.k,
      sentAt: new Date(at).toISOString(),
      attempt: (Number(item.tries) || 0) + 1,
      changes,
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

  /** The due deliveries in the order a turn takes them: those that have not
   *  failed first, then the rest; inside each, one per registrant before
   *  anyone's second, each registrant's own in the order they came due. */
  function turnOrder(body, due) {
    const rank = (failed) => {
      const byOwner = new Map();
      for (const q of due) {
        const sub = body.subs[q.sub];
        if ((Number(q.tries) > 0 || Number(sub.miss) > 0 || Number(sub.fails) > 0) !== failed) continue;
        const owner = sub.owner || `sub:${q.sub}`;
        if (!byOwner.has(owner)) byOwner.set(owner, []);
        byOwner.get(owner).push(q);
      }
      const out = [];
      for (let round = 0, more = true; more; round++) {
        more = false;
        for (const list of byOwner.values()) if (round < list.length) { out.push(list[round]); more = true; }
      }
      return out;
    };
    return [...rank(false), ...rank(true)];
  }

  /** Send what is due, fairly across receivers (see the header). Never throws,
   *  and never runs beside itself in this process. */
  async function deliverDue() {
    if (turning) return { skipped: "turn-running" };
    turning = true;
    try { return await turn(); } finally { turning = false; }
  }

  async function turn() {
    const key = signingKeyOf(env);
    if (!key) return { skipped: "no-signing-key" };
    if (!deliveriesOn()) return { skipped: "deliveries-off" };
    const read = await doc.read({ quiet: true });
    if (!read?.ok) return { skipped: "unread" };
    const body = bodyOf(read.body);
    const began = now();
    const due = body.queue.filter((q) => Number(q.next) <= began && liveAt(body.subs[q.sub], began));
    // One job per receiving host, hosts in the order of their first delivery.
    const jobs = new Map();
    for (const q of turnOrder(body, due)) {
      const host = body.subs[q.sub].host || body.subs[q.sub].url;
      if (!jobs.has(host)) jobs.set(host, []);
      jobs.get(host).push(q);
    }
    const outcomes = new Map(); // k -> { how: "done" | "gone" | "retry", sets: how many sets it carried }
    const memo = new Map();
    const attempt = async (item) => {
      const sub = body.subs[item.sub];
      const carried = Array.isArray(item.sets) ? item.sets.length : 0;
      const changes = changesOf(body, item, sub, memo);
      if (!changes.length) return { how: "done", sets: carried, silent: true };
      const req = buildDelivery(item, sub, key, now(), changes);
      let status = 0;
      try {
        const res = await within(Promise.resolve().then(() => send(req.url, { method: "POST", headers: req.headers, body: req.body })), attemptTimeoutMs);
        status = Number(res?.status) || 0;
      } catch { status = 0; /* refused by the guard, timed out, or no answer */ }
      return { how: status >= 200 && status < 300 ? "done" : status === 410 ? "gone" : "retry", sets: carried, answered: status > 0 };
    };
    const hosts = [...jobs.values()];
    let next = 0;
    const lane = async () => {
      while (next < hosts.length) {
        const items = hosts[next++];
        const from = now();
        for (const item of items) {
          // Past the turn's budget, or this host's share of it: the rest wait for the next turn.
          if (now() - began >= TURN_BUDGET_MS || now() - from >= HOST_TURN_MS) break;
          const o = await attempt(item);
          outcomes.set(item.k, o);
          if (o.how === "retry" && !o.answered) break; // a host that does not answer gets no more this turn
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DELIVERY_LANES, hosts.length) }, () => lane()));
    const waiting = due.length - outcomes.size;
    if (!outcomes.size) return { sent: 0, left: body.queue.length, waiting };
    const tally = { delivered: 0, retried: 0, dropped: 0, removedOn410: 0 };
    const r = await doc.update((b) => {
      const cur = bodyOf(b);
      tally.delivered = tally.retried = tally.dropped = tally.removedOn410 = 0;
      const keep = [];
      for (const q of cur.queue) {
        const o = outcomes.get(q.k);
        if (!o) { keep.push(q); continue; }
        const sub = cur.subs[q.sub];
        if (o.how === "done") {
          if (!o.silent) tally.delivered++;
          if (sub) { delete sub.miss; delete sub.fails; }
          // A set that joined while this one was on its way is still to be announced.
          const later = Array.isArray(q.sets) ? q.sets.slice(o.sets) : [];
          if (later.length) keep.push({ k: q.k, sub: q.sub, at: q.at, sets: later, tries: 0, next: Number(q.next) || now() });
          continue;
        }
        if (o.how === "gone") { if (sub) { delete cur.subs[q.sub]; tally.removedOn410++; } continue; }
        const tries = (Number(q.tries) || 0) + 1;
        if (sub) sub.miss = (Number(sub.miss) || 0) + 1; // attempts in a row with no 2xx: it stands behind what has not failed
        if (tries > RETRY_DELAYS_MS.length) { tally.dropped++; if (sub) sub.fails = (Number(sub.fails) || 0) + 1; continue; }
        tally.retried++;
        keep.push({ ...q, tries, next: now() + RETRY_DELAYS_MS[tries - 1] });
      }
      cur.queue = keep.filter((q) => cur.subs[q.sub]);
      tidySets(cur);
      return cur;
    }, { fallback: emptyBody() });
    if (!r?.ok) return { skipped: "unsaved" };
    for (const k of Object.keys(tally)) counts[k] += tally[k];
    return { sent: [...outcomes.values()].filter((o) => !o.silent).length, ...tally, left: bodyOf(r.body).queue.length, waiting };
  }

  /** Counts only, for the operator view. */
  async function status() {
    const read = await doc.read({ quiet: true });
    const body = bodyOf(read?.ok ? read.body : null);
    const subs = Object.values(body.subs);
    return {
      configured: Boolean(signingKeyOf(env)), deliveries: deliveriesOn() ? "on" : "off",
      subscriptions: subs.length, pending: subs.filter((s) => s.pending).length, failing: subs.filter((s) => Number(s.fails) >= 1).length,
      bound: maxSubscriptions(env), hardBound: hardMaxSubscriptions(env),
      queued: body.queue.length, changeSets: Object.keys(body.sets).length, pricesKept: body.prices ? Object.keys(body.prices).length : 0,
      sinceBoot: { ...counts },
    };
  }

  return { register, registerPending, unsubscribe, notePrices, deliverDue, status, buildDelivery };
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
 * send one delivery twice; without a state database the lease is a plain
 * call, and the turn's own guard (deliverDue) keeps it from running beside
 * itself.
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

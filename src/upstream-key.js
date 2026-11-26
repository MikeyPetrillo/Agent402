// Bring your own key: a buyer that holds its own key for a tool's upstream
// sends it in the X-Agent402-Upstream-Key request header, the call runs with
// that key, and the call is priced at the own-key price instead of the list price.
//
// THE SWITCH. Off unless UPSTREAM_KEY=on (read from the environment at each
// use). While off the header is still removed from every request as it
// arrives, without its value being read, and nothing else in this module
// acts: no route takes a key, no quote, 402, settlement or booking differs
// for any request, with the header or without, and no surface mentions it
// (the tool description, /llms.txt, /llms-full.txt, the OpenAPI parameter,
// the /privacy item, the /terms item, the changelog entry).
//
// WHICH TOOLS. Only the tools in UPSTREAM_KEY_TOOLS, each naming a provider in PROVIDERS.
// A tool named for the referral routes (REFERRAL_SLUGS, read as written)
// is left out: a referral copy is sold at the public route's price, so the
// public route never undercuts it. The referral gate holds the same rule from
// its side: a tool listed here is refused under /ref at boot, with the reason
// (referralCheaperDirect, server.js), so naming one there sells it on neither. A tool priced per request (a quote or a
// tier quote) or metered is never listed here. Every other route ignores the
// header: it is removed from the request at intake and never read, used or
// forwarded.
//
// THE PRICE is the own-key price: the lowest flat price in the served catalog
// (the cheapest per-call tier), never above the tool's own list price. It is
// derived from the catalog at first use, never typed.
//
// DECIDED PER REQUEST, AND AGAIN AT SETTLEMENT. The header is taken off the
// request as it arrives (upstreamKeyIntake: removed from req.headers and
// req.rawHeaders, so no logger, recorder, analytics event or store downstream
// can read it) and held in a WeakMap keyed by the request object, so it lives
// exactly as long as the request. The gate (upstreamKeyGate, mounted before
// the paywall) decides once per request: a well-formed key for a listed tool
// on a request with no Tempo, card or credits credential is APPLIED, and only
// then do three readers see it: the x402 price function (the own-key price on
// every accept of that request), the books (settledPriceUsd) and the tool's
// handler (upstreamKeyFor). The x402 paywall resolves the price again from
// the paid request itself, so a payment signed at the own-key price on a
// request without the header is answered 402 at the list price before any
// facilitator is asked: a cheap quote never pays for a full-price call.
//
// RAILS. x402 (every accept, the MPP evm translation included, since it
// settles through the x402 paywall) prices per request and settles only a
// final answer under 400, so a refused key is never charged. Tempo, card and
// credits credentials are refused with 400 (`upstream_key_rail_unsupported`)
// before any handler runs, and the 402 of an applied request offers no Tempo
// or card challenge.
//
// THE KEY GOES ONE PLACE. The handler sends it only to its provider's hosts
// (PROVIDERS[...].hosts), never ours in its place: there is no fallback to the
// server's own key, so a refused key answers 401 or 403 with
// `reason: "upstream_key_refused"` and `charged: false`. Calls made with it run
// inside runWithUpstreamKey, which the egress meter reads (upstreamKeyCallTo)
// so the call is not counted against our own daily ceilings or budgets for
// that host: it is the buyer's call on the buyer's key. Per-address and
// per-wallet rate limits still apply.
//
// THE COOL-DOWN. A refused key is uncharged, and each one is a failed sign-in
// to the provider from this server's address. After
// UPSTREAM_KEY_REFUSED_MAX refused keys inside UPSTREAM_KEY_COOLDOWN_MS from
// one verified payer, or from one client address, a request that carries the
// header on a route that takes it is answered 429 `upstream_key_cooldown`
// with Retry-After, before the paywall and without a call to the provider.
// The same call without the header is sold at the list price as always:
// nobody is refused a purchase. A served call does not shorten the count
// (only time does), and the record is a bounded in-memory map, per process.
//
// COUNTS. upstreamKeyStatus() is the operator's view
// (/__operator/upstream-key.json): outcomes per tool since boot. No key, no
// payer and no address is in it.
import { AsyncLocalStorage } from "node:async_hooks";
import { verifiedPayerOf } from "./verified-payment.js";
import { parseSwitch } from "./feature-flags.js";
import { limiterKey } from "./rate-limit.js";

/** Is bring-your-own-key on for this server? Off unless UPSTREAM_KEY=on. */
export const upstreamKeyEnabled = (env = process.env) => parseSwitch(env?.UPSTREAM_KEY) === true;
/** The date of the /terms and /privacy text shown while the switch is on. */
export const UPSTREAM_KEY_TERMS_DATE = "2026-11-26";
const LEGAL_DATE_LINE = /last updated (\d{4}-\d{2}-\d{2})\./;
/** A rendered legal page: while the switch is on, its "last updated" date is the later of its own and UPSTREAM_KEY_TERMS_DATE (never a date after today). */
export function withUpstreamKeyDate(html, { env = process.env, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!upstreamKeyEnabled(env)) return String(html);
  return String(html).replace(LEGAL_DATE_LINE, (m, own) => `last updated ${UPSTREAM_KEY_TERMS_DATE > own && UPSTREAM_KEY_TERMS_DATE <= today ? UPSTREAM_KEY_TERMS_DATE : own}.`);
}
export const UPSTREAM_KEY_HEADER = "X-Agent402-Upstream-Key";
const HEADER = UPSTREAM_KEY_HEADER.toLowerCase();
/** The longest header value read; a longer one is answered 400 before any work. */
export const UPSTREAM_KEY_MAX_CHARS = 256;
export const UPSTREAM_KEY_REFUSED = "upstream_key_refused";

/** The providers a listed tool can name: hosts, key shape, advice. */
export const PROVIDERS = Object.freeze({
  github: Object.freeze({
    name: "GitHub",
    keyWord: "GitHub token",
    hosts: Object.freeze(["api.github.com"]),
    // The narrowest key that works, in the copy's own words.
    advice: "a fine-grained token with no permissions (a public repository read needs none) and a short expiry",
    // A personal access token (classic or fine-grained), an OAuth, user,
    // server or refresh token: the formats GitHub documents.
    shape: /^(?:gh[pousr]_[A-Za-z0-9]{20,251}|github_pat_[A-Za-z0-9_]{20,245})$/,
  }),
});
/** Tool slug -> provider id. */
export const UPSTREAM_KEY_TOOLS = Object.freeze({ "github-repo": "github" });

const referralSlugs = (env = process.env) => new Set(String(env.REFERRAL_SLUGS ?? "").split(",").map((s) => s.trim()).filter(Boolean));

/** The provider a catalog route takes a buyer's key for, or null. */
export function upstreamKeyProviderOf(def, env = process.env) {
  if (!upstreamKeyEnabled(env)) return null;
  const slug = def?.slug;
  if (typeof slug !== "string" || !Object.hasOwn(UPSTREAM_KEY_TOOLS, slug)) return null;
  if (typeof def.quote === "function" || typeof def.tierQuote === "function" || def.metered || def.modelBacked === true) return null;
  if (referralSlugs(env).has(slug)) return null;
  return PROVIDERS[UPSTREAM_KEY_TOOLS[slug]] || null;
}
/** Is this route one that takes a buyer's key wherever the referral routes do
 *  not name it? Read by the referral gate's price-parity boot check: such a
 *  route is never sold under /ref. */
export const upstreamKeyListed = (def, env = process.env) => upstreamKeyEnabled(env) && upstreamKeyProviderOf(def, { UPSTREAM_KEY: "on" }) !== null;
/** Does this route take a buyer's key? */
export const upstreamKeyOffered = (def, env = process.env) => upstreamKeyProviderOf(def, env) !== null;

// ---- the price ----
const microOf = (price) => {
  const m = /^\$(\d+(?:\.\d+)?)$/.exec(String(price ?? ""));
  if (!m) return null;
  const micro = Math.round(Number(m[1]) * 1e6);
  return micro > 0 ? micro : null;
};
const priceText = (micro) => "$" + (micro / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
let catalogOf = () => null;
let feeMicro = null;
// The payer a request's payment header names, unverified, on any x402 rail
// (an address, or a promise of one). The gate reads it to hold a payer in its
// cool-down, and a refusal is recorded under it as well as under the verified
// payer, so both sides of the cool-down read one key on every rail.
let namedPayerOf = null;
/** Hand in the served catalog (a getter: the fee is read from it at first use) and, optionally, the reader of the payer a payment header names. */
export function configureUpstreamKeys({ catalog = null, claimedPayerOf = undefined } = {}) {
  catalogOf = typeof catalog === "function" ? catalog : () => catalog;
  feeMicro = null;
  if (claimedPayerOf !== undefined) namedPayerOf = typeof claimedPayerOf === "function" ? claimedPayerOf : null;
}
/** The own-key price in micro-dollars: the lowest flat price in the catalog. */
function ownKeyPriceMicro() {
  if (feeMicro !== null) return feeMicro;
  let low = null;
  for (const def of Object.values(catalogOf() || {})) {
    if (!def || typeof def.quote === "function" || typeof def.tierQuote === "function" || def.metered) continue;
    const m = microOf(def.price);
    if (m !== null && (low === null || m < low)) low = m;
  }
  if (low !== null) feeMicro = low;
  return low;
}
/** The price a route quotes with a buyer's key: the own-key price, never above list; null when it cannot be read. */
export function upstreamKeyPriceOf(def) {
  const list = microOf(def?.price);
  const fee = ownKeyPriceMicro();
  if (list === null || fee === null) return null;
  return priceText(Math.min(fee, list));
}

// ---- intake: the header leaves the request before anything else reads it ----
const held = new WeakMap(); // request -> { key } | { refused }
/** Take the header off one request (req.headers and req.rawHeaders). */
export function takeUpstreamKey(req) {
  if (!req || typeof req !== "object" || !req.headers) return;
  const raw = req.headers[HEADER];
  if (Array.isArray(req.rawHeaders)) {
    for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
      if (String(req.rawHeaders[i]).toLowerCase() === HEADER) req.rawHeaders.splice(i, 2);
    }
  }
  if (raw === undefined) return;
  delete req.headers[HEADER];
  // Off: removed unread, and nothing is kept for any later reader.
  if (!upstreamKeyEnabled()) { counters.removedWhileOff++; return; }
  const value = Array.isArray(raw) ? raw.join(",") : String(raw);
  if (value.length > UPSTREAM_KEY_MAX_CHARS) held.set(req, { refused: "upstream_key_too_long" });
  else held.set(req, { key: value.trim() });
}
/** Middleware: mounted first, so every later reader sees a request without the header. */
export function upstreamKeyIntake() {
  return function upstreamKeyIntakeMw(req, _res, next) { takeUpstreamKey(req); next(); };
}
/** The shape check a header reader runs (bounded: a value past the cap is not tested). */
export function upstreamKeyShapeOk(provider, value) {
  return typeof value === "string" && value.length > 0 && value.length <= UPSTREAM_KEY_MAX_CHARS && !!provider?.shape?.test(value);
}

const refusalBody = (reason, error, extra = {}) => ({ error, reason, header: UPSTREAM_KEY_HEADER, charged: false, ...extra, errorCode: "invalid_input" });
// An answer about one request's own credential: never kept by a cache.
const refusal = (res, reason, error, extra = {}) => {
  try { res.setHeader?.("Cache-Control", "no-store"); } catch { /* the answer still goes out */ }
  return res.status(400).json(refusalBody(reason, error, extra));
};
/** Middleware: a header over the bound is answered 400 here, before any work (mount after the security headers). */
export function upstreamKeyBound() {
  return function upstreamKeyBoundMw(req, res, next) {
    if (held.get(req)?.refused !== "upstream_key_too_long") return next();
    held.delete(req);
    count("tooLong");
    return refusal(res, "upstream_key_too_long", `${UPSTREAM_KEY_HEADER} is longer than ${UPSTREAM_KEY_MAX_CHARS} characters. Nothing ran.`, { maxChars: UPSTREAM_KEY_MAX_CHARS });
  };
}

// ---- the transport: a key that crossed the network unencrypted is not used ----
// What is read, in order, and why each reader can be believed:
//   1. An `http` claim in X-Forwarded-Proto (any entry), Forwarded (`proto=`)
//      or the CDN's CF-Visitor is believed from ANY peer: it can only refuse.
//      A proxy that appends its own entry leaves a client-written `https`
//      beside its `http`, and the `http` wins.
//   2. A TLS socket to this process is https.
//   3. A plain socket from a peer that is a trusted proxy (TRUST_PROXY_HOPS of
//      1 or more, or a request the CDN resolver proved, req.viaCdn) with no
//      `http` claim is not known to be http: served.
//   4. A plain socket from any other address IS http, whatever the request's
//      own headers say: with no trusted proxy, an `https` claim is the
//      client's own word and is never read.
// Loopback is exempt (local development, tests, this server's own replays): a
// request on a loopback socket is refused only when its forwarding headers
// both name a client that is not loopback and carry an `http` claim, which is
// a proxy on this host reporting a remote plain-HTTP client.
export const UPSTREAM_KEY_IN_CLEAR = "upstream_key_sent_in_clear";
const SCHEME_HEADER_MAX = 512; // a longer forwarding header is read to here only
const isLoopback = (ip) => {
  const a = String(ip || "").toLowerCase().replace(/^::ffff:/, "");
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
};
const headerText = (req, name) => {
  const v = req.headers?.[name];
  return (Array.isArray(v) ? v.join(",") : String(v ?? "")).slice(0, SCHEME_HEADER_MAX).toLowerCase();
};
function claimsHttp(req) {
  if (headerText(req, "x-forwarded-proto").split(",").some((p) => p.trim() === "http")) return true;
  if (headerText(req, "forwarded").split(/[;,]/).some((p) => /^proto="?http"?$/.test(p.trim()))) return true;
  const visitor = headerText(req, "cf-visitor");
  return visitor.includes('"scheme":"http"') || visitor.includes('"scheme": "http"');
}
const namesRemoteClient = (req) => !isLoopback(req.ip) || headerText(req, "x-forwarded-for").split(",").some((p) => p.trim() !== "" && !isLoopback(p.trim()));
/**
 * Did this request reach the server over plain HTTP, as far as it can be
 * known? `hops` is the server's trusted proxy count (TRUST_PROXY_HOPS).
 */
export function arrivedInClear(req, { hops = 0 } = {}) {
  const http = claimsHttp(req);
  if (isLoopback(req.socket?.remoteAddress)) return http && namesRemoteClient(req);
  if (http) return true;
  if (req.socket?.encrypted === true) return false;
  return !(hops >= 1 || req.viaCdn === true);
}
/**
 * Middleware: a request that carried the header over plain HTTP is answered
 * 400 here, before any payment work, on every route (the key is exposed
 * whatever the route does with it). Mount after the client address is
 * resolved and after the security headers.
 */
export function upstreamKeyTransport({ hops = 0 } = {}) {
  return function upstreamKeyTransportMw(req, res, next) {
    if (!held.has(req)) return next();
    let clear = true;
    try { clear = arrivedInClear(req, { hops }); } catch { clear = true; }
    if (!clear) return next();
    held.delete(req);
    count("inClear");
    return refusal(res, UPSTREAM_KEY_IN_CLEAR, `${UPSTREAM_KEY_HEADER} reached this server over plain HTTP, so the key crossed the network unencrypted. It was not used and nothing ran. Revoke that key, and send a new one over HTTPS only.`, { revokeKey: true });
  };
}

// ---- the decision, once per request ----
const decided = new WeakMap(); // request -> { slug, provider, key, price }
// Each gate's marks, the ones it sets BEFORE the handler included (an accepted
// credential, a settlement in progress): the post-settle marks alone are not
// yet set when this gate runs. `mppCredential` (the MPP evm translation) is
// not one: it settles through the x402 paywall.
const OTHER_RAIL_MARKS = Object.freeze(["mppTempoCredential", "tempoSettling", "tempoSettled", "mppStripeCredential", "stripeSettling", "stripeSettled", "creditsSettling", "creditsSettled"]);
const otherRail = (req) => OTHER_RAIL_MARKS.some((m) => req[m] === true);
// Outcomes since boot: the totals, and the same per tool where a tool is
// known. `applied` is a keyed request that went on to the paywall (an unpaid
// quote included); `refusedByUpstream` a paid one whose key the provider refused.
const OUTCOMES = Object.freeze(["removedWhileOff", "applied", "ignored", "malformed", "otherRail", "inClear", "tooLong", "refusedByUpstream", "cooldown"]);
const zero = () => Object.fromEntries(OUTCOMES.map((k) => [k, 0]));
const counters = zero();
const bySlug = new Map();
function count(outcome, slug = null) {
  counters[outcome]++;
  if (typeof slug !== "string" || !Object.hasOwn(UPSTREAM_KEY_TOOLS, slug)) return;
  if (!bySlug.has(slug)) bySlug.set(slug, zero());
  bySlug.get(slug)[outcome]++;
}

// ---- the cool-down after refused keys ----
/** Refused keys from one payer or one address, inside the window, before the cool-down. */
export const UPSTREAM_KEY_REFUSED_MAX = 5;
export const UPSTREAM_KEY_COOLDOWN_MS = 15 * 60_000;
/** The most payers and addresses remembered at once. */
export const UPSTREAM_KEY_COOLDOWN_KEYS_MAX = 5000;
export const UPSTREAM_KEY_COOLDOWN = "upstream_key_cooldown";
let clock = () => Date.now();
/** Test seam: the cool-down's clock (null restores the wall clock). */
export function __setUpstreamKeyClockForTest(fn) { clock = typeof fn === "function" ? fn : () => Date.now(); }
/** Test seam: forget every refusal. */
export function __resetUpstreamKeyCooldownForTest() { refusals.clear(); }
const refusals = new Map(); // "payer:<address>" | "addr:<address>" -> [refusal times, oldest first]
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// An EVM payer in lower case; any other (base58, Stellar, Algorand) exactly as given.
const payerKey = (p) => (typeof p === "string" && p && p.length <= 128 ? `payer:${EVM_ADDRESS.test(p) ? p.toLowerCase() : p}` : null);
// One client network, as the rate limiters key it: an IPv6 address by its /64
// (src/rate-limit.js limiterKey), so addresses rotated inside one allocation
// share one count.
const addressKey = (ip) => (typeof ip === "string" && ip && ip.length <= 64 ? `addr:${limiterKey(ip)}` : null);
// The payer the payment header names, through the configured reader: a value,
// a promise of one, or null. A rail prefix (`svm:`, `avm:`, `stellar:`) is
// dropped so the key is the address itself, as the verified payer is.
const NAMED_PREFIX = /^(?:svm|avm|stellar):/;
const bareAddress = (p) => (typeof p === "string" && p ? p.replace(NAMED_PREFIX, "") : null);
function namedPayer(req, reader = namedPayerOf) {
  if (typeof reader !== "function") return null;
  let v = null;
  try { v = reader(req); } catch { return null; }
  return v && typeof v.then === "function" ? v.then(bareAddress, () => null) : bareAddress(v);
}
const live = (times, now) => times.filter((t) => now - t < UPSTREAM_KEY_COOLDOWN_MS);
function noteRefusal(key, now) {
  if (!key) return;
  const times = live(refusals.get(key) || [], now);
  times.push(now);
  // Re-inserted so the map's order is by last refusal: the oldest goes first.
  refusals.delete(key);
  if (refusals.size >= UPSTREAM_KEY_COOLDOWN_KEYS_MAX) {
    for (const [k, v] of refusals) if (!live(v, now).length) refusals.delete(k);
    while (refusals.size >= UPSTREAM_KEY_COOLDOWN_KEYS_MAX) refusals.delete(refusals.keys().next().value);
  }
  refusals.set(key, times.slice(-UPSTREAM_KEY_REFUSED_MAX));
}
/** Milliseconds this key's cool-down still runs, 0 when it is not in one. */
function cooldownLeft(key, now) {
  if (!key) return 0;
  const kept = refusals.get(key);
  if (!kept) return 0;
  const times = live(kept, now);
  if (!times.length) { refusals.delete(key); return 0; }
  if (times.length < UPSTREAM_KEY_REFUSED_MAX) return 0;
  return Math.max(0, times[times.length - UPSTREAM_KEY_REFUSED_MAX] + UPSTREAM_KEY_COOLDOWN_MS - now);
}
/** Record one key the provider refused, against the request's verified payer and its client address. */
export function noteUpstreamKeyRefused(req, slug = null) {
  count("refusedByUpstream", slug);
  const now = clock();
  let payer = null;
  try { payer = verifiedPayerOf(req); } catch { payer = null; }
  noteRefusal(payerKey(payer), now);
  noteRefusal(addressKey(req?.ip), now);
  // And under the payer the gate will read from the next request's header,
  // where that is another text than the verified one (or nothing verified).
  const also = (named) => { if (named && named !== payer && payerKey(named) !== payerKey(payer)) noteRefusal(payerKey(named), now); };
  const named = req ? namedPayer(req) : null;
  if (named && typeof named.then === "function") void named.then(also, () => {});
  else also(named);
}
/** Seconds until a keyed request from this payer or address is taken again; 0 when it is taken now. */
export function upstreamKeyCooldownSeconds(req, claimedPayer = null) {
  const now = clock();
  const left = Math.max(cooldownLeft(payerKey(claimedPayer), now), cooldownLeft(addressKey(req?.ip), now));
  return left > 0 ? Math.max(1, Math.ceil(left / 1000)) : 0;
}
const malformedText = (provider) => `${UPSTREAM_KEY_HEADER} on this route takes a ${provider.keyWord}, and the value sent is not one. Nothing ran.`;
const otherRailText = `${UPSTREAM_KEY_HEADER} is accepted with an x402 payment only. Pay this call over x402 with the header, or send it without the header to pay the list price on this rail.`;
const cooldownBody = (provider, slug, wait) => ({
  error: `Too many keys sent in ${UPSTREAM_KEY_HEADER} were refused by ${provider.name}, so the header is not taken again for ${wait} seconds. Nothing ran. This call without the header is sold at the list price now.`,
  reason: UPSTREAM_KEY_COOLDOWN, header: UPSTREAM_KEY_HEADER, tool: slug, charged: false, retryAfterSeconds: wait, errorCode: "rate_limited",
});
/**
 * For a gate of another rail that takes money BEFORE the handler (a Tempo
 * credential: its input check runs before anything is broadcast or claimed):
 * the refusal this request's key draws on that rail, or null when it carries
 * no key or the route takes none. `{ status, body, headers, retry }`, the
 * shape that gate's input check answers; the key is dropped with it. Called
 * by the gate once it has accepted the request as its own credential, so
 * the request is on that rail and never reaches the paywall.
 */
export function upstreamKeyOtherRailRefusal(req, def) {
  const h = req && typeof req === "object" ? held.get(req) : null;
  if (!h || typeof h.key !== "string") return null;
  const provider = upstreamKeyProviderOf(def);
  if (!provider) return null;
  held.delete(req);
  const retry = `without the ${UPSTREAM_KEY_HEADER} header`;
  const headers = { "Cache-Control": "no-store" };
  if (!upstreamKeyShapeOk(provider, h.key)) {
    count("malformed", def.slug);
    return { status: 400, body: refusalBody("upstream_key_malformed", malformedText(provider), { tool: def.slug }), headers, retry };
  }
  const wait = upstreamKeyCooldownSeconds(req, null);
  if (wait > 0) {
    count("cooldown", def.slug);
    return { status: 429, body: cooldownBody(provider, def.slug, wait), headers: { ...headers, "Retry-After": String(wait) }, retry };
  }
  count("otherRail", def.slug);
  return { status: 400, body: refusalBody("upstream_key_rail_unsupported", otherRailText, { tool: def.slug }), headers, retry };
}
/**
 * Middleware, mounted after the Tempo, card and credits gates and before the
 * paywall: decides the request. `defOf(req)` is the catalog route;
 * `claimedPayerOf(req)` the payer the payment header names on any x402 rail
 * (unverified, a value or a promise; default: the reader handed to
 * configureUpstreamKeys). `claimedOf(req)` says another rail has ALREADY
 * taken this request's payment (a claimed transfer): such a request is never
 * refused here, since a refusal would keep money for nothing; its key is
 * dropped and the call goes on at that rail's list price.
 */
export function upstreamKeyGate(defOf, { claimedPayerOf = undefined, claimedOf = null } = {}) {
  return function upstreamKeyGateMw(req, res, next) {
    const h = held.get(req);
    if (!h || typeof h.key !== "string") return next();
    held.delete(req);
    let def = null;
    try { def = defOf(req); } catch { def = null; }
    const provider = upstreamKeyProviderOf(def);
    // Not a route that takes a key: the header is ignored, and nothing keeps it.
    if (!provider) { count("ignored"); return next(); }
    let taken = false;
    try { taken = typeof claimedOf === "function" && claimedOf(req) === true; } catch { taken = false; }
    if (taken) { count("otherRail", def.slug); return next(); }
    if (!upstreamKeyShapeOk(provider, h.key)) {
      count("malformed", def.slug);
      return refusal(res, "upstream_key_malformed", malformedText(provider), { tool: def.slug });
    }
    const decide = (claimed) => {
      // In its cool-down after refused keys: answered here, before the paywall,
      // with no call to the provider. The call without the header is unaffected.
      const wait = upstreamKeyCooldownSeconds(req, claimed);
      if (wait > 0) {
        count("cooldown", def.slug);
        res.setHeader("Retry-After", String(wait));
        res.setHeader("Cache-Control", "no-store");
        return res.status(429).json(cooldownBody(provider, def.slug, wait));
      }
      if (otherRail(req)) {
        count("otherRail", def.slug);
        return refusal(res, "upstream_key_rail_unsupported", otherRailText, { tool: def.slug });
      }
      const price = upstreamKeyPriceOf(def);
      if (!price) { count("ignored"); return next(); }
      decided.set(req, { slug: def.slug, provider, key: h.key, price });
      count("applied", def.slug);
      return next();
    };
    const claimed = claimedPayerOf !== undefined ? namedPayer(req, claimedPayerOf) : namedPayer(req);
    if (claimed && typeof claimed.then === "function") return void claimed.then(decide, () => decide(null)).catch(next);
    return decide(claimed);
  };
}
/** The own-key price this request is priced at on this route, or null (list price). */
export function upstreamKeyQuoteOf(req, def) {
  const d = req && typeof req === "object" ? decided.get(req) : null;
  return d && def && d.slug === def.slug ? d.price : null;
}
/** The same in dollars, for the books; 0 when it does not apply. */
export function upstreamKeyPriceUsd(req, def) {
  const p = upstreamKeyQuoteOf(req, def);
  return p ? Number(p.slice(1)) : 0;
}
/** Is a buyer's key applied on this request for this route? */
export const upstreamKeyApplies = (req, def) => upstreamKeyQuoteOf(req, def) !== null;
/** The buyer's key for the tool `slug` on this request, or null. Read by that tool's handler only. */
export function upstreamKeyFor(req, slug) {
  const d = req && typeof req === "object" ? decided.get(req) : null;
  return d && d.slug === slug ? d.key : null;
}

// ---- the calls made with it ----
const scope = new AsyncLocalStorage();
/**
 * Run fn with the buyer's key in use for `slug`'s provider hosts (null: plain
 * run). `req` is the request the key came on: a key the provider refuses
 * (upstreamKeyRefusedError) is recorded against it for the cool-down.
 */
export function runWithUpstreamKey(slug, fn, req = null) {
  const provider = typeof slug === "string" && Object.hasOwn(UPSTREAM_KEY_TOOLS, slug) ? PROVIDERS[UPSTREAM_KEY_TOOLS[slug]] : null;
  if (!provider) return fn();
  const refused = (err) => { if (err?.upstreamKeyRefused === true) { try { noteUpstreamKeyRefused(req, slug); } catch { /* the answer is the error's */ } } throw err; };
  let out;
  try { out = scope.run({ hosts: new Set(provider.hosts) }, fn); } catch (err) { return refused(err); }
  return out && typeof out.then === "function" ? out.then((v) => v, refused) : out;
}
/** Is this outbound call (by host) made with a buyer's key? Read by the egress meter. */
export function upstreamKeyCallTo(host) {
  const s = scope.getStore();
  return !!s && typeof host === "string" && s.hosts.has(host.toLowerCase());
}
/** The error a refused buyer key answers: 401 or 403, uncharged, with its reason. */
export function upstreamKeyRefusedError(status, providerName) {
  const code = status === 403 ? 403 : 401;
  const err = new Error(`${providerName} refused the key sent in ${UPSTREAM_KEY_HEADER} (HTTP ${code}). Check the key, or send the call without the header to pay the list price.`);
  err.statusCode = code;
  err.upstreamKeyRefused = true;
  err.charged = false;
  return err;
}

// ---- copy, from the table above ----
const toolsOffered = (catalog) => Object.values(catalog || {}).filter((d) => upstreamKeyOffered(d)).sort((a, b) => a.slug.localeCompare(b.slug));
/** The tool description's sentence for a listed route ("" otherwise). */
export function upstreamKeySentence(slug) {
  const provider = upstreamKeyEnabled() && Object.hasOwn(UPSTREAM_KEY_TOOLS, slug) ? PROVIDERS[UPSTREAM_KEY_TOOLS[slug]] : null;
  if (!provider) return "";
  return `Bring your own ${provider.keyWord}: send it in ${UPSTREAM_KEY_HEADER} with an x402 payment and the call runs with it at the own-key price. Use ${provider.advice}, over HTTPS only.`;
}
/** The /llms.txt line, short (the index has a byte bound), or "": the rule in full is upstreamKeyLine on /llms-full.txt. */
export function upstreamKeyBrief(catalog) {
  const tools = toolsOffered(catalog);
  if (!tools.length) return "";
  return `**Bring your own key:** ${tools.map((d) => `\`${d.slug}\``).join(", ")} takes yours in \`${UPSTREAM_KEY_HEADER}\` (x402).`;
}
const adviceOf = (tools) => { const a = [...new Set(tools.map((d) => PROVIDERS[UPSTREAM_KEY_TOOLS[d.slug]]).filter((p) => p?.advice).map((p) => `for ${p.name}, ${p.advice}`))]; return a.length ? `: ${a.join("; ")}` : ""; };
/** The /llms-full.txt paragraph (leading space), or "" when no served route takes a key. */
export function upstreamKeyLine(catalog) {
  const tools = toolsOffered(catalog);
  if (!tools.length) return "";
  const list = tools.map((d) => `\`${d.slug}\` (${PROVIDERS[UPSTREAM_KEY_TOOLS[d.slug]].keyWord}; ${upstreamKeyPriceOf(d) || d.price} instead of ${d.price})`).join(", ");
  return ` **Bring your own key.** On ${list}, send your own key in the \`${UPSTREAM_KEY_HEADER}\` request header (at most ${UPSTREAM_KEY_MAX_CHARS} characters) with an x402 payment: the 402 quotes the own-key price, the call runs with your key, and it is sent only to that tool's own upstream, used for that one call and never stored or logged. A key the upstream refuses is answered 401 or 403 with \`reason\` \`${UPSTREAM_KEY_REFUSED}\` and \`charged: false\`, and never retried with ours; after ${UPSTREAM_KEY_REFUSED_MAX} refused keys in ${UPSTREAM_KEY_COOLDOWN_MS / 60_000} minutes from one payer or one address, the header is answered 429 with \`reason\` \`${UPSTREAM_KEY_COOLDOWN}\` and Retry-After (the same call without the header is still sold at the list price). Send it over HTTPS only: a key that reaches this server over plain HTTP (loopback, as in local development, is exempt) is answered 400 with \`reason\` \`${UPSTREAM_KEY_IN_CLEAR}\` and \`charged: false\`, is not used, and should be revoked. Use the narrowest key that works${adviceOf(tools)}. Tempo, card and credits payments with the header are answered 400; every other route ignores it.`;
}
/** The OpenAPI header parameter of a listed route, or []. */
export function upstreamKeyHeaderParams(def) {
  const provider = upstreamKeyProviderOf(def);
  if (!provider) return [];
  return [{
    name: UPSTREAM_KEY_HEADER,
    in: "header",
    required: false,
    description: `Your own ${provider.keyWord}. With an x402 payment the call runs with it at the own-key price (${upstreamKeyPriceOf(def) || def.price} instead of ${def.price}); it is sent only to ${provider.hosts.join(", ")}, used for this one call and never stored. A refused key answers 401 or 403 with reason ${UPSTREAM_KEY_REFUSED} and charged false; after ${UPSTREAM_KEY_REFUSED_MAX} refused keys in ${UPSTREAM_KEY_COOLDOWN_MS / 60_000} minutes from one payer or one address the header answers 429 with reason ${UPSTREAM_KEY_COOLDOWN} and Retry-After. Use ${provider.advice}, and send it over HTTPS only: one that arrives over plain HTTP (loopback exempt) answers 400 with reason ${UPSTREAM_KEY_IN_CLEAR} and charged false, and should be revoked.`,
    schema: { type: "string", maxLength: UPSTREAM_KEY_MAX_CHARS },
  }];
}
/** The /privacy item ("" when no route takes a key). */
export function upstreamKeyPrivacyItem(catalog = catalogOf()) {
  const tools = toolsOffered(catalog);
  if (!tools.length) return "";
  const named = tools.map((d) => `${PROVIDERS[UPSTREAM_KEY_TOOLS[d.slug]].name}, for <code>${d.slug}</code>`).join("; ");
  return `  <li><b>Your own upstream key.</b> A key you send in the <code>${UPSTREAM_KEY_HEADER}</code> header is
  removed from the request as it arrives, used only for that one call to that tool's own provider (${named}), and then
  dropped with the request: it is never logged, stored, cached or sent to analytics. A key that arrives over plain
  HTTP is not used, and the answer says to revoke it.</li>
`;
}

/** The /terms acceptable-use item ("" while the switch is off). */
export function upstreamKeyTermsItem(env = process.env) {
  if (!upstreamKeyEnabled(env)) return "";
  return `  <li><b>Your own keys for other services:</b> If you send your own key for another service with a call, you confirm that the key is yours to use, that the other service's terms allow this use, and that you are responsible for the key and for the calls made with it. A key you send is one of the inputs you send; <a href="/privacy">/privacy</a> says what we do with it.</li>
`;
}

/** Operator figures: this process's outcomes since boot, in all and per tool. No key, payer or address. */
export function upstreamKeyStatus() {
  const now = clock();
  let coolingDown = 0;
  for (const [k] of refusals) if (cooldownLeft(k, now) > 0) coolingDown++;
  return {
    enabled: upstreamKeyEnabled(),
    tools: Object.keys(UPSTREAM_KEY_TOOLS),
    scope: "this process, since boot",
    counts: { ...counters },
    byTool: Object.fromEntries([...bySlug].map(([slug, c]) => [slug, { ...c }])),
    cooldown: { refusedMax: UPSTREAM_KEY_REFUSED_MAX, windowSeconds: UPSTREAM_KEY_COOLDOWN_MS / 1000, tracked: refusals.size, trackedMax: UPSTREAM_KEY_COOLDOWN_KEYS_MAX, coolingDown },
  };
}

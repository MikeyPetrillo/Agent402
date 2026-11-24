// The AWS Marketplace front door: /aws/<slug>.
//
// Agents that pay through Amazon Bedrock AgentCore payments with the AWS
// Billing connector buy a curated set of tools here and pay in US dollars on
// their AWS bill. Each route's 402 carries ONE offer: x402 `exact` on the
// network `aws:base`, priced in `iso4217:USD`, with a quote this server signs
// (the AWS Marketplace seller SDK, `@aws/fiat-extension-for-x402`). No
// stablecoin offer, no MPP offer, no proof-of-work: this prefix sells through
// AWS Marketplace only, and nothing it answers points a buyer at the other
// surfaces of this server.
//
// The gate is standalone, like the referral copies (src/referral-gate.js): it
// is not a catalog route, adds nothing to the catalog or the rails, and runs
// its own x402 resource server, so every 402 the direct routes answer (and
// every Bazaar listing) stays byte-for-byte what it was. It calls the tool's
// own handler.
//
// OFF unless every required setting is present and usable (awsMarketplaceConfig):
// the quote-signing key (its presence is the switch), its key id and the
// AWS Marketplace product id. With the switch off nothing is built or
// mounted and /aws answers as any unknown path; the SDK is imported only when
// the gate is built, so it is not in the boot graph.
//
// MONEY RULES. This rail differs from every other one here: AWS Marketplace
// captures the payment when it issues the buyer's payment token, BEFORE the
// request reaches this server, and there is no seller refund call. So:
//   - An input this server can refuse before the run is refused BEFORE the
//     402 when the unpaid request carries it (nothing to pay), and refused
//     WITHOUT USING the payment when a paid request carries it: the same
//     payment can be sent again with a corrected input while it is valid.
//   - One payment buys one answer. The verified `payment_id` (never the
//     buyer-set payload field) is claimed in a store every instance shares
//     (Redis SET NX; this process's memory when Redis does not answer, the
//     same fail-open choice src/mppx-store.js makes: the buyer has already
//     paid, so refusing would charge without serving). A second use is 409.
//   - A run that does not end in a delivered 200 (a handler error, a timeout,
//     a buyer gone before the answer) gives the payment back for another
//     attempt, up to AWS_MARKETPLACE_RETRY_MAX more, inside its validity.
//     Every such attempt is recorded for the operator in a store a deploy
//     keeps (src/aws-unanswered.js), with whether the payment can still be
//     retried; a served resend marks it answered, and one never answered
//     reads owed on refundsOwed (a billing adjustment is the owner's,
//     through AWS Marketplace).
//   - The sale is booked once, on the final response (`finish`, status 200),
//     on the private rail "aws" (src/paid-rails.js): no public reader returns
//     it and no public figure counts it. Its transaction is the payment id.
//
// The quote's `iss` is BASE_URL + "/aws", the endpoint URL registered for the
// listing; the bare endpoint (/aws) answers the 402 of the first listed tool,
// since AWS Marketplace asks the registered URL itself to answer 402 unpaid.
// The public key is served at /aws/.well-known/jwks.json, the JWKS URL
// registered for the listing.
import { binaryTypesOf } from "./tool-media-type.js";
import { namesOwnHost } from "./referral-gate.js";
import { withoutChargeSentences } from "./not-charged.js";
import { resaleBarredReason, resaleClearanceRefusal, refAnswerOf } from "./resale-terms.js";
import { createHash } from "node:crypto";
import { AWS_LISTING_SLUGS } from "./aws-listing.js";
import { createAwsUnansweredBook, awsUnansweredWord } from "./aws-unanswered.js";

export const AWS_NETWORK = "aws:base";
export const AWS_RAIL = "aws";
export const AWS_WIRE = "aws";
export const AWS_PREFIX = "/aws";
export const AWS_JWKS_PATH = "/aws/.well-known/jwks.json";
/** The listing's tools (src/aws-listing.js, grouped there with the notice each
 *  is sold under): fixed-price tools that compute their answer from the
 *  caller's own input or public data. Each still meets the boot checks. */
export const AWS_DEFAULT_SLUGS = AWS_LISTING_SLUGS;
export const AWS_DEFAULTS = Object.freeze({ quoteSeconds: 300, retryMax: 2, quotesPerMin: 60, paidPerMin: 120 });
/** The settings without which the gate stays off. */
export const AWS_REQUIRED_VARS = Object.freeze(["AWS_MARKETPLACE_QUOTE_KEY", "AWS_MARKETPLACE_QUOTE_KEY_ID", "AWS_MARKETPLACE_PRODUCT_ID"]);
/** A DPoP proof id is kept this long (the SDK's floor(60 + 5) + 6 for a store that records in `has`). */
export const AWS_DPOP_KEEP_SECONDS = 71;
/** The longest a payment claim is kept when its token's expiry cannot be read. */
const CLAIM_FALLBACK_MS = 30 * 60_000;
const CLAIM_SKEW_MS = 60_000;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PRODUCT_ID = /^prod-[A-Za-z0-9]{6,40}$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,64}$/;

function intKnob(raw, dflt, min, max) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return dflt;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** The PEM of the quote-signing key: the PEM itself, or base64 of it on one line. */
export function quoteKeyPem(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (text.includes("-----BEGIN")) return text.replace(/\\n/g, "\n");
  try {
    const decoded = Buffer.from(text, "base64").toString("utf8").trim();
    return decoded.includes("-----BEGIN") ? decoded : null;
  } catch { return null; }
}

/** Where the payment service's keys are read: AWS's own host by default. An
 *  override is taken only on an AWS host over https, or on this machine's
 *  loopback (a local test of the verification). */
export function paymentJwksBase(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  let u;
  try { u = new URL(text); } catch { return undefined; }
  if (u.username || u.password || u.search || u.hash) return undefined;
  const host = u.hostname.toLowerCase();
  if (u.protocol === "https:" && (host.endsWith(".api.aws") || host.endsWith(".amazonaws.com"))) return u.href.replace(/\/+$/, "");
  if (u.protocol === "http:" && (host === "127.0.0.1" || host === "localhost")) return u.href.replace(/\/+$/, "");
  return undefined;
}

/** Why the gate is off, in one line (names only, never a value), or null when it is on. */
export function awsMarketplaceConfigProblem(env = process.env) {
  if (!String(env.AWS_MARKETPLACE_QUOTE_KEY || "").trim()) return null; // switched off: nothing to say
  const missing = AWS_REQUIRED_VARS.filter((k) => !String(env[k] || "").trim());
  if (missing.length) return `missing ${missing.join(", ")}`;
  if (!quoteKeyPem(env.AWS_MARKETPLACE_QUOTE_KEY)) return "AWS_MARKETPLACE_QUOTE_KEY is not a PEM private key (or base64 of one)";
  if (!KEY_ID.test(String(env.AWS_MARKETPLACE_QUOTE_KEY_ID).trim())) return "AWS_MARKETPLACE_QUOTE_KEY_ID is not a usable key id";
  if (!PRODUCT_ID.test(String(env.AWS_MARKETPLACE_PRODUCT_ID).trim())) return "AWS_MARKETPLACE_PRODUCT_ID is not an AWS Marketplace product id (prod-...)";
  const slugs = String(env.AWS_MARKETPLACE_SLUGS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (slugs.some((s) => !SLUG.test(s))) return "AWS_MARKETPLACE_SLUGS names a value that is not a slug";
  if (intKnob(env.AWS_MARKETPLACE_QUOTE_SECONDS, 300, 30, 3600) === null) return "AWS_MARKETPLACE_QUOTE_SECONDS is not a whole number of seconds from 30 to 3600";
  if (intKnob(env.AWS_MARKETPLACE_RETRY_MAX, 2, 0, 5) === null) return "AWS_MARKETPLACE_RETRY_MAX is not a whole number from 0 to 5";
  if (intKnob(env.AWS_MARKETPLACE_QUOTES_PER_MIN, AWS_DEFAULTS.quotesPerMin, 1, 100_000) === null) return "AWS_MARKETPLACE_QUOTES_PER_MIN is not a whole number from 1 to 100000";
  if (intKnob(env.AWS_MARKETPLACE_PAID_PER_MIN, AWS_DEFAULTS.paidPerMin, 1, 100_000) === null) return "AWS_MARKETPLACE_PAID_PER_MIN is not a whole number from 1 to 100000";
  if (paymentJwksBase(env.AWS_MARKETPLACE_PAYMENT_JWKS_URL) === undefined) return "AWS_MARKETPLACE_PAYMENT_JWKS_URL is not an https AWS host (or loopback)";
  if (String(env.AWS_MARKETPLACE_JWKS_EXTRA || "").trim()) {
    try { JSON.parse(env.AWS_MARKETPLACE_JWKS_EXTRA); } catch { return "AWS_MARKETPLACE_JWKS_EXTRA is not JSON"; }
  }
  return null;
}

/** True when this boot sells through the AWS Marketplace front door: paid
 *  mode with every required setting present and usable. */
export function awsMarketplaceOffered(env = process.env) {
  try { return env.FREE_MODE !== "true" && awsMarketplaceConfig(env, { baseUrl: "https://example.invalid" }) !== null; } catch { return false; }
}

/** The gate's settings, or null when it is off (switched off, or a setting unusable). */
export function awsMarketplaceConfig(env = process.env, { baseUrl = "" } = {}) {
  if (!String(env.AWS_MARKETPLACE_QUOTE_KEY || "").trim()) return null;
  if (awsMarketplaceConfigProblem(env)) return null;
  let origin;
  try { origin = new URL(String(baseUrl)).origin; } catch { return null; }
  const listed = String(env.AWS_MARKETPLACE_SLUGS || "").split(",").map((s) => s.trim()).filter(Boolean);
  let extra = [];
  if (String(env.AWS_MARKETPLACE_JWKS_EXTRA || "").trim()) {
    const parsed = JSON.parse(env.AWS_MARKETPLACE_JWKS_EXTRA);
    extra = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.keys) ? parsed.keys : [parsed];
  }
  return Object.freeze({
    pem: quoteKeyPem(env.AWS_MARKETPLACE_QUOTE_KEY),
    kid: String(env.AWS_MARKETPLACE_QUOTE_KEY_ID).trim(),
    productId: String(env.AWS_MARKETPLACE_PRODUCT_ID).trim(),
    slugs: Object.freeze([...new Set(listed.length ? listed : AWS_DEFAULT_SLUGS)]),
    quoteSeconds: intKnob(env.AWS_MARKETPLACE_QUOTE_SECONDS, 300, 30, 3600),
    retryMax: intKnob(env.AWS_MARKETPLACE_RETRY_MAX, 2, 0, 5),
    quotesPerMin: intKnob(env.AWS_MARKETPLACE_QUOTES_PER_MIN, AWS_DEFAULTS.quotesPerMin, 1, 100_000),
    paidPerMin: intKnob(env.AWS_MARKETPLACE_PAID_PER_MIN, AWS_DEFAULTS.paidPerMin, 1, 100_000),
    paymentJwksUrl: paymentJwksBase(env.AWS_MARKETPLACE_PAYMENT_JWKS_URL) || null,
    extraJwks: Object.freeze(extra),
    serviceUrl: `${origin}${AWS_PREFIX}`,
  });
}

// An input field that names a URL for the tool to read: a name ending in url or
// uri (url, urls, imageUrl, feed_url), a link-like name, or a schema format of
// uri. A tool with one fetches content a third party owns, which this listing
// does not resell.
const URL_FIELD_NAME = /(?:url|uri)s?$/;
const LINK_FIELD_NAMES = new Set(["href", "src", "link", "website", "page"]);
const URL_FORMATS = new Set(["uri", "url", "iri", "uri-reference"]);
const HTTP_VALUE = /^\s*https?:\/\//i;

/** The input fields of `def` that name a URL for the tool to fetch, in order (empty when none). */
export function callerUrlFields(def) {
  const found = new Set();
  const props = def?.discovery?.inputSchema?.properties;
  if (props && typeof props === "object") {
    for (const [name, schema] of Object.entries(props)) {
      const key = String(name).toLowerCase().replace(/[^a-z]/g, "");
      const format = String(schema?.format ?? schema?.items?.format ?? "").toLowerCase();
      if (URL_FIELD_NAME.test(key) || LINK_FIELD_NAMES.has(key) || URL_FORMATS.has(format)) found.add(name);
    }
  }
  for (const input of [def?.discovery?.input, def?.discovery?.startingInput]) {
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    for (const [name, value] of Object.entries(input)) {
      const key = String(name).toLowerCase().replace(/[^a-z]/g, "");
      const values = Array.isArray(value) ? value : [value];
      if (URL_FIELD_NAME.test(key) || LINK_FIELD_NAMES.has(key) || values.some((v) => typeof v === "string" && HTTP_VALUE.test(v) && !/\s/.test(v.trim()))) found.add(name);
    }
  }
  return [...found];
}

const flatUsdOf = (def) => Number(String(def?.price ?? "").replace(/[^0-9.]/g, "")) || 0;
const hasPriceFn = (def) => typeof def?.quote === "function" || typeof def?.tierQuote === "function";

/**
 * Why a catalog definition cannot be sold here, or null. `flags` are the
 * server's readings: identityBound, lastingEffect, paysThirdParty,
 * longRunning, modelBacked, chatTier, compute (reaches no upstream).
 */
export function awsIneligibility(def, flags = {}, { ownHosts = [] } = {}) {
  if (!def || typeof def !== "object") return "not in the catalog";
  // Resold through AWS Marketplace, a third party: a raw pass-through of a
  // source whose terms bar that is never served here (src/resale-terms.js),
  // nor is a tool that fetches a page, file or feed the caller names. Checked
  // first, so the boot line names this reason whatever else the tool lacks.
  const resaleBarred = resaleBarredReason(def);
  if (resaleBarred) return resaleBarred;
  const urlFields = callerUrlFields(def);
  if (urlFields.length) return `fetches third-party content from a URL the caller names (${urlFields.slice(0, 3).join(", ")})`;
  // Then sold only when its upstream terms are cleared for resale through a
  // third party, or it reaches none (resaleClearanceRefusal).
  const resaleRefused = resaleClearanceRefusal(def, { compute: flags.compute === true });
  if (resaleRefused) return resaleRefused;
  if (typeof def.handler !== "function") return "in the catalog but has no handler";
  const method = String(def.route || "").split(" ")[0];
  if (method !== "GET" && method !== "POST") return "not a GET or POST route";
  if (flags.identityBound) return "identity-bound route (an AWS buyer carries no wallet)";
  if (flags.lastingEffect) return "its effect outlives the answer";
  if (flags.paysThirdParty) return "pays an outside seller";
  if (flags.longRunning) return "long-running or composite route";
  if (flags.chatTier || def.category === "llm") return "a model tier";
  if (flags.modelBacked || def.modelBacked === true) return "model-backed";
  if (binaryTypesOf(def)) return "answers bytes, not JSON";
  if (hasPriceFn(def)) return "priced per request (this listing sells fixed prices)";
  if (namesOwnHost(def, ownHosts)) return "its published example or input hints name this server's own host";
  const usd = flatUsdOf(def);
  if (!(usd > 0)) return "no list price";
  if (!/^\$?\d+(\.\d{1,8})?$/.test(String(def.price).trim())) return "its list price is not a plain US dollar amount with at most 8 decimals";
  return null;
}

/** The listed definitions that pass the boot checks (in listed order), and the refused ones with why. */
export function awsRoutes(config, catalog, flagsOf = () => ({}), opts = {}) {
  const bySlug = new Map();
  for (const def of Object.values(catalog || {})) if (def?.slug && !bySlug.has(def.slug)) bySlug.set(def.slug, def);
  const defs = new Map();
  const refused = [];
  for (const slug of config?.slugs || []) {
    const def = bySlug.get(slug);
    let why;
    try { why = def ? awsIneligibility(def, flagsOf(def) || {}, opts) : "not in the catalog"; } catch { why = "could not be checked"; }
    if (why) refused.push({ slug, reason: why });
    else defs.set(slug, def);
  }
  return { defs, refused };
}

/** The slug a path names (`/aws` is the first listed tool), or null. Canonical spelling only. */
export function awsSlugOfPath(path, defs) {
  const p = String(path || "");
  if (!defs || !defs.size) return null;
  if (p === AWS_PREFIX) return defs.keys().next().value;
  const m = /^\/aws\/([a-z0-9][a-z0-9-]{0,63})$/.exec(p);
  return m && defs.has(m[1]) ? m[1] : null;
}

function decodeJwtClaims(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part || part.length > 16_384) return null;
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** When a verified payment stops being usable: the later of its token's and
 *  its quote's expiry (both already verified), plus clock skew. */
export function claimUntilMs(paymentToken, nowMs = Date.now()) {
  const token = decodeJwtClaims(paymentToken);
  const quote = token ? decodeJwtClaims(token.quote_token) : null;
  const exps = [token?.exp, quote?.exp].map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!exps.length) return nowMs + CLAIM_FALLBACK_MS;
  return Math.min(Math.max(...exps) * 1000 + CLAIM_SKEW_MS, nowMs + 31 * 24 * 3600_000);
}

/**
 * The shared record of used payments and DPoP proofs. `getClient` resolves to
 * a node-redis client or null; on null or an error this process's memory
 * stands in (fail open: the buyer has already paid).
 *   begin(id, untilMs, retryMax) -> "ok" | "used"
 *   end(id, { served }) -> { retriesLeft }  (an unserved attempt is given back while attempts remain)
 *   seenProof(jti) -> true when the proof id was already recorded (and records it)
 */
/**
 * Per-client rate limits on /aws (one fixed minute window each, in this
 * process; keys are digests, never the address or the buyer id itself):
 *   - an unpaid request (a quote or a refusal, and a request whose payment
 *     header does not verify) per client address (an IPv6 address by its
 *     /64): `quotesPerMin`;
 *   - a paid request whose payment has not been accepted for a run yet, per
 *     AWS buyer (the verified token's `sub`) and per client address:
 *     `paidPerMin` each.
 * A paid call already accepted (its payment claimed for a run once, a
 * resend after a failed run included) is never counted against or refused.
 */
export function createAwsRateLimits({ quotesPerMin = AWS_DEFAULTS.quotesPerMin, paidPerMin = AWS_DEFAULTS.paidPerMin, now = Date.now, maxKeys = 50_000 } = {}) {
  const windows = new Map(); // digest -> { start, n }
  const key = (kind, v) => createHash("sha256").update(`${kind}|${String(v)}`).digest("base64url").slice(0, 22);
  const hit = (kind, v, limit) => {
    const t = now();
    const k = key(kind, v);
    let w = windows.get(k);
    if (!w || t - w.start >= 60_000) {
      if (!w && windows.size >= maxKeys) for (const [wk, ww] of windows) { if (t - ww.start >= 60_000) windows.delete(wk); if (windows.size < maxKeys) break; }
      if (!w && windows.size >= maxKeys) windows.delete(windows.keys().next().value);
      w = { start: t, n: 0 };
      windows.set(k, w);
    }
    w.n += 1;
    return w.n > limit ? Math.max(1, Math.ceil((w.start + 60_000 - t) / 1000)) : 0;
  };
  return {
    /** Seconds to wait (0: go on) for an unpaid request from `client`. */
    quote: (client) => hit("q", client, quotesPerMin),
    /** Seconds to wait (0: go on) for a paid request not yet accepted. */
    paid: (client, buyer) => Math.max(hit("pc", client, paidPerMin), buyer ? hit("pb", buyer, paidPerMin) : 0),
  };
}

export function createAwsPaymentClaims({ getClient = async () => null, now = Date.now, prefix = "aws-mp:", log = (m) => console.warn(m) } = {}) {
  const local = new Map(); // key -> { value, until }
  let lastLog = 0;
  const degraded = (op, e) => {
    if (now() - lastLog < 60_000) return;
    lastLog = now();
    try { log(`[aws-marketplace] redis ${op} failed, using this process's record: ${String(e?.message || e).slice(0, 160)}`); } catch { /* never throws */ }
  };
  const sweep = () => { const t = now(); if (local.size > 10_000) for (const [k, v] of local) if (v.until <= t) local.delete(k); };
  const lget = (k) => { const v = local.get(k); if (!v) return null; if (v.until <= now()) { local.delete(k); return null; } return v.value; };
  const lsetNx = (k, value, until) => { sweep(); if (lget(k) !== null) return false; local.set(k, { value, until }); return true; };
  const lincr = (k, until) => { const n = (Number(lget(k)) || 0) + 1; local.set(k, { value: n, until }); return n; };
  async function client() { try { return await getClient(); } catch { return null; } }
  const attempts = new Map(); // id -> { n, max, until } for end()

  return {
    async begin(id, untilMs, retryMax = AWS_DEFAULTS.retryMax) {
      const key = String(id);
      const ttl = Math.max(1000, Math.ceil(untilMs - now()));
      const lock = `${prefix}l:${key}`, count = `${prefix}n:${key}`;
      let took = null, n = null;
      const c = await client();
      if (c) {
        try {
          took = (await c.set(lock, "1", { NX: true, PX: ttl })) === "OK";
          if (took) { n = Number(await c.incr(count)); await c.pExpire(count, ttl); }
        } catch (e) { degraded("claim", e); took = null; }
      }
      if (took === null) {
        took = lsetNx(lock, 1, now() + ttl);
        if (took) n = lincr(count, now() + ttl);
      }
      if (!took) return "used";
      if (n > 1 + retryMax) return "used"; // attempts spent: the lock stays
      attempts.set(key, { n, max: 1 + retryMax, until: now() + ttl });
      return "ok";
    },
    async end(id, { served }) {
      const key = String(id);
      const a = attempts.get(key);
      attempts.delete(key);
      if (served || !a) return { retriesLeft: 0 };
      const left = a.max - a.n;
      if (left <= 0) return { retriesLeft: 0 };
      const lock = `${prefix}l:${key}`;
      local.delete(lock);
      const c = await client();
      if (c) { try { await c.del(lock); } catch (e) { degraded("release", e); } }
      return { retriesLeft: left };
    },
    /** Whether this payment was accepted before (claimed for a run at least once). */
    async accepted(id) {
      const count = `${prefix}n:${String(id)}`;
      const c = await client();
      if (c) { try { return Number(await c.get(count)) > 0; } catch (e) { degraded("read", e); } }
      return Number(lget(count)) > 0;
    },
    async seenProof(jti) {
      const k = `${prefix}d:${String(jti)}`;
      const c = await client();
      if (c) {
        try { return (await c.set(k, "1", { NX: true, EX: AWS_DPOP_KEEP_SECONDS })) !== "OK"; } catch (e) { degraded("proof", e); }
      }
      return !lsetNx(k, 1, now() + AWS_DPOP_KEEP_SECONDS * 1000);
    },
  };
}

const PAYMENT_HEADERS = ["payment-signature", "x-payment"];
const carriesPayment = (req) => PAYMENT_HEADERS.some((h) => typeof req.headers?.[h] === "string" && req.headers[h] !== "");

/** The x402 route table for the listed tools: one `aws:base` offer each.
 *  `describe` gives a tool's AWS-facing description (src/aws-listing.js
 *  awsDescriptionOf: no sentence pointing past the listing). */
export function awsRouteTable(config, defs, describe = (def) => def.description) {
  const table = {};
  let first = true;
  const html = "<!doctype html><meta charset=\"utf-8\"><title>Payment required</title><p>Payment required.</p>";
  for (const [slug, def] of defs) {
    const method = String(def.route).split(" ")[0];
    const entry = {
      accepts: {
        scheme: "exact",
        network: AWS_NETWORK,
        payTo: config.productId,
        price: String(def.price).trim().startsWith("$") ? String(def.price).trim() : `$${String(def.price).trim()}`,
        maxTimeoutSeconds: config.quoteSeconds,
        extra: { reference: slug, description: String(def.name || slug).slice(0, 200) },
      },
      description: String(describe(def) || def.name || slug).slice(0, 1000),
      mimeType: "application/json",
      customPaywallHtml: html,
    };
    table[`${method} ${AWS_PREFIX}/${slug}`] = entry;
    if (first) { table[`${method} ${AWS_PREFIX}`] = entry; first = false; }
  }
  return table;
}

/**
 * Build the gate (async: it imports the seller SDK). Returns
 * { handler(req, res, next), jwks, stats(), failed(), slugs(), endpointSlug }
 * (failed() resolves to the unanswered record, src/aws-unanswered.js).
 * `sdk`, `core`, `express` are injectable for tests; the defaults are the
 * installed packages.
 */
export async function createAwsMarketplaceGate({
  config, defs, claims,
  recordSale, preValidate = () => null, runAsCaller = (_req, fn) => fn(), handlerInputOf = (req) => (req.method === "GET" ? { ...(req.query || {}) } : (req.body && typeof req.body === "object" ? req.body : {})),
  isSynthetic = () => false, redact = (s) => s, ownHosts = [], ownPaths = [], onServed = null, onToolError = null,
  clientKey = (req) => String(req.ip || ""), rateLimits = null, describe = (def) => def.description, unanswered = null,
  sdk = null, core = null, express = null, now = Date.now, log = (m) => console.warn(m),
}) {
  if (!config || !defs || !defs.size || !claims || typeof recordSale !== "function") throw new Error("aws gate: missing a dependency");
  const S = sdk || await import("@aws/fiat-extension-for-x402");
  const coreServer = core?.server || await import("@x402/core/server");
  const coreFacilitator = core?.facilitator || await import("@x402/core/facilitator");
  const X = express || await import("@x402/express");

  const signer = S.LocalQuoteSigner.fromPem(config.pem, { kid: config.kid, serviceUrl: config.serviceUrl });
  const jwks = S.jwksDocument(signer.publicJwk, ...config.extraJwks);
  const verifier = new S.AgenticCommerceVerifier({
    sellerKeyResolver: { type: "static", publicJwk: signer.publicJwk },
    ...(config.paymentJwksUrl ? { paymentTokenJwksUrl: config.paymentJwksUrl } : {}),
  });
  const facilitator = new coreFacilitator.x402Facilitator().register(AWS_NETWORK, new S.ExactAgenticCommerceFacilitatorScheme({ verifier }));
  const server = new coreServer.x402ResourceServer(new S.InProcessFacilitatorClient(facilitator));
  S.registerExactAgenticCommerceServer(server, {
    signer,
    dpopNonceStore: { has: (jti) => claims.seenProof(jti), add: () => {} },
  });
  // The verified payment, handed to the route through the request. This hook
  // runs before the scheme's own DPoP replay check, so nothing is claimed
  // here: the route claims it, once every check has passed.
  server.onAfterVerify(async (ctx) => {
    try {
      const req = ctx?.transportContext?.request?.adapter?.req;
      const result = ctx?.result;
      if (!req || !result?.isValid) return undefined;
      const id = result.extra?.paymentId;
      if (typeof id !== "string" || !id) return { abort: true, reason: "invalid_payment", message: "The payment carries no payment id." };
      req.__awsPayment = { paymentId: id, buyer: typeof result.payer === "string" && result.payer ? result.payer : null, untilMs: claimUntilMs(ctx.paymentPayload?.payload?.paymentToken, now()) };
    } catch { return { abort: true, reason: "invalid_payment", message: "The payment could not be read." }; }
    return undefined;
  });
  const routes = awsRouteTable(config, defs, describe);
  const httpServer = new coreServer.x402HTTPResourceServer(server, routes);
  await httpServer.initialize();
  const mw = X.paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false);

  const counters = { quotes: 0, refusedInput: 0, paidRuns: 0, served: 0, replayed: 0, failedAttempts: 0, chargedWithoutAnswer: 0, booked: 0, limitedUnpaid: 0, limitedPaid: 0 };
  const limits = rateLimits || createAwsRateLimits({ quotesPerMin: config.quotesPerMin, paidPerMin: config.paidPerMin, now });
  const tooMany = (res, slug, wait, paid) => {
    res.set("Retry-After", String(wait));
    return res.status(429).json({
      error: paid ? "Too many paid requests from this client in the last minute." : "Too many requests from this client in the last minute.",
      errorReason: "rate_limited", tool: slug, retryAfterSeconds: wait,
      ...(paid ? { paymentUsed: false, note: "This payment was not used. Send the request again with the same payment after Retry-After, while it is valid." } : {}),
    });
  };
  const unansweredBook = unanswered || createAwsUnansweredBook({ file: null, now, log });
  let wordCache = null;
  // A pointer at this server's other surfaces: its host, or a path one of
  // its direct routes answers on (`POST /api/sql-cert-verify`, `/mcp`). A
  // path is read as a whole token, so a word that merely starts like one is not.
  const hostsLc = ownHosts.map((h) => String(h || "").toLowerCase()).filter(Boolean);
  const pathSet = new Set(ownPaths.map((p) => String(p || "").toLowerCase().replace(/\/+$/, "")).filter((p) => p.startsWith("/")));
  const PATH_TOKEN = /(?:^|[\s"'`(,;:=])(\/[A-Za-z0-9._~\-/]{1,200})/g;
  const pointersIn = (s) => {
    if (typeof s !== "string" || !s) return [];
    const lc = s.toLowerCase();
    const out = hostsLc.filter((h) => lc.includes(h));
    if (pathSet.size) for (const m of lc.matchAll(PATH_TOKEN)) { const p = m[1].replace(/[.,;:]+$/, "").replace(/\/+$/, ""); if (pathSet.has(p)) out.push(p); }
    return out;
  };
  const notePointers = (s) => pointersIn(s).length > 0;
  // `given`: the caller's own input as text; a pointer the caller sent (a
  // path in the text it asked about) is its own content, not ours, and stays.
  const clean = (value, depth = 0, given = "") => {
    if (typeof value === "string") return pointersIn(value).some((p) => !given.includes(p)) ? undefined : value;
    if (!value || typeof value !== "object" || depth > 6) return value;
    if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1, given)).filter((v) => v !== undefined);
    const out = {};
    for (const [k, v] of Object.entries(value)) { if (k === "howToCall") continue; const w = clean(v, depth + 1, given); if (w !== undefined) out[k] = w; }
    return out;
  };
  const inputText = (input) => { try { return JSON.stringify(input ?? null).toLowerCase(); } catch { return ""; } };
  // The payment was taken before the handler ran, so a handler's "nothing was
  // charged" is dropped: the body's paymentUsed and note state the payment.
  const errorText = (msg) => { const t = String(redact(withoutChargeSentences(String(msg || ""))) || "").slice(0, 600); return t && !notePointers(t) ? t : "The request could not be completed."; };

  async function runPaid(req, res, def) {
    const pay = req.__awsPayment;
    if (!pay) { res.status(500).json({ error: "The payment could not be read.", tool: def.slug }); return; }
    // An input this server refuses before the run: the payment is not used.
    const bad = (() => { try { return preValidate(def, req); } catch { return null; } })();
    if (bad) {
      counters.refusedInput++;
      res.status(bad.status || 400).json({ ...clean(bad.body || {}), error: errorText(bad.body?.error), tool: def.slug, paymentUsed: false, note: "This payment was not used. Correct the input and send the request again with the same payment while it is valid." });
      return;
    }
    // A payment not accepted before meets the per-buyer and per-address
    // limits; one already accepted (a resend after a failed run) never does.
    const known = await (async () => { try { return typeof claims.accepted === "function" && await claims.accepted(pay.paymentId); } catch { return false; } })();
    if (!known) {
      const wait = limits.paid(clientKey(req), pay.buyer);
      if (wait > 0) { counters.limitedPaid++; tooMany(res, def.slug, wait, true); return; }
    }
    const verdict = await claims.begin(pay.paymentId, pay.untilMs, config.retryMax);
    if (verdict !== "ok") {
      counters.replayed++;
      res.status(409).json({ error: "This payment was already used.", errorReason: "payment_replayed", tool: def.slug });
      return;
    }
    counters.paidRuns++;
    let ended = false;
    const finishRun = async (served, status) => {
      if (ended) return null;
      ended = true;
      const { retriesLeft } = await claims.end(pay.paymentId, { served });
      if (served) {
        counters.served++;
        // A resend of a payment that failed before: its unanswered entry is answered now.
        if (known) { try { await unansweredBook.resolve(pay.paymentId, "served"); } catch { /* bookkeeping only */ } }
        try {
          recordSale({ slug: def.slug, priceUsd: flatUsdOf(def), quoteUsd: flatUsdOf(def), rail: AWS_RAIL, network: AWS_NETWORK, payer: null, tx: pay.paymentId, wire: AWS_WIRE, synthetic: isSynthetic(req) });
          counters.booked++;
        } catch { /* booking never fails a served call */ }
        if (onServed) { try { onServed(req, def); } catch { /* bookkeeping only */ } }
      } else {
        counters.failedAttempts++;
        // Every unanswered attempt is recorded, with whether the payment can
        // still be retried; a served resend marks it answered (above).
        if (retriesLeft <= 0) {
          counters.chargedWithoutAnswer++;
          try { log(`[aws-marketplace] a paid ${def.slug} call ended without an answer (status ${status}) and payment ${String(pay.paymentId).slice(0, 200)} has no attempts left`); } catch { /* never throws */ }
        }
        await unansweredBook.record({ at: now(), paymentId: pay.paymentId, slug: def.slug, status, priceUsd: flatUsdOf(def), attemptsLeft: retriesLeft, retryUntilMs: pay.untilMs });
      }
      return retriesLeft;
    };
    res.once("finish", () => { void finishRun(res.statusCode === 200, res.statusCode); });
    res.once("close", () => { if (!res.writableFinished) void finishRun(false, 499); });

    let result;
    try {
      const input = handlerInputOf(req, def);
      result = await runAsCaller(req, () => def.handler(input, req));
      if (result && (result.__binary || typeof result.__sse === "function")) throw Object.assign(new Error("This tool's answer cannot be served on this route."), { statusCode: 500 });
      // A tool's declared answer for third-party resale (src/resale-terms.js
      // refAnswerOf, the one /ref serves) is the answer sold here too.
      if (typeof def.refAnswer === "function") {
        result = refAnswerOf(def, result);
        if (result === undefined) throw Object.assign(new Error("This tool's answer could not be prepared for this route."), { statusCode: 500 });
      }
      // The answer goes out without a pointer at this server's other surfaces
      // (a field naming a direct route, such as a verify step, is dropped);
      // text the caller sent is its own and stays.
      const text = JSON.stringify(result === undefined ? null : clean(result, 0, inputText(input)));
      if (typeof text !== "string") throw Object.assign(new Error("The answer could not be serialized."), { statusCode: 500 });
      res.status(200).type("application/json").send(text);
    } catch (err) {
      let status = Number(err?.statusCode);
      if (!(status >= 400 && status < 600)) status = 500;
      if (onToolError) { try { onToolError(def.slug, status, err); } catch { /* logging only */ } }
      // The payment is given back before the answer goes out, so the buyer's
      // immediate resend finds it usable.
      const left = await finishRun(false, status);
      const body = { error: errorText(err?.message), tool: def.slug };
      if (left > 0) Object.assign(body, { paymentUsed: false, attemptsLeft: left, note: "The call did not complete. Send the request again with the same payment while it is valid." });
      else Object.assign(body, { paymentUsed: true, note: "The call did not complete and this payment has no attempts left. Refunds follow the AWS Marketplace refund process." });
      if (status >= 400 && status < 500) Object.assign(body, clean({ expected: def.discovery?.inputSchema?.properties || {}, required: def.discovery?.inputSchema?.required || [] }));
      if (!res.headersSent) res.status(status).json(body);
    }
  }

  // Watches the paywall's own answer to a request that carries a payment:
  // its 402 status is counted as an unpaid request, and when that is past the
  // limit, the 402's headers and body are replaced by the 429. Returns the
  // function that ends the watch (called when the payment verified).
  function limitUnverified(req, res, slug) {
    const OWN = ["status", "setHeader", "json", "send"];
    let wait = 0, watching = true;
    const end = () => { if (!watching) return; watching = false; for (const m of OWN) delete res[m]; };
    res.status = function status(code) {
      if (watching && Number(code) === 402 && !wait) wait = limits.quote(clientKey(req));
      if (wait > 0) return res;
      return Object.getPrototypeOf(res).status.call(res, code);
    };
    res.setHeader = function setHeader(...args) {
      if (wait > 0) return res;
      return Object.getPrototypeOf(res).setHeader.apply(res, args);
    };
    const finish = (m) => function (...args) {
      if (wait > 0) { end(); counters.limitedUnpaid++; tooMany(res, slug, wait, false); return res; }
      end();
      return res[m](...args);
    };
    res.json = finish("json");
    res.send = finish("send");
    return end;
  }

  async function handler(req, res, next) {
    const slug = awsSlugOfPath(req.path, defs);
    if (!slug) return next();
    const def = defs.get(slug);
    const method = String(def.route).split(" ")[0];
    // An unpaid HEAD never reaches the paid route, and no other method does either.
    if (req.method !== method) { res.set("Allow", method); return res.status(405).json({ error: `Use ${method}.`, tool: slug }); }
    if (!carriesPayment(req)) {
      const wait = limits.quote(clientKey(req));
      if (wait > 0) { counters.limitedUnpaid++; return tooMany(res, slug, wait, false); }
      // A request that carries an input this server refuses gets the refusal,
      // not a quote: nothing is paid for a call that could not run.
      let input = null;
      try { input = handlerInputOf(req, def); } catch { input = null; }
      if (input && typeof input === "object" && Object.keys(input).length) {
        const bad = (() => { try { return preValidate(def, req); } catch { return null; } })();
        if (bad) { counters.refusedInput++; return res.status(bad.status || 400).json({ ...clean(bad.body || {}), error: errorText(bad.body?.error), tool: slug }); }
      }
      counters.quotes++;
    }
    // A payment header that does not verify is answered the paywall's 402
    // (a fresh quote). That answer is counted against the unpaid limit, and
    // past it the client gets the 429 instead of the quote, so a header of
    // junk is no way around the limit. A payment that verifies never reaches
    // this: its run starts (next) before anything is written.
    const unlimit = carriesPayment(req) ? limitUnverified(req, res, slug) : () => {};
    try {
      await mw(req, res, () => { unlimit(); return runPaid(req, res, def); });
    } catch (err) {
      try { log(`[aws-marketplace] ${slug}: ${String(redact(String(err?.message || err))).slice(0, 160)}`); } catch { /* never throws */ }
      if (!res.headersSent) res.status(500).json({ error: "The request could not be completed.", tool: slug });
    }
    return undefined;
  }

  return {
    handler,
    jwks,
    endpointSlug: defs.keys().next().value,
    slugs: () => [...defs.keys()],
    stats: () => ({ ...counters }),
    failed: async () => (await unansweredBook.list()).entries,
    unanswered: () => unansweredBook.list(),
    /** The record's word for refundsOwed (src/aws-unanswered.js), shared for 30 seconds. */
    unansweredWord: async (opts = {}) => {
      const t = now();
      if (wordCache && t - wordCache.at < 30_000 && wordCache.key === JSON.stringify(opts)) return wordCache.value;
      const r = await unansweredBook.list();
      const value = awsUnansweredWord(r.ok ? r.entries : null, { ...opts, now: t });
      wordCache = { at: t, key: JSON.stringify(opts), value };
      return value;
    },
    /** The operator's review of an entry; true when an unresolved entry was marked. */
    markReviewed: async (paymentId) => { const done = await unansweredBook.resolve(paymentId, "reviewed"); if (done) wordCache = null; return done; },
  };
}

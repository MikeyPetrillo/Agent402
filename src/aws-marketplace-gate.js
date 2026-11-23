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
//     attempt, up to AWS_MARKETPLACE_RETRY_MAX more, inside its validity. The
//     attempt that exhausts it is recorded for the operator (charged without
//     an answer: a billing adjustment is the owner's, through AWS
//     Marketplace).
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

export const AWS_NETWORK = "aws:base";
export const AWS_RAIL = "aws";
export const AWS_WIRE = "aws";
export const AWS_PREFIX = "/aws";
export const AWS_JWKS_PATH = "/aws/.well-known/jwks.json";
/** The first listing: own-code tools with a low failure rate and a fixed price. */
export const AWS_DEFAULT_SLUGS = Object.freeze(["extract", "render", "pdf-to-markdown", "redact", "sql-guard", "email-guard", "sanctions-name", "sanctions-wallet"]);
export const AWS_DEFAULTS = Object.freeze({ quoteSeconds: 300, retryMax: 2 });
/** The settings without which the gate stays off. */
export const AWS_REQUIRED_VARS = Object.freeze(["AWS_MARKETPLACE_QUOTE_KEY", "AWS_MARKETPLACE_QUOTE_KEY_ID", "AWS_MARKETPLACE_PRODUCT_ID"]);
/** A DPoP proof id is kept this long (the SDK's floor(60 + 5) + 6 for a store that records in `has`). */
export const AWS_DPOP_KEEP_SECONDS = 71;
/** The longest a payment claim is kept when its token's expiry cannot be read. */
const CLAIM_FALLBACK_MS = 30 * 60_000;
const CLAIM_SKEW_MS = 60_000;
/** Operator record of charged runs that ended without an answer. */
const FAILED_KEEP = 200;

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
  if (paymentJwksBase(env.AWS_MARKETPLACE_PAYMENT_JWKS_URL) === undefined) return "AWS_MARKETPLACE_PAYMENT_JWKS_URL is not an https AWS host (or loopback)";
  if (String(env.AWS_MARKETPLACE_JWKS_EXTRA || "").trim()) {
    try { JSON.parse(env.AWS_MARKETPLACE_JWKS_EXTRA); } catch { return "AWS_MARKETPLACE_JWKS_EXTRA is not JSON"; }
  }
  return null;
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
    paymentJwksUrl: paymentJwksBase(env.AWS_MARKETPLACE_PAYMENT_JWKS_URL) || null,
    extraJwks: Object.freeze(extra),
    serviceUrl: `${origin}${AWS_PREFIX}`,
  });
}

const flatUsdOf = (def) => Number(String(def?.price ?? "").replace(/[^0-9.]/g, "")) || 0;
const hasPriceFn = (def) => typeof def?.quote === "function" || typeof def?.tierQuote === "function";

/**
 * Why a catalog definition cannot be sold here, or null. `flags` are the
 * server's readings: identityBound, lastingEffect, paysThirdParty,
 * longRunning, modelBacked, chatTier.
 */
export function awsIneligibility(def, flags = {}, { ownHosts = [] } = {}) {
  if (!def || typeof def !== "object") return "not in the catalog";
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

/** The x402 route table for the listed tools: one `aws:base` offer each. */
export function awsRouteTable(config, defs) {
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
      description: String(def.description || def.name || slug).slice(0, 1000),
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
 * { handler(req, res, next), jwks, stats(), failed(), slugs(), endpointSlug }.
 * `sdk`, `core`, `express` are injectable for tests; the defaults are the
 * installed packages.
 */
export async function createAwsMarketplaceGate({
  config, defs, claims,
  recordSale, preValidate = () => null, runAsCaller = (_req, fn) => fn(), handlerInputOf = (req) => (req.method === "GET" ? { ...(req.query || {}) } : (req.body && typeof req.body === "object" ? req.body : {})),
  isSynthetic = () => false, redact = (s) => s, ownHosts = [], onServed = null, onToolError = null,
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
      req.__awsPayment = { paymentId: id, untilMs: claimUntilMs(ctx.paymentPayload?.payload?.paymentToken, now()) };
    } catch { return { abort: true, reason: "invalid_payment", message: "The payment could not be read." }; }
    return undefined;
  });
  const routes = awsRouteTable(config, defs);
  const httpServer = new coreServer.x402HTTPResourceServer(server, routes);
  await httpServer.initialize();
  const mw = X.paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false);

  const counters = { quotes: 0, refusedInput: 0, paidRuns: 0, served: 0, replayed: 0, failedAttempts: 0, chargedWithoutAnswer: 0, booked: 0 };
  const failedLog = [];
  const notePointers = (s) => typeof s === "string" && ownHosts.some((h) => h && s.toLowerCase().includes(String(h).toLowerCase()));
  const clean = (value, depth = 0) => {
    if (typeof value === "string") return notePointers(value) ? undefined : value;
    if (!value || typeof value !== "object" || depth > 6) return value;
    if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1)).filter((v) => v !== undefined);
    const out = {};
    for (const [k, v] of Object.entries(value)) { if (k === "howToCall") continue; const w = clean(v, depth + 1); if (w !== undefined) out[k] = w; }
    return out;
  };
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
        try {
          recordSale({ slug: def.slug, priceUsd: flatUsdOf(def), quoteUsd: flatUsdOf(def), rail: AWS_RAIL, network: AWS_NETWORK, payer: null, tx: pay.paymentId, wire: AWS_WIRE, synthetic: isSynthetic(req) });
          counters.booked++;
        } catch { /* booking never fails a served call */ }
        if (onServed) { try { onServed(req, def); } catch { /* bookkeeping only */ } }
      } else {
        counters.failedAttempts++;
        if (retriesLeft <= 0) {
          counters.chargedWithoutAnswer++;
          failedLog.push({ at: new Date(now()).toISOString(), slug: def.slug, paymentId: pay.paymentId, status, priceUsd: flatUsdOf(def) });
          if (failedLog.length > FAILED_KEEP) failedLog.shift();
          try { log(`[aws-marketplace] a paid ${def.slug} call ended without an answer (status ${status}) and its payment has no attempts left`); } catch { /* never throws */ }
        }
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
      const text = JSON.stringify(result === undefined ? null : result);
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

  async function handler(req, res, next) {
    const slug = awsSlugOfPath(req.path, defs);
    if (!slug) return next();
    const def = defs.get(slug);
    const method = String(def.route).split(" ")[0];
    // An unpaid HEAD never reaches the paid route, and no other method does either.
    if (req.method !== method) { res.set("Allow", method); return res.status(405).json({ error: `Use ${method}.`, tool: slug }); }
    if (!carriesPayment(req)) {
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
    try {
      await mw(req, res, () => runPaid(req, res, def));
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
    failed: () => failedLog.slice(),
  };
}

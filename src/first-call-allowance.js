// First-call allowance: a wallet that has never paid us is served its FIRST
// paid call on an eligible route without being charged, inside hard caps.
// Off unless FIRST_CALL_ALLOWANCE is exactly "on".
//
// The buyer still sends a valid signed x402 EVM `exact` payment. The paywall
// verifies it with the facilitator as for any call (a bad signature or an
// unfunded wallet never reaches a handler), so the identity is the signed
// EIP-3009 payer (src/payer.js) and the authorization is real and funded.
// Then, before the handler runs, the dispatcher (server.js) asks this module
// for a grant. A granted call runs as usual; when its answer is a final 200,
// the x402 onBeforeSettle hook below returns the protocol's `skip` directive,
// so the facilitator is never called and nothing is broadcast. The signed
// authorization is simply never used. Any other status settles exactly as
// today (a >= 400 is never settled at all) and gives the grant back.
//
// What the buyer sees on a granted 200: the header X-Agent402-Allowance:
// first-call, a `firstCallAllowance` field on a JSON object body, and no
// PAYMENT-RESPONSE header (nothing settled, so there is no receipt). Every
// reader that books money reads the request's allowance state first: the
// settle-outcome listeners are skipped (src/hangup-settlement.js runOutcome:
// no sale, no breaker outcome, no composite outcome), the idempotency cache
// never stores the answer, and with no receipt no hang-up debt or refund row
// can be written. The grant itself is recorded here, not in the sales ledger.
//
// Caps, each claimed atomically in ONE Redis script before the handler runs:
//   - one grant per wallet: a key per lowercased EVM payer. A claim holds it
//     for CLAIM_TTL_MS (so a claim left by a crash or a lost release
//     expires); a served grant keeps it for FIRST_CALL_ALLOWANCE_WALLET_TTL_DAYS
//     (default 400). With the state database on, a granted wallet is also
//     written as a record with no expiry and read back first, so the grant
//     holds after the key is gone;
//   - a global daily USD cap (FIRST_CALL_ALLOWANCE_DAILY_USD, default 2; 0
//     grants nothing), counted at the route's list price;
//   - a per-client-address daily count (FIRST_CALL_ALLOWANCE_IP_PER_DAY,
//     default 2), keyed on a digest of req.ip;
// and released (wallet key deleted, both counters returned) when the call
// does not end in a served 200. A store that does not answer grants nothing.
// The caps are claimed BEFORE the balance read, so a spent cap or a granted
// wallet costs no RPC; the read itself is bounded to BALANCE_READ_MS in all
// (a slow or failed read grants nothing, and the claim is given back).
//
// Sybil bound: a fresh wallet costs nothing to make, so per-wallet and per-IP
// caps only slow one actor down. What bounds the total is the daily USD cap:
// whatever any number of wallets and addresses do, the service gives away at
// most that much list price per UTC day. Every grant also needs a wallet that
// holds at least the call's price on the paying chain (verify, plus a balance
// read here), so each Sybil wallet must be funded.
//
// Scope: an eligible route is a flagship (src/mcp-flagship.js) or one listed
// in ALLOWANCE_EXTRA_SLUGS (the owner may name the set instead with
// FIRST_CALL_ALLOWANCE_SLUGS), priced at or under FIRST_CALL_ALLOWANCE_MAX_USD
// (default 0.01), and never a metered/quoted route, a route whose effect
// outlives the answer, an identity-bound route or a long-running/async one.
// Only plain x402 EVM exact: never Tempo, MPP, card, credits, upto, Permit2,
// the Gateway batched option, a stream or an async-job replay. Our own wallets
// and any wallet with a paid sale on the books never get one. A call that asks
// for a share link (share=true) never gets one either: the link is written
// only on a settled 200, and a grant is never settled.

import { createHash } from "node:crypto";
import { ALLOWANCE_STATE, allowanceOf, allowanceServed } from "./allowance-state.js";
import { FLAGSHIP_SLUGS } from "./mcp-flagship.js";
import { hasLastingEffect, hangupKeyDigest } from "./hangup-forgiveness.js";
import { isLongRunningSlug } from "./composite-spend-guard.js";
import { asyncProfileOf } from "./slow-routes.js";
import { wantsAsync, LOOPBACK_HEADER } from "./async-jobs.js";
import { isGatewayBatchedRequest } from "./gateway-wire.js";
import { payerFromRequest, paymentHeaderOf, paymentSchemeOf, paymentNonceIdentityOf, normalizePayerAddress } from "./payer.js";
import { coverTermsOf, readTokenBalance } from "./inflight-cover.js";
import { OUR_EVM_WALLETS } from "./revenue-live.js";
import { getSharedRedisClient } from "./shared-limit.js";
import { withLoopTimeout } from "./loop-deadline.js";
import { keyOf, OP_MS } from "./shared-limits.js";
import { stateDbEnabled, records } from "./state-db.js";
import { handlerInputOf } from "./handler-input.js";
import { wantsShare, answerShareEnabled } from "./answer-share.js";
import { decodePaymentHeader } from "./payment-header.js";

export const ALLOWANCE_HEADER = "X-Agent402-Allowance";
export const ALLOWANCE_HEADER_VALUE = "first-call";
export const ALLOWANCE_BODY_FIELD = "firstCallAllowance";
/** Routes eligible beyond the flagships (still subject to every rule above). */
export const ALLOWANCE_EXTRA_SLUGS = Object.freeze([]);
const RECORD_COLLECTION = "first-call-allowance";
const MICRO = 1_000_000;
const DAY_TTL_SECONDS = 2 * 86_400;
// A claimed (not yet served) wallet key expires after this, so a claim that
// was never released (a crash, a lost release) frees the wallet again.
const CLAIM_TTL_MS = 30 * 60_000;
const CLAIM_TTL_SECONDS = CLAIM_TTL_MS / 1000;
const STATE = ALLOWANCE_STATE;
const ALLOWANCE_NOTE = "First paid call from this wallet: served by the first-call allowance. The payment was verified and not settled; nothing was charged.";

function envNumber(name, dflt) {
  const raw = String(process.env[name] ?? "").trim();
  if (raw === "") return dflt;
  const n = Number(raw);
  // A malformed value reads as the default, never as a wider cap.
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Call-time config (a test boot sets the env before it starts the server). */
export function firstCallAllowanceConfig() {
  const listed = String(process.env.FIRST_CALL_ALLOWANCE_SLUGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    enabled: String(process.env.FIRST_CALL_ALLOWANCE ?? "").trim() === "on",
    dailyMicro: Math.round(envNumber("FIRST_CALL_ALLOWANCE_DAILY_USD", 2) * MICRO),
    maxMicro: Math.round(envNumber("FIRST_CALL_ALLOWANCE_MAX_USD", 0.01) * MICRO),
    ipPerDay: Math.floor(envNumber("FIRST_CALL_ALLOWANCE_IP_PER_DAY", 2)),
    walletTtlSeconds: Math.max(86_400, Math.round(envNumber("FIRST_CALL_ALLOWANCE_WALLET_TTL_DAYS", 400) * 86_400)),
    balanceReadMs: Math.max(50, Math.round(envNumber("FIRST_CALL_ALLOWANCE_BALANCE_MS", 1_000))),
    slugs: new Set(listed.length ? listed : [...FLAGSHIP_SLUGS, ...ALLOWANCE_EXTRA_SLUGS]),
  };
}
export function firstCallAllowanceEnabled() { return firstCallAllowanceConfig().enabled; }

const listMicroOf = (def) => Math.round((Number(String(def?.price ?? "").replace(/[^0-9.]/g, "")) || 0) * MICRO);
const identityBound = (def) => def?.identityBound === true || def?.category === "memory" || ["my-usage", "attest", "receipts", "feedback"].includes(def?.slug);

/** Why this catalog route can never take a grant, or null when it can. */
export function allowanceRouteRefusal(def, cfg = firstCallAllowanceConfig()) {
  const slug = def?.slug;
  if (typeof slug !== "string" || !cfg.slugs.has(slug)) return "route not eligible";
  if (typeof def.quote === "function" || typeof def.tierQuote === "function" || def.metered) return "metered route";
  if (hasLastingEffect(slug) || def.spendsOwnWallet === true) return "lasting effect";
  if (identityBound(def)) return "identity-bound route";
  if (isLongRunningSlug(slug) || asyncProfileOf(def)) return "long-running route";
  const micro = listMicroOf(def);
  if (!(micro > 0)) return "no price";
  if (micro > cfg.maxMicro) return "over the price cap";
  return null;
}

export { allowanceOf, allowanceServed };

/** A call that asks for a share link takes no grant while sharing is on: the
 *  link is written only on a settled 200. With sharing off the handler ignores
 *  `share`, so asking for it costs nothing. */
export function shareBlocksGrant(input) { return answerShareEnabled() && wantsShare(input?.share); }

const isOurs = (payer) => {
  const p = String(payer || "").toLowerCase();
  if (!p) return true;
  if (OUR_EVM_WALLETS.has(p)) return true;
  const treasury = String(process.env.WALLET_ADDRESS || "").trim().toLowerCase();
  return Boolean(treasury) && p === treasury;
};
const dayOf = (now) => new Date(now).toISOString().slice(0, 10);
const keysFor = (payer, ip, now) => {
  const day = dayOf(now);
  return {
    wallet: keyOf("fca-w", payer),
    usd: keyOf("fca-usd", day),
    count: keyOf("fca-n", day),
    ip: keyOf("fca-ip", `${day}:${hangupKeyDigest(`ip:${ip}`).slice(3)}`),
  };
};

// KEYS: wallet, usd, count, ip. ARGV: token, micro, dailyCap, ipCap, ttl, claimTtl.
// All checks, then all writes: two concurrent first calls queue on Redis and
// only the first finds the wallet key absent.
const CLAIM = `
if redis.call('EXISTS', KEYS[1]) == 1 then return {0, 'wallet already granted'} end
local micro = tonumber(ARGV[2])
local usd = tonumber(redis.call('GET', KEYS[2]) or '0')
if usd + micro > tonumber(ARGV[3]) then return {0, 'daily cap'} end
local ip = tonumber(redis.call('GET', KEYS[4]) or '0')
if ip + 1 > tonumber(ARGV[4]) then return {0, 'address cap'} end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[6])
redis.call('INCRBY', KEYS[2], micro)
redis.call('EXPIRE', KEYS[2], ARGV[5])
redis.call('INCR', KEYS[3])
redis.call('EXPIRE', KEYS[3], ARGV[5])
redis.call('INCR', KEYS[4])
redis.call('EXPIRE', KEYS[4], ARGV[5])
return {1, ''}`;
// Release a claim that was not served: the wallet key only while it still
// holds this claim's token, and each counter back, never below zero.
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
local micro = tonumber(ARGV[2])
local usd = tonumber(redis.call('GET', KEYS[2]) or '0')
if usd > 0 then redis.call('SET', KEYS[2], math.max(0, usd - micro), 'KEEPTTL') end
local n = tonumber(redis.call('GET', KEYS[3]) or '0')
if n > 0 then redis.call('DECR', KEYS[3]) end
local ip = tonumber(redis.call('GET', KEYS[4]) or '0')
if ip > 0 then redis.call('DECR', KEYS[4]) end
return 1`;
// Keep a served grant's wallet key for the long TTL: when it still holds
// this claim's token, or when the claim's own TTL already ran out.
const COMMIT = `
local v = redis.call('GET', KEYS[1])
if v == ARGV[1] or not v then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) end
return 1`;

/** `p` within `ms` of loop time (src/loop-deadline.js), else a rejection: no
 *  store or RPC read here waits longer, and an answer that landed while the
 *  loop was held is read, not taken for one that did not come. */
function within(p, ms) {
  return withLoopTimeout(p, ms, () => new Error("timed out"));
}
async function sharedClient() {
  try { return (await within(getSharedRedisClient(), OP_MS())) || null; } catch { return null; }
}
async function evalBounded(script, keys, args) {
  const c = await sharedClient();
  if (!c) return { ok: false, error: "shared store unavailable" };
  try {
    const value = await within(c.eval(script, { keys, arguments: args.map(String) }), OP_MS());
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

// This process's own counts for the operator view (the caps are on Redis).
let lastStoreError = null;
let deniedToday = { day: "", byReason: {} };
// Refusals of NEW wallets only (no paid sale on the books, not ours), by
// reason and route, so a refusal count is not swamped by returning buyers who
// could never take a grant. `unclassified` counts refusals whose payer could
// not be read cheaply (another rail, no signed payer, an async ledger seam).
// Slugs come from the catalog, never from input; still at most
// NEW_WALLET_SLUG_CAP per reason, the rest folded into "other". No payer
// address is kept.
export const NEW_WALLET_SLUG_CAP = 50;
let newWalletDeniedToday = { day: "", byReason: {}, unclassified: {} };
let lifecycleToday = { day: "", claimed: 0, served: 0, released: 0 };
function noteDenied(reason, now, slug = null, payerClass = "unknown") {
  const day = dayOf(now);
  if (deniedToday.day !== day) deniedToday = { day, byReason: {} };
  deniedToday.byReason[reason] = (deniedToday.byReason[reason] || 0) + 1;
  if (newWalletDeniedToday.day !== day) newWalletDeniedToday = { day, byReason: {}, unclassified: {} };
  if (payerClass === "unknown") {
    newWalletDeniedToday.unclassified[reason] = (newWalletDeniedToday.unclassified[reason] || 0) + 1;
    return;
  }
  if (payerClass !== "new") return;
  const row = newWalletDeniedToday.byReason[reason] || (newWalletDeniedToday.byReason[reason] = { total: 0, bySlug: {} });
  row.total++;
  const s = typeof slug === "string" && slug ? slug : "other";
  const k = Object.hasOwn(row.bySlug, s) || Object.keys(row.bySlug).length < NEW_WALLET_SLUG_CAP ? s : "other";
  row.bySlug[k] = (row.bySlug[k] || 0) + 1;
}

/** The signed payer of a plain x402 EVM exact payment, read as the grant path
 *  reads it, or `{ why }` naming the refusal. No store or RPC read. */
function plainEvmExactPayer(req) {
  // Plain x402 EVM exact only: the request carries a payment header the x402
  // paywall verified, and no other gate (Tempo, Stripe, credits, the MPP shim)
  // took it. Permit2 and the Gateway batched option are excluded by shape.
  if (req.tempoSettled || req.stripeSettled || req.creditsSettled || req.mppCredential) return { why: "rail" };
  const header = paymentHeaderOf(req);
  if (!header || paymentSchemeOf(req) !== "exact" || isGatewayBatchedRequest(req)) return { why: "rail" };
  let payload = null;
  try { payload = decodePaymentHeader(header); } catch { payload = null; }
  if (!payload?.payload?.authorization || payload?.payload?.permit2Authorization) return { why: "rail" };
  const network = String(payload?.accepted?.network ?? payload?.network ?? "");
  if (!network.startsWith("eip155:")) return { why: "rail" };
  const payer = payerFromRequest(req);
  if (!payer) return { why: "no signed payer" };
  return { why: null, header, network, payer };
}

/** Whether a refused request's payer is "new", "returning", "ours" or
 *  "unknown". Reads the ledger only through a synchronous `hasPaidSale` (the
 *  server's is an in-memory SQLite read); an async one is never called here and
 *  the payer reads "unknown". Never reads the grant records. */
function payerClassOf(req, { payer = undefined, synthetic = false, hasPaidSale } = {}) {
  try {
    const p = payer === undefined ? plainEvmExactPayer(req).payer : payer;
    if (!p) return "unknown";
    if (synthetic || isOurs(p)) return "ours";
    if (typeof hasPaidSale !== "function" || hasPaidSale.constructor?.name === "AsyncFunction") return "unknown";
    const v = hasPaidSale(p);
    if (v && typeof v.then === "function") { v.then(() => {}, () => {}); return "unknown"; }
    return v ? "returning" : "new";
  } catch { return "unknown"; }
}
function noteLifecycle(what, now) {
  const day = dayOf(now);
  if (lifecycleToday.day !== day) lifecycleToday = { day, claimed: 0, served: 0, released: 0 };
  lifecycleToday[what]++;
}

// Claimed grants by the payment that carries them: network, signed payer and
// EIP-3009 nonce, the identity the settle hook can read from the payment
// payload it is handed. The hook decides from this, not from finding the
// request, so a vendor change to how the request reaches hooks can never
// settle a call whose answer already says nothing was charged. One process
// claims and settles one request, so the map is this process's own; an entry
// leaves when its response ends, and a stale one (a response that never
// ended) after CLAIM_TTL_MS.
const claimsByPayment = new Map();
/** `network|payer|nonce`, lowercased, or null when the parts are not there. */
export function allowancePaymentKey(network, from, nonce) {
  const n = String(network || "").toLowerCase(), f = String(from || "").toLowerCase(), x = String(nonce || "").toLowerCase();
  if (!n.startsWith("eip155:") || !/^0x[0-9a-f]{40}$/.test(f) || !/^0x[0-9a-f]{1,128}$/.test(x)) return null;
  return `${n}|${f}|${x}`;
}
function paymentKeyOfCtx(ctx) {
  const p = ctx?.paymentPayload;
  const auth = p?.payload?.authorization;
  return allowancePaymentKey(p?.accepted?.network ?? p?.network ?? ctx?.requirements?.network, auth?.from, auth?.nonce);
}
function pruneClaims(now) {
  for (const [k, a] of claimsByPayment) if (now - a.claimedAt > CLAIM_TTL_MS) claimsByPayment.delete(k);
}

function store(req, a) {
  Object.defineProperty(req, STATE, { value: a, writable: true, configurable: true, enumerable: false });
  return a;
}

/**
 * Ask for a grant for a paid request whose handler is next. Always resolves
 * to the state it stored on the request ({ granted, reason }); never throws.
 * `ip` is req.ip; `synthetic` marks our own probes. Test seams: `hasPaidSale`,
 * `readBalance`.
 */
export async function claimFirstCallAllowance(req, res, def, { ip = null, synthetic = false, hasPaidSale = () => false, readBalance = readTokenBalance, now = Date.now() } = {}) {
  const cfg = firstCallAllowanceConfig();
  const a = { granted: false, state: "denied", reason: null, payer: null, micro: 0, keys: null, token: null, slug: def?.slug || null, done: false };
  // `who` classifies the payer for the new-wallet counts: a function, called
  // only on a refusal, so a granted call does no extra read.
  const deny = (reason, who = () => payerClassOf(req, { synthetic, hasPaidSale })) => {
    a.reason = reason;
    noteDenied(reason, now, a.slug, typeof who === "function" ? who() : who);
    return store(req, a);
  };
  if (!cfg.enabled) { a.reason = "off"; return store(req, a); }
  const routeWhy = allowanceRouteRefusal(def, cfg);
  if (routeWhy) return deny(routeWhy);
  if (!(cfg.dailyMicro > 0)) return deny("daily cap");
  const rail = plainEvmExactPayer(req);
  if (rail.why) return deny(rail.why, "unknown");
  const { header, network, payer } = rail;
  const known = () => payerClassOf(req, { payer, synthetic, hasPaidSale });
  if (wantsAsync(req) || req.headers?.[LOOPBACK_HEADER] || req.body?.stream === true) return deny("async or streamed", known);
  if (synthetic || isOurs(payer)) return deny("own wallet", "ours");
  if (typeof ip !== "string" || !ip) return deny("no client address", known);
  // A share link is written only on a settled 200: a grant would hand out a
  // link that is never written.
  let input = null;
  try { input = handlerInputOf(req, def); } catch { input = null; }
  if (!input) return deny("input", known);
  if (shareBlocksGrant(input)) return deny("share", known);
  let paid = true;
  try { paid = Boolean(await hasPaidSale(payer)); } catch { paid = true; }
  if (paid) return deny("paid before", "returning");
  if (stateDbEnabled()) {
    let seen = true;
    try { seen = (await records.get(RECORD_COLLECTION, payer)) != null; } catch { seen = true; }
    if (seen) return deny("wallet already granted", "returning");
  }
  // From here the payer is known new: no paid sale and no grant record.
  const fresh = "new";
  const terms = coverTermsOf(header);
  if (!terms || terms.payer !== payer) return deny("rail", fresh);
  // The settle hook finds the grant by this identity: a payment without one
  // is never granted.
  const ident = paymentNonceIdentityOf(req);
  const paymentKey = ident && ident.from === payer ? allowancePaymentKey(ident.network, ident.from, ident.nonce) : null;
  if (!paymentKey) return deny("rail", fresh);
  // The cheap caps first (one Redis script): a spent cap, a used address or a
  // granted wallet is refused with no RPC read.
  const micro = listMicroOf(def);
  const keys = keysFor(payer, ip, now);
  const token = `claim:${createHash("sha256").update(`${payer}:${now}:${Math.random()}`).digest("hex").slice(0, 16)}`;
  const r = await evalBounded(CLAIM, [keys.wallet, keys.usd, keys.count, keys.ip], [token, micro, cfg.dailyMicro, cfg.ipPerDay, DAY_TTL_SECONDS, CLAIM_TTL_SECONDS]);
  if (!r.ok) { lastStoreError = r.error; return deny("store unavailable", fresh); }
  lastStoreError = null;
  if (Number(r.value?.[0]) !== 1) {
    const why = String(r.value?.[1] || "refused");
    // A wallet key on the store is a wallet granted before: not new.
    return deny(why, why === "wallet already granted" ? "returning" : fresh);
  }
  // The balance must cover the call: verify proved it at verify time; this
  // read refuses a wallet that cannot be read in time or does not hold the
  // price, and gives the claim back.
  let balance = null;
  try { balance = await within(readBalance({ network: terms.network, asset: terms.asset, payer }), cfg.balanceReadMs); } catch { balance = null; }
  if (typeof balance !== "bigint" || balance < terms.atomic) {
    const back = await evalBounded(RELEASE, [keys.wallet, keys.usd, keys.count, keys.ip], [token, micro]);
    if (!back.ok) lastStoreError = back.error;
    return deny("balance", fresh);
  }
  Object.assign(a, { granted: true, state: "claimed", payer, micro, keys, token, network, res, paymentKey, claimedAt: now });
  store(req, a);
  pruneClaims(now);
  claimsByPayment.set(paymentKey, a);
  noteLifecycle("claimed", now);
  // No receipt on a served grant: nothing settled. Dropped at the source so
  // no reader of the header can mistake the call for a settlement.
  const origSetHeader = res.setHeader;
  res.setHeader = function allowanceSetHeader(name, value) {
    if (a.state === "served" && typeof name === "string" && /^(x-)?payment-response$/i.test(name)) return this;
    return origSetHeader.call(this, name, value);
  };
  // The body says so where the route answers a JSON object. Added only to a
  // 200, the one status whose settlement the hook skips.
  const origJson = res.json;
  res.json = function allowanceJson(body) {
    if (a.state === "claimed" && res.statusCode === 200 && body && typeof body === "object" && !Array.isArray(body) && !Object.hasOwn(body, ALLOWANCE_BODY_FIELD)) {
      body = { ...body, [ALLOWANCE_BODY_FIELD]: { granted: true, charged: false, note: ALLOWANCE_NOTE } };
    }
    return origJson.call(this, body);
  };
  return a;
}

/**
 * The x402 onBeforeSettle decision: the protocol's `skip` with an unsettled
 * result for a payment holding a claimed grant whose answer is a 200, else
 * undefined (settle as usual). The grant is found by the payment's own
 * identity (network, signed payer, nonce) from the payload the hook is
 * handed; only when the payload has no readable identity is the request
 * looked up (transportContext.request.adapter.req), and a request found
 * holding a claimed grant is then skipped too. Either way a call whose answer
 * says nothing was charged is never settled.
 */
export function allowanceSettleDecision(ctx) {
  const key = paymentKeyOfCtx(ctx);
  let a = key ? claimsByPayment.get(key) || null : null;
  if (!a && !key) a = allowanceOf(ctx?.transportContext?.request?.adapter?.req);
  if (!a || a.state !== "claimed") return undefined;
  // A different request carrying the same signed payment (refused upstream by
  // the idempotency and replay claims, so not expected here) settles as usual:
  // the grant belongs to the request that claimed it.
  const seen = ctx?.transportContext?.request?.adapter?.req;
  if (seen && typeof seen === "object" && allowanceOf(seen) !== a) return undefined;
  const res = a.res;
  if (!res || res.statusCode !== 200) return undefined;
  const network = String(ctx?.requirements?.network || a.network || "");
  a.state = "served";
  try { res.setHeader(ALLOWANCE_HEADER, ALLOWANCE_HEADER_VALUE); } catch { /* headers already out: the body field still says so */ }
  return { skip: true, result: { success: true, transaction: "", network, payer: a.payer } };
}

/** Register the skip. Must run after the hooks that abort a settle (the
 *  wallet blocklist, client-gone) and before the authorization claim, so a
 *  skipped settle never holds or consumes the authorization's settle claim. */
export function registerFirstCallAllowanceSettleHook(server) {
  server.onBeforeSettle((ctx) => {
    try { return allowanceSettleDecision(ctx); } catch { return undefined; }
  });
  return server;
}

/**
 * Close a request's grant when its response ends, however it ends: a served
 * one is kept (the wallet key marked granted, a record written with the state
 * database), any other is given back. Idempotent; never throws.
 */
export async function finishFirstCallAllowance(req, { now = Date.now() } = {}) {
  const a = allowanceOf(req);
  if (!a || !a.granted || a.done) return false;
  a.done = true;
  if (a.paymentKey && claimsByPayment.get(a.paymentKey) === a) claimsByPayment.delete(a.paymentKey);
  a.res = null;
  const k = a.keys;
  if (a.state === "served") {
    await evalBounded(COMMIT, [k.wallet], [a.token, `granted:${now}`, firstCallAllowanceConfig().walletTtlSeconds]);
    if (stateDbEnabled()) {
      // The grant's time is its claim, not this finish: a paid call the
      // wallet made while a slow free call ran is booked between the two,
      // and it is a sale after the grant (the returning-payers figure reads
      // sales strictly after this time). The claim found no paid sale.
      const grantedAt = Number.isFinite(a.claimedAt) ? a.claimedAt : now;
      try { await records.put(RECORD_COLLECTION, a.payer, { grantedAt: new Date(grantedAt).toISOString(), slug: a.slug, network: a.network }); }
      catch (e) { lastStoreError = `record: ${String(e?.message || e).slice(0, 80)}`; }
    }
    noteLifecycle("served", now);
    console.log(`[allowance] first-call grant served on ${a.slug} (${a.network}); settlement skipped, nothing charged`);
    return true;
  }
  const r = await evalBounded(RELEASE, [k.wallet, k.usd, k.count, k.ip], [a.token, a.micro]);
  if (!r.ok) lastStoreError = r.error;
  a.state = "released";
  noteLifecycle("released", now);
  return true;
}

// Returning grant holders, for the operator view only: of the wallets with a
// served grant (the permanent records), how many later made an outside paid
// sale on any route, and how many did so within RETURN_WINDOW_MS of the grant.
// A sale at the grant's own moment or before it never counts. Cached for
// RETURNED_CACHE_MS (FIRST_CALL_ALLOWANCE_RETURNED_CACHE_MS), one computation in flight at a time; grants are read a
// page at a time up to RETURNED_MAX_GRANTS, and the ledger is asked once per
// chunk of wallets (src/sales-ledger.js firstPaidSaleAfterAsync).
export const RETURN_WINDOW_MS = 7 * 86_400_000;
export const RETURNED_CACHE_MS = 5 * 60_000;
const RETURNED_PAGE = 1_000;
const RETURNED_MAX_GRANTS = 100_000;
let returnedCache = null;
let returnedInflight = null;

/** Every served grant as [{ payer, grantedAtMs }] (state database records;
 *  none without it), at most RETURNED_MAX_GRANTS. */
export async function listServedGrants({ max = RETURNED_MAX_GRANTS } = {}) {
  if (!stateDbEnabled()) return { grants: [], complete: true };
  const grants = [];
  let after = "";
  for (;;) {
    const page = await records.list(RECORD_COLLECTION, { limit: RETURNED_PAGE, after });
    for (const r of page) {
      if (grants.length >= max) return { grants, complete: false };
      grants.push({ payer: r.id, grantedAtMs: Date.parse(r.body?.grantedAt) });
    }
    if (page.length < RETURNED_PAGE) return { grants, complete: true };
    after = page[page.length - 1].id;
  }
}

/** Compute the figure from a grant list and the ledger reader (test seams). */
export async function computeReturnedPayers({ listGrants = listServedGrants, firstPaidAfter, now = Date.now() } = {}) {
  const listed = await listGrants();
  const byPayer = new Map();
  for (const g of listed?.grants || []) {
    const payer = normalizePayerAddress(g?.payer);
    const t = Number(g?.grantedAtMs);
    if (!payer || !Number.isFinite(t)) continue;
    // One grant per wallet; a duplicate keeps the earliest.
    if (!byPayer.has(payer) || t < byPayer.get(payer)) byPayer.set(payer, t);
  }
  const grants = [...byPayer].map(([payer, grantedAtMs]) => ({ payer, grantedAtMs }));
  const first = grants.length ? await firstPaidAfter(grants) : new Map();
  let paidAgain = 0, paidAgainWithin7d = 0, since = Infinity;
  for (const g of grants) {
    since = Math.min(since, g.grantedAtMs);
    const ts = Number(first?.get?.(g.payer));
    // The ledger is asked for sales strictly after the grant; checked again
    // here so a reader that returns the free call's own moment never counts it.
    if (!Number.isFinite(ts) || !(ts > g.grantedAtMs)) continue;
    paidAgain++;
    if (ts - g.grantedAtMs <= RETURN_WINDOW_MS) paidAgainWithin7d++;
  }
  return {
    granted: grants.length,
    paidAgain,
    paidAgainWithin7d,
    sinceIso: Number.isFinite(since) ? new Date(since).toISOString() : null,
    asOf: new Date(now).toISOString(),
    complete: listed?.complete !== false,
  };
}

/** The cached figure: the same object within RETURNED_CACHE_MS of its
 *  computation, recomputed after it. A failed computation is not cached. */
export async function returnedPayersStatus({ now = Date.now(), cacheMs = envNumber("FIRST_CALL_ALLOWANCE_RETURNED_CACHE_MS", RETURNED_CACHE_MS), ...seams } = {}) {
  if (returnedCache && now - returnedCache.at < cacheMs) return returnedCache.value;
  if (!returnedInflight) {
    returnedInflight = computeReturnedPayers({ ...seams, now })
      .then((value) => { returnedCache = { at: now, value }; return value; })
      .finally(() => { returnedInflight = null; });
  }
  return returnedInflight;
}

/** Operator figures (micro-dollars rounded to USD) and the public word.
 *  `returned` (operator view only) adds `returnedPayers`: its value is the
 *  ledger reader, firstPaidSaleAfterAsync, passed in so this module never
 *  loads the sales ledger. Reported whether the switch is on or off. */
export async function firstCallAllowanceStatus({ now = Date.now(), returned = null } = {}) {
  const cfg = firstCallAllowanceConfig();
  const out = {
    enabled: cfg.enabled,
    dailyCapUsd: cfg.dailyMicro / MICRO,
    maxPriceUsd: cfg.maxMicro / MICRO,
    perAddressPerDay: cfg.ipPerDay,
    routes: [...cfg.slugs].sort(),
    today: null,
    deniedToday: deniedToday.day === dayOf(now) ? { ...deniedToday.byReason } : {},
    newWalletDeniedToday: newWalletDeniedToday.day === dayOf(now)
      ? Object.fromEntries(Object.entries(newWalletDeniedToday.byReason).map(([r, v]) => [r, { total: v.total, bySlug: { ...v.bySlug } }]))
      : {},
    unclassifiedDeniedToday: newWalletDeniedToday.day === dayOf(now) ? { ...newWalletDeniedToday.unclassified } : {},
    processToday: lifecycleToday.day === dayOf(now) ? { claimed: lifecycleToday.claimed, served: lifecycleToday.served, released: lifecycleToday.released } : { claimed: 0, served: 0, released: 0 },
    lastStoreError,
    status: "off",
  };
  if (returned) {
    const seams = typeof returned === "function" ? { firstPaidAfter: returned } : returned;
    out.returnedPayers = await returnedPayersStatus({ ...seams, now }).catch((e) => ({ error: String(e?.message || e).slice(0, 120) }));
  }
  if (!cfg.enabled) return out;
  // Bounded like the claim: a hung store reads "unavailable" within OP_MS.
  const c = await sharedClient();
  if (!c) { out.status = "unavailable"; return out; }
  try {
    const day = dayOf(now);
    const [usd, n] = await within(Promise.all([c.get(keyOf("fca-usd", day)), c.get(keyOf("fca-n", day))]), OP_MS());
    const usdMicro = Number(usd) || 0;
    out.today = { day, grants: Number(n) || 0, usd: usdMicro / MICRO };
    out.status = !(cfg.dailyMicro > 0) || usdMicro >= cfg.dailyMicro ? "spent" : "on";
  } catch (e) {
    out.status = "unavailable";
    out.lastStoreError = String(e?.message || e).slice(0, 120);
  }
  return out;
}

/** Test seam: how many claimed payments this process holds. */
export function _allowanceClaimsHeld() { return claimsByPayment.size; }
/** Test seam. */
export function _resetFirstCallAllowance() { claimsByPayment.clear(); returnedCache = null; returnedInflight = null; lastStoreError = null; deniedToday = { day: "", byReason: {} }; newWalletDeniedToday = { day: "", byReason: {}, unclassified: {} }; lifecycleToday = { day: "", claimed: 0, served: 0, released: 0 }; }

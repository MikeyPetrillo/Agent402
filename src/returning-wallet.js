// A lower price for a returning wallet, by wallet hint.
//
// OFF unless RETURNING_WALLET_PRICE=on. A buyer names its wallet in the
// request header X-Agent402-Wallet. When that wallet has paid on enough
// distinct days (RETURNING_WALLET_MIN_PAID_DAYS, default 3, inside
// RETURNING_WALLET_WINDOW_DAYS, default 30), the 402 of that same call quotes
// the route's x402 EVM `exact` accepts at a discount
// (RETURNING_WALLET_DISCOUNT_BPS, default 1000 = 10%). Every other accept, and
// every surface that publishes a price, stays at list. The discount is taken
// from the route's LIST price; a chain's premium is added and its price floor
// applied afterwards, as for any quote, so a chain at its floor quotes the
// same amount either way and the 402 names it (`atListOn`) instead of saying
// the discount was applied there.
//
// THE HINT IS PROVEN BEFORE IT IS READ. A request's hint is read against the
// ledger only when the same request proves control of that wallet in the
// X-Agent402-Wallet-Proof header: `<unix seconds>.<signature>`, the wallet's
// EIP-191 (personal_sign) signature over walletProofMessage (five lines that
// name this server's host name, the route as METHOD and path, the wallet in
// lowercase and the same seconds), within PROOF_SKEW_SECONDS of this server's
// clock either way. A proof is good for one request that carries no payment
// and one that carries a payment (the quote and its signed retry, which
// resends the same headers); any other use is refused. A request without a
// valid proof is quoted list and its 402 reads `why: "unproven"` whatever the
// wallet's history, so the answer about a wallet nobody proved is the same
// for every wallet, and the ledger is not read for it.
//
// THE HINT IS STILL A CLAIM. It only ever changes a QUOTE. On the paid request the
// price is decided again, from the payment itself: the discount stands only
// when the EIP-3009 authorization the request carries is signed FROM the
// hinted wallet (and that wallet still qualifies). Any other payer is priced
// at list, so a payment signed for the discounted amount by another wallet no
// longer matches the route's requirement: the gate answers 402 with the list
// price, before the facilitator is asked and with nothing charged. The
// facilitator's verify then proves the signature belongs to that `from`, and a
// last check before the settle refuses a discounted settle whose proven payer
// is not the wallet the discount was given to. So a discounted charge is
// always a charge to a wallet that qualified, and a sale is booked at what
// that wallet signed (src/paid-price.js).
//
// Never discounted: a route priced per request (a quote or a tier quote), a
// metered route (src/metered-slugs.js: an upstream is paid per call), a route
// whose effect outlives the answer or that spends this host's own wallet, a
// route sold on the referral routes (REFERRAL_SLUGS, read as written: a
// referral copy is sold at the public route's price, so the public route
// never undercuts it), and our own wallets.
//
// The paid-days read is the sales ledger's, handed in by the server
// (configureReturningWallet), cached per wallet for CACHE_MS and then dropped
// from memory (nothing here is written to a store), and bounded per minute
// twice: one client address (an IPv6 one folded to its /64) causes at most
// LOOKUPS_PER_ADDRESS_PER_MINUTE fresh reads, and all callers together
// LOOKUPS_PER_MINUTE. Past either bound an unknown wallet is quoted list,
// never refused, and a wallet already read keeps its quote: one caller naming
// unused wallets spends its own share, not everyone's.
import { METERED_SLUGS } from "./metered-slugs.js";
import { hasLastingEffect } from "./lasting-effect-slugs.js";
import { payerFromRequest, paymentHeaderOf, paymentSchemeOf } from "./payer.js";
import { decodePaymentHeader } from "./payment-header.js";
import { limiterKey } from "./rate-limit.js";
import { recoverMessageAddress } from "viem";

export const WALLET_HINT_HEADER = "X-Agent402-Wallet";
/** The request header that proves control of the hinted wallet (see the head of this file). */
export const WALLET_PROOF_HEADER = "X-Agent402-Wallet-Proof";
/** How far a proof's time may sit from this server's clock, either way. */
export const PROOF_SKEW_SECONDS = 300;
/** Most proofs whose uses are kept at once; past it a new proof is refused (quoted list) until old ones expire. */
export const PROOF_SEEN_MAX = 20_000;
export const RETURNING_WALLET_DEFAULTS = Object.freeze({ discountBps: 1000, minPaidDays: 3, windowDays: 30 });
/** The largest discount a setting can name (a malformed or larger value reads as the default). */
export const RETURNING_WALLET_MAX_BPS = 5000;
export const CACHE_MS = 10 * 60_000;
export const CACHE_MAX = 5000;
/** Fresh (uncached) ledger reads per minute, all callers together; past it an unknown wallet is quoted list. */
export const LOOKUPS_PER_MINUTE = 600;
/** Fresh ledger reads one client address may cause per minute (its share of the bound above). */
export const LOOKUPS_PER_ADDRESS_PER_MINUTE = 30;
/** Most client addresses counted apart in one minute; the rest share one count. */
const ADDRESS_KEYS_MAX = 5000;
/** The most bytes the 402's `returningWalletPrice` value takes, in any shape and at any setting. */
export const OFFER_MAX_BYTES = 126;
export const RETURNING_WALLET_MISMATCH = "returning_wallet_mismatch";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const intEnv = (env, name, dflt, { min, max }) => {
  const raw = String(env[name] ?? "").trim();
  if (raw === "") return dflt;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
};

/** Call-time config. A malformed value reads as the default, never as a deeper discount or a lower bar. */
export function returningWalletConfig(env = process.env) {
  return {
    enabled: String(env.RETURNING_WALLET_PRICE ?? "").trim().toLowerCase() === "on",
    discountBps: intEnv(env, "RETURNING_WALLET_DISCOUNT_BPS", RETURNING_WALLET_DEFAULTS.discountBps, { min: 1, max: RETURNING_WALLET_MAX_BPS }),
    minPaidDays: intEnv(env, "RETURNING_WALLET_MIN_PAID_DAYS", RETURNING_WALLET_DEFAULTS.minPaidDays, { min: 1, max: 365 }),
    windowDays: intEnv(env, "RETURNING_WALLET_WINDOW_DAYS", RETURNING_WALLET_DEFAULTS.windowDays, { min: 1, max: 365 }),
  };
}
export function returningWalletEnabled(env = process.env) { return returningWalletConfig(env).enabled; }

/** The slugs sold on the referral routes, as the operator wrote them. */
function referralSlugs(env = process.env) {
  return new Set(String(env.REFERRAL_SLUGS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

/** Why this catalog route is never discounted, or null when it can be. */
export function returningWalletRouteRefusal(def, env = process.env) {
  const slug = def?.slug;
  if (typeof slug !== "string" || !slug) return "no route";
  if (typeof def.quote === "function" || typeof def.tierQuote === "function" || def.metered) return "priced per request";
  if (METERED_SLUGS.has(slug) || def.modelBacked === true) return "an upstream is paid per call";
  if (hasLastingEffect(slug) || def.spendsOwnWallet === true || def.paysThirdPartySeller === true) return "lasting effect";
  if (referralSlugs(env).has(slug)) return "sold on the referral routes";
  if (listMicroOf(def.price) === null) return "no price";
  return null;
}

const listMicroOf = (price) => {
  const m = /^\$(\d+(?:\.\d+)?)$/.exec(String(price ?? ""));
  if (!m) return null;
  const micro = Math.round(Number(m[1]) * 1e6);
  return micro > 0 ? micro : null;
};
/**
 * "$0.001" at 1000 bps -> "$0.0009". Whole micro-dollars, rounded UP, at
 * least one micro-dollar, and never above list. A price this cannot read is
 * returned unchanged.
 */
export function discountedPrice(price, bps) {
  const micro = listMicroOf(price);
  const b = Number(bps);
  if (micro === null || !Number.isInteger(b) || b <= 0 || b > RETURNING_WALLET_MAX_BPS) return price;
  const off = Math.max(1, Math.min(micro, Math.ceil((micro * (10_000 - b)) / 10_000)));
  return "$" + (off / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * The text a wallet signs (EIP-191 personal_sign) to prove the hint: `host` is
 * this server's host name (from BASE_URL), `route` the route as METHOD and
 * path ("POST /api/hash"), `wallet` the address in lowercase, `time` unix
 * seconds (the same number the header carries).
 */
export function walletProofMessage({ host, route, wallet, time }) {
  return `Agent402 returning-wallet price\nhost: ${String(host).toLowerCase()}\nroute: ${route}\nwallet: ${String(wallet).toLowerCase()}\ntime: ${time}`;
}
/** The header value for a proof: `<unix seconds>.<signature>`. */
export function walletProofHeader(time, signature) { return `${time}.${signature}`; }

/** The wallet a request names in its hint header (lowercased), or null. */
export function walletHintOf(req) {
  const raw = req?.headers?.[WALLET_HINT_HEADER.toLowerCase()];
  const v = typeof raw === "string" ? raw.trim() : "";
  return ADDR.test(v) ? v.toLowerCase() : null;
}

// ---- the paid-days read (the server's sales ledger), cached and bounded ----
let paidDaysOf = null;
let isOursFn = () => false;
let serverHost = null;
/** Hand in the ledger read (wallet, sinceMs) => distinct paid days, the own-wallet
 *  check, and this server's host name (a proof names it; with none set no proof holds). */
export function configureReturningWallet({ paidDays = null, isOurs = null, host = null } = {}) {
  paidDaysOf = typeof paidDays === "function" ? paidDays : null;
  isOursFn = typeof isOurs === "function" ? isOurs : () => false;
  serverHost = typeof host === "string" && host.trim() ? host.trim().toLowerCase() : null;
}
const cache = new Map(); // wallet -> { at, days, window }, oldest read first
const byAddress = new Map(); // client address -> fresh reads this minute
let minute = 0, lookups = 0, sweeper = null;
const counters = { hinted: 0, unproven: 0, quotedDiscount: 0, paidDiscount: 0, paidOtherWallet: 0, notQualified: 0, lookupsHeld: 0, lookupsHeldAddress: 0, settleRefused: 0 };

/** Drop every wallet whose cache window is over (the map is in read order). */
export function sweepReturningWallet(now = Date.now()) {
  for (const [wallet, hit] of cache) {
    if (now - hit.at < CACHE_MS) break;
    cache.delete(wallet);
  }
}
const HELD = Symbol("held");
/**
 * Distinct paid days of a wallet inside the window; HELD when a bound holds
 * the read this minute, null when it cannot be read. `client` is the caller's
 * address key (null for a call that has none: the service-wide bound alone).
 */
function paidDays(wallet, cfg, now, client = null) {
  const hit = cache.get(wallet);
  if (hit && now - hit.at < CACHE_MS && hit.window === cfg.windowDays) return hit.days;
  if (typeof paidDaysOf !== "function") return null;
  const m = Math.floor(now / 60_000);
  if (m !== minute) { minute = m; lookups = 0; byAddress.clear(); }
  const key = client === null ? null : byAddress.has(client) || byAddress.size < ADDRESS_KEYS_MAX ? client : "*";
  if (key !== null && (byAddress.get(key) || 0) >= LOOKUPS_PER_ADDRESS_PER_MINUTE) { counters.lookupsHeldAddress++; return HELD; }
  if (lookups >= LOOKUPS_PER_MINUTE) { counters.lookupsHeld++; return HELD; }
  lookups++;
  if (key !== null) byAddress.set(key, (byAddress.get(key) || 0) + 1);
  let days = null;
  try { days = Number(paidDaysOf(wallet, now - cfg.windowDays * 86_400_000)); } catch { days = null; }
  if (!Number.isFinite(days) || days < 0) return null;
  sweepReturningWallet(now);
  cache.delete(wallet);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(wallet, { at: now, days, window: cfg.windowDays });
  // A wallet nobody names again still leaves memory when its window is over.
  if (!sweeper) { sweeper = setInterval(() => sweepReturningWallet(), 30_000); sweeper.unref?.(); }
  return days;
}
/** "yes", "no", or "held" (a bound holds the read this minute). Our own wallets are "no". */
function qualification(wallet, { cfg, now, client = null }) {
  if (!ADDR.test(String(wallet || ""))) return "no";
  const w = String(wallet).toLowerCase();
  let ours = false;
  try { ours = isOursFn(w) === true; } catch { ours = true; }
  if (ours) return "no";
  const days = paidDays(w, cfg, now, client);
  if (days === HELD) return "held";
  return days !== null && days >= cfg.minPaidDays ? "yes" : "no";
}
/** Does this wallet qualify now? Our own wallets never do. */
export function walletQualifies(wallet, { cfg = returningWalletConfig(), now = Date.now(), client = null } = {}) {
  return qualification(wallet, { cfg, now, client }) === "yes";
}
/** The address key a request's fresh reads are counted under (an IPv6 address folded to its /64). */
const clientKeyOf = (req) => limiterKey(req?.ip || req?.socket?.remoteAddress || "-");

/** The signed payer of a plain x402 EVM exact payment on this request, `false`
 *  when the request carries a payment of another shape, null when it carries none. */
function signedExactPayer(req) {
  const header = paymentHeaderOf(req);
  if (!header) return null;
  if (req.tempoSettled || req.stripeSettled || req.creditsSettled || req.mppCredential) return false;
  if (paymentSchemeOf(req) !== "exact") return false;
  let payload = null;
  try { payload = decodePaymentHeader(header); } catch { payload = null; }
  if (!payload?.payload?.authorization || payload?.payload?.permit2Authorization) return false;
  if (!String(payload?.accepted?.network ?? payload?.network ?? "").startsWith("eip155:")) return false;
  const payer = payerFromRequest(req);
  return payer && ADDR.test(payer) ? payer.toLowerCase() : false;
}

// ---- the proof: checked once per request, each proof used at most twice ----
const PROOF = /^(\d{1,12})\.(0x[0-9a-fA-F]{130})$/;
const proving = new WeakMap(); // request -> the check in flight or done
const proven = new WeakMap(); // request -> { wallet, route } once its proof holds
const seenProofs = new Map(); // signature -> { unpaid, paid, expires }, oldest first
/** The route a proof names for this catalog entry: "METHOD /path". */
const routeOf = (def) => {
  const m = /^([A-Z]+)\s+(\/\S*)$/.exec(String(def?.route ?? "").trim());
  return m ? `${m[1]} ${m[2]}` : null;
};
/** Record one use of a proof; false when that use is spent or no room is left. */
function useProof(signature, paid, expires, now) {
  const key = signature.toLowerCase();
  let e = seenProofs.get(key);
  if (!e) {
    if (seenProofs.size >= PROOF_SEEN_MAX) for (const [k, v] of seenProofs) { if (v.expires > now) break; seenProofs.delete(k); }
    if (seenProofs.size >= PROOF_SEEN_MAX) return false;
    e = { unpaid: false, paid: false, expires };
    seenProofs.set(key, e);
  }
  const slot = paid ? "paid" : "unpaid";
  if (e[slot]) return false;
  e[slot] = true;
  return true;
}
/** The proof header's parts ({ time, signature }), or null when it is not that shape. */
export function walletProofShape(raw) {
  const m = typeof raw === "string" ? PROOF.exec(raw.trim()) : null;
  return m ? { time: m[1], signature: m[2] } : null;
}
async function checkProof(req, def, now) {
  const cfg = returningWalletConfig();
  if (!cfg.enabled || returningWalletRouteRefusal(def)) return;
  const hint = walletHintOf(req);
  const route = routeOf(def);
  const shape = walletProofShape(req?.headers?.[WALLET_PROOF_HEADER.toLowerCase()]);
  if (!hint || !route || !serverHost || !shape) return;
  const m = [null, shape.time, shape.signature];
  const time = Number(m[1]);
  if (!(Math.abs(now / 1000 - time) <= PROOF_SKEW_SECONDS)) return;
  let signer = null;
  try { signer = await recoverMessageAddress({ message: walletProofMessage({ host: serverHost, route, wallet: hint, time: m[1] }), signature: m[2] }); } catch { signer = null; }
  if (typeof signer !== "string" || signer.toLowerCase() !== hint) return;
  if (!useProof(m[2], paymentHeaderOf(req) != null, (time + PROOF_SKEW_SECONDS) * 1000, now)) return;
  proven.set(req, { wallet: hint, route });
}
/**
 * Check the request's wallet proof for this route (once per request; every
 * accept of one request shares it). Run before returningWalletQuote: a
 * decision made without it treats the hint as unproven.
 */
export function proveReturningWallet(req, def, { now = Date.now() } = {}) {
  if (!req || typeof req !== "object") return Promise.resolve();
  let p = proving.get(req);
  if (!p) { p = checkProof(req, def, now).catch(() => {}); proving.set(req, p); }
  return p;
}

const quotes = new WeakMap(); // request -> the decision, made once per request
/**
 * The decision for one request on one route, made once and kept on the
 * request: { applied, wallet, bps, price, why }. `applied` is true only when
 * the route is eligible, the hint names a wallet that qualifies and, on a
 * paid request, the payment is signed from that same wallet.
 */
export function returningWalletQuote(req, def, { now = Date.now() } = {}) {
  if (!req || typeof req !== "object") return { applied: false, why: "no request" };
  const kept = quotes.get(req);
  if (kept && kept.slug === def?.slug) return kept;
  const out = decide(req, def, now);
  out.slug = def?.slug || null;
  quotes.set(req, out);
  return out;
}
function decide(req, def, now) {
  const cfg = returningWalletConfig();
  if (!cfg.enabled) return { applied: false, why: "off" };
  const routeWhy = returningWalletRouteRefusal(def);
  if (routeWhy) return { applied: false, why: routeWhy };
  const hint = walletHintOf(req);
  if (!hint) return { applied: false, why: "no hint" };
  counters.hinted++;
  const signed = signedExactPayer(req);
  if (signed === false) return { applied: false, wallet: hint, why: "another payment shape" };
  if (signed !== null && signed !== hint) { counters.paidOtherWallet++; return { applied: false, wallet: hint, why: "paid from another wallet" }; }
  // Nothing about a wallet the request has not proven is read or said.
  const proof = proven.get(req);
  if (!proof || proof.wallet !== hint || proof.route !== routeOf(def)) { counters.unproven++; return { applied: false, wallet: hint, why: "unproven" }; }
  const qualifies = qualification(hint, { cfg, now, client: clientKeyOf(req) });
  if (qualifies === "held") return { applied: false, wallet: hint, why: "not read" };
  if (qualifies !== "yes") { counters.notQualified++; return { applied: false, wallet: hint, why: "not qualified" }; }
  const price = discountedPrice(def.price, cfg.discountBps);
  if (price === def.price) return { applied: false, wallet: hint, why: "no room" };
  if (signed === null) counters.quotedDiscount++; else counters.paidDiscount++;
  return { applied: true, wallet: hint, bps: cfg.discountBps, price, paid: signed !== null, why: null };
}
/** The decision already made for this request, or null. */
export function returningWalletOf(req) { return (req && typeof req === "object" && quotes.get(req)) || null; }
/**
 * The gate's note for one EVM exact accept of a discounted request: did the
 * quote on this network come out under its list quote? (A chain at its price
 * floor quotes the same amount.) Kept on the request's decision for the 402.
 */
export function noteReturningWalletAccept(req, network, lowered) {
  const q = returningWalletOf(req);
  if (!q || q.applied !== true || typeof network !== "string") return;
  (q.accepts ??= new Map()).set(network, lowered === true);
}

/**
 * Before a settle: a discounted request settles only for the wallet the
 * discount was given to. Returns { abort, reason } to refuse, else undefined.
 */
export function returningWalletSettleDecision(ctx) {
  const req = ctx?.transportContext?.request?.adapter?.req;
  const q = returningWalletOf(req);
  if (!q || q.applied !== true) return undefined;
  const from = String(ctx?.paymentPayload?.payload?.authorization?.from || "").toLowerCase();
  if (ADDR.test(from) && from === q.wallet) return undefined;
  counters.settleRefused++;
  return { abort: true, reason: RETURNING_WALLET_MISMATCH };
}

/** Why a named wallet's quote did not change, as the 402 says it (one word). */
const PUBLIC_WHY = Object.freeze({
  "unproven": "unproven", // no valid proof of the wallet on this request: quoted list, nothing read
  "not qualified": "unqualified", // under the paid-days bar (or not a wallet the offer is for)
  "not read": "lookup_busy", // the read is held this minute: quoted list, ask again shortly
  "paid from another wallet": "other_payer",
  "another payment shape": "other_rail", // not an x402 exact EIP-3009 payment on an EVM chain
  "no room": "min_price", // a list price too small to lower
});
/**
 * What the 402 of an eligible route says about the offer (null while off), in
 * fields and at most OFFER_MAX_BYTES: the header, the percentage and the bar;
 * `applied` true only when this request's quote is lower on at least one
 * accept; `why` when a named wallet's quote did not change; `atListOn` for
 * the chains whose price floor held the quote at list (the first that fit,
 * the rest counted in `atListMore`). The rule in prose is on /llms-full.txt
 * and in the route's OpenAPI operation.
 */
export function returningWalletOffer(def, req = null) {
  const cfg = returningWalletConfig();
  if (!cfg.enabled || returningWalletRouteRefusal(def)) return null;
  const q = req ? returningWalletOf(req) : null;
  const terms = { header: WALLET_HINT_HEADER, discountPercent: cfg.discountBps / 100 };
  const notApplied = (why) => ({ ...terms, minPaidDays: cfg.minPaidDays, windowDays: cfg.windowDays, applied: false, ...(why ? { why } : {}) });
  if (q?.applied !== true) return notApplied(PUBLIC_WHY[q?.why] || null);
  const noted = [...(q.accepts || [])];
  const atList = noted.filter(([, lowered]) => !lowered).map(([network]) => network);
  if (noted.length && atList.length === noted.length) return notApplied("price_floor");
  const out = { ...terms, applied: true };
  if (!atList.length) return out;
  out.atListOn = [];
  for (const network of atList) {
    const left = atList.length - out.atListOn.length - 1;
    const next = { ...out, atListOn: [...out.atListOn, network], ...(left > 0 ? { atListMore: left } : {}) };
    if (out.atListOn.length && JSON.stringify(next).length > OFFER_MAX_BYTES) break;
    out.atListOn.push(network);
  }
  if (atList.length > out.atListOn.length) out.atListMore = atList.length - out.atListOn.length;
  return out;
}

/**
 * What the hint header is read for and what is kept of it, in the words
 * /privacy and the service manifest's data handling both print (one source,
 * so the two cannot disagree): the named wallet and its count of paid days
 * sit in this process's cache for CACHE_MS, are dropped by the sweep, and
 * are never written to a store.
 */
export function returningWalletDataHandling() {
  return {
    read: `read against the sales ledger to decide that request's quote, only when the same request proves control of that wallet with a signature in the ${WALLET_PROOF_HEADER} header`,
    kept: `the address and its count of paid days are held in memory for about ${Math.round(CACHE_MS / 60_000)} minutes, and a used proof's signature until its ${Math.round(PROOF_SKEW_SECONDS / 60)}-minute window has passed, and neither is written to a store`,
  };
}

/** Operator figures: this process's counts and the settings in force. */
export function returningWalletStatus() {
  const cfg = returningWalletConfig();
  return { ...cfg, header: WALLET_HINT_HEADER, proofHeader: WALLET_PROOF_HEADER, proofsKept: seenProofs.size, lookupsPerMinute: LOOKUPS_PER_MINUTE, lookupsPerAddressPerMinute: LOOKUPS_PER_ADDRESS_PER_MINUTE, counts: { ...counters }, cachedWallets: cache.size };
}
/** Test seam. */
export function __resetReturningWallet() {
  cache.clear(); byAddress.clear(); seenProofs.clear(); minute = 0; lookups = 0;
  for (const k of Object.keys(counters)) counters[k] = 0;
}

/**
 * The offer on an eligible route's JSON 402 body (`returningWalletPrice`),
 * mounted only while the switch is on. The body only: the PAYMENT-REQUIRED
 * header and its accepts are the gate's, untouched here.
 */
export function returningWalletOfferMiddleware(defOf) {
  return function returningWalletOffer402(req, res, next) {
    let def = null;
    try { def = defOf(req); } catch { def = null; }
    if (!def || returningWalletOffer(def) === null) return next();
    const origSend = res.send;
    res.send = function offeredSend(chunk) {
      try {
        if (res.statusCode === 402 && !res.headersSent && typeof chunk === "string" && chunk.trimStart().startsWith("{")) {
          const body = JSON.parse(chunk);
          if (body && typeof body === "object" && !Array.isArray(body) && body.returningWalletPrice === undefined) chunk = JSON.stringify({ ...body, returningWalletPrice: returningWalletOffer(def, req) });
        }
      } catch { /* an offer must never break a 402 */ }
      return origSend.call(this, chunk);
    };
    next();
  };
}

/** The rule's two clauses every prose surface shares, from the settings in force. */
const quotedClause = (cfg, route) => `quoted ${cfg.discountBps / 100}% under ${route} list price on its x402 exact accepts on EVM chains; a chain's premium and price floor still apply, so a chain at its floor can quote the same amount`;
const SIGNER_CLAUSE = "a payment of the lower amount from any other wallet is answered 402 at the list price, and nothing is charged";
/** How a request proves the wallet, in the words every prose surface shares. */
const proofClause = () => `prove that wallet in the \`${WALLET_PROOF_HEADER}\` header as \`<unix seconds>.<signature>\`: the wallet's EIP-191 (personal_sign) signature over five lines separated by single line feeds (none after the last): \`Agent402 returning-wallet price\`, \`host: <this server's host name>\`, \`route: <METHOD> <path>\`, \`wallet: <the address in lowercase>\` and \`time: <the same seconds>\`, within ${PROOF_SKEW_SECONDS / 60} minutes of the server's clock. One proof serves one request without a payment and one with a payment (the quote and its signed retry); a request without a valid proof is quoted list and its 402 says nothing about the wallet (\`why\`: \`unproven\`)`;

/** The rule in prose for /llms-full.txt, or "" while the switch is off. */
export function returningWalletSentence() {
  const cfg = returningWalletConfig();
  if (!cfg.enabled) return "";
  return `Returning wallets pay less: send your wallet address in the \`${WALLET_HINT_HEADER}\` request header and ${proofClause()}. When that wallet has paid here on ${cfg.minPaidDays} or more days in the last ${cfg.windowDays}, that same call is ${quotedClause(cfg, "the route's")}. An eligible route's 402 carries \`returningWalletPrice\`: the header, the percentage and the bar, \`applied\` (true when this request's quote is lower), \`why\` when a named wallet's quote is not (\`unproven\`: no valid proof; \`unqualified\`: under the bar; \`lookup_busy\`: not read this minute, ask again; \`other_payer\`: the payment is signed by another wallet; \`other_rail\`: the payment is not an x402 exact EIP-3009 authorization on an EVM chain; \`min_price\`: the price has no room under it; \`price_floor\`: every chain quoted sits at its floor) and \`atListOn\` (the chains a price floor held at list). A route whose 402 does not carry it stays at list, for example a route priced per request, a metered or model-backed route, a routing tier or a route whose effect outlives the answer. Send both headers again with the payment, signed from that wallet: ${SIGNER_CLAUSE}.`;
}
/** The header parameters an eligible route's OpenAPI operation declares (the hint and its proof), or []. */
export function returningWalletHeaderParams(def) {
  const cfg = returningWalletConfig();
  if (!cfg.enabled || returningWalletRouteRefusal(def)) return [];
  return [{
    name: WALLET_HINT_HEADER,
    in: "header",
    required: false,
    description: `Your EVM wallet address, read only with a valid ${WALLET_PROOF_HEADER}. A wallet that has paid here on ${cfg.minPaidDays} or more days in the last ${cfg.windowDays} is ${quotedClause(cfg, "this route's")}. Send both headers again with the payment, signed from that wallet: ${SIGNER_CLAUSE}.`,
    schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
  }, {
    name: WALLET_PROOF_HEADER,
    in: "header",
    required: false,
    description: `With ${WALLET_HINT_HEADER}: ${proofClause()}.`,
    schema: { type: "string", pattern: "^[0-9]{1,12}\\.0x[0-9a-fA-F]{130}$" },
  }];
}

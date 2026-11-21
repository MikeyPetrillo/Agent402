// A lower price for a returning wallet, by wallet hint.
//
// OFF unless RETURNING_WALLET_PRICE=on. A buyer names its wallet in the
// request header X-Agent402-Wallet. When that wallet has paid on enough
// distinct days (RETURNING_WALLET_MIN_PAID_DAYS, default 3, inside
// RETURNING_WALLET_WINDOW_DAYS, default 30), the 402 of that same call quotes
// the route's x402 EVM `exact` accepts at a discount
// (RETURNING_WALLET_DISCOUNT_BPS, default 1000 = 10%). Every other accept, and
// every surface that publishes a price, stays at list.
//
// THE HINT IS A CLAIM. It only ever changes a QUOTE. On the paid request the
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
// (configureReturningWallet), cached per wallet for CACHE_MS, and bounded per
// minute: past the bound an unknown wallet is quoted list, never refused.
import { METERED_SLUGS } from "./metered-slugs.js";
import { hasLastingEffect } from "./lasting-effect-slugs.js";
import { payerFromRequest, paymentHeaderOf, paymentSchemeOf } from "./payer.js";
import { decodePaymentHeader } from "./payment-header.js";

export const WALLET_HINT_HEADER = "X-Agent402-Wallet";
export const RETURNING_WALLET_DEFAULTS = Object.freeze({ discountBps: 1000, minPaidDays: 3, windowDays: 30 });
/** The largest discount a setting can name (a malformed or larger value reads as the default). */
export const RETURNING_WALLET_MAX_BPS = 5000;
export const CACHE_MS = 10 * 60_000;
export const CACHE_MAX = 5000;
/** Fresh (uncached) ledger reads per minute; past it an unknown wallet is quoted list. */
export const LOOKUPS_PER_MINUTE = 600;
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

/** The wallet a request names in its hint header (lowercased), or null. */
export function walletHintOf(req) {
  const raw = req?.headers?.[WALLET_HINT_HEADER.toLowerCase()];
  const v = typeof raw === "string" ? raw.trim() : "";
  return ADDR.test(v) ? v.toLowerCase() : null;
}

// ---- the paid-days read (the server's sales ledger), cached and bounded ----
let paidDaysOf = null;
let isOursFn = () => false;
/** Hand in the ledger read (wallet, sinceMs) => distinct paid days, and the own-wallet check. */
export function configureReturningWallet({ paidDays = null, isOurs = null } = {}) {
  paidDaysOf = typeof paidDays === "function" ? paidDays : null;
  isOursFn = typeof isOurs === "function" ? isOurs : () => false;
}
const cache = new Map(); // wallet -> { at, days }
let minute = 0, lookups = 0;
const counters = { hinted: 0, quotedDiscount: 0, paidDiscount: 0, paidOtherWallet: 0, notQualified: 0, lookupsHeld: 0, settleRefused: 0 };

/** Distinct paid days of a wallet inside the window, or null when it cannot be read now. */
function paidDays(wallet, cfg, now) {
  const hit = cache.get(wallet);
  if (hit && now - hit.at < CACHE_MS && hit.window === cfg.windowDays) return hit.days;
  if (typeof paidDaysOf !== "function") return null;
  const m = Math.floor(now / 60_000);
  if (m !== minute) { minute = m; lookups = 0; }
  if (lookups >= LOOKUPS_PER_MINUTE) { counters.lookupsHeld++; return null; }
  lookups++;
  let days = null;
  try { days = Number(paidDaysOf(wallet, now - cfg.windowDays * 86_400_000)); } catch { days = null; }
  if (!Number.isFinite(days) || days < 0) return null;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(wallet, { at: now, days, window: cfg.windowDays });
  return days;
}
/** Does this wallet qualify now? Our own wallets never do. */
export function walletQualifies(wallet, { cfg = returningWalletConfig(), now = Date.now() } = {}) {
  if (!ADDR.test(String(wallet || ""))) return false;
  const w = String(wallet).toLowerCase();
  let ours = false;
  try { ours = isOursFn(w) === true; } catch { ours = true; }
  if (ours) return false;
  const days = paidDays(w, cfg, now);
  return days !== null && days >= cfg.minPaidDays;
}

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
  if (!walletQualifies(hint, { cfg, now })) { counters.notQualified++; return { applied: false, wallet: hint, why: "not qualified" }; }
  const price = discountedPrice(def.price, cfg.discountBps);
  if (price === def.price) return { applied: false, wallet: hint, why: "no room" };
  if (signed === null) counters.quotedDiscount++; else counters.paidDiscount++;
  return { applied: true, wallet: hint, bps: cfg.discountBps, price, paid: signed !== null, why: null };
}
/** The decision already made for this request, or null. */
export function returningWalletOf(req) { return (req && typeof req === "object" && quotes.get(req)) || null; }

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

/** What the 402 of an eligible route says about the offer (null while off). */
export function returningWalletOffer(def, req = null) {
  const cfg = returningWalletConfig();
  if (!cfg.enabled || returningWalletRouteRefusal(def)) return null;
  const q = req ? returningWalletOf(req) : null;
  return {
    header: WALLET_HINT_HEADER,
    discountPercent: cfg.discountBps / 100,
    minPaidDays: cfg.minPaidDays,
    windowDays: cfg.windowDays,
    applied: q?.applied === true,
    note: `Send your wallet address in ${WALLET_HINT_HEADER}. A wallet that has paid here on ${cfg.minPaidDays} or more days in the last ${cfg.windowDays} is quoted ${cfg.discountBps / 100}% under list on this route's x402 exact accepts on EVM chains; the payment must be signed from that wallet, and any other payer is quoted list and not charged.`,
  };
}

/** Operator figures: this process's counts and the settings in force. */
export function returningWalletStatus() {
  const cfg = returningWalletConfig();
  return { ...cfg, header: WALLET_HINT_HEADER, counts: { ...counters }, cachedWallets: cache.size };
}
/** Test seam. */
export function __resetReturningWallet() {
  cache.clear(); minute = 0; lookups = 0;
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

/** One sentence for prose surfaces (llms.txt), or "" while the switch is off. */
export function returningWalletSentence() {
  const cfg = returningWalletConfig();
  if (!cfg.enabled) return "";
  return `Returning wallets pay less: send your wallet address in the \`${WALLET_HINT_HEADER}\` request header, and when that wallet has paid here on ${cfg.minPaidDays} or more days in the last ${cfg.windowDays}, the 402 of that same call quotes ${cfg.discountBps / 100}% under list on the x402 exact accepts of EVM chains (most deterministic tools; metered, model-backed and routing routes stay at list, and each eligible route's 402 states the offer in \`returningWalletPrice\`). The payment must be signed from that wallet: any other payer is quoted list and is not charged.`;
}
/** The header parameter an eligible route's OpenAPI operation declares, or null. */
export function returningWalletHeaderParam(def) {
  const cfg = returningWalletConfig();
  if (!cfg.enabled || returningWalletRouteRefusal(def)) return null;
  return {
    name: WALLET_HINT_HEADER,
    in: "header",
    required: false,
    description: `Your EVM wallet address. A wallet that has paid here on ${cfg.minPaidDays} or more days in the last ${cfg.windowDays} is quoted ${cfg.discountBps / 100}% under list on this route's x402 exact accepts on EVM chains; the payment must then be signed from that wallet.`,
    schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
  };
}

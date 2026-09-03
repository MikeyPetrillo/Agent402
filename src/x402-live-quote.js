// Learn a seller's price from the only surface guaranteed to have it: a live 402.
//
// WHY THIS EXISTS (2026-08-07, from a seller report).
// A seller reported that every one of their listed endpoints came back
// price:null, priceUsd:0, payable:"unknown" - while each endpoint returns a
// textbook x402 v2 challenge (Base USDC, a real payTo) the moment you POST `{}`
// at it. Sampling the index the same day, roughly a third of rows carried no
// price at all, so this was never one seller's problem.
//
// Two causes, both ours:
//   1. A manifest may list `resources` as bare URL STRINGS (theirs does, and
//      the spec permits it). normaliseManifestTools can only read a price from
//      an OBJECT, so a string-listing seller is permanently priceless no matter
//      how well their endpoints behave.
//   2. probePaywall - the one thing that talks to a seller's endpoint - filters
//      on `Number(t.price) > 0`. A route with no price is never probed, and
//      probing is the only thing that would give it one. Circular by
//      construction: the sellers who most need the probe are the only ones
//      excluded from it.
//
// OpenAPI cannot close this: it has no place for an x402 quote. The 402 itself
// is the source of truth, which is also why the router already reads a live 402
// for payTo (payToFromLive402) before spending. This reads the same challenge
// for price and networks.
//
// Deliberately CONSERVATIVE about money: an amount we cannot price leaves the
// price null and still records the networks, so the row becomes "payable over
// x402 on Base" rather than a guessed dollar figure. Under-claiming is the
// safe direction when the number decides what a buyer is charged.

/** USDC is 6 decimals on every chain we accept. Anything else we refuse to
 *  price rather than guess - a wrong exponent is a 1000x pricing error. */
const USDC_DECIMALS = 6;
const USDC_NAME = /^(usdc|usd coin)$/i;

/**
 * Pull the accepts array out of a live 402.
 *
 * x402 v2 carries it base64 in the `payment-required` HEADER with an empty (or
 * unrelated) body; other sellers put it in the JSON body; some serve BOTH, with
 * the body nesting it under `payment`. All three are read, header first,
 * because the header is the spec's home for it.
 */
export function acceptsFromLive402({ header, body } = {}) {
  const dig = (obj) => {
    if (!obj || typeof obj !== "object") return null;
    if (Array.isArray(obj.accepts) && obj.accepts.length) return obj.accepts;
    // Sellers wrap the envelope: { payment: { accepts } }, { x402: { accepts } }.
    for (const k of ["payment", "x402", "paymentRequired", "payment_required", "data"]) {
      const nested = obj[k];
      if (nested && typeof nested === "object" && Array.isArray(nested.accepts) && nested.accepts.length) {
        return nested.accepts;
      }
    }
    return null;
  };

  if (typeof header === "string" && header.trim()) {
    try {
      const decoded = JSON.parse(Buffer.from(header.trim(), "base64").toString("utf8"));
      const hit = dig(decoded);
      if (hit) return hit;
    } catch { /* fall through to the body */ }
  }
  if (typeof body === "string" && body.trim()) {
    try {
      const hit = dig(JSON.parse(body));
      if (hit) return hit;
    } catch { /* unreadable */ }
  }
  if (body && typeof body === "object") {
    const hit = dig(body);
    if (hit) return hit;
  }
  return null;
}

/** Is this accepts entry denominated in USDC? Checked by NAME (what x402 v2
 *  puts in `extra`) rather than by address, so a new chain's USDC works without
 *  a table to forget to update. */
const SVM_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
function isUsdc(a) {
  if (USDC_NAME.test(String(a?.extra?.name || "").trim())) return true;
  // Solana v2 accepts carry NO extra.name (their extra is feePayer et al) -
  // the name convention is an EVM EIP-712 artifact. On Solana the mint
  // address IS the identity, so the one well-known mainnet mint is
  // recognized directly. Without this, every pure-Solana catalog priced as
  // "networks only" forever (measured 2026-09-01: sol.blockrun's 128 routes).
  return String(a?.asset || "") === SVM_USDC_MINT;
}

/**
 * Turn a live 402's accepts into the fields the index stores.
 *
 * Mirrors bazaarItemToTool's preference order deliberately - prefer Base USDC,
 * then any USDC, then the first entry - so a row learned from a live probe and
 * a row learned from the Bazaar are directly comparable. Two price ladders for
 * the same catalogue would be worse than none.
 *
 * Returns price:null (never 0, never a guess) when the amount cannot be priced,
 * while still returning the networks, because "payable on Base, amount unknown"
 * is both true and useful, and 0 would read as free.
 */
export function quoteFromAccepts(accepts) {
  const list = Array.isArray(accepts) ? accepts.filter((a) => a && typeof a === "object") : [];
  if (!list.length) return null;

  const preferred =
    list.find((a) => a.network === "eip155:8453" && isUsdc(a)) ||
    list.find(isUsdc) ||
    list[0];

  let price = null;
  const decimals = Number.isInteger(a$(preferred?.extra?.decimals)) ? a$(preferred.extra.decimals)
    : isUsdc(preferred) ? USDC_DECIMALS
      : null;
  if (decimals != null && preferred?.amount != null) {
    const n = Number(preferred.amount);
    // A negative or non-finite amount is corrupt, not free.
    if (Number.isFinite(n) && n >= 0) price = n / 10 ** decimals;
  }

  return {
    price,
    networks: [...new Set(list.map((a) => a.network).filter((n) => typeof n === "string" && n))],
    payTo: typeof preferred?.payTo === "string" ? preferred.payTo : null,
    asset: typeof preferred?.asset === "string" ? preferred.asset : null,
    // Which entry priced it, so a surprising number can be traced to its source.
    network: typeof preferred?.network === "string" ? preferred.network : null,
  };
}

/** Number() that refuses strings-that-are-not-numbers, for the decimals hint. */
function a$(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return NaN;
}

/**
 * Which HTTP methods to try, in order, for a route whose price we do not know.
 *
 * A GET-only prober cannot see a POST-only seller: such endpoints 404 on GET
 * and 402 on POST, so the whole catalogue reads as priceless. When the catalogue
 * states a method we trust it and try only that; when the method was INFERRED
 * (or absent) we try GET then POST, because a POST with `{}` to a GET endpoint
 * is harmless and a GET to a POST endpoint is a 404 that costs one request.
 *
 * Never PUT/PATCH/DELETE: an unpaid probe must not be able to mutate anything,
 * even by accident, on a stranger's server.
 */
export function probeMethodsFor(tool) {
  const stated = String(tool?.method || "").toUpperCase();
  if (stated === "POST") return ["POST"];
  if (stated === "GET" && tool?.methodInferred !== true) return ["GET", "POST"];
  if (stated && stated !== "GET" && stated !== "POST") return [];
  return ["GET", "POST"];
}

/** Is this response a usable x402 quote? 402 is the only healthy answer to an
 *  unpaid call; a 200 means the route is not paywalled at all. */
export function isQuoteResponse(status) {
  return status === 402;
}

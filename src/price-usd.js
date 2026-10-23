// One reader for a crawled row's price, in whatever shape the row holds it.
//
// A crawled row's `price` is not one type. The manifest, OpenAPI and llms.txt
// readers store the seller's dollar label as written ("$0.01", "0.003 USDC"),
// a live 402 stores a number, the Bazaar merge stores a number or the
// registry's own value, and a few sellers publish an object ({usd},
// {amountMinor, currency}, {amount, asset, decimals}). A bare Number() reads
// every label as NaN, which turns a priced route into an unpriced one; a
// reader that strips every non-digit welds a date into a price. Every reader
// of a row's price goes through this module instead, so a label, a number and
// a supported object give the same figure, and a value we cannot read gives
// null (never 0, which would read as free).
//
// A leaf on purpose: the paid seller tools and the decide rows import it
// without pulling in the crawler.

import { EVM_TOKEN_DOMAINS } from "./evm-usdc-domain.js";

/**
 * An AMOUNT beside PAYMENT CONTEXT is base units of a token, never dollars
 * (2026-09-22). Two live shapes still read atomic figures as dollars after the
 * 2026-09-15 fix, because that one recognised the accept shape at the ENTRY
 * level only:
 *   - a manifest price OBJECT, `price: { amount: "3000", asset: <Base USDC>,
 *     decimals: 6, display: "$0.003" }`, was listed at $3000 (the object path
 *     took `amount` as dollars and never read `decimals`, `asset` or `display`);
 *   - MPP's discovery shape in an OpenAPI operation, `x-payment-info: {
 *     amount: "5000", currency: <Tempo USDC.e>, method: "tempo", intent:
 *     "charge", offers: [...] }`, was listed at $5000 instead of $0.005.
 * Payment context is `decimals`, an `asset`, or a `currency` beside an MPP
 * `method`/`intent`. A bare `currency: "USDC"` beside an amount is NOT context:
 * catalogues publish `{ amount: "0.032", currency: "USDC" }` meaning dollars.
 * A fractional figure is never base units, so it keeps its dollar reading.
 * Decimals are the declared ones, else 6 for the stablecoins every rail here
 * settles in (USDC on any chain, Tempo USDC.e and PathUSD), else NOTHING: a
 * token we cannot size is a price we do not publish (the live-402 probe learns
 * it), because a wrong exponent is the same million-fold error by another road.
 */
const SIX_DECIMAL_TICKER = /^(usdc|usd coin|usdc\.e|pathusd)$/i;
// Each id as its chain publishes it, lowercased HERE rather than by hand: the
// first cut typed the Solana mint out in lower case and got one letter wrong,
// which reads as "we cannot size this token" and publishes no price at all.
const SIX_DECIMAL_ASSETS = new Set([
  ...EVM_TOKEN_DOMAINS.filter((d) => d.symbol === "USDC").map((d) => d.asset),
  "0x20C000000000000000000000b9537d11c60E8b50", // Tempo USDC.e
  "0x20c0000000000000000000000000000000000000", // Tempo PathUSD
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // Solana USDC mint
].map((a) => a.toLowerCase()));
/** Six, when this object names a token we RECOGNISE as dollar-pegged. Null
 *  otherwise, which is the whole gate: sizing an amount by decimals only turns
 *  base units into DOLLARS if the token is a dollar. */
function dollarPeggedDecimalsOf(obj) {
  for (const id of [obj?.asset, obj?.currency, obj?.asset_address, obj?.assetAddress, obj?.symbol, obj?.extra?.name]) {
    if (typeof id !== "string" || !id.trim()) continue;
    const v = id.trim();
    if (SIX_DECIMAL_TICKER.test(v) || SIX_DECIMAL_ASSETS.has(v.toLowerCase())) return 6;
  }
  return null;
}
function declaredDecimalsOf(obj) {
  const d = obj?.decimals;
  if (typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 36) return d;
  if (typeof d === "string" && /^\s*\d{1,2}\s*$/.test(d) && Number(d) <= 36) return Number(d);
  return null;
}
/** Decimals to divide an amount by, or null to publish no price at all.
 *
 *  A DECLARED `decimals` used to be enough on its own, which made the seller's
 *  own field the whole rule for ANY asset: `{ amount: "5000", decimals: 18,
 *  asset: <some token> }` published 0.000000000000005 as a DOLLAR price of a
 *  token that is not a dollar, and the same field set to 2 would have published
 *  $50. Decimals say how to READ an amount, never what it is worth, so the
 *  token has to be one we recognise as dollar-pegged first; anything else is a
 *  price the live-402 probe learns rather than one we invent.
 *
 *  A declaration that CONTRADICTS the chain (USDC is six decimals on every rail
 *  we settle) is not a tie we get to break: publish nothing. */
export function tokenDecimalsOf(obj) {
  const pegged = dollarPeggedDecimalsOf(obj);
  if (pegged == null) return null;
  const declared = declaredDecimalsOf(obj);
  if (declared != null && declared !== pegged) return null;
  return pegged;
}
/** An asset IDENTIFIER - an EVM address, a Solana mint, a CAIP-19 id - rather
 *  than a ticker. Payment context is the identifier: a ticker is a word a
 *  catalogue writes beside a dollar figure. */
function looksLikeAssetIdentifier(v) {
  if (typeof v !== "string") return false;
  const id = v.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(id) || /^0x[0-9a-fA-F]{64}$/.test(id)) return true;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id)) return true; // base58 mint
  return id.includes(":") && /[/:][^\s:/]{6,}$/.test(id);   // caip-19 and friends
}
export function atomicContext(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (obj.decimals != null) return true;
  // A TICKER IS NOT PAYMENT CONTEXT, in whichever field it is written. The rule
  // was applied to `currency` and not to `asset`, so one declaration read three
  // ways: `{ amount: 2, currency: "USDC" }` was $2, `{ amount: 2, symbol:
  // "USDC" }` was $2, and `{ amount: 2, asset: "USDC" }` was $0.000002 - a
  // millionfold under-quote on a seller's listing, arrived at from the same
  // sentence. An asset field carrying a real identifier still states base
  // units, which is what an x402 accept carries and what every case this
  // machinery was built for looks like.
  // A token identifier in `currency` states base units too: an OpenAPI price
  // of { currency: <USDC contract>, amount: "10000" } is $0.01, not $10,000.
  if (looksLikeAssetIdentifier(obj.asset) || looksLikeAssetIdentifier(obj.currency)) return true;
  return typeof obj.currency === "string" && !!obj.currency.trim()
    && (typeof obj.method === "string" || typeof obj.intent === "string");
}
/** The dollar figure an amount in atomic context stands for: a number, the
 *  fractional figure itself when it cannot be base units, or null for a token
 *  whose decimals we cannot know. */
export function atomicAmountToDollars(obj, amount) {
  const whole = typeof amount === "number" ? (Number.isInteger(amount) && amount >= 0)
    : (typeof amount === "string" && /^\s*\d+\s*$/.test(amount));
  if (!whole) {
    const frac = typeof amount === "number" ? Number.isFinite(amount) && amount >= 0
      : (typeof amount === "string" && /^\s*\d*\.\d+\s*$/.test(amount));
    return frac ? amount : null;
  }
  const decimals = tokenDecimalsOf(obj);
  if (decimals == null) return null;
  const usd = Number(String(amount).trim()) / 10 ** decimals;
  // Only a figure that writes out as a plain decimal. JS renders anything from
  // 1e21 up (and below 1e-6) in exponent notation, and every price reader
  // downstream takes a STRING: "$1e+21" parses to null in our own reader and to
  // some unrelated number in any reader that strips punctuation. A price we
  // cannot write down is a price we do not publish.
  if (!Number.isFinite(usd) || /e/i.test(String(usd))) return null;
  return usd;
}

/** USD → integer micro-dollars for exact compares (avoids float !== hazards).
 *  Exported for the dataset snapshot, which needs a price column that is NULL
 *  when the origin published something unparseable - never parsePrice's 0,
 *  which would publish "free" for "we could not read it". */
export function priceToMicroUsd(p) {
  if (p == null || p === "") return null;
  if (typeof p === "number") return Number.isFinite(p) && p >= 0 ? Math.round(p * 1e6) : null;

  // A seller may publish a price as an OBJECT. Read the shapes that actually
  // appear in the crawl rather than dropping a price we were told: a bare
  // {usd}, or Stripe-style minor units. Measured 2026-09-11: 21 routes carried
  // {"amountMinor":50,"currency":"USD"} or {"usd":0.05} and every one of them
  // published as null while the seller had stated the price plainly.
  if (typeof p === "object") {
    if (Number.isFinite(Number(p.usd))) return priceToMicroUsd(Number(p.usd));
    if (Number.isFinite(Number(p.amountMinor)) && String(p.currency || "USD").toUpperCase() === "USD") {
      return Math.round(Number(p.amountMinor) * 1e4); // cents -> micro-dollars
    }
    // `amount` beside payment context (decimals / asset / an MPP currency) is
    // BASE UNITS, the same rule parseManifestPrice reads it by: the million-
    // fold overquote arrives here too whenever a row stores its price object.
    const amount = p.amount != null && atomicContext(p) ? atomicAmountToDollars(p, p.amount) : p.amount;
    return priceToMicroUsd(p.display ?? p.price ?? amount ?? null);
  }
  if (typeof p !== "string") return null;

  // Strip currency and separators, then require the remainder to be ONE number.
  // The old rule deleted every non-digit and parsed whatever was left, so
  // "$free (since 2026-09-02)" became 20260902 - a date welded into a price,
  // and not a small error: five routes published at $20,260,902 while their
  // seller was saying FREE. A string carrying several numbers is a sentence,
  // not a price, and the honest answer is null.
  const cleaned = p.replace(/[$,\s]|usdc?\b/gi, "");
  if (!/^[0-9]*\.?[0-9]+$/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1e6);
}

/** A row's price in USD: a number (0 for a stated zero), or null when the
 *  value cannot be read. The same rule as priceToMicroUsd, which it wraps. */
export function priceUsdOf(p) {
  const micro = priceToMicroUsd(p);
  return micro == null ? null : micro / 1e6;
}

/** True only for a price that reads as a positive dollar figure. */
export function isPricedAboveZero(p) {
  const micro = priceToMicroUsd(p);
  return micro != null && micro > 0;
}

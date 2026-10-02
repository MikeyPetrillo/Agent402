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
// for price, networks and the payTo per network, so the index knows where the
// origin asks to be paid even when no manifest or registry row says so.
//
// Deliberately CONSERVATIVE about money: an amount we cannot price leaves the
// price null and still records the networks, so the row becomes "payable over
// x402 on Base" rather than a guessed dollar figure. Under-claiming is the
// safe direction when the number decides what a buyer is charged.

/** USDC is 6 decimals on every chain we accept. Anything else we refuse to
 *  price rather than guess - a wrong exponent is a 1000x pricing error. */
const USDC_DECIMALS = 6;
import { evmDomainsOfAccepts } from "./evm-usdc-domain.js";
import { unpackRequestContract } from "./request-contract.js";
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
    // `accepts` is the spec's name; a few sellers publish the same array as
    // `paymentRequirements` (the v1 SDK's type name) or `requirements`, which
    // read as "402 we cannot parse" until 2026-09-23 (73 such reads in the
    // first hour of counting).
    const arrayOf = (o) => {
      for (const k of ["accepts", "paymentRequirements", "payment_requirements", "requirements"]) {
        if (Array.isArray(o?.[k]) && o[k].length) return o[k];
      }
      return null;
    };
    const top = arrayOf(obj);
    if (top) return top;
    // Sellers wrap the envelope: { payment: { accepts } }, { x402: { accepts } }.
    for (const k of ["payment", "x402", "paymentRequired", "payment_required", "data", "error"]) {
      const nested = obj[k];
      if (nested && typeof nested === "object") {
        const hit = arrayOf(nested);
        if (hit) return hit;
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
  // "networks only" forever (measured 2026-09-01: a seller's 128 routes).
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
  // The EIP-712 domain each EVM accept advertises (asset + extra.name), kept
  // beside the payTo so the router label can say "unpayable by a stock buyer"
  // later without the 402 in hand (src/evm-usdc-domain.js).
  const evmDomainByNetwork = evmDomainsOfAccepts(list);

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

  // Every accept's payTo, keyed by its network: the same shape
  // paymentFieldsFromAccepts gives a manifest or registry row, so a row learned
  // from a live 402 joins the Base leaderboard scan (allPayToOrigins) and the
  // chain join on the origin's own address like any other. A 402 that names
  // one network twice (two assets) keeps the preferred accept's payTo, then
  // the first seen.
  const payToByNetwork = {};
  for (const a of [preferred, ...list]) {
    if (typeof a.network === "string" && a.network && typeof a.payTo === "string" && a.payTo && !payToByNetwork[a.network]) {
      payToByNetwork[a.network] = a.payTo;
    }
  }

  return {
    price,
    networks: [...new Set(list.map((a) => a.network).filter((n) => typeof n === "string" && n))],
    payTo: typeof preferred?.payTo === "string" ? preferred.payTo : null,
    payToByNetwork,
    asset: typeof preferred?.asset === "string" ? preferred.asset : null,
    // Which entry priced it, so a surprising number can be traced to its source.
    network: typeof preferred?.network === "string" ? preferred.network : null,
    ...(Object.keys(evmDomainByNetwork).length ? { evmDomainByNetwork } : {}),
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

// A route that REQUIRES a query parameter often validates it before the
// paywall, so an unpaid probe of the bare path gets a 400/422 and never sees the
// 402 - and with it the price and every chain the route takes. Measured
// 2026-09-23: a seller's three `?url=` routes stayed Base-only in our index while
// their live 402s offered Base and Solana; the same origin's parameter-free
// routes were read fine. Across the index, 12,143 rows declare a required query
// parameter (507 sellers).
//
// The values are OURS, never the seller's example: request-contract.js keeps
// only parameter NAMES from a seller's OpenAPI on purpose (examples carry keys
// and third-party text). A fixed placeholder per name shape is enough to get
// past a presence check, and the call is still unpaid, so nothing runs that the
// bare probe would not have reached.
const QUERY_PLACEHOLDERS = [
  [/^(url|uri|link|href|site|website|page|endpoint|target|source|src)(_?url)?$/i, "https://example.com"],
  [/url$|uri$/i, "https://example.com"],
  [/^(domain|host|hostname)$/i, "example.com"],
  [/^(email|mail)$/i, "test@example.com"],
  [/^(ip|ip_?address)$/i, "8.8.8.8"],
  [/^(symbol|ticker|coin|asset|token)$/i, "BTC"],
  [/^(chain|network)$/i, "base"],
  [/^(limit|count|n|size|page|days|top)$/i, "1"],
];
export function queryPlaceholderFor(name) {
  for (const [re, v] of QUERY_PLACEHOLDERS) if (re.test(name)) return v;
  return "test";
}

/**
 * seller key + route as one URL text. A route is stored relative to its seller,
 * so for a bare origin this is plain concatenation. A path seller's route AT
 * its prefix root ("/" or "/?q=1": a Supabase edge function, a Vercel or
 * Cloudflare function serving one paid endpoint at its own path) joins to the
 * prefix itself, "<key>?q=1", never "<key>/?q=1": the seller lists the URL
 * without the slash, and a function host may redirect or 404 the other one.
 * Keys are stored normalised (no trailing slash), so this is a split, not a
 * parse; the caller still validates the result (sellerRouteUrl).
 */
export function joinSellerRoute(key, route) {
  const k = String(key || "");
  const r = String(route || "");
  const scheme = k.indexOf("://");
  const slash = scheme >= 0 ? k.indexOf("/", scheme + 3) : -1;
  const hasPrefix = slash >= 0 && slash < k.length - 1;
  if (hasPrefix && (r === "/" || r.startsWith("/?"))) return `${k.replace(/\/+$/, "")}${r.slice(1)}`;
  return `${k}${r}`;
}

/**
 * The URLs an unpaid quote probe should try for one route, in order. A route
 * whose seller declares required query parameters is tried WITH them first
 * (placeholders, see above), then bare; every other route is tried bare only,
 * exactly as before. A parameter the route already carries is left alone.
 */
export function probeTargetsFor(originUrl, tool) {
  const bare = joinSellerRoute(originUrl, tool?.route || "");
  const names = unpackRequestContract(tool)?.required?.query || [];
  if (!names.length) return [bare];
  let u;
  try { u = new URL(bare); } catch { return [bare]; }
  let added = 0;
  for (const n of names) {
    if (u.searchParams.has(n)) continue;
    u.searchParams.set(n, queryPlaceholderFor(n));
    added++;
  }
  return added ? [u.toString(), bare] : [bare];
}

// The POST twin of the query placeholders: a route whose OpenAPI declares
// required JSON body fields often validates them before its paywall, so the
// bare `{}` probe got a 400/422 and never saw the 402. 25% of misses in the
// first hour of counting (2026-09-23) were such input errors. Names come from
// request-contract.js (dotted paths, names only); every leaf gets the same
// name-shaped placeholder the query side uses. Types are unknown, so a field
// that wants a number may still refuse - the bare `{}` follows as before.
export function probeBodyFor(tool) {
  const paths = unpackRequestContract(tool)?.required?.body || [];
  if (!paths.length) return null;
  // Seller-supplied names walked into an object: null-prototype nodes, own-key
  // checks only, and the prototype-addressing names refused outright, so no
  // path can reach Object.prototype whatever request-contract lets through.
  const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
  const root = Object.create(null);
  for (const path of paths) {
    const segs = String(path).split(".");
    if (segs.some((seg) => RESERVED.has(seg) || !seg)) continue;
    let node = root;
    segs.forEach((seg, i) => {
      if (i === segs.length - 1) {
        if (!Object.hasOwn(node, seg)) node[seg] = queryPlaceholderFor(seg);
      } else {
        if (!Object.hasOwn(node, seg) || typeof node[seg] !== "object" || node[seg] === null) node[seg] = Object.create(null);
        node = node[seg];
      }
    });
  }
  return Object.keys(root).length ? JSON.stringify(root) : null;
}

/**
 * Every unpaid request one quote probe may make for a route, in order: each
 * target (placeholder query first, then bare) by each allowed verb, and for a
 * POST the placeholder body before `{}`. Duplicates are dropped, so a route
 * that declares nothing makes exactly the requests it always did.
 */
export function probeAttemptsFor(originUrl, tool) {
  const filled = probeBodyFor(tool);
  const out = [];
  const seen = new Set();
  for (const target of probeTargetsFor(originUrl, tool)) {
    for (const method of probeMethodsFor(tool)) {
      const bodies = method === "POST" ? [filled, "{}"].filter(Boolean) : [null];
      for (const body of bodies) {
        const k = `${method} ${target} ${body}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ target, method, body });
      }
    }
  }
  return out;
}

/** Is this response a usable x402 quote? 402 is the only healthy answer to an
 *  unpaid call; a 200 means the route is not paywalled at all. */
export function isQuoteResponse(status) {
  return status === 402;
}

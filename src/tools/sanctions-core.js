// Screening a name or a crypto address against the published sanctions lists.
//
// WHAT THIS IS AND IS NOT, because the difference is the whole product.
//
// A HIT is a fact: this exact string appears on a list we downloaded, and we
// can name the list, the entry and when we fetched it.
//
// A MISS IS NOT A CLEARANCE. It means "not found on the lists we checked, as
// of the date we fetched them". Sanctions lists change without notice, the
// same person appears under many spellings, and ownership rules (OFAC's 50%
// rule, for one) put entities on the hook that appear on no list by name. A
// tool that answers "clean" invites someone to rely on it for a decision it
// cannot support, and that is a worse failure than answering nothing at all.
// So there is no `clean`, no `safe` and no boolean that reads as permission:
// the answer is `match` / `no_match_on_lists_checked`, every response names
// the lists and their fetch dates, and the caveat rides in the payload rather
// than in documentation someone may not read.
//
// Pure: no network, no clock beyond what the caller passes. The loader fetches
// and caches; this decides what a match is, so the matching can be tested
// exhaustively without touching a government endpoint.

/** Assets whose addresses are case-sensitive. Folding these merges distinct
 *  addresses, the same rule src/payer.js follows for payers. */
const CASE_SENSITIVE = new Set(["XBT", "BTC", "BCH", "LTC", "XMR", "ZEC", "DASH", "SOL", "TRX", "XRP", "ADA", "DOT"]);

/** Normalise one address for comparison. EVM is case-insensitive (and often
 *  checksummed); base58/bech32 chains are NOT. */
export function normalizeAddress(addr, asset = null) {
  const a = String(addr || "").trim();
  if (!a) return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return a.toLowerCase();           // EVM
  if (asset && !CASE_SENSITIVE.has(String(asset).toUpperCase())) return a.toLowerCase();
  return a;                                                             // exact, never folded
}

/**
 * Every Digital Currency Address in a parsed OFAC SDN list (src/ofac-sdn.js
 * parseSdnXml), keyed for an O(1) lookup that names who it belongs to:
 * normalized address -> { asset, address, entity, sdnId }.
 *
 * The key is normalizeAddress WITHOUT the asset: EVM folded to lowercase,
 * every other address exactly as listed. Keying on the asset folded the
 * base58 addresses OFAC lists under tickers missing from CASE_SENSITIVE (a
 * Tron address under USDT, DOGE, BSV, ...), and a lookup without an asset
 * hint, which is how the router screens a payout address, then missed them.
 * The first listing of an address wins.
 */
export function sdnCryptoAddresses(list) {
  const out = new Map();
  for (const e of list?.entries || []) {
    for (const { asset, address } of e.addresses || []) {
      const key = normalizeAddress(address);
      if (!key || out.has(key)) continue;
      out.set(key, { asset, address, entity: e.name, sdnId: e.uid });
    }
  }
  return out;
}

/** The entry's type in the vocabulary this tool has always published (the
 *  SDN.CSV column): individual, vessel, aircraft, and -0- for an entity. */
const SDN_TYPE_WORD = { individual: "individual", vessel: "vessel", aircraft: "aircraft", entity: "-0-" };

/** Names from a parsed OFAC SDN list: the primary name, the entry id and its type. */
export function sdnNames(list) {
  const out = [];
  for (const e of list?.entries || []) {
    if (!e.name || e.name === "-0-") continue;
    const t = String(e.sdnType || "").trim().toLowerCase();
    out.push({ id: e.uid, name: e.name, type: t ? (SDN_TYPE_WORD[t] || t) : null });
  }
  return out;
}

/** Look one address up: the exact key first (EVM folded, everything else as
 *  given), then the asset-aware key a caller's hint selects. */
export function lookupAddress(map, raw, asset = null) {
  const exact = normalizeAddress(raw);
  if (exact && map.has(exact)) return map.get(exact);
  const hinted = normalizeAddress(raw, asset);
  if (hinted && hinted !== exact && map.has(hinted)) return map.get(hinted);
  return null;
}

/** Fold a name for comparison: case, punctuation and corporate suffixes.
 *  Deliberately conservative - it never drops words that carry identity. */
export function foldName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[.,'"()]/g, " ")
    .replace(/\b(co|corp|corporation|inc|incorporated|ltd|limited|llc|llp|plc|gmbh|sa|nv|bv|ag|as|oyj|ab|pte|pty|jsc|pjsc|ojsc|ooo|oao|pao|zao)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Name screening. EXACT and CONTAINS only - never a fuzzy distance.
 *
 * A fuzzy matcher on sanctions data is a liability: it produces confident
 * near-misses on common surnames, and a caller acting on "87% similar to a
 * sanctioned person" is acting on a number we invented. Exact and substring
 * matches are facts a reader can check against the published list themselves.
 * Callers who want fuzzy matching have the entry list to do it on their own
 * terms, with their own tolerance, which is where that decision belongs.
 */
export function screenName(query, entries, { limit = 25 } = {}) {
  const q = foldName(query);
  if (!q || q.length < 3) return { query: String(query || ""), matches: [], reason: "a name needs at least three characters to screen" };
  // ALL-TOKEN matching exists because substring matching misses the ordinary
  // way a person's name is written. OFAC stores "PUTIN, Vladimir Vladimirovich";
  // a buyer screens "Vladimir Putin"; neither string contains the other, so the
  // tool answered no_match against a correctly loaded 19,388-entry list. That is
  // a FALSE NEGATIVE on a sanctions screen - the one direction this product must
  // not fail in, because the buyer reads it as "clean" and acts.
  //
  // It is NOT a fuzzy score, and the tool's promise of "no similarity scoring"
  // still holds: every query token must appear as a WHOLE WORD in the entry.
  // No edit distance, no partial credit, no ranking - "Vladimir Putin" matches
  // "PUTIN, Vladimir Vladimirovich" and does not match "PUTINA, Olga".
  // Reported under its own matchType so a consumer can tell the three apart.
  //
  // Requires two or more query tokens: a single token is already covered by the
  // substring pass, and treating one token as an all-token match would make
  // every common surname a hit.
  const qTokens = q.split(" ").filter((t) => t.length > 1);
  const exact = [], contains = [], allTokens = [];
  for (const e of entries || []) {
    const n = foldName(e.name);
    if (!n) continue;
    if (n === q) exact.push({ ...e, matchType: "exact" });
    else if (n.includes(q) || q.includes(n)) contains.push({ ...e, matchType: "contains" });
    else if (qTokens.length >= 2) {
      const nTokens = new Set(n.split(" "));
      if (qTokens.every((t) => nTokens.has(t))) allTokens.push({ ...e, matchType: "all-tokens" });
    }
    if (exact.length + contains.length + allTokens.length > 5000) break; // pathological query guard
  }
  return {
    query: String(query || ""),
    matches: [...exact, ...contains, ...allTokens].slice(0, limit),
    exactCount: exact.length,
    containsCount: contains.length,
    allTokensCount: allTokens.length,
  };
}

/**
 * The verdict vocabulary. There is no "clear", "clean", "safe" or "approved"
 * in it, and that is deliberate: a word like that is read as permission, and
 * nothing here can grant permission.
 */
export const SANCTIONS_VERDICTS = Object.freeze({
  match: "this exact value appears on at least one of the lists named in `listsChecked`",
  no_match_on_lists_checked: "this value does not appear on the lists named in `listsChecked`, as of the dates in `listsFetchedAt`. That is NOT a clearance: lists change without notice, entities appear under many spellings, and ownership rules put parties in scope who are named on no list. Use this as one input to your own screening, never as the decision",
  match_caveat: "a match is a string match against a published list, not a confirmed identification. Names repeat and addresses are reused; confirm the entry against the list itself (the SDN id is given) before acting on it",
  lists_unavailable: "we could not load one or more lists, so this answer would be incomplete and is refused rather than reported as no match",
});

// Phrase aliases: names a tool of this catalog answers to ONLY when the query
// writes the whole name. Read by /api/find (src/find.js) and /api/route
// (src/x402-index.js), so the two agree.
//
// Why a second kind of alias. A curated `aliases` entry scores word by word on
// /api/route: any query word found inside the alias takes slug credit, so an
// alias written for "current bitcoin price" would also lift its tool for
// "current gold price" and "current stock price", and one written for a
// coin's volatility would take "jpy volatility" and "implied volatility".
// Those are other jobs. A phrase alias earns nothing for one of its words.
//
// THE RULE. A phrase alias counts when its words stand NEXT TO EACH OTHER in
// the query, in any order, once the function words in PHRASE_SKIP are set
// aside: "current bitcoin price", "what is the current price of bitcoin" and
// "volatility of bitcoin" each write a whole phrase. A word between them that
// is not a function word is a qualifier and makes it another task ("bitcoin
// implied volatility", "current bitcoin etf price"), so the phrase does not
// count there and the query is ranked exactly as it is without this list.
// The full word set anywhere in the query was the looser choice: it reads a
// qualified task as the plain one. A fixed word order was the stricter one:
// it misses "price of bitcoin, current".
//
// A hit scores each of the phrase's words like a word of a name the query
// covers whole (the weight a curated alias or a compound slug already takes
// there), never added to a slug hit. Every existing `aliases` entry is read
// exactly as before: this list is a separate, opt-in table.
//
// Adding a phrase: two words or more, on a slug in the catalog, with a case
// for it and for its neighbors in scripts/test-phrase-aliases.js. Bounded
// work per query (the table is a few rows); no model, no network.
import { splitTokens } from "./query-terms.js";

export const PHRASE_ALIASES = Object.freeze({
  // The live price of the two coins buyers name most, asked as "current".
  "crypto-price": Object.freeze(["current-bitcoin-price", "current-btc-price", "current-ethereum-price", "current-eth-price"]),
  // crypto-history computes a coin's volatility over a look-back window.
  "crypto-history": Object.freeze(["bitcoin-volatility", "btc-volatility", "ethereum-volatility", "eth-volatility"]),
  // A base64-encoded string is what base64 decodes. Its record writes "encode",
  // never "encoded" or "string", so without the phrase it led a tool the query
  // names only as the string's source ("scanned from a qr code") by a sliver
  // that any new tool writing "base64" closed.
  "base64": Object.freeze(["decode-base64-encoded-string"]),
});

// Function words a phrase is read across. Nothing that names a thing or
// qualifies one belongs here.
export const PHRASE_SKIP = Object.freeze(new Set(["a", "an", "the", "of", "for", "in", "on", "at", "to", "is", "are", "was", "s", "what", "whats", "me", "my"]));

const QUERY_MAX = 500;
const WORDS_MAX = 64;
// slug -> its phrases as word lists, built once.
const TABLE = Object.entries(PHRASE_ALIASES).map(([slug, phrases]) => [slug, phrases.map((p) => splitTokens(p)).filter((ws) => ws.length >= 2)]);
// Every word any phrase holds: a query with none of them is done in one pass.
const ANY_WORD = new Set(TABLE.flatMap(([, phrases]) => phrases.flat()));

/** Whether `words` (a phrase) is one contiguous window of `q` (the query's
 *  words with the function words set aside), in any order. */
function windowHolds(q, words) {
  const n = words.length;
  for (let i = 0; i + n <= q.length; i++) {
    let all = true;
    for (let j = 0; j < n && all; j++) {
      let found = false;
      for (let k = 0; k < n && !found; k++) found = q[i + k] === words[j];
      all = found;
    }
    if (all) return true;
  }
  return false;
}

/**
 * The phrase aliases a query writes out whole.
 * @param {string} query
 * @returns {Map<string, Set<string>>|null} slug -> the words of its phrases
 *   the query writes; null for a query that writes none (nearly every query)
 */
export function phraseAliasHits(query) {
  if (typeof query !== "string") return null;
  const raw = splitTokens(query.slice(0, QUERY_MAX)).slice(0, WORDS_MAX);
  let any = false;
  for (let i = 0; i < raw.length && !any; i++) any = ANY_WORD.has(raw[i]);
  if (!any) return null;
  const q = raw.filter((w) => !PHRASE_SKIP.has(w));
  let hits = null;
  for (const [slug, phrases] of TABLE) {
    for (const words of phrases) {
      if (!windowHolds(q, words)) continue;
      let set = (hits ||= new Map()).get(slug);
      if (!set) hits.set(slug, (set = new Set()));
      for (const w of words) set.add(w);
    }
  }
  return hits;
}

// Query tokenization for the lexical routers (/api/route, /api/find, the
// /api/index search), Unicode-aware.
//
// Why (2026-09-10, reported from outside): every router split the query on
// `[^a-z0-9]+`, so a query in any script other than basic Latin produced ZERO
// terms and zero results - "中国供应商核验" returned nothing while "china
// supplier verification" ranked three sellers. Reproduced on prod the same
// day. The scorer is lexical and stays lexical: this does not translate, it
// only stops throwing the query away.
//
// Rules:
//   - a run of letters/digits is a term (Unicode letters count; case-folded);
//   - splitTokens folds a run whole; caseRuns (seller-written names) also
//     reads a run's camelCase and acronym parts, as extra words beside the
//     whole run, never in place of it; queryTerms folds the buyer's run whole;
//   - a run of CJK ideographs / kana / hangul carries no word boundaries, so it
//     is emitted as CHARACTER BIGRAMS (中国供应商 -> 中国, 国供, 供应, 应商) plus
//     the whole run, which is the usual n-gram treatment for unsegmented
//     scripts; a lone CJK character is a term on its own;
//   - the ASCII short-term rule stands: a Latin term under three characters
//     matches whole tokens only ("ip" must not substring-match gzip); a CJK
//     bigram is two characters by construction and matches by substring, which
//     is the only sensible match for an unsegmented script.
// Pure functions, no state, imported by three routers so they cannot drift.

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const NON_TOKEN_RE = /[^\p{L}\p{N}]+/u;

/** True when the term is made of CJK characters (bigram or whole run). */
export function isCjkTerm(term) {
  return typeof term === "string" && term.length > 0 && [...term].every((ch) => CJK_RE.test(ch));
}

/** Split a string into alphanumeric runs, Unicode-aware, lower-cased. */
export function splitTokens(str) {
  return String(str || "").toLowerCase().split(NON_TOKEN_RE).filter(Boolean);
}

// Word boundaries inside one run, read BEFORE case-folding. Seller names are
// often an OpenAPI operationId ("webPageToMarkdown", "getUSDCPrice"); folded
// first they were one opaque token, so a multi-word query never covered the
// name (2026-11-15, reported by a seller). A boundary sits:
//   - between a lower-case letter and an upper-case one, unless the lower-case
//     letter opens the run ("iPhone", "eBay" stay whole);
//   - between a digit and a capitalized word ("erc20Token" -> erc20 token,
//     while "P2P" and "3D" stay whole);
//   - before the last capital of an acronym when a lower-case word of two or
//     more letters follows ("getUSDCPrice" -> get usdc price), so a plural
//     acronym ("APIs", "IPv4") is not cut.
// The parts are EXTRA words: the whole folded run stays the name's word (a
// brand-cased "GitHub", "OpenAI", "DeFi" keeps its own token and its word
// count), and the router reads the parts only to decide that a query covers
// the name, so a fragment ("ai", "de", "fi") never scores on its own.
export const CASE_SPLIT_MAX_CHARS = 256;
const CASE_BOUNDARY_RE = /(?<=[\p{L}\p{N}]\p{Ll})(?=\p{Lu})|(?<=\p{N})(?=\p{Lu}\p{Ll})|(?<=\p{Lu}{2})(?=\p{Lu}\p{Ll}{2})/gu;

/** A run's camelCase / acronym parts, lower-cased, or null when the run has
 *  no boundary. */
export function caseParts(run) {
  const s = String(run || "");
  if (s.length > CASE_SPLIT_MAX_CHARS || s.toLowerCase() === s) return null;
  const parts = s.replace(CASE_BOUNDARY_RE, " ").toLowerCase().split(NON_TOKEN_RE).filter(Boolean);
  return parts.length > 1 ? parts : null;
}

/**
 * A seller-written name as words: `toks` is splitTokens (the whole folded
 * runs, which are the name's word count), and `parts` is null when no run has
 * a case boundary, else an array aligned with `toks` holding each run's parts
 * (or null). A long string (a seller can publish names up to its document's
 * size) is not case-read: reading case costs per character, and a name over
 * ten words earns no slug credit anyway.
 */
export function caseRuns(str) {
  const s = String(str || "");
  const toks = splitTokens(s);
  if (s.length > CASE_SPLIT_MAX_CHARS || s.toLowerCase() === s) return { toks, parts: null };
  const raw = s.split(NON_TOKEN_RE).filter(Boolean);
  // A fold that changes the run structure (a capital whose lower case adds a
  // combining mark) is not case-read: the parts must line up with the runs.
  if (raw.length !== toks.length) return { toks, parts: null };
  let parts = null;
  for (let i = 0; i < raw.length; i++) {
    const p = caseParts(raw[i]);
    if (!p || p.join("") !== toks[i]) continue;
    (parts ||= new Array(toks.length).fill(null))[i] = p;
  }
  return { toks, parts };
}

/** Expand one alphanumeric run into terms: a Latin/other-script run is one
 *  term; a run containing CJK is split into CJK stretches (bigrams + whole
 *  stretch) and the non-CJK remainder. */
function expandRun(run) {
  if (!CJK_RE.test(run)) return [run];
  const out = [];
  let cjk = "", other = "";
  const flush = () => {
    if (cjk) {
      const chars = [...cjk];
      if (chars.length === 1) out.push(chars[0]);
      else {
        for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
        out.push(cjk);
      }
      cjk = "";
    }
    if (other) { out.push(other); other = ""; }
  };
  for (const ch of run) {
    if (CJK_RE.test(ch)) { if (other) { out.push(other); other = ""; } cjk += ch; }
    else { if (cjk) flush(); other += ch; }
  }
  flush();
  return out;
}

/**
 * Query -> terms. Deduplicated, in order of first appearance, capped.
 * @param {string} q
 * @param {object} [o]
 * @param {number} [o.max=32]      cap on the number of terms
 */
export function queryTerms(q, { max = 32 } = {}) {
  const seen = new Set();
  const out = [];
  // The buyer's words are folded whole, as before: splitting them would turn
  // field names in a pasted description ("marketCap", "yieldToMaturity") into
  // extra common words and move rankings. The case split is for seller-written
  // names (caseRuns), which a lower-case multi-word query then covers.
  for (const run of splitTokens(q)) {
    for (const t of expandRun(run)) {
      if (seen.has(t)) continue;
      seen.add(t); out.push(t);
      if (out.length >= max) return out;
    }
  }
  return out;
}

// FILLER: words a buyer adds that say nothing about the task. "the", "a" and
// "for" sit in almost every seller description, and "api" and "tool" in most
// seller slugs and paths, so each scored (and "api" and "tool" selected rows)
// for every listing alike: a high-volume seller whose slug reads "api" took
// slug points for "weather api" whatever it sells. The scorers drop them;
// the whole query still decides which compound slugs a query covers.
export const FILLER_TERMS = Object.freeze(new Set(["the", "a", "an", "for", "tool", "tools", "api", "apis"]));
/** Terms for scoring: the filler dropped, unless every term is filler (a
 *  query "api" still asks for something). */
export function withoutFiller(terms) {
  const list = Array.isArray(terms) ? terms : [];
  const kept = list.filter((t) => !FILLER_TERMS.has(t));
  return kept.length ? kept : list;
}

/** The match predicate for one term against a lower-cased haystack string:
 *  substring for terms of three or more characters and for every CJK term;
 *  whole-token for a short Latin term (the 2026-08-28 "ip" rule). */
export function termMatcher(term) {
  if (term.length >= 3 || isCjkTerm(term)) return (str) => str.includes(term);
  return (str) => splitTokens(str).includes(term);
}

// PLURALS. A buyer writes "uuids", "ids", "hashes"; the catalog names the
// thing once, as a slug word, tag or alias ("uuid", "id", "hash"). A plural
// query word matched only incidental description text, so a shared verb
// ("generate") decided the ranking (2026-11-22: "generate version 7 uuids"
// ranked captcha-generate first). The candidates are the regular English
// singulars; the caller keeps the word as written unless the catalog uses a
// candidate and not the word itself, so "news" or "series" never change.
/** Regular singular forms of a Latin word, most specific first; [] when the
 *  word does not read as a plural ("address", "status", "analysis"). */
export function singularCandidates(term) {
  const t = String(term || "");
  if (t.length < 3 || t.length > 40 || !/^[a-z]+s$/.test(t)) return [];
  if (/(?:ss|us|is)$/.test(t)) return [];
  const out = [];
  if (/ies$/.test(t) && t.length > 4) out.push(t.slice(0, -3) + "y");
  if (/(?:ch|sh|x|z|ss)es$/.test(t)) out.push(t.slice(0, -2));
  out.push(t.slice(0, -1));
  return out;
}

// SPELLED-OUT VERSIONS. "version 7", "ver. 4" and "v 6" are the words a tool
// names as "v7", "v4", "v6" (an alias such as uuid-v7); the lone digit is a
// one-character token every scorer drops. Returns the short forms, in order.
const VERSION_RE = /(?<![\p{L}\p{N}])(?:version|ver|v)\.?\s*(\d{1,3})(?![\p{L}\p{N}])/giu;
export function versionTerms(q) {
  const s = String(q || "").slice(0, 1000);
  const out = [];
  for (const m of s.matchAll(VERSION_RE)) {
    const v = `v${Number(m[1])}`;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

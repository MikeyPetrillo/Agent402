// One-call tool resolver. Instead of an agent spending tokens searching the web
// and reading pages just to discover how to do something, it sends a task
// description here and gets back the best-matching tool(s) with everything needed
// to call them directly: route, price, input schema, and a ready example.
// Deterministic lexical ranking (no LLM, no tokens), consistent with the MCP
// connector's search_tools weighting.
import { partialFields, clampFields } from "./partial-answer.js";
import { toolList } from "./pages.js";
import { queryTerms } from "./query-terms.js";
import { rankSkillPacks } from "./skills.js";
import { UNIT_CATEGORIES } from "./tools/convert-gen.js";
import { UNIT_ALIASES } from "./tools/kit2.js";

// Common English stopwords that contribute noise instead of intent. Kept short
// on purpose — every word here matches many tool descriptions, so dropping it
// from the query sharpens ranking without affecting recall on the intent words.
// Words that are values rather than capabilities: anything carrying a digit,
// a long unbroken token (an encoded payload), or a part of an IANA zone name.
const TIMEZONE_WORDS = (() => {
  const set = new Set();
  try {
    for (const z of Intl.supportedValuesOf("timeZone")) for (const w of z.toLowerCase().split(/[/_-]+/)) if (w.length > 2) set.add(w);
  } catch { /* older runtimes: no zone list, nothing excluded */ }
  return set;
})();
export function isValueTerm(term) {
  const t = String(term || "");
  return /\d/.test(t) || t.length >= 16 || TIMEZONE_WORDS.has(t);
}

const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "to", "for", "with", "by", "and", "or",
  "is", "are", "was", "were", "be", "been", "this", "that", "it", "as", "at",
  "from", "into", "onto", "my", "me", "i", "you", "your", "we", "our",
  "do", "does", "did", "can", "will", "would", "should",
]);

// Every unit word the retired ~970 pairwise convert-<from>-to-<to> slugs used
// to lexical-match, derived from the live conversion table (full ids split on
// hyphens, e.g. "nautical-miles" → nautical + miles) plus the short aliases
// unit-convert accepts (km, kg, mph, …). A query containing any of these words
// gets the synthetic term "units" appended, which maps it onto unit-convert's
// curated "units" tag — so "convert stones to kg"-style tasks still resolve to
// the one surviving converter instead of tying across unrelated *-convert
// tools. "per"/"us" are dropped: they appear inside compound ids
// (miles-per-hour, us-gallons) but are far too generic as standalone triggers.
// Known tradeoff: generic time words (days/hours/years/seconds/light) stay in
// the set, adding mild recall noise for date-ish queries. Deliberate — the
// find suite locks the current behavior; trim later if it bites.
const UNIT_WORDS = new Set(
  [
    ...Object.values(UNIT_CATEGORIES).flatMap((cat) => Object.keys(cat.units).flatMap((id) => id.split("-"))),
    ...Object.keys(UNIT_ALIASES),
  ].filter((w) => w.length > 1 && !STOPWORDS.has(w) && w !== "per" && w !== "us")
);

// Delegated-purchase intent (see the synthetic "sor" term below). Both sets
// must hit for the term to be appended - "buy bitcoin price" stays a crypto
// query, and "pay an EXTERNAL api" becomes a router query.
const DELEGATION_VERBS = new Set(["buy", "purchase", "pay", "order", "hire", "rent", "outsource", "delegate", "call"]);
const THIRD_PARTY_MARKERS = new Set(["external", "another", "other", "others", "someone", "somebody", "seller", "sellers", "vendor", "third", "party", "third-party", "behalf", "elsewhere", "ecosystem", "marketplace"]);

/**
 * Append curated front-door tags for web-search / answer / news phrasing.
 * Shared by /api/find and the hosted MCP search_tools lexical scorer so both
 * surfaces agree on the default job. Mutates `terms` in place; safe no-op when
 * the query is not front-door shaped.
 * @param {string[]} terms
 * @param {string} q
 */
export function applyFrontDoorTerms(terms, q) {
  const ql = String(q || "").toLowerCase();
  // Web search: "search the web", "google X", "look up online", "web search for"
  if (!terms.includes("web-search") && (
    /\b(search\s+the\s+web|web\s+search|search\s+online|google\s+|bing\s+|look\s+up\s+online|look\s+up\s+on\s+the\s+web|find\s+on\s+the\s+web)\b/.test(ql)
    || /\b(search|look\s+up)\s+(for\s+)?(pages?|sites?|urls?|links?)\b/.test(ql)
  )) {
    terms.push("web-search");
  }
  // Cited answer: "answer this question", "with citations", "grounded answer"
  if (!terms.includes("answer") && (
    /\b(answer\s+(this\s+)?(question|me)|answer\s+with\s+citations|cited?\s+answer|grounded\s+answer|question\s+with\s+citations)\b/.test(ql)
    || /\b(what\s+is|who\s+is|explain)\b.+\b(with\s+sources|with\s+citations|cite\s+sources)\b/.test(ql)
  )) {
    terms.push("answer");
  }
  // News: "latest news", "breaking news", "headlines about"
  if (!terms.includes("breaking-news") && (
    /\b(latest\s+news|breaking\s+news|news\s+(about|on|for|headlines)|headlines\s+(about|on|for)|current\s+events)\b/.test(ql)
  )) {
    terms.push("breaking-news");
  }
}

/**
 * Rank catalog tools against a free-text task description.
 * @param {object} catalog  CATALOG map (route -> def)
 * @param {string} query    natural-language task / keywords
 * @param {object} [opts]
 * @param {number} [opts.k=5]        max results
 * @param {string} [opts.baseUrl=""] base for docs links
 * @param {Set<string>} [opts.powSlugs] compute-payable slugs (for the free flag)
 * @returns {{query:string, count:number, results:Array}}
 */
// Most rows one /api/find answer carries, and the default when none is asked
// for. Published on every answer so the ceiling is never read as the match count.
// CONVERSION DIRECTION. "convert markdown to pdf" names a source and a
// target; a tool named pdf-to-markdown shares every word and does the
// opposite. The words around each "to" / "into" (source before, target
// after) and each "from" (target before, source after) are candidate pairs:
// up to two kept terms on each side, stopping at the next direction word.
// A pair only ever matters when some tool's own name states it reversed, so
// "want to convert" or "how to" produce pairs that match nothing.
const DIRECTION_WORDS = new Set(["to", "into", "from"]);
export function conversionPairs(q, terms) {
  const kept = new Set(terms);
  const pairs = [];
  // One clause at a time: a pair never spans a sentence or a parenthesis.
  for (const clause of String(q || "").toLowerCase().split(/[.;:!?()\n]+/).slice(0, 16)) {
    const tokens = clause.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 96);
    // Up to two kept terms walking away from i, and the direction word that ended the walk.
    const side = (i, step) => {
      const out = [];
      let j = i + step;
      for (; j >= 0 && j < tokens.length && out.length < 2; j += step) {
        if (DIRECTION_WORDS.has(tokens[j])) return { out, stop: tokens[j] };
        if (kept.has(tokens[j])) out.push(tokens[j]);
      }
      return { out, stop: tokens[j] && DIRECTION_WORDS.has(tokens[j]) ? tokens[j] : null };
    };
    for (let i = 0; i < tokens.length && pairs.length < 8; i++) {
      if (!DIRECTION_WORDS.has(tokens[i])) continue;
      const before = side(i, -1), after = side(i, 1);
      if (!before.out.length || !after.out.length) continue;
      if (tokens[i] !== "from") pairs.push({ from: before.out, to: after.out });
      // "from X to Y" is the "to" pair; only a bare "Y from X" reads the other way round.
      else if (after.stop !== "to" && after.stop !== "into") pairs.push({ from: after.out, to: before.out });
    }
  }
  return pairs;
}
// The directions a tool's own names state: its slug ("pdf-to-markdown"), its
// name ("PDF to Markdown", "Text-to-speech") and its aliases, each read as
// hyphenated words and split once on "to".
let statedReads = 0;
/** Test seam: how many times a tool's names were read for their stated directions. */
export function _statedDirectionReads() { return statedReads; }
function readStatedDirections(t) {
  statedReads++;
  const out = [];
  const add = (text) => {
    const parts = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").split("-to-");
    if (parts.length !== 2) return;
    const [l, r] = parts.map((x) => new Set(x.split("-").filter(Boolean)));
    if (l.size && r.size) out.push([l, r]);
  };
  add(t.slug);
  add(t.name);
  for (const al of t.aliases || []) add(al);
  return out;
}
// Read once per catalog entry, not once per scored tool per query. The key is
// the entry object the catalog holds (findTools scores a fresh copy of each
// entry on every query, so the copy itself is never seen twice). The slug,
// name and aliases the value was read from are kept beside it and compared on
// every use, so an entry whose names or aliases change (replaced, or edited
// in place) is read again.
const statedMemo = new WeakMap();
function statedDirections(t, entry) {
  const al = t.aliases;
  const keyed = entry !== null && typeof entry === "object" && (al == null || Array.isArray(al));
  if (!keyed) return readStatedDirections(t);
  const m = statedMemo.get(entry);
  if (m && m.slug === t.slug && m.name === t.name && m.aliases.length === (al ? al.length : 0)) {
    let same = true;
    for (let i = 0; i < m.aliases.length; i++) if (m.aliases[i] !== al[i]) { same = false; break; }
    if (same) return m.out;
  }
  const out = readStatedDirections(t);
  statedMemo.set(entry, { slug: t.slug, name: t.name, aliases: al ? al.slice() : [], out });
  return out;
}
/** "reverse" when the tool's names state a pair backwards and never forwards, "forward" when one states it as asked, else null. */
function directionOf(t, pairs, entry) {
  let reverse = null;
  for (const [l, r] of statedDirections(t, entry)) {
    for (const p of pairs) {
      if (p.from.some((x) => l.has(x)) && p.to.some((x) => r.has(x))) return { way: "forward" };
      const to = p.to.find((x) => l.has(x)), from = p.from.find((x) => r.has(x));
      if (to && from && !reverse) reverse = { way: "reverse", from, to };
    }
  }
  return reverse;
}

export const FIND_TOP_MAX = 25;
export const FIND_TOP_DEFAULT = 5;

export function findTools(catalog, query, { k = 5, baseUrl = "", powSlugs } = {}) {
  // Cap the query length so a pathological input can't drive unbounded work.
  const q = String(query || "").slice(0, 500);
  // Strip stopwords + 1-char tokens — they match thousands of tools and add noise
  // without signal. Keep the cap tight so each scoring pass is bounded.
  // Unicode-aware (src/query-terms.js): CJK runs become bigrams + the run;
  // Latin runs are unchanged.
  const rawTerms = queryTerms(q, { max: 64 });
  const terms = rawTerms.filter((t) => t.length > 1 && !STOPWORDS.has(t)).slice(0, 32);
  // Unit-word synonym: "convert miles to kilometers"-style tasks used to hit a
  // dedicated pairwise slug; now they must resolve to unit-convert. One
  // synthetic "units" term (a curated unit-convert tag) is enough to break the
  // score tie against the other *-convert tools without distorting queries
  // that never mention a unit.
  if (!terms.includes("units") && terms.some((t) => UNIT_WORDS.has(t))) terms.push("units");
  // Same mechanism for DELEGATED PURCHASE intent: "buy a tool from another
  // seller", "pay an external api on my behalf" are asking for the Smart Order
  // Router (it resolves a seller, pays them over x402, relays the result), but
  // lexically they lose to unrelated tools - "api" matches every openapi-*
  // slug and "pay" matches "payload" (audited 2026-07-28). Requires BOTH a
  // delegation verb AND a third-party marker, so ordinary "buy"/"pay" queries
  // are untouched; the synthetic "sor" term is a curated route-execute tag.
  if (!terms.includes("sor")
    && terms.some((t) => DELEGATION_VERBS.has(t))
    && terms.some((t) => THIRD_PARTY_MARKERS.has(t))) terms.push("sor");
  // "layer 2" is the spelled-out form of the tag every L2 tool already carries,
  // but neither token survives to match on: the digit is a 1-char token dropped
  // above, leaving bare "layer" - which reached nothing ("layer 2 updates"
  // resolved to sql-guard at 4). Matched as a PHRASE, never as the word alone:
  // tagging "layer" on the L2 tools was tried first and sent "osi model layer"
  // and "layer of encryption" to l2-tvl at high confidence. "layer" is ordinary
  // English; "layer 2" is not.
  if (!terms.includes("l2") && /\blayer[\s-]*2\b/.test(q.toLowerCase())) terms.push("l2");
  // Front-door bias (search / answer / news): common agent jobs should land on
  // the flagship web tools first. Phrase-gated like "layer 2" so ordinary words
  // ("search" inside "search tools catalog", bare "question") do not hijack
  // unrelated tasks. Tags appended are curated on search / answer / search-news.
  applyFrontDoorTerms(terms, q);
  // The default is FIVE and the ceiling is 25, and `count` below reports what
  // this answer carries - so a caller reading `count: 5` for a broad query was
  // being told five tools match when five is simply what we return. Publish the
  // ceiling and whether the ranking was cut by it, the same disclosure
  // /api/route and /api/index now carry (2026-09-22).
  const limit = Math.min(Math.max(parseInt(k, 10) || 5, 1), FIND_TOP_MAX);
  // The miss carries the same envelope as the hit: one shape to learn.
  if (!terms.length) return { query: q, count: 0, topMax: FIND_TOP_MAX, truncated: false, ...partialFields(0, 0), results: [] };

  // Directional alignment: how many adjacent (q[i], q[i+1]) query-term pairs
  // appear in the slug *in the same order*. Historically this broke the tie
  // between the symmetric pairwise convert slugs (miles-to-km vs km-to-miles —
  // both retired in favor of unit-convert); it still helps any directional
  // slug family (html-to-markdown vs markdown-to-html). Cheap to compute
  // (O(terms) per tool) and contributes only to the tiebreak, so it never
  // overrides a stronger lexical match.
  const directionScore = (slug) => {
    let s = 0;
    for (let i = 0; i < terms.length - 1; i++) {
      const a = slug.indexOf(terms[i]);
      const b = slug.indexOf(terms[i + 1]);
      if (a !== -1 && b !== -1 && a < b) s++;
    }
    return s;
  };

  // How INFORMATIVE is each query term? A term that matches half the catalog
  // ("check", "data", "text") says almost nothing about which tool is wanted; a
  // term that matches three ("sessions", "website", "transcribe") says almost
  // everything. Scoring them equally is why "check if a website is up" resolved
  // to `spf-check` — three tools share the word "check", the one distinguishing
  // word "website" counted for one point, and the common word decided it.
  //
  // Standard inverse-document-frequency, computed live from the catalog itself
  // so it needs no tuning table and cannot go stale as tools are added. Fully
  // deterministic: same catalog and same query give the same ranking, which the
  // no-LLM contract requires.
  //
  // Each tool is normalized ONCE here. The document-frequency pass is
  // O(terms x tools), so anything rebuilt inside it is rebuilt up to ~17,000
  // times per request (32 terms x 527 tools); concatenating the haystack per
  // pair measured 23ms p50 on a worst-case query. Hoisting it is the difference
  // between a scoring improvement and a latency regression on the entry point
  // we tell every agent to use.
  const all = toolList(catalog).map((t) => ({
    t,
    slug: t.slug.toLowerCase(),
    name: (t.name || "").toLowerCase(),
    segs: new Set(t.slug.toLowerCase().split("-")),
    tagSet: new Set((t.tags || []).map((tg) => String(tg).toLowerCase())),
    // Each alias as the words it is made of (stopwords and 1-letter parts
    // dropped, the same filter the query terms go through).
    aliasWords: (t.aliases || []).map((a) => String(a).toLowerCase().split(/[-\s]+/).filter((w) => w.length > 1 && !STOPWORDS.has(w))).filter((ws) => ws.length),
    // Aliases are in the haystack because /api/route already scores them and
    // the two resolvers disagreeing about the same tool is a defect a buyer
    // meets as "your search cannot find the endpoint your own URL serves".
    // Deliberately in `hay` rather than beside the slug: an alias is a name the
    // tool also answers to, not a stronger claim than its own name, and the
    // tag cap on the 402 challenge means aliases can never live in `tags`.
    hay: `${t.name} ${t.description} ${t.category} ${(t.tags || []).join(" ")} ${(t.aliases || []).join(" ")}`.toLowerCase(),
  }));
  const N = all.length || 1;
  // ONE-LETTER TYPOS. A word no tool mentions anywhere ("danctions") used to
  // score nothing and answer an empty list, which a caller reads as "no tool
  // does this". When a word of six or more letters matches nothing, it is
  // replaced by the catalog word one same-length edit away (two edits of any
  // kind for nine letters or more),
  // the most common one on a tie, and the answer says what it corrected.
  const corrected = {};
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (term.length < 6 || !/^[a-z]+$/.test(term)) continue;
    if (all.some((e) => e.slug.includes(term) || e.hay.includes(term))) continue;
    const fix = closestCatalogWord(term, catalogVocabulary(all));
    if (fix) { corrected[term] = fix; terms[i] = fix; }
  }
  const idf = new Map();
  for (const term of terms) {
    let df = 0;
    for (const e of all) if (e.slug.includes(term) || e.hay.includes(term)) df++;
    // log((N+1)/(df+1)): ~5.6 for a term unique to one tool, ~1.0 for one that
    // matches 200. Floored so a ubiquitous term still nudges rather than
    // flipping sign or vanishing entirely.
    idf.set(term, Math.max(0.25, Math.log((N + 1) / (df + 1))));
  }

  const termSet = new Set(terms);
  // Empty for a query that names no direction, so the passes below cost nothing.
  const pairs = conversionPairs(q, terms);
  const wayOf = new Map(); // slug -> { way, from, to }, only for tools that state one of the pairs
  const scored = [];
  for (const e of all) {
    const { t, slug, name, tagSet, hay, aliasWords } = e;
    // An alias counts only when EVERY word of it is in the query: "website
    // history" hits the alias website-history, but "chat" alone does not hit
    // chat-completions-nano-tier. Word-by-word credit let generic aliases
    // outrank a tool's own name.
    const aliasHitWords = new Set(aliasWords.filter((ws) => ws.every((w) => termSet.has(w))).flat());
    // Slugs are hyphenated words, so a WHOLE segment matching a query term is a
    // real signal while an incidental substring is usually an accident:
    // "check" sits inside "checksum", "data" inside "wikidata-entity", "detect"
    // inside "base-detect". Those accidents used to score the same +4 as a
    // genuine match, which is how "check if a website is up" resolved to
    // `checksum`/`spf-check` while `http-check` lost, and "store data between
    // sessions" resolved to `wikidata-entity` while the memory tools lost.
    //
    // A wrong top result is not a cosmetic problem here: /api/find is the entry
    // point we advertise everywhere, and an agent that trusts it pays for the
    // wrong tool and gets something useless on its first call.
    const segs = e.segs;
    let score = 0;
    for (const term of terms) {
      let s = 0;
      // A curated alias is a name the tool also answers to (/api/route scores
      // it like the slug). It scores like a word of the slug, never above the
      // tool's own exact name, and never ADDED to a slug hit (max, not sum).
      // At +1 in the haystack an alias moved nothing: "md5" ranked `hash`
      // below `checksum` although hash carries the alias (2026-09-25).
      const slugPart = slug === term ? 10 : segs.has(term) ? 6 : slug.includes(term) ? 2 : 0;
      const aliasPart = aliasHitWords.has(term) ? 6 : 0;
      s += Math.max(slugPart, aliasPart);
      if (name.includes(term)) s += 2;
      // A curated tag is a stronger signal than a stray hit in the description.
      if (tagSet.has(term)) s += 3;
      if (hay.includes(term)) s += 1;
      score += s * idf.get(term);           // weight by how much the term narrows things
    }
    if (score > 0) {
      scored.push([score, t, directionScore(slug)]);
      if (pairs.length) { const d = directionOf(t, pairs, catalog[t.route]); if (d) wayOf.set(t.slug, d); }
    }
  }
  const reversed = (t) => wayOf.get(t.slug)?.way === "reverse";
  // A tool whose own name states the query's direction backwards ranks below
  // every tool that does not, whatever it scored on the shared words; then
  // highest score first; then more in-order term pairs win (directional intent);
  // then shorter slug (more specific); then alpha for full determinism.
  scored.sort((a, b) =>
    (reversed(a[1]) ? 1 : 0) - (reversed(b[1]) ? 1 : 0) ||
    b[0] - a[0] ||
    b[2] - a[2] ||
    a[1].slug.length - b[1].slug.length ||
    a[1].slug.localeCompare(b[1].slug)
  );

  const results = scored.slice(0, limit).map(([score, t]) => {
    const example = t.discovery?.input ?? t.discovery?.example;
    const required = Array.isArray(t.discovery?.inputSchema?.required) ? t.discovery.inputSchema.required : [];
    // Pre-assemble the call so an agent doesn't have to split the route string
    // and decide body-vs-query itself. Body for write methods, query for the rest.
    // Skipped when there's no example — `callExample` should always be runnable.
    let callExample;
    if (example && t.route) {
      const [method, path] = t.route.split(" ");
      callExample = ["POST", "PUT", "PATCH"].includes(method)
        ? { method, path, body: example }
        : { method, path, query: example };
    }
    return {
      slug: t.slug,
      name: t.name,
      route: t.route,
      price: t.price,
      // Served alongside `price` so a consumer moving between /api/find,
      // /api/route and /api/index/tools reads the same field names everywhere.
      // These three surfaces disagreed on the spelling, and a missing key is
      // indistinguishable from a missing value.
      priceUsd: (() => { const n = Number(String(t.price ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) && String(t.price ?? "") !== "" ? n : null; })(),
      // Discovery up top: the answer to "how do I call this" should be visible
      // before the verbose description/schema/score fields.
      callExample,
      example,
      required,
      inputSchema: t.discovery?.inputSchema,
      category: t.category,
      description: t.description,
      score,
      computePayable: powSlugs ? powSlugs.has(t.slug) : undefined,
      docs: baseUrl ? `${baseUrl}/tools/${t.slug}` : undefined,
      // This tool's name states the opposite conversion to the one asked for.
      ...(reversed(t) ? { reversed: true } : {}),
    };
  });
  // Cross-surface: also recommend the matching skill pack(s) so an agent asking
  // about a multi-tool task (e.g. "audit a domain") sees the whole workflow,
  // not just the highest-scoring single tool. Empty array when nothing matches
  // strongly — packs only show up when the lexical signal is real.
  // Price each pack's steps from the SAME catalog we just ranked, so the
  // a la carte comparison is live rather than a second copy of the price list.
  const priceIndex = new Map();
  for (const t of toolList(catalog)) {
    const n = Number(String(t.price ?? "").replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n)) priceIndex.set(String(t.slug).toLowerCase(), n);
  }
  const packs = rankSkillPacks(q, {
    k: 2, baseUrl,
    toolPriceUsd: (slug) => priceIndex.get(String(slug).toLowerCase()) ?? null,
    ...(powSlugs ? { toolFree: (slug) => powSlugs.has(slug) } : {}),
  });
  // DID WE ACTUALLY SERVE THE QUERY, or just score well on its common words?
  //
  // The absolute score cannot answer that. Measured against the live catalog,
  // eighteen tasks this service genuinely cannot do — "order me a pizza",
  // "call my mother", "write my thesis", "detect the language of text" — every
  // one returned a confident top hit scoring 4 to 42, far above the weak-match
  // floor of 3. "call" matched `eth-call`, "car" matched `card-validate`,
  // "write" matched `memory-write`. Nothing was ever recorded as a miss.
  //
  // Two consequences, and the second is the expensive one:
  //   * a buyer who trusts the top hit pays for a tool that cannot help;
  //   * the demand board's find-miss signal can NEVER fire for a capability
  //     gap phrased in plain English, so it only ever captured gibberish
  //     ("undefined", "[object object]") and is structurally blind to what we
  //     should build next. "No demand for X" was unfalsifiable.
  //
  // The rarest term is the one that defines the task: "language" in "detect the
  // language of text", "pizza" in "order me a pizza". If the top result does
  // not mention it ANYWHERE — slug, name, description, tags, category — we did
  // not serve the query, however high the score climbed on "detect" or "order".
  //
  // This is ADDITIVE. Ranking is untouched and every result is still returned;
  // it only lets the caller tell a real answer from a lexical coincidence.
  let rarestTerm = null, rarestTermCovered = true, coverageShare = null;
  // A DATA VALUE is never the word that defines a task: "1767200000" in
  // "convert unix timestamp 1767200000 to ...", "400x400", an encoded payload,
  // or a time-zone city ("auckland"). No tool describes those, so each made a
  // correct top hit read as a miss and filed a wish (replayed from the demand
  // board 2026-10-06). They still count toward ranking; they just never decide.
  const defining = terms.filter((t) => !isValueTerm(t));
  if (results.length && defining.length) {
    rarestTerm = defining.reduce((a, b) => (idf.get(b) > idf.get(a) ? b : a));
    const top = all.find((e) => e.t.slug === results[0].slug);
    // Check the FULL catalog record, tags included: the API response omits
    // `tags`, so a tool whose match lives in a tag would read as a miss there.
    const covers = (term) => !!top && (top.slug.includes(term) || top.hay.includes(term) || top.tagSet.has(term));
    rarestTermCovered = covers(rarestTerm);
    // An uncovered rarest term is often an incidental word that no tool
    // mentions ("claims" in "decode jwt token and extract claims", "statute" in
    // "convert statute miles to kilometers"): the top hit IS the answer, yet
    // every such query was told to file a wish and recorded as a miss - 346 of
    // the 359 live clusters on the demand board read that way on 2026-09-25.
    // So the rarest term decides only when the top hit carries little of the
    // query's weight: to count as served it must cover at least two terms, at
    // least half the query's idf weight, and at least one term in its own slug
    // or name (a description-only overlap is how "excel data jobs" reached an
    // unemployment tool). "call my mother" (covers "call" only) and "order me
    // a pizza" stay misses.
    if (!rarestTermCovered && top) {
      let coveredW = 0, totalW = 0, coveredN = 0, named = false;
      for (const term of terms) {
        const w = idf.get(term) || 0;
        totalW += w;
        if (covers(term)) {
          coveredW += w; coveredN++;
          if (top.slug.includes(term) || top.name.includes(term)) named = true;
        }
      }
      coverageShare = totalW > 0 ? coveredW / totalW : 0;
      if (coveredN >= 2 && coverageShare >= 0.5 && named) rarestTermCovered = true;
    }
  }

  // A stated direction that only a reversed tool matches. When some tool's
  // name states the opposite conversion, none states the one asked for, and
  // the top result does not mention both the source and the target, no tool
  // here converts that way: the answer says so in `direction.served` and
  // reads as a miss (rarestTermCovered false is the one switch every caller
  // of this function already reads to mark the rows weak and record the need).
  let direction = null;
  const firstReversed = scored.find((x) => reversed(x[1]));
  if (firstReversed && results.length) {
    const { from, to } = wayOf.get(firstReversed[1].slug);
    const forward = scored.some((x) => wayOf.get(x[1].slug)?.way === "forward");
    const top = all.find((e) => e.t.slug === results[0].slug);
    const mentions = (term) => !!top && (top.slug.includes(term) || top.hay.includes(term) || top.tagSet.has(term));
    // Without a tool named for the direction, the top result still serves it
    // when it mentions both ends (a general converter, a tool whose name
    // does not spell the direction out): a tool that may do the task is
    // never marked as a miss.
    const served = forward || (!reversed(results[0]) && mentions(from) && mentions(to));
    direction = { from, to, served, reversed: scored.filter((x) => reversed(x[1])).slice(0, 5).map((x) => x[1].slug) };
    if (!served) rarestTermCovered = false;
  }

  return {
    query: String(query),
    // `count` is what this answer CARRIES. It read as "this is how many tools
    // can do that" - `count: 5` against a 600-row catalog is the same silence
    // that had one page of /api/index read as the whole index. `matched` is the
    // number a caller concluding "there is no tool for this" actually needs.
    count: results.length,
    topMax: FIND_TOP_MAX,
    ...partialFields(scored.length, results.length),
    ...clampFields(k, FIND_TOP_MAX, "k"),
    truncated: results.length >= limit && scored.length > results.length,
    results,
    packs,
    rarestTerm,
    rarestTermCovered,
    ...(coverageShare != null ? { coverageShare: Math.round(coverageShare * 100) / 100 } : {}),
    ...(Object.keys(corrected).length ? { corrected } : {}),
    ...(direction ? { direction } : {}),
  };
}

// Every word the catalog uses, with how many tools use it. Built once per
// catalog list and reused, so a typo costs one scan of the vocabulary, not of
// every tool's text.
// Keyed on the list's slugs: the catalog list is rebuilt per call, so an
// object key would never hit.
const vocabCache = new Map();
function catalogVocabulary(all) {
  const key = all.length ? all.map((e) => e.slug).join(",") : "";
  if (key && vocabCache.has(key)) return vocabCache.get(key).words;
  const words = new Map();
  for (const e of all) {
    for (const w of new Set(`${e.slug.replace(/-/g, " ")} ${e.hay}`.split(/[^a-z]+/))) {
      if (w.length >= 4) words.set(w, (words.get(w) || 0) + 1);
    }
  }
  if (key) {
    if (vocabCache.size >= 4) vocabCache.delete(vocabCache.keys().next().value);
    vocabCache.set(key, { words });
  }
  return words;
}

/** The catalog word within one edit of `term` (two at nine letters or more),
 *  the most common on a tie; null when there is none. Edits are insert,
 *  delete, substitute and swap of two neighbors; under nine letters only a
 *  same-length edit counts. */
export function closestCatalogWord(term, words) {
  const max = term.length >= 9 ? 2 : 1;
  let best = null, bestD = max + 1, bestN = 0;
  for (const [w, n] of words) {
    // Under nine letters only a same-length slip counts (one letter replaced
    // or two neighbors swapped): adding or dropping a letter turns real words
    // into other real words ("mother" into "other") and would hide a miss.
    if (max === 1 ? w.length !== term.length : Math.abs(w.length - term.length) > max) continue;
    const d = editDistance(term, w, max);
    if (d < bestD || (d === bestD && n > bestN)) { best = w; bestD = d; bestN = n; }
  }
  return bestD <= max && bestD > 0 ? best : null;
}

function editDistance(a, b, cap) {
  const m = a.length, n = b.length;
  let prev2 = null, prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    prev2 = prev; prev = cur;
  }
  return prev[n];
}

/**
 * A query no catalog tool serves still returns its nearest word matches
 * ("book a flight" ranked the order-book tools on "book"). Mark every row weak
 * so a caller that reads only `results` does not pay for one; the rows stay.
 */
export function markMissRows(result) {
  if (!result || typeof result !== "object") return result;
  result.weakMatches = true;
  result.results = (Array.isArray(result.results) ? result.results : []).map((r) => ({ ...r, weak: true }));
  return result;
}

/**
 * When no catalog tool does the task but an indexed seller does, the rows /api/find
 * still returns are its nearest word matches, not answers ("book a flight" ranked
 * the order-book tools on the word "book"). An agent that reads only `results`
 * would pay for one. Mark every row weak and lead the hint with the router link;
 * the rows stay, so a client that reads them keeps working.
 */
export function markWeakMatches(result, routeAcross) {
  if (!result || typeof result !== "object") return result;
  result.weakMatches = true;
  result.results = (Array.isArray(result.results) ? result.results : []).map((r) => ({ ...r, weak: true }));
  result.hint = "none of these results does this task; an indexed seller does - call routeAcross";
  result.routeAcross = routeAcross;
  return result;
}

/**
 * The find->seller bridge: does this query look like the NAME of an indexed
 * x402 seller rather than (or as well as) a task? Agents search /api/find for
 * sellers by name - a cluster of recorded "misses" were hunts for one indexed
 * seller by its host label (2026-07-28). Pure lexical matching over the
 * routable-seller summaries; returns AT MOST max sellers as {host, origin,
 * toolCount} - no third-party display text rides along, by construction.
 *
 * Match rules (tuned against false positives on task-shaped queries):
 *  - exact host-label match at >=4 chars ("acmeagent" === label of acmeagent.example),
 *    excluding generic labels: "api" exactly matches api.example.com's label
 *    but an agent searching "api" wants tools, not that seller
 *  - substring either way at >=5 chars against the compacted host or the
 *    compacted query ("bigworldmodel" vs www.bigworldmodel.example)
 * Exact label matches rank first, then higher toolCount.
 */
const GENERIC_HOST_LABELS = new Set([
  "api", "apis", "app", "apps", "web", "www", "tool", "tools", "agent",
  "agents", "x402", "mcp", "data", "test", "demo", "dev", "io", "ai", "server",
]);
export function findRelatedSellers(query, sellers, { max = 3 } = {}) {
  const qcompact = String(query || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (qcompact.length < 4 || !Array.isArray(sellers) || GENERIC_HOST_LABELS.has(qcompact)) return [];
  const scored = [];
  for (const s of sellers) {
    const host = String(s.host || "").toLowerCase();
    if (!host) continue;
    const labels = host.split(".").filter((l) => l && l !== "www");
    const hostcompact = labels.join("");
    const exact = labels.some((l) => l.replace(/[^a-z0-9]/g, "") === qcompact);
    const substr = qcompact.length >= 5 && (hostcompact.includes(qcompact) || (hostcompact.length >= 5 && qcompact.includes(hostcompact)));
    if (!exact && !substr) continue;
    scored.push([exact ? 1 : 0, s.toolCount || 0, { host: s.host, origin: s.origin, toolCount: s.toolCount || 0 }]);
  }
  scored.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  return scored.slice(0, max).map((x) => x[2]);
}

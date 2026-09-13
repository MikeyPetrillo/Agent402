// One-call tool resolver. Instead of an agent spending tokens searching the web
// and reading pages just to discover how to do something, it sends a task
// description here and gets back the best-matching tool(s) with everything needed
// to call them directly: route, price, input schema, and a ready example.
// Deterministic lexical ranking (no LLM, no tokens), consistent with the MCP
// connector's search_tools weighting.
import { toolList } from "./pages.js";
import { queryTerms } from "./query-terms.js";
import { rankSkillPacks } from "./skills.js";
import { UNIT_CATEGORIES } from "./tools/convert-gen.js";
import { UNIT_ALIASES } from "./tools/kit2.js";

// Common English stopwords that contribute noise instead of intent. Kept short
// on purpose — every word here matches many tool descriptions, so dropping it
// from the query sharpens ranking without affecting recall on the intent words.
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
  const limit = Math.min(Math.max(parseInt(k, 10) || 5, 1), 25);
  if (!terms.length) return { query: q, count: 0, results: [] };

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
    // Aliases are in the haystack because /api/route already scores them and
    // the two resolvers disagreeing about the same tool is a defect a buyer
    // meets as "your search cannot find the endpoint your own URL serves".
    // Deliberately in `hay` rather than beside the slug: an alias is a name the
    // tool also answers to, not a stronger claim than its own name, and the
    // tag cap on the 402 challenge means aliases can never live in `tags`.
    hay: `${t.name} ${t.description} ${t.category} ${(t.tags || []).join(" ")} ${(t.aliases || []).join(" ")}`.toLowerCase(),
  }));
  const N = all.length || 1;
  const idf = new Map();
  for (const term of terms) {
    let df = 0;
    for (const e of all) if (e.slug.includes(term) || e.hay.includes(term)) df++;
    // log((N+1)/(df+1)): ~5.6 for a term unique to one tool, ~1.0 for one that
    // matches 200. Floored so a ubiquitous term still nudges rather than
    // flipping sign or vanishing entirely.
    idf.set(term, Math.max(0.25, Math.log((N + 1) / (df + 1))));
  }

  const scored = [];
  for (const e of all) {
    const { t, slug, name, tagSet, hay } = e;
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
      if (slug === term) s += 10;
      else if (segs.has(term)) s += 6;      // a whole word of the slug
      else if (slug.includes(term)) s += 2; // incidental substring, kept but demoted
      if (name.includes(term)) s += 2;
      // A curated tag is a stronger signal than a stray hit in the description.
      if (tagSet.has(term)) s += 3;
      if (hay.includes(term)) s += 1;
      score += s * idf.get(term);           // weight by how much the term narrows things
    }
    if (score > 0) scored.push([score, t, directionScore(slug)]);
  }
  // Highest score first; then more in-order term pairs win (directional intent);
  // then shorter slug (more specific); then alpha for full determinism.
  scored.sort((a, b) =>
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
  let rarestTerm = null, rarestTermCovered = true;
  if (results.length && terms.length) {
    rarestTerm = terms.reduce((a, b) => (idf.get(b) > idf.get(a) ? b : a));
    const top = all.find((e) => e.t.slug === results[0].slug);
    // Check the FULL catalog record. An earlier attempt tested the API response,
    // which omits `tags` — so tools whose match lives in a tag looked like
    // misses, and the rule appeared to have a 40% false-positive rate it did
    // not have.
    rarestTermCovered = top
      ? top.slug.includes(rarestTerm) || top.hay.includes(rarestTerm) || top.tagSet.has(rarestTerm)
      : false;
  }

  return {
    query: String(query),
    count: results.length,
    results,
    packs,
    rarestTerm,
    rarestTermCovered,
  };
}

/**
 * The find->seller bridge: does this query look like the NAME of an indexed
 * x402 seller rather than (or as well as) a task? Agents search /api/find for
 * sellers by name - 25 recorded "misses" for "minia2a" were hunts for the
 * indexed seller minia2a.uk (2026-07-28). Pure lexical matching over the
 * routable-seller summaries; returns AT MOST max sellers as {host, origin,
 * toolCount} - no third-party display text rides along, by construction.
 *
 * Match rules (tuned against false positives on task-shaped queries):
 *  - exact host-label match at >=4 chars ("minia2a" === label of minia2a.uk),
 *    excluding generic labels: "api" exactly matches api.example.com's label
 *    but an agent searching "api" wants tools, not that seller
 *  - substring either way at >=5 chars against the compacted host or the
 *    compacted query ("cloudworldmodel" vs www.cloudworldmodel.ai)
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

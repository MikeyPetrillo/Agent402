// One-call tool resolver. Instead of an agent spending tokens searching the web
// and reading pages just to discover how to do something, it sends a task
// description here and gets back the best-matching tool(s) with everything needed
// to call them directly: route, price, input schema, and a ready example.
// Deterministic lexical ranking (no LLM, no tokens), consistent with the MCP
// connector's search_tools weighting.
import { toolList } from "./pages.js";
import { rankSkillPacks } from "./skills.js";

// Common English stopwords that contribute noise instead of intent. Kept short
// on purpose — every word here matches many tool descriptions, so dropping it
// from the query sharpens ranking without affecting recall on the intent words.
const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "to", "for", "with", "by", "and", "or",
  "is", "are", "was", "were", "be", "been", "this", "that", "it", "as", "at",
  "from", "into", "onto", "my", "me", "i", "you", "your", "we", "our",
  "do", "does", "did", "can", "will", "would", "should",
]);

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
  const rawTerms = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const terms = rawTerms.filter((t) => t.length > 1 && !STOPWORDS.has(t)).slice(0, 32);
  const limit = Math.min(Math.max(parseInt(k, 10) || 5, 1), 25);
  if (!terms.length) return { query: q, count: 0, results: [] };

  const scored = [];
  for (const t of toolList(catalog)) {
    const slug = t.slug.toLowerCase();
    const name = (t.name || "").toLowerCase();
    const tagSet = new Set((t.tags || []).map((tg) => String(tg).toLowerCase()));
    const hay = `${t.name} ${t.description} ${t.category} ${(t.tags || []).join(" ")}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (slug === term) score += 10;
      else if (slug.includes(term)) score += 4;
      if (name.includes(term)) score += 2;
      // A curated tag is a stronger signal than a stray hit in the description.
      if (tagSet.has(term)) score += 3;
      if (hay.includes(term)) score += 1;
    }
    if (score > 0) scored.push([score, t]);
  }
  // Highest score first; break ties by shorter slug (more specific) then alpha.
  scored.sort((a, b) => b[0] - a[0] || a[1].slug.length - b[1].slug.length || a[1].slug.localeCompare(b[1].slug));

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
  const packs = rankSkillPacks(q, { k: 2, baseUrl });
  return { query: String(query), count: results.length, results, packs };
}

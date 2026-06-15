// One-call tool resolver. Instead of an agent spending tokens searching the web
// and reading pages just to discover how to do something, it sends a task
// description here and gets back the best-matching tool(s) with everything needed
// to call them directly: route, price, input schema, and a ready example.
// Deterministic lexical ranking (no LLM, no tokens), consistent with the MCP
// connector's search_tools weighting.
import { toolList } from "./pages.js";

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
  const terms = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 32);
  const limit = Math.min(Math.max(parseInt(k, 10) || 5, 1), 25);
  if (!terms.length) return { query: q, count: 0, results: [] };

  const scored = [];
  for (const t of toolList(catalog)) {
    const slug = t.slug.toLowerCase();
    const name = (t.name || "").toLowerCase();
    const hay = `${t.name} ${t.description} ${t.category} ${(t.tags || []).join(" ")}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (slug === term) score += 10;
      else if (slug.includes(term)) score += 4;
      if (name.includes(term)) score += 2;
      if (hay.includes(term)) score += 1;
    }
    if (score > 0) scored.push([score, t]);
  }
  // Highest score first; break ties by shorter slug (more specific) then alpha.
  scored.sort((a, b) => b[0] - a[0] || a[1].slug.length - b[1].slug.length || a[1].slug.localeCompare(b[1].slug));

  const results = scored.slice(0, limit).map(([score, t]) => ({
    slug: t.slug,
    name: t.name,
    route: t.route,
    price: t.price,
    category: t.category,
    description: t.description,
    score,
    computePayable: powSlugs ? powSlugs.has(t.slug) : undefined,
    inputSchema: t.discovery?.inputSchema,
    example: t.discovery?.input ?? t.discovery?.example,
    docs: baseUrl ? `${baseUrl}/tools/${t.slug}` : undefined,
  }));
  return { query: String(query), count: results.length, results };
}

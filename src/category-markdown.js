// Markdown catalogs an agent can load whole: /tools.md lists the categories and
// /tools/<category>.md lists that category's tools, one line each (route,
// price, a one-sentence description, its page). The full machine surfaces
// (/openapi.json, /api/pricing, /llms-full.txt) are too large for one context
// window; these are the split. Prices come from the catalog entry itself, the
// same value the 402 quotes, and a route quoted per request says "from".
import { toolList, CATEGORIES } from "./pages.js";
import { isComputePayable } from "./pow.js";
import { fromPriceLabel } from "./quoted-from.js";
import { mppOffered } from "./site-org.js";

/** Bytes one category catalog may take (scripts/test-agent-catalogs.js). */
export const CATEGORY_MD_BUDGET_BYTES = 64 * 1024;
const DESC_MAX = 200;

const priceOf = (t) => (t.quoteRange && t.quoteRange.maxUsd > t.quoteRange.minUsd ? `from ${fromPriceLabel(t)}` : String(t.price ?? ""));
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
/** The first sentence, or the text cut at a word within DESC_MAX. */
function shortDesc(text) {
  const s = oneLine(text);
  const m = s.match(/^(.{20,}?[.!?])(\s|$)/);
  const first = m ? m[1] : s;
  if (first.length <= DESC_MAX) return first;
  const cut = first.slice(0, DESC_MAX + 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[\s,;:-]+$/, "")}...`;
}
const mdText = (s) => oneLine(s).replace(/([\\`*_[\]<>|])/g, "\\$1");

/** The categories the live catalog uses, in CATEGORIES order. */
export function usedCategories(catalog) {
  const used = new Set(toolList(catalog).map((t) => t.category));
  return Object.keys(CATEGORIES).filter((k) => used.has(k) && k !== "convert");
}

export function categoryMarkdown(baseUrl, catalog, key) {
  if (!Object.hasOwn(CATEGORIES, key) || !usedCategories(catalog).includes(key)) return null;
  const cat = CATEGORIES[key];
  const tools = toolList(catalog).filter((t) => t.category === key).sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  const lines = tools.map((t) => `- [${mdText(t.name || t.slug)}](${baseUrl}/tools/${t.slug}): \`${t.method} ${t.path}\`, ${priceOf(t)}${isComputePayable(t) ? " or free with proof-of-work" : ""}. ${mdText(shortDesc(t.description))}`);
  return `# ${cat.label}

${oneLine(cat.blurb)}

${tools.length} tools. Pay per call over x402${mppOffered() ? " or MPP" : ""} (the 402 on each route names the ways it takes); input schemas: ${baseUrl}/openapi.json?category=${key}. All categories: ${baseUrl}/tools.md

${lines.join("\n")}
`;
}

export function categoriesMarkdownIndex(baseUrl, catalog) {
  const all = toolList(catalog);
  const rows = usedCategories(catalog).map((k) => `- [${mdText(CATEGORIES[k].label)}](${baseUrl}/tools/${k}.md): ${all.filter((t) => t.category === k).length} tools`);
  return `# Agent402 tool catalog, by category

One markdown file per category, each small enough to load whole. Every route and price: ${baseUrl}/api/pricing ; input schemas per category: ${baseUrl}/openapi.json?category=<key>

${rows.join("\n")}
`;
}

// The prose word count of a served /tools/<slug> page, the definition
// scripts/test-tool-page-words.js budgets (read its header for the rule).
import { stripScripts, stripTags } from "./html-text.js";

import { MAX_WORDS as DESCRIPTION_MAX_WORDS, PAGE_SUMMARY } from "./description-limits.js";

export const LEAD_MAX = 45;
export const BODY_MAX = 250;
// The Details paragraph (.tp-about): what is left of the page text after the
// lead sentence. A tool with a pageSummary shows that shorter text, so its
// Details holds at most ABOUT_MAX_SUMMARY words; every other tool shows its
// catalog description, held to that description's own ceiling.
export const ABOUT_MAX_SUMMARY = 130;
export const ABOUT_MAX_DESCRIPTION = DESCRIPTION_MAX_WORDS;
const SUMMARIZED = new Set(PAGE_SUMMARY);
export const aboutMaxFor = (slug) => (SUMMARIZED.has(slug) ? ABOUT_MAX_SUMMARY : ABOUT_MAX_DESCRIPTION);

const dropAll = (s, re) => { let prev; do { prev = s; s = s.replace(re, " "); } while (s !== prev); return s; };

/** The words of an HTML fragment's prose (definition above). */
export function proseWords(html) {
  let s = stripScripts(String(html ?? ""));
  for (const re of [/<pre\b[^>]*>[\s\S]*?<\/pre\s*>/gi, /<code\b[^>]*>[\s\S]*?<\/code\s*>/gi, /<table\b[^>]*>[\s\S]*?<\/table\s*>/gi,
    /<figure\b[^>]*>[\s\S]*?<\/figure\s*>/gi, /<nav\b[^>]*>[\s\S]*?<\/nav\s*>/gi, /<h1\b[^>]*>[\s\S]*?<\/h1\s*>/gi]) s = dropAll(s, re);
  // Entities read as the characters they show (a no-break space as a space), so
  // "webhook&#39;s" is one word, as a reader sees it.
  const text = stripTags(s).replace(/&nbsp;|&#160;/g, " ").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&(?!amp;)[a-z]+;|&#\d+;/gi, " ").replace(/&amp;/g, "&").replace(/\u2060/g, "");
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/** The tool's own paragraph under Details: its pageSummary, or its catalog
 *  description, less the sentence the page leads with. */
const ABOUT = /<p class="tp-sub tp-about">[\s\S]*?<\/p\s*>/i;

/** { lead, body, about } prose word counts of a served tool page: `body` is
 *  the template's prose below the lead, `about` the tool's own description
 *  paragraph, counted apart (lead + body + about is every prose word). */
export function toolPageWords(html) {
  const src = String(html ?? "");
  const start = src.indexOf('<div class="tp-wrap">');
  if (start < 0) return null;
  const foot = src.indexOf("<footer", start);
  const col = src.slice(start, foot < 0 ? src.length : foot);
  const h2 = col.search(/<h2\b/);
  const lead = h2 < 0 ? col : col.slice(0, h2);
  const below = h2 < 0 ? "" : col.slice(h2);
  const about = (below.match(ABOUT) || [""])[0];
  return { lead: proseWords(lead).length, body: proseWords(below.replace(ABOUT, " ")).length, about: proseWords(about).length };
}

// Where a lead the template cut may not stop (cutWords in src/pages.js holds
// the same two lists): a bare number or price, and a connecting word.
const LEAD_END_NUMBER = /^[$€£]?\d[\d.,:/-]*%?$/;
export const LEAD_END_WORDS = ["a", "an", "the", "and", "or", "nor", "but", "of", "on", "in", "to", "for", "by", "with", "from", "at", "as", "via", "into", "onto", "per", "than", "that", "which", "its", "is", "are", "plus", "over", "under", "across", "between", "through", "within", "without", "when", "while", "if", "vs"];
const END_WORD = new Set(LEAD_END_WORDS);

/** What is wrong with how a page's lead ends, as a list of words (empty when
 *  nothing is). `lead` and `about` are the texts of the lead and the Details
 *  paragraph as a reader sees them (tags out, entities decoded).
 *    every lead: "open parenthesis", "open bracket", "open quote", and
 *      "abbreviation" (it stops on "e.g." or "i.e.").
 *    a lead the template cut (it ends "...", or Details repeats it and goes
 *      on): "number" (its last word is a bare number or a price), "word:<w>"
 *      (a connecting word), and for one ending "..." also "mid-clause": the
 *      text it was cut from does not go on with a comma, semicolon, colon,
 *      spaced dash or opening parenthesis, and the lead does not end on a
 *      closing bracket. */
export function leadFaults(lead, about = "") {
  const L = String(lead || "").trim();
  const ellipsis = L.endsWith("...");
  const body = (ellipsis ? L.slice(0, -3) : L.replace(/[.!?]$/, "")).trim();
  const faults = [];
  const count = (ch) => body.split(ch).length - 1;
  if (count("(") > count(")")) faults.push("open parenthesis");
  if (count("[") > count("]") || count("{") > count("}")) faults.push("open bracket");
  if (count('"') % 2 || count("`") % 2) faults.push("open quote");
  if (/(?:^|[^a-z])(?:e\.g|i\.e)$/i.test(body)) faults.push("abbreviation");
  const rest = String(about || "").startsWith(body) ? String(about).slice(body.length) : null;
  const cut = ellipsis || (rest != null && rest.replace(/^[.!?]/, "").trim() !== "");
  if (!cut) return faults;
  const last = (body.split(/\s+/).at(-1) || "").replace(/[,;:.!?)\]}"'`]+$/g, "").replace(/^[(\[{"'`]+/, "");
  if (LEAD_END_NUMBER.test(last)) faults.push("number");
  if (END_WORD.has(last.toLowerCase())) faults.push(`word:${last}`);
  if (ellipsis && !/[)\]}]$/.test(body) && !(rest != null && /^(?:[,;:]| [-–] | \()/.test(rest))) faults.push("mid-clause");
  return faults;
}

const paragraphText = (html, cls) => {
  const m = new RegExp(`<p class="${cls}"[^>]*>([\\s\\S]*?)</p\\s*>`, "i").exec(String(html ?? ""));
  if (!m) return "";
  return stripTags(m[1], "").replace(/&nbsp;|&#160;/g, " ").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
};
/** { lead, about } of a served tool page, as text. */
export const toolPageLead = (html) => ({ lead: paragraphText(html, "tp-lead"), about: paragraphText(html, "tp-sub tp-about") });

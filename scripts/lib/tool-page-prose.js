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

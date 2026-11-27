// Prose word counts for page-length budgets.
//
// Prose is what a reader reads as sentences: code blocks, inline code, tables,
// scripts and styles are dropped before counting, and a word is a run of
// non-space characters holding a letter or a digit (so a bare "-" or an
// entity such as "&middot;" is not a word).
import { stripScripts, stripTags, decodeEntities } from "./html-text.js";

function dropElements(html, tag) {
  let s = String(html ?? "");
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
  let prev;
  do { prev = s; s = s.replace(re, " "); } while (s !== prev);
  return s;
}

/** Words of prose in an HTML fragment (code and tables excluded). */
export function proseWords(html) {
  let s = stripScripts(html);
  for (const tag of ["pre", "table", "code"]) s = dropElements(s, tag);
  // An entity left after decoding (&middot;, &rarr;) is a mark, not a word.
  const text = decodeEntities(stripTags(s)).replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, " ");
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** A skill pack page split into its lead (the paragraph under the h1) and its
 *  body (everything after the lead up to the back link, less the sources'
 *  attribution sentences, counted apart), as prose word counts.
 *  null when the page does not have that shape. */
export function packPageProse(html) {
  const s = String(html ?? "");
  const h1End = s.indexOf("</h1>");
  const end = s.indexOf("All skill packs</a>");
  if (h1End < 0 || end < 0) return null;
  const rest = s.slice(h1End + 5, end);
  const m = /^\s*<p\b[^>]*>([\s\S]*?)<\/p>/.exec(rest);
  if (!m) return null;
  // The bought route under the price is a literal, not prose; the sources'
  // attribution sentences are their required wording, counted on their own.
  const after = rest.slice(m[0].length).replace(/<div class="sk-buy-route">[\s\S]*?<\/div>/g, " ");
  const attr = /<p class="sk-attr"[^>]*>([\s\S]*?)<\/p>/.exec(after);
  const body = attr ? after.replace(attr[0], " ") : after;
  return { lead: proseWords(m[1]), body: proseWords(body), attribution: attr ? proseWords(attr[1]) : 0 };
}

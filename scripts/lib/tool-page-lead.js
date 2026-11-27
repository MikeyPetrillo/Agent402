// How a served tool page's lead ends: the checks scripts/test-tool-page-words.js
// holds every lead to. The word counts live in ./page-words.js ("tool" mode).
import { stripTags } from "./html-text.js";

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

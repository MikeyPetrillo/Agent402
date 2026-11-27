// Prose word counts for a rendered page, the measure the long-page budgets
// read (scripts/test-ops-page-words.js).
//
// Counted: the words a reader meets in the page's <main>, as prose. Not
// counted: scripts, styles, svg, tables, code and pre blocks (figures and
// commands, not reading), the site footer and nav, a paragraph hidden until
// a control shows it, and the body of a closed <details> (optional detail
// the reader opens on purpose); its <summary> is counted. A word is a
// run that holds a letter, so a bare figure is not a word.
import { stripScripts, stripTags, decodeEntities } from "./html-text.js";

/** The inner HTML of the page's <main>, or the whole page when it has none. */
export function mainOf(html) {
  const s = String(html ?? "");
  const open = s.search(/<main\b[^>]*>/i);
  if (open < 0) return s;
  const start = s.indexOf(">", open) + 1;
  const end = s.lastIndexOf("</main>");
  return s.slice(start, end > start ? end : s.length);
}

// Remove the innermost element of `tag` until none is left, so nested ones
// are removed whole.
function dropElement(html, tag, keep = () => " ") {
  const re = new RegExp(`<${tag}\\b([^>]*)>((?:(?!<${tag}\\b)[\\s\\S])*?)</${tag}\\s*>`, "i");
  let s = html;
  let m;
  while ((m = re.exec(s))) s = s.slice(0, m.index) + keep(m) + s.slice(m.index + m[0].length);
  return s;
}

/** The prose a reader sees with every optional detail closed. */
export function proseText(html) {
  let s = stripScripts(String(html ?? ""));
  for (const tag of ["svg", "table", "pre", "code", "footer", "nav"]) s = dropElement(s, tag);
  // A paragraph the page hides until a control shows it is not on screen.
  s = s.replace(/<p\b[^>]*\bstyle="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/p\s*>/gi, " ");
  // A closed <details> keeps only its summary; an open one is read whole.
  s = dropElement(s, "details", (m) => {
    if (/\bopen\b/i.test(m[1])) return ` ${m[2]} `;
    const sum = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(m[2]);
    return ` ${sum ? sum[1] : ""} `;
  });
  return decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();
}

export function countWords(text) {
  return (String(text).match(/[^\s]*[A-Za-z][^\s]*/g) || []).length;
}

/** Prose words in the page's <main>. */
export function mainProseWords(html) {
  return countWords(proseText(mainOf(html)));
}

/** Prose words in <main> before its first <h2>. */
export function wordsBeforeFirstH2(html) {
  const m = mainOf(html);
  const at = m.search(/<h2\b/i);
  return countWords(proseText(at < 0 ? m : m.slice(0, at)));
}

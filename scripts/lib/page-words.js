// One word counter for every page-length budget. Four modes, each the measure
// one family of budget tests holds; a mode's rule is stated once, above its
// functions, and scripts/test-page-words.js pins each on fixed HTML.
//
//   main      (test-ops-page-words, test-legal-summary)
//             mainProseWords, wordsBeforeFirstH2, proseText, mainOf, countWords
//             Prose in the page's <main> with every optional detail closed.
//             Not counted: scripts, styles, svg, tables, code, pre, the footer
//             and nav, a paragraph styled display:none, the body of a closed
//             <details> (its summary is counted; an open one is read whole).
//             A word holds a LETTER: a bare figure, a separator dot or any
//             other token of punctuation alone is not a word. Entities: the
//             ones the renderers emit are decoded (&amp; &lt; &gt; &quot;
//             &#39; &#47;); a no-break space separates words; any other
//             entity standing alone (&middot;) is a mark, not a word.
//   visible   (test-hub-page-words)
//             visiblePageWords, countVisibleWords
//             Every word a sighted reader is shown from <main> to the site
//             footer, table cells and button labels included. Not counted:
//             code, nav and aside, aria-hidden, display:none and
//             screen-reader-only elements, the body of a closed <details>.
//             A word holds a letter OR a digit. `topWords` stops at the
//             first <h2>.
//   tool      (test-tool-page-words)
//             toolPageWords, toolProseWordList, the TOOL_* budgets, aboutMaxFor
//             A served /tools/<slug> page as { lead, body, about }: prose
//             above the first h2, the template's prose below it, and the
//             tool's own Details paragraph. Not counted: pre, code, tables,
//             figures, nav and the h1. Entities read as the characters they
//             show. A word holds a letter or a digit.
//   fragment  (test-pack-page-words, test-changelog-archive)
//             fragmentProseWords, packPageProse
//             Prose of an HTML fragment: pre, tables and code dropped, an
//             entity left after decoding is a mark, not a word. A word holds
//             a letter or a digit. packPageProse splits a skill pack page
//             into { lead, body, attribution }.
//
// The modes differ on purpose (a hub page's table cells are reading load, an
// operations page's are figures), so a budget names its mode and a limit is
// never compared across modes.
import { stripScripts, stripTags, decodeEntities } from "./html-text.js";
import { MAX_WORDS as DESCRIPTION_MAX_WORDS, PAGE_SUMMARY } from "./description-limits.js";

/** The modes, by name: what each counts (the header states each rule in full). */
export const MODES = Object.freeze({
  main: "prose in <main>, optional detail closed; a word holds a letter",
  visible: "every word a reader is shown from <main> to the footer; a word holds a letter or a digit",
  tool: "a tool page's lead, body and Details paragraph as prose",
  fragment: "prose of a fragment, code and tables dropped",
});

// ── main ────────────────────────────────────────────────────────────────────
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
  // A no-break space separates words like any space. An entity the decoder
  // leaves that stands alone (&middot;, &rarr;) is a mark, not a word; one
  // inside a word stays part of that word.
  const text = stripTags(s).replace(/&nbsp;|&#160;|&#xa0;|\u00a0/gi, " ");
  return decodeEntities(text).replace(/\u00a0/g, " ").replace(/(^|\s)&#?[a-z0-9]+;(?=\s|$)/gi, "$1").replace(/\s+/g, " ").trim();
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

// ── visible ─────────────────────────────────────────────────────────────────
// The page is read from <main> to the site footer, as one walk over its
// elements. An element served with the `hidden` attribute IS counted: the
// pages use it for blocks a script shows once their data loads (the home
// page's live figures and their labels), so a reader does see those words.
// Attribute text (a placeholder, a title, an aria-label) is not on the page
// as words and is not counted. The body of a closed <details> is detail a
// reader opens on purpose, which is why required text never goes in one.
//   topWords:  every counted word above the first h2: the h1, the lead, the
//              buttons and the labels of any figure beside them.
//   bodyWords: every counted word on the page.
const DROP = new Set(["script", "style", "pre", "code", "svg", "noscript", "iframe", "canvas", "template", "nav", "aside"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
// Elements whose content is raw text: a "<" inside is not a tag.
const RAW = new Set(["script", "style"]);

function mainRegion(html) {
  const s = String(html ?? "");
  const a = s.indexOf("<main");
  if (a < 0) return "";
  let b = s.indexOf("<footer", a);
  if (b < 0) b = s.indexOf("</main>", a);
  return s.slice(a, b < 0 ? s.length : b);
}

const isHidden = (attrs) =>
  /\baria-hidden\s*=\s*["']?true/i.test(attrs)
  || /\bstyle\s*=\s*"[^"]*\bdisplay\s*:\s*none/i.test(attrs)
  || /\bclass\s*=\s*"[^"]*(?<![\w-])(?:sr-only|visually-hidden)(?![\w-])/i.test(attrs);

/** The visible text of a region, with a marker where the first <h2> opens.
 *  Returns { top, all }: the text above that h2, and the whole text. */
function visibleText(region) {
  const out = [];
  let topEnd = -1;
  // Each open element: { tag, skip } where skip means "nothing inside counts".
  const stack = [];
  const skipping = () => stack.length > 0 && stack[stack.length - 1].skip;
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let at = 0, m;
  const put = (t) => { if (t && !skipping()) out.push(t); };
  while ((m = re.exec(region))) {
    put(region.slice(at, m.index));
    at = re.lastIndex;
    if (m[1]) { // a close tag: pop to its nearest open element
      const tag = m[1].toLowerCase();
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      out.push(" ");
      continue;
    }
    if (!m[2]) continue; // a comment
    const tag = m[2].toLowerCase();
    const attrs = m[3] || "";
    if (tag === "h2" && topEnd < 0 && !skipping()) topEnd = out.length;
    out.push(" ");
    if (VOID.has(tag) || /\/\s*$/.test(attrs)) continue;
    const parent = stack[stack.length - 1];
    // Inside a closed <details> only its own <summary> is read.
    const closedBody = parent && parent.tag === "details" && parent.closed && tag !== "summary";
    const skip = skipping() || DROP.has(tag) || isHidden(attrs) || closedBody;
    stack.push({ tag, skip, closed: tag === "details" && !/(?:^|\s)open(?=[\s=/>]|$)/i.test(attrs.replace(/"[^"]*"|'[^']*'/g, '""')) });
    if (RAW.has(tag)) { // jump to the matching close tag
      const end = region.toLowerCase().indexOf(`</${tag}`, at);
      at = end < 0 ? region.length : end;
      re.lastIndex = at;
    }
  }
  put(region.slice(at));
  // Text directly inside a closed <details> but outside its summary is not
  // written by any page here; the summary rule above covers element children.
  const clean = (parts) => parts.join("")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#?[a-z0-9]+;/gi, (e) => (/^&(amp|#38);$/i.test(e) ? "&" : " "));
  return { top: clean(topEnd < 0 ? out : out.slice(0, topEnd)), all: clean(out) };
}

/** Words in a text: runs of non-space holding a letter or a digit. */
export function countVisibleWords(t) {
  return String(t ?? "").split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

/** { topWords, bodyWords, topText } for one served page's HTML. */
export function visiblePageWords(html) {
  const { top, all } = visibleText(mainRegion(html));
  return { topWords: countVisibleWords(top), bodyWords: countVisibleWords(all), topText: top.replace(/\s+/g, " ").trim() };
}

// ── tool ────────────────────────────────────────────────────────────────────
export const TOOL_LEAD_MAX = 45;
export const TOOL_BODY_MAX = 250;
// The Details paragraph (.tp-about): what is left of the page text after the
// lead sentence. A tool with a pageSummary shows that shorter text, so its
// Details holds at most TOOL_ABOUT_MAX_SUMMARY words; every other tool shows its
// catalog description, held to that description's own ceiling.
export const TOOL_ABOUT_MAX_SUMMARY = 130;
export const TOOL_ABOUT_MAX_DESCRIPTION = DESCRIPTION_MAX_WORDS;
const SUMMARIZED = new Set(PAGE_SUMMARY);
export const aboutMaxFor = (slug) => (SUMMARIZED.has(slug) ? TOOL_ABOUT_MAX_SUMMARY : TOOL_ABOUT_MAX_DESCRIPTION);

const dropAll = (s, re) => { let prev; do { prev = s; s = s.replace(re, " "); } while (s !== prev); return s; };

/** The words (a list) of a tool page fragment's prose. */
export function toolProseWordList(html) {
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
  return { lead: toolProseWordList(lead).length, body: toolProseWordList(below.replace(ABOUT, " ")).length, about: toolProseWordList(about).length };
}

// ── fragment ────────────────────────────────────────────────────────────────
function dropElements(html, tag) {
  let s = String(html ?? "");
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
  let prev;
  do { prev = s; s = s.replace(re, " "); } while (s !== prev);
  return s;
}

/** Words of prose in an HTML fragment (code and tables excluded). */
export function fragmentProseWords(html) {
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
  return { lead: fragmentProseWords(m[1]), body: fragmentProseWords(body), attribution: attr ? fragmentProseWords(attr[1]) : 0 };
}

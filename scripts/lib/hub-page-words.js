// Reading load of a served page, in words, for the hub-page budgets
// (scripts/test-hub-page-words.js).
//
// The page is read from <main> to the site footer, as one walk over its
// elements. Left out, with everything inside them:
//   - code (pre, code) and markup a reader does not read as words (script,
//     style, svg, iframe, canvas, noscript, template);
//   - navigation (nav, aside: the breadcrumb and the docs sidebar);
//   - what no sighted reader is shown: aria-hidden="true", `display:none` in
//     an element's own style attribute, and the screen-reader-only classes
//     (sr-only, visually-hidden);
//   - the body of a closed <details>: its summary is counted, its body is
//     detail a reader opens on purpose. That is why required text never goes
//     in one.
// Everything else a reader sees is a word here: headings, paragraphs, list
// items, table cells, button and link labels, kickers and figure labels.
// An element served with the `hidden` attribute IS counted: the pages use it
// for blocks a script shows once their data loads (the home page's live
// figures and their labels), so a reader does see those words.
// Attribute text (a placeholder, a title, an aria-label) is not on the page
// as words and is not counted.
//
//   topWords:  every counted word above the first h2: the h1, the lead, the
//              buttons and the labels of any figure beside them. This is what
//              a visitor meets before the page's first section.
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
export function countWords(t) {
  return String(t ?? "").split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

/** { topWords, bodyWords, topText } for one served page's HTML. */
export function pageWords(html) {
  const { top, all } = visibleText(mainRegion(html));
  return { topWords: countWords(top), bodyWords: countWords(all), topText: top.replace(/\s+/g, " ").trim() };
}

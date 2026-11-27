// Reading load of a served page, in words, for the hub-page budgets
// (scripts/test-hub-page-words.js).
//
// The page is read from <main> to the site footer. Code (pre, code), markup a
// reader does not read as prose (script, style, svg, iframe, canvas, noscript,
// template) and navigation (nav, aside: the breadcrumb and the docs sidebar)
// are left out. A closed <details> counts its summary only: its body is detail
// a reader opens on purpose. That is why required text never goes in one.
//
//   leadWords: the words of the <p> paragraphs above the first h2 (the lead a
//              visitor reads before the page's first section).
//   bodyWords: every word a reader sees without opening anything.

const DROP = ["script", "style", "pre", "code", "svg", "noscript", "iframe", "canvas", "template", "nav", "aside"];

function mainRegion(html) {
  const s = String(html ?? "");
  const a = s.indexOf("<main");
  if (a < 0) return "";
  let b = s.indexOf("<footer", a);
  if (b < 0) b = s.indexOf("</main>", a);
  return s.slice(a, b < 0 ? s.length : b);
}

function dropElements(html) {
  let s = html;
  let prev;
  do {
    prev = s;
    for (const t of DROP) s = s.replace(new RegExp(`<${t}\\b[^>]*>(?:(?!<${t}\\b)[\\s\\S])*?</${t}\\s*>`, "gi"), " ");
  } while (s !== prev);
  return s;
}

// A closed <details> keeps its summary; innermost first, so nesting is read.
function closeDetails(html) {
  let s = html;
  let prev;
  do {
    prev = s;
    s = s.replace(/<details\b([^>]*)>((?:(?!<details\b)[\s\S])*?)<\/details\s*>/gi, (m, attrs, inner) => {
      if (/\bopen\b/i.test(attrs)) return inner;
      const sum = inner.match(/<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i);
      return ` ${sum ? sum[1] : ""} `;
    });
  } while (s !== prev);
  return s;
}

function text(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#?[a-z0-9]+;/gi, (e) => (/^&(amp|#38);$/i.test(e) ? "&" : " "));
}

/** Words in a text: runs of non-space holding a letter or a digit. */
export function countWords(t) {
  return String(t ?? "").split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

/** { leadWords, bodyWords } for one served page's HTML. */
export function pageWords(html) {
  const main = closeDetails(dropElements(mainRegion(html)));
  const h2 = main.search(/<h2\b/i);
  const top = h2 < 0 ? main : main.slice(0, h2);
  const paragraphs = [...top.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)].map((m) => text(m[1])).join(" ");
  return { leadWords: countWords(paragraphs), bodyWords: countWords(text(main)) };
}

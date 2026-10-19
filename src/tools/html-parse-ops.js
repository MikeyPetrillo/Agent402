// The HTML parsing operations that run inside the HTML worker (./html-pool.js):
// article extraction, crawl page content, page metadata and HTML to markdown.
// Each takes plain data and returns plain data, so it crosses the thread
// boundary unchanged. Callers reach them through runHtml(), never directly.
import { loadJsdom, loadReadability, loadTurndown, lazyImport } from "./lazy-deps.js";
import { scrubHidden } from "./hidden-content.js";
import { markUntrusted } from "./provenance.js";

// One configured turndown per use, loaded with the first job that needs it.
const articleTurndown = lazyImport(async () => {
  const TurndownService = await loadTurndown();
  return new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
});
const crawlTurndown = lazyImport(async () => {
  const TurndownService = await loadTurndown();
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  td.remove(["script", "style", "noscript", "template", "iframe", "svg"]);
  return td;
});

/** Raw HTML -> a readable article (markdown + metadata), for extract and render. */
export async function articleFromHtml(html, finalUrl) {
  const [JSDOM, Readability, turndown] = await Promise.all([loadJsdom(), loadReadability(), articleTurndown()]);
  const dom = new JSDOM(html, { url: finalUrl });
  // Text the page hides from a person (comments, display:none, white-on-white,
  // zero-width characters) is reported, quoting any of it that reads as an
  // instruction to an AI. The page is left as is: what extraction returns is
  // unchanged (Readability keeps its own visibility rules).
  const hiddenContent = scrubHidden(dom.window.document, { mode: "keep" });
  const article = new Readability(dom.window.document).parse();
  if (!article || !article.content) {
    const err = new Error("Could not extract readable content from this page");
    err.statusCode = 422;
    throw err;
  }
  const markdown = turndown.turndown(article.content);
  // R-14: mark the extracted (and, via renderArticle, rendered) page content as
  // untrusted external data. `url` above is the source; this adds the flag.
  return markUntrusted({
    url: finalUrl,
    title: article.title || null,
    byline: article.byline || null,
    siteName: article.siteName || null,
    excerpt: article.excerpt || null,
    lang: article.lang || null,
    wordCount: markdown.split(/\s+/).filter(Boolean).length,
    markdown,
    hiddenContent,
  });
}

function meta(doc, selector, attr = "content") {
  return doc.querySelector(selector)?.getAttribute(attr) || null;
}

/** Raw HTML -> title, description, OpenGraph, Twitter card, canonical, favicon. */
export async function pageMetaFromHtml(html, finalUrl) {
  const JSDOM = await loadJsdom();
  const doc = new JSDOM(html, { url: finalUrl }).window.document;

  const og = {};
  const twitter = {};
  for (const el of doc.querySelectorAll("meta[property^='og:'], meta[name^='og:']")) {
    const key = (el.getAttribute("property") || el.getAttribute("name")).slice(3);
    if (el.getAttribute("content")) og[key] = el.getAttribute("content");
  }
  for (const el of doc.querySelectorAll("meta[name^='twitter:'], meta[property^='twitter:']")) {
    const key = (el.getAttribute("name") || el.getAttribute("property")).slice(8);
    if (el.getAttribute("content")) twitter[key] = el.getAttribute("content");
  }

  const favicon =
    doc.querySelector("link[rel='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']")
      ?.href || new URL("/favicon.ico", finalUrl).href;

  return {
    url: finalUrl,
    title: doc.title || null,
    description: meta(doc, "meta[name='description']"),
    canonical: doc.querySelector("link[rel='canonical']")?.href || null,
    favicon,
    og,
    twitter,
  };
}

export function titleOf(doc, html) {
  const t = doc?.querySelector?.("title")?.textContent;
  if (t && t.trim()) return t.trim().replace(/\s+/g, " ").slice(0, 300);
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim().slice(0, 300) : null;
}

export function cleanText(s) {
  return String(s || "").replace(/\r/g, "").replace(/[ \t\f\v]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// HTML -> { title, content } in markdown or text. Readability's main-content
// extraction when it parses (articles, docs pages), the cleaned <body> when it
// does not (home pages, indexes), so every HTML page yields SOMETHING.
export async function pageContentFromHtml(html, url, format) {
  const [JSDOM, Readability, turndown] = await Promise.all([loadJsdom(), loadReadability(), format === "text" ? null : crawlTurndown()]);
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const title = titleOf(doc, html);
  // Hidden text (comments, display:none, white-on-white, zero-width
  // characters) is reported on the page; the content itself is unchanged.
  const hiddenContent = scrubHidden(doc, { mode: "keep" });
  let container = null;
  let usedReadability = false;
  try {
    const article = new Readability(doc.cloneNode(true), { charThreshold: 200 }).parse();
    if (article && article.content && article.textContent && article.textContent.trim().length >= 80) {
      container = new JSDOM(article.content, { url }).window.document.body;
      usedReadability = true;
    }
  } catch { /* fall through to the body */ }
  if (!container) {
    for (const el of doc.querySelectorAll("script,style,noscript,template,iframe,svg,canvas")) el.remove();
    container = doc.body || doc.documentElement;
  }
  let content;
  if (format === "text") {
    content = cleanText(container.textContent);
  } else {
    try { content = cleanText(turndown.turndown(container.innerHTML || "")); } catch { content = cleanText(container.textContent); }
    // Readability drops the page's own heading; put the title back on top so
    // the markdown reads as a document.
    if (usedReadability && title && !content.toLowerCase().includes(title.toLowerCase())) content = `# ${title}\n\n${content}`;
  }
  return { title, content, hiddenContent };
}

/** html-to-markdown's conversion. `text` is already validated and capped. */
export async function markdownFromHtml(text, mode) {
  const [TurndownService, JSDOM] = await Promise.all([loadTurndown(), loadJsdom()]);
  const doc = new JSDOM(text, { contentType: "text/html" }).window.document;
  const hiddenContent = scrubHidden(doc, { mode });
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  // keep (the default) converts the original string, so the markdown is
  // exactly what this tool returned before hiddenContent existed.
  return { markdown: td.turndown(mode === "drop" ? (doc.body || doc.documentElement) : text), hiddenContent };
}

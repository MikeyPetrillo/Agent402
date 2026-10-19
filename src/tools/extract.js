import { loadJsdom, loadReadability, loadTurndown, lazyImport } from "./lazy-deps.js";
import { scrubHidden } from "./hidden-content.js";
import { safeFetch } from "./fetch-guard.js";
import { markUntrusted } from "./provenance.js";

// jsdom, Readability and turndown load on the first article (./lazy-deps.js),
// not at boot. One configured turndown instance is shared after that.
const turndownInstance = lazyImport(async () => {
  const TurndownService = await loadTurndown();
  return new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
});

/**
 * Turn raw HTML into a readable article object (markdown + metadata).
 */
export async function htmlToArticle(html, finalUrl) {
  const [JSDOM, Readability, turndown] = await Promise.all([loadJsdom(), loadReadability(), turndownInstance()]);
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

/**
 * Extract the main readable content of a page as markdown.
 */
export async function extractArticle(rawUrl) {
  const { finalUrl, html } = await safeFetch(rawUrl);
  return htmlToArticle(html, finalUrl);
}

function meta(doc, selector, attr = "content") {
  return doc.querySelector(selector)?.getAttribute(attr) || null;
}

/**
 * Fetch page metadata: title, description, OpenGraph, Twitter card, canonical, favicon.
 */
export async function fetchPageMeta(rawUrl) {
  const { finalUrl, html } = await safeFetch(rawUrl);
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

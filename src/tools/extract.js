import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { safeFetch } from "./fetch-guard.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

/**
 * Extract the main readable content of a page as markdown.
 */
export async function extractArticle(rawUrl) {
  const { finalUrl, html } = await safeFetch(rawUrl);
  const dom = new JSDOM(html, { url: finalUrl });
  const article = new Readability(dom.window.document).parse();
  if (!article || !article.content) {
    const err = new Error("Could not extract readable content from this page");
    err.statusCode = 422;
    return Promise.reject(err);
  }
  const markdown = turndown.turndown(article.content);
  return {
    url: finalUrl,
    title: article.title || null,
    byline: article.byline || null,
    siteName: article.siteName || null,
    excerpt: article.excerpt || null,
    lang: article.lang || null,
    wordCount: markdown.split(/\s+/).filter(Boolean).length,
    markdown,
  };
}

function meta(doc, selector, attr = "content") {
  return doc.querySelector(selector)?.getAttribute(attr) || null;
}

/**
 * Fetch page metadata: title, description, OpenGraph, Twitter card, canonical, favicon.
 */
export async function fetchPageMeta(rawUrl) {
  const { finalUrl, html } = await safeFetch(rawUrl);
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

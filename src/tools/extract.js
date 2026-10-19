import { safeFetch } from "./fetch-guard.js";
import { runHtml } from "./html-pool.js";

// The parsing itself (jsdom, Readability, turndown) runs in the HTML worker
// (./html-pool.js, ./html-parse-ops.js): a page that is slow to parse holds a
// worker until its time limit, never the event loop.

/**
 * Turn raw HTML into a readable article object (markdown + metadata).
 */
export async function htmlToArticle(html, finalUrl) {
  return runHtml("article", { html, url: finalUrl }, Buffer.byteLength(String(html ?? "")));
}

/**
 * Extract the main readable content of a page as markdown.
 */
export async function extractArticle(rawUrl) {
  const { finalUrl, html } = await safeFetch(rawUrl);
  return htmlToArticle(html, finalUrl);
}

/**
 * Fetch page metadata: title, description, OpenGraph, Twitter card, canonical, favicon.
 */
export async function fetchPageMeta(rawUrl) {
  const { finalUrl, html } = await safeFetch(rawUrl);
  return runHtml("meta", { html, url: finalUrl }, Buffer.byteLength(String(html ?? "")));
}

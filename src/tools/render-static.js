// The no-browser read for the render tool: fetch the page and turn its served
// HTML into the article with the same converter render uses (htmlToArticle),
// and start the headless browser only when the page needs JavaScript.
//
// Why: most pages a caller sends to render serve their readable content in the
// HTML itself, and for those the browser adds a second or more (a pool slot, a
// context, every subresource, network idle) and Chromium's memory, for the same
// markdown. On a 40-page sample of public pages the served-HTML read matched
// or beat the rendered one on title, links and text on every page this verdict
// sends to it (scripts/test-render-static.js pins the verdict's rules).
//
// When the browser still runs (the verdict, below, says the page needs it):
//   - the fetch failed in any way (a refusal, a timeout, a non-HTML answer, a
//     host the guard refuses): the browser path runs exactly as before, so
//     every error a caller can get is the browser path's own;
//   - the served HTML yields no readable article, or fewer than
//     STATIC_MIN_WORDS words (an app shell);
//   - the HTML carries an empty single-page-app mount (root, app, __next,
//     __nuxt, svelte, ___gatsby, app-root), a noscript notice asking for
//     JavaScript beside little text, or hydrated web components (lit parts,
//     declarative shadow roots), whose DOM after scripts run is not the
//     served one.
// A page read this way answers `rendered: false`; a rendered page keeps
// `rendered: true`. RENDER_STATIC_READ=off sends every page to the browser.
import { safeFetch } from "./fetch-guard.js";
import { htmlToArticle } from "./extract.js";

export const STATIC_MIN_WORDS = 50;
// A noscript JavaScript notice decides only beside this little text.
export const STATIC_JS_NOTICE_MAX_WORDS = 300;
// The fetch's own limit: a slow origin goes to the browser without waiting
// the default fetch timeout first.
export const STATIC_FETCH_TIMEOUT_MS = 8000;
export const STATIC_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const SPA_MOUNT = /<(div|main|section)\b[^>]*\bid\s*=\s*["']?(root|app|__next|__nuxt|svelte|___gatsby)["']?[^>]*>\s*<\/\1\s*>/i;
const APP_ROOT = /<app-root\b[^>]*>\s*<\/app-root\s*>/i;
const HYDRATED_COMPONENTS = /<!--lit-part|\bshadowrootmode\s*=/i;
const JS_NOTICE = /<noscript\b[^>]*>[\s\S]{0,600}?\b(enable|requires?|turn on|needs?)\b[\s\S]{0,40}?javascript/i;

export function staticReadEnabled(env = process.env) {
  return String(env.RENDER_STATIC_READ ?? "").trim().toLowerCase() !== "off";
}

/**
 * Does the served HTML stand in for the rendered page? { useStatic, why }.
 * `article` is htmlToArticle's answer (or null), `error` the fetch's or the
 * extraction's error (or null). Pure.
 */
export function staticReadVerdict({ html, article, error, contentType = "text/html" }) {
  if (error) return { useStatic: false, why: "fetch-or-extract-failed" };
  if (contentType && !/html|xml/i.test(String(contentType))) return { useStatic: false, why: "not-html" };
  const src = typeof html === "string" ? html : "";
  const words = Number(article?.wordCount) || 0;
  if (!article || words < STATIC_MIN_WORDS) return { useStatic: false, why: "little-text" };
  if (SPA_MOUNT.test(src) || APP_ROOT.test(src)) return { useStatic: false, why: "spa-mount" };
  if (HYDRATED_COMPONENTS.test(src)) return { useStatic: false, why: "hydrated-components" };
  if (words < STATIC_JS_NOTICE_MAX_WORDS && JS_NOTICE.test(src)) return { useStatic: false, why: "javascript-notice" };
  return { useStatic: true, why: "served-html" };
}

/**
 * render's read: the served HTML when the verdict allows it, else
 * `browser(url)` (the in-process renderer or the browser worker). Errors on
 * the static leg are never the caller's answer: the browser path runs and
 * answers as it always has.
 */
export async function renderWithStaticRead(url, browser, { signal, fetchImpl = safeFetch, toArticle = htmlToArticle, env = process.env } = {}) {
  if (staticReadEnabled(env) && !signal?.aborted) {
    let fetched = null, article = null, error = null;
    try {
      fetched = await fetchImpl(url, { userAgent: STATIC_DESKTOP_UA, headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" }, timeoutMs: STATIC_FETCH_TIMEOUT_MS });
      article = await toArticle(fetched.html, fetched.finalUrl);
    } catch (e) { error = e; }
    const v = staticReadVerdict({ html: fetched?.html, article, error, contentType: fetched?.contentType });
    if (v.useStatic && !signal?.aborted) {
      article.rendered = false;
      return article;
    }
  }
  return browser(url, { signal });
}

#!/usr/bin/env node
// render's no-browser read (src/tools/render-static.js), offline: the verdict
// that decides between the served HTML and the browser, and the read itself
// with a stub fetch, a stub converter and a stub browser.
//
//   node scripts/test-render-static.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import {
  STATIC_MIN_WORDS, STATIC_JS_NOTICE_MAX_WORDS, renderWithStaticRead, staticReadEnabled, staticReadVerdict,
} from "../src/tools/render-static.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const page = (body, head = "") => `<!doctype html><html><head><title>T</title>${head}</head><body>${body}</body></html>`;
const art = (n) => ({ title: "T", wordCount: n, markdown: "w ".repeat(n) });

// ---- the verdict ------------------------------------------------------------
ok(staticReadVerdict({ html: page("<article><p>text</p></article>"), article: art(400) }).useStatic, "a page whose served HTML carries its article is read without the browser");
ok(!staticReadVerdict({ html: page(""), article: null, error: Object.assign(new Error("x"), { statusCode: 422 }) }).useStatic, "no readable article: the browser");
ok(!staticReadVerdict({ html: page("<p>x</p>"), article: null, error: Object.assign(new Error("403"), { statusCode: 403 }) }).useStatic, "a refused fetch: the browser");
ok(!staticReadVerdict({ html: page("<p>x</p>"), article: art(STATIC_MIN_WORDS - 1) }).useStatic, `fewer than ${STATIC_MIN_WORDS} words: the browser`);
ok(staticReadVerdict({ html: page("<p>x</p>"), article: art(STATIC_MIN_WORDS) }).useStatic, `${STATIC_MIN_WORDS} words: served HTML`);
for (const [shell, name] of [
  ['<div id="root"></div>', "an empty React root"],
  ["<div id='app'>\n</div>", "an empty Vue app"],
  ['<div id="__next" data-x="1"></div>', "an empty Next.js mount"],
  ['<div id="__nuxt"></div>', "an empty Nuxt mount"],
  ['<div id="___gatsby"></div>', "an empty Gatsby mount"],
  ["<app-root></app-root>", "an empty Angular root"],
]) ok(staticReadVerdict({ html: page(`${shell}<p>long text</p>`), article: art(5000) }).why === "spa-mount", `${name}: the browser, whatever the text`);
ok(staticReadVerdict({ html: page('<div id="root"><h1>Server rendered</h1></div>'), article: art(400) }).useStatic, "a filled React root (server rendered): served HTML");
ok(staticReadVerdict({ html: page("<main><!--lit-part abc--><p>x</p><!--/lit-part--></main>"), article: art(800) }).why === "hydrated-components", "lit parts: the browser (the DOM after scripts differs)");
ok(staticReadVerdict({ html: page('<x-card><template shadowrootmode="open"><p>x</p></template></x-card>'), article: art(800) }).why === "hydrated-components", "a declarative shadow root: the browser");
const notice = '<noscript>Please enable JavaScript to view this site.</noscript>';
ok(staticReadVerdict({ html: page(`${notice}<p>x</p>`), article: art(STATIC_JS_NOTICE_MAX_WORDS - 1) }).why === "javascript-notice", "a JavaScript notice beside little text: the browser");
ok(staticReadVerdict({ html: page(`${notice}<p>x</p>`), article: art(STATIC_JS_NOTICE_MAX_WORDS) }).useStatic, "a JavaScript notice beside a full article: served HTML (the notice is for script-blocking readers)");
ok(staticReadVerdict({ html: "%PDF-1.7", article: art(400), contentType: "application/pdf" }).why === "not-html", "a non-HTML answer: the browser");
ok(staticReadVerdict({ html: page("<p>x</p>"), article: art(400), contentType: "application/xhtml+xml; charset=utf-8" }).useStatic, "XHTML: served HTML");
ok(staticReadEnabled({}) && staticReadEnabled({ RENDER_STATIC_READ: "on" }) && !staticReadEnabled({ RENDER_STATIC_READ: " OFF " }), "RENDER_STATIC_READ: unset or on reads the served HTML, off does not");

// ---- the read ---------------------------------------------------------------
function harness({ html = page("<article>text</article>"), words = 400, fetchError = null, contentType = "text/html; charset=utf-8", toArticleError = null } = {}) {
  const calls = { fetch: [], browser: [] };
  const fetchImpl = async (url, opts) => {
    calls.fetch.push({ url, opts });
    if (fetchError) throw fetchError;
    return { finalUrl: `${url}#final`, html, contentType };
  };
  const toArticle = async (h, u) => {
    if (toArticleError) throw toArticleError;
    return { url: u, title: "T", byline: null, wordCount: words, markdown: "m", hiddenContent: { total: 0 }, untrustedContent: true };
  };
  const browser = async (url, o) => { calls.browser.push({ url, o }); return { url, title: "T", wordCount: 9, markdown: "rendered", rendered: true }; };
  return { calls, fetchImpl, toArticle, browser };
}
{
  const h = harness();
  const out = await renderWithStaticRead("https://a.test/p", h.browser, { fetchImpl: h.fetchImpl, toArticle: h.toArticle, env: {} });
  ok(out.rendered === false && out.url === "https://a.test/p#final" && h.calls.browser.length === 0, "a static page answers rendered: false at its final URL, and no browser runs");
  ok(Object.keys(out).at(-1) === "rendered", "...with rendered last, where the browser path puts it");
  ok(/Chrome\//.test(h.calls.fetch[0].opts.userAgent) && h.calls.fetch[0].opts.timeoutMs > 0, "...fetched with the browser's user agent and its own time limit");
}
{
  const h = harness({ html: page('<div id="root"></div>'), words: 5000 });
  const ac = new AbortController();
  const out = await renderWithStaticRead("https://a.test/spa", h.browser, { fetchImpl: h.fetchImpl, toArticle: h.toArticle, env: {}, signal: ac.signal });
  ok(out.rendered === true && h.calls.browser.length === 1 && h.calls.browser[0].o.signal === ac.signal, "an app shell goes to the browser, with the caller's signal");
}
{
  const refused = Object.assign(new Error("The host refused this server's request (HTTP 403)"), { statusCode: 403 });
  const h = harness({ fetchError: refused });
  const out = await renderWithStaticRead("https://a.test/blocked", h.browser, { fetchImpl: h.fetchImpl, toArticle: h.toArticle, env: {} });
  ok(out.rendered === true && h.calls.browser.length === 1, "a refused fetch goes to the browser; the refusal is never the answer");
}
{
  const h = harness({ fetchError: Object.assign(new Error("private"), { statusCode: 400 }) });
  const browserErr = Object.assign(new Error("the browser's own refusal"), { statusCode: 400 });
  let got = null;
  try { await renderWithStaticRead("http://10.0.0.1/", async () => { throw browserErr; }, { fetchImpl: h.fetchImpl, toArticle: h.toArticle, env: {} }); } catch (e) { got = e; }
  ok(got === browserErr, "a URL the guard refuses answers the browser path's own error, as before");
}
{
  const h = harness({ toArticleError: Object.assign(new Error("Could not extract readable content from this page"), { statusCode: 422 }) });
  const out = await renderWithStaticRead("https://a.test/canvas", h.browser, { fetchImpl: h.fetchImpl, toArticle: h.toArticle, env: {} });
  ok(out.rendered === true && h.calls.browser.length === 1, "no readable article in the served HTML: the browser");
}
{
  const h = harness();
  const out = await renderWithStaticRead("https://a.test/p", h.browser, { fetchImpl: h.fetchImpl, toArticle: h.toArticle, env: { RENDER_STATIC_READ: "off" } });
  ok(out.rendered === true && h.calls.fetch.length === 0 && h.calls.browser.length === 1, "RENDER_STATIC_READ=off: no fetch, every page to the browser");
}
{
  const h = harness();
  const ac = new AbortController(); ac.abort();
  await renderWithStaticRead("https://a.test/p", h.browser, { fetchImpl: h.fetchImpl, toArticle: h.toArticle, env: {}, signal: ac.signal });
  ok(h.calls.fetch.length === 0, "a caller already gone starts no fetch");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

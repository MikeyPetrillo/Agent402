#!/usr/bin/env node
// render's no-browser read (src/tools/render-static.js), offline: the verdict
// that decides between the served HTML and the browser, and the read itself
// with a stub fetch, a stub converter and a stub browser.
//
//   node scripts/test-render-static.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import dnsP from "node:dns/promises";
import {
  STATIC_MIN_WORDS, STATIC_JS_NOTICE_MAX_WORDS, STATIC_SCAN_MAX_CHARS, renderWithStaticRead, staticReadEnabled, staticReadVerdict,
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

// ---- the verdict's cost on a crafted page -------------------------------------
// The verdict runs on the main thread over up to the fetch's 5 MB, so every
// marker is read in one pass: pages built to make a backtracking pattern
// search (unclosed tags, repeated ids, thousands of noscript openings) must
// each finish in one short turn. Measured before the bound: 4.7 s for the
// first page below, minutes for the dense ones.
{
  const crafted = {
    "an unclosed div with 39,000 repeated ids": "<div " + " id=root".repeat(39000),
    "26,000 unclosed root divs": "<div id=root".repeat(26000),
    "2,000 root divs with long attribute runs": ("<div id=root" + " a".repeat(50)).repeat(2000),
    "35,000 unclosed app-root tags": "<app-root".repeat(35000),
    "an unclosed noscript with 157,000 attributes": "<noscript" + " x".repeat(157000),
    "18,500 noscript notices with no JavaScript word": "<noscript>enable ".repeat(18500),
    "shadowrootmode with long space runs": ("shadowrootmode" + " ".repeat(200)).repeat(1500),
    "the first page repeated to the fetch's 5 MB": ("<div " + " id=root".repeat(39000)).repeat(16),
  };
  let worst = 0, worstName = "";
  for (const [name, html] of Object.entries(crafted)) {
    const t = performance.now();
    staticReadVerdict({ html, article: art(100) });
    const ms = performance.now() - t;
    if (ms > worst) { worst = ms; worstName = name; }
    ok(ms < 250, `crafted page (${name}, ${html.length} chars): the verdict takes ${ms.toFixed(1)} ms on the main thread`);
  }
  console.log(`  longest verdict turn: ${worst.toFixed(1)} ms (${worstName})`);
  // The scan reads a bounded prefix; a marker inside it still decides.
  const pad = "<p>" + "w ".repeat(1000) + "</p>";
  ok(staticReadVerdict({ html: page(pad + '<div id="root"></div>'), article: art(5000) }).why === "spa-mount", "a mount after ordinary text inside the scanned prefix is still read");
  ok(staticReadVerdict({ html: page(`<div ${"data-x=1 ".repeat(100)}id="app"></div>`), article: art(5000) }).why === "spa-mount", "a mount with long attributes before its id is still read");
  ok(STATIC_SCAN_MAX_CHARS >= 256 * 1024, "the scanned prefix is at least 256 KB");
  // Past the prefix nothing is read: a page over the bound whose only marker
  // sits after it is decided on the prefix alone, and the same marker moved
  // inside the prefix still decides.
  const filler = "<p>" + "w ".repeat(1000) + "</p>";
  const body = filler.repeat(Math.ceil((STATIC_SCAN_MAX_CHARS + 4096) / filler.length));
  const late = page(body + '<div id="root"></div>');
  ok(late.length > STATIC_SCAN_MAX_CHARS && late.indexOf('<div id="root">') > STATIC_SCAN_MAX_CHARS, `setup: a ${late.length}-character page with its mount past the ${STATIC_SCAN_MAX_CHARS}-character prefix`);
  ok(staticReadVerdict({ html: late, article: art(5000) }).useStatic === true, "a mount past the scanned prefix is not read: the page is decided on the prefix");
  ok(staticReadVerdict({ html: page('<div id="root"></div>' + body), article: art(5000) }).why === "spa-mount", "control: the same page with its mount inside the prefix reads spa-mount");
}

// ---- the read through the real fetch guard ------------------------------------
// No fetchImpl: the static leg uses safeFetch, so a private address is refused
// before anything is sent, a redirect hop to one is refused at connect, and
// the browser path (with its own guard) answers as it always has.
{
  let hits = 0;
  const local = createServer((req, res) => { hits++; res.end("<html><body><article>" + "internal ".repeat(200) + "</article></body></html>"); });
  await new Promise((r) => local.listen(0, "127.0.0.1", r));
  const lport = local.address().port;
  const browserCalls = [];
  const browser = async (url) => { browserCalls.push(url); return { url, title: "T", wordCount: 9, markdown: "rendered", rendered: true }; };

  const direct = await renderWithStaticRead(`http://127.0.0.1:${lport}/`, browser, { env: {} });
  ok(direct.rendered === true && browserCalls.length === 1 && hits === 0, `a 127.0.0.1 URL with no fetchImpl: the guard refuses the static read, nothing is fetched (${hits} hits), the browser path answers`);

  // A public name (stubbed answer) whose origin redirects to a private
  // address. The stand-in origin answers the first request the way undici
  // follows a 302: it re-requests the Location through the same pinned
  // dispatcher and options, so the hop meets the connect-time guard.
  const P = dnsP.Resolver.prototype, r4 = P.resolve4, r6 = P.resolve6;
  const names = { "pub.render-static.test": ["93.184.215.14"], "inside.render-static.test": ["10.0.0.5"] };
  P.resolve4 = async function (n, ...a) { if (names[n]) return names[n]; return r4.call(this, n, ...a); };
  P.resolve6 = async function (n, ...a) { if (names[n]) { const e = new Error("none"); e.code = "ENODATA"; throw e; } return r6.call(this, n, ...a); };
  const realFetch = globalThis.fetch;
  for (const target of [`http://127.0.0.1:${lport}/`, `http://[::ffff:127.0.0.1]:${lport}/`, `http://inside.render-static.test:${lport}/`]) {
    let origin = 0;
    globalThis.fetch = async (u, init) => {
      if (new URL(String(u)).hostname === "pub.render-static.test") { origin++; return realFetch(target, init); }
      return realFetch(u, init);
    };
    const before = browserCalls.length;
    let out = null, err = null;
    try { out = await renderWithStaticRead("http://pub.render-static.test/page", browser, { env: {} }); } catch (e) { err = e; }
    globalThis.fetch = realFetch;
    ok(!err && origin === 1 && out?.rendered === true && browserCalls.length === before + 1 && hits === 0, `a redirect to ${target}: the hop is refused at connect, nothing is fetched (${hits} hits), the browser path answers${err ? ` (${err.message})` : ""}`);
  }
  P.resolve4 = r4; P.resolve6 = r6;
  // Live control: the stand-in internal service answers a fetch that skips
  // the guard, so the zero hits above are the guard's refusals.
  const control = async (u) => { const r = await realFetch(`http://127.0.0.1:${lport}/`); return { html: await r.text(), finalUrl: u, contentType: "text/html" }; };
  await renderWithStaticRead("http://pub.render-static.test/page", browser, { env: {}, fetchImpl: control });
  ok(hits === 1, `control: a fetch without the guard reaches the stand-in (${hits} hit)`);
  local.close();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

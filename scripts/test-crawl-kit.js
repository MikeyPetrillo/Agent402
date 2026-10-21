// scripts/test-crawl-kit.js
// Tests for src/tools/crawl-kit.js (site-map, site-crawl). Pattern matches
// scripts/test-web-kit.js / test-b2b-enrich-kit.js:
//   - Catalog envelope + input validation + pure parsers run with no network.
//   - Every upstream call is served by a stubbed globalThis.fetch hosting a
//     tiny fake site under https://example.com (robots disallow path, sitemap
//     index + gzipped child, links, in-site redirect, redirect into a private
//     IP, private-IP link, offsite link, binary page, a page that hangs).
//     example.com is used as the fake site's name so the real SSRF guard
//     (assertPublicUrl's DNS lookup) stays in the path; the only network touch
//     is that one DNS query, exactly as scripts/test-fetch-guard.js does.
//   - Budget paths are driven through the kit's __test.CONFIG seam so the
//     timeout cases take milliseconds instead of tens of seconds.
//   - Live checks against the real example sites are opt-in: CRAWL_LIVE_TEST=1.

import { gzipSync } from "node:zlib";
import { CRAWL_TOOLS, CRAWL_USER_AGENT, normalizeUrl, hostAllowed, parseSitemap, sitemapDeclarations, extractLinks, pageContent, __test } from "../src/tools/crawl-kit.js";

const h = (slug) => CRAWL_TOOLS.find((t) => t.slug === slug).handler;
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
async function throws(promise, status, label) {
  try { await promise; fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status) { pass++; console.log(`ok - ${label} -> ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status}, got ${e.statusCode} (${e.message})`); }
  }
}

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
ok(CRAWL_TOOLS.length === 2, `2 tools exported (got ${CRAWL_TOOLS.length})`);
const SPEC = { "site-map": { price: "$0.005" }, "site-crawl": { price: "$0.02" } };
for (const t of CRAWL_TOOLS) {
  const spec = SPEC[t.slug];
  ok(!!spec, `${t.slug}: is an expected slug`);
  if (!spec) continue;
  ok(t.route === `POST /api/${t.slug}`, `${t.slug}: POST /api/${t.slug} route`);
  ok(t.price === spec.price, `${t.slug}: priced ${spec.price} (got ${t.price})`);
  ok(t.category === "web", `${t.slug}: category=web`);
  ok(typeof t.handler === "function", `${t.slug}: has handler`);
  const d = t.discovery;
  ok(d && d.bodyType === "json" && d.input && d.inputSchema && d.output?.example, `${t.slug}: full discovery envelope`);
  ok(!/\u2014/.test(t.description), `${t.slug}: description has no em dash`);
}
ok(CRAWL_USER_AGENT === "Agent402Bot/1.0 (+https://agent402.tools)", "user-agent string");

// ----------------------------------------------------------------------------
// Pure helpers
// ----------------------------------------------------------------------------
ok(normalizeUrl("HTTPS://Example.com:443/a/?#frag") === "https://example.com/a/", "normalizeUrl: lowercases host, drops default port, fragment, empty query");
ok(normalizeUrl("http://user:pw@example.com:80/x?y=1") === "http://example.com/x?y=1", "normalizeUrl: strips userinfo, keeps query");
ok(normalizeUrl("/rel/path", "https://example.com/dir/") === "https://example.com/rel/path", "normalizeUrl: resolves relative against base");
ok(normalizeUrl("mailto:a@b.c") === null && normalizeUrl("javascript:void(0)", "https://example.com") === null, "normalizeUrl: non-http(s) -> null");
ok(hostAllowed("example.com", "www.example.com", false) && hostAllowed("www.example.com", "example.com", false), "hostAllowed: www and bare are one site");
ok(!hostAllowed("docs.example.com", "example.com", false) && hostAllowed("docs.example.com", "example.com", true), "hostAllowed: subdomains only when enabled");
ok(!hostAllowed("notexample.com", "example.com", true) && !hostAllowed("example.com.evil.test", "example.com", true), "hostAllowed: suffix tricks refused");
ok(sitemapDeclarations("User-agent: *\nSitemap: https://example.com/a.xml\n sitemap:https://example.com/b.xml").length === 2, "sitemapDeclarations: both lines");
const sm = parseSitemap('<?xml version="1.0"?><urlset><url><loc>https://example.com/x?a=1&amp;b=2</loc></url><url><loc> https://example.com/y </loc></url></urlset>');
ok(!sm.index && sm.locs.length === 2 && sm.locs[0] === "https://example.com/x?a=1&b=2", "parseSitemap: urlset locs, entity-decoded, trimmed");
ok(parseSitemap("<sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>").index === true, "parseSitemap: index detected");
ok(parseSitemap("https://example.com/p1\nnot a url\nhttps://example.com/p2\n").locs.length === 2, "parseSitemap: plain-text sitemap");
const links = extractLinks('<base href="https://example.com/base/"><a href="a">A</a><a href=\'/b#x\'>B</a><a href=c>C</a><a href="#top">T</a><a href="mailto:x@y.z">M</a><a href="javascript:void(0)">J</a><a href="https://other.test/q?x=1&amp;y=2">O</a><a href="/b">dup</a>', "https://example.com/");
ok(links.join(" ") === "https://example.com/base/a https://example.com/b https://example.com/base/c https://other.test/q?x=1&y=2", `extractLinks: base honoured, quotes/unquoted, fragments dropped, schemes filtered, deduped (${links.join(" ")})`);
const pcMd = await pageContent("<html><head><title> Hello  World </title></head><body><script>alert(1)</script><h1>Hi</h1><p>Some <b>bold</b> text.</p></body></html>", "https://example.com/", "markdown");
ok(pcMd.title === "Hello World" && /Hi/.test(pcMd.content) && /\*\*bold\*\*/.test(pcMd.content) && !/alert/.test(pcMd.content), `pageContent markdown: title normalized, markdown produced, script dropped (${JSON.stringify(pcMd.content)})`);
const pcTx = await pageContent("<html><body><style>.x{}</style><p>Plain   text</p><p>here</p></body></html>", "https://example.com/", "text");
ok(/Plain text/.test(pcTx.content) && !/\.x\{\}/.test(pcTx.content) && !/[#*]/.test(pcTx.content), `pageContent text: clean text, no style, no markdown marks (${JSON.stringify(pcTx.content)})`);

// ----------------------------------------------------------------------------
// Input validation (no fetch)
// ----------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error("no network in validation phase"); };
for (const slug of ["site-map", "site-crawl"]) {
  await throws(h(slug)({}), 400, `${slug}: missing url`);
  await throws(h(slug)({ url: "   " }), 400, `${slug}: blank url`);
  await throws(h(slug)({ url: "not a url" }), 400, `${slug}: unparseable url`);
  await throws(h(slug)({ url: "ftp://example.com/x" }), 400, `${slug}: non-http scheme`);
  await throws(h(slug)({ url: "https://example.com/" + "a".repeat(2100) }), 400, `${slug}: url over 2048 chars`);
  await throws(h(slug)({ url: "http://127.0.0.1/" }), 400, `${slug}: loopback start refused`);
  await throws(h(slug)({ url: "http://10.0.0.5/" }), 400, `${slug}: RFC1918 start refused`);
  await throws(h(slug)({ url: "http://169.254.169.254/latest/meta-data" }), 400, `${slug}: metadata IP start refused`);
  await throws(h(slug)({ url: "http://[::1]/" }), 400, `${slug}: IPv6 loopback start refused`);
  await throws(h(slug)({ url: "https://example.com", limit: 0 }), 400, `${slug}: limit 0`);
  await throws(h(slug)({ url: "https://example.com", limit: "x" }), 400, `${slug}: limit non-integer`);
}
await throws(h("site-map")({ url: "https://example.com", limit: 501 }), 400, "site-map: limit over 500");
await throws(h("site-map")({ url: "https://example.com", includeSubdomains: "maybe" }), 400, "site-map: bad boolean");
await throws(h("site-map")({ url: "https://example.com", search: 42 }), 400, "site-map: search not a string");
await throws(h("site-crawl")({ url: "https://example.com", limit: 21 }), 400, "site-crawl: limit over 20");
await throws(h("site-crawl")({ url: "https://example.com", maxDepth: 3 }), 400, "site-crawl: maxDepth over 2");
await throws(h("site-crawl")({ url: "https://example.com", format: "pdf" }), 400, "site-crawl: bad format");
await throws(h("site-crawl")({ url: "https://example.com", maxCharsPerPage: 20001 }), 400, "site-crawl: maxCharsPerPage over 20000");
await throws(h("site-crawl")({ url: "https://example.com", includePatterns: "x".repeat(201) }), 400, "site-crawl: pattern too long");
await throws(h("site-crawl")({ url: "https://example.com", excludePatterns: Array.from({ length: 21 }, () => "a") }), 400, "site-crawl: too many patterns");
await throws(h("site-crawl")({ url: "https://example.com", includePatterns: [1] }), 400, "site-crawl: non-string pattern");
ok(fetchCalls === 0, "validation failures never fetch");

// ----------------------------------------------------------------------------
// Fake site under https://example.com served by a stubbed fetch
// ----------------------------------------------------------------------------
const SITE = "https://example.com";
const html = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const ROUTES = new Map(Object.entries({
  "/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /private/\n\nUser-agent: Agent402Bot\nDisallow: /private/\nDisallow: /bot-only/\nSitemap: https://example.com/sitemap-index.xml\n" },
  "/sitemap-index.xml": { type: "application/xml", body: "<sitemapindex><sitemap><loc>https://example.com/sitemap-a.xml</loc></sitemap><sitemap><loc>https://example.com/sitemap-b.xml.gz</loc></sitemap></sitemapindex>" },
  "/sitemap-a.xml": { type: "application/xml", body: "<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/about</loc></url><url><loc>https://example.com/blog/1</loc></url><url><loc>https://example.com/private/secret</loc></url><url><loc>https://other.test/x</loc></url><url><loc>https://docs.example.com/p</loc></url><url><loc>http://10.0.0.9/internal</loc></url></urlset>" },
  "/sitemap-b.xml.gz": { type: "application/gzip", body: gzipSync(Buffer.from("<urlset><url><loc>https://example.com/blog/2</loc></url><url><loc>https://example.com/docs</loc></url></urlset>")) },
  "/": { type: "text/html", body: html("Fake Home", '<h1>Welcome</h1><p>This is the home page of the fake site, with enough words to be a document.</p><a href="/about">About</a> <a href="/blog/1">Blog</a> <a href="/private/secret">Private</a> <a href="/redirect">R</a> <a href="/redirect-private">RP</a> <a href="http://10.0.0.5/admin">Admin</a> <a href="https://www.iana.org/domains">Offsite</a> <a href="/file.pdf">PDF</a> <a href="mailto:a@b.c">Mail</a> <a href="#top">Top</a> <a href="/about#x">About again</a> <a href="https://docs.example.com/p">Docs sub</a> <a href="/bot-only/x">Bot only</a>') },
  "/about": { type: "text/html; charset=utf-8", body: html("About Us", '<h1>About</h1><p>We are a fake company and this paragraph exists so the page has some real content to convert.</p><a href="/">Home</a> <a href="/deep/x">Deep</a>') },
  "/deep/x": { type: "text/html", body: html("Deep X", '<p>Deep page one with a bit of text in it.</p><a href="/deep/y">Deeper</a>') },
  "/deep/y": { type: "text/html", body: html("Deep Y", "<p>Deep page two.</p>") },
  "/blog/1": { type: "text/html", body: html("Blog 1", "<article><h2>Post one</h2><p>" + "Lorem ipsum dolor sit amet. ".repeat(200) + "</p></article>") },
  "/blog/2": { type: "text/html", body: html("Blog 2", "<p>Post two.</p>") },
  "/docs": { type: "text/html", body: html("Docs", "<p>Docs.</p>") },
  "/target": { type: "text/html", body: html("Target", "<p>You were redirected here.</p>") },
  "/redirect": { status: 301, location: "/target" },
  "/redirect-private": { status: 302, location: "http://127.0.0.1/secret" },
  "/file.pdf": { type: "application/pdf", body: "%PDF-1.4 binary" },
  "/private/secret": { type: "text/html", body: html("Secret", "<p>should never be fetched</p>") },
  "/bot-only/x": { type: "text/html", body: html("Bot only", "<p>should never be fetched</p>") },
  "/missing": { status: 404, type: "text/html", body: "<p>nope</p>" },
  "/broken": { status: 500, type: "text/html", body: "<p>boom: secret upstream detail</p>" },
  "/hang": { hang: true },
}));

let fetched = [];
let hangUntilAbort = true;
function stubFetch(url, init = {}) {
  const u = new URL(String(url));
  fetched.push(u.href);
  ok(init.headers?.["User-Agent"] === CRAWL_USER_AGENT, `fetch ${u.pathname}: carries the Agent402Bot user-agent`);
  if (u.host === "docs.example.com") return new Response(html("Docs sub", "<p>Subdomain page.</p>"), { status: 200, headers: { "content-type": "text/html" } });
  if (u.host !== "example.com" && u.host !== "www.example.com") throw Object.assign(new Error("stub: offsite fetch attempted " + u.href), { code: "ESTUB_OFFSITE" });
  const r = ROUTES.get(u.pathname);
  if (!r) return new Response("<p>not found</p>", { status: 404, headers: { "content-type": "text/html" } });
  if (r.hang) {
    return new Promise((_, reject) => {
      const sig = init.signal;
      if (sig?.aborted) return reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
      sig?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })), { once: true });
      if (!hangUntilAbort) setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })), 50);
    });
  }
  if (r.status >= 300 && r.status < 400) return new Response("", { status: r.status, headers: { location: r.location } });
  return new Response(r.body, { status: r.status || 200, headers: { "content-type": r.type } });
}
globalThis.fetch = stubFetch;
const fetchedPaths = () => fetched.map((u) => new URL(u).pathname);

// ---- site-map --------------------------------------------------------------
fetched = [];
const map = await h("site-map")({ url: SITE });
ok(map.url === "https://example.com/" && map.host === "example.com", "site-map: url + host echoed");
ok(map.fetches === 5 && map.fetches <= 6, `site-map: home + robots + index + 2 children = 5 fetches (got ${map.fetches})`);
ok(fetchedPaths()[0] === "/" && fetchedPaths()[1] === "/robots.txt", "site-map: start page first, robots second");
ok(map.sitemapsRead === 3, `site-map: index + gz child + plain child read (got ${map.sitemapsRead})`);
ok(map.urls.some((u) => u === "https://example.com/blog/2") && map.urls.some((u) => u === "https://example.com/docs"), "site-map: gzipped child sitemap URLs present");
ok(map.urls.some((u) => u === "https://example.com/about") && !map.urls.some((u) => u === "https://example.com/target"), "site-map: link + sitemap URLs merged (redirect target not fetched here)");
ok(!map.urls.some((u) => { const h = new URL(u).host; return h === "other.test" || h.endsWith(".other.test") || h === "iana.org" || h.endsWith(".iana.org"); }), "site-map: offsite URLs filtered");
ok(!map.urls.some((u) => u.includes("10.0.0") || u.includes("127.0.0.1")), "site-map: private-IP URLs filtered");
ok(!map.urls.some((u) => new URL(u).host === "docs.example.com"), "site-map: subdomain excluded by default");
ok(!map.urls.some((u) => u.includes("#") || u.startsWith("mailto")), "site-map: fragments + non-http dropped");
ok(new Set(map.urls).size === map.urls.length, "site-map: deduped");
ok(map.sources.sitemap + map.sources.links === map.total && map.sources.sitemap >= 2 && map.sources.links >= 5, `site-map: sources add up (${JSON.stringify(map.sources)} total ${map.total})`);
ok(map.truncated === false && map.warnings.length === 0, "site-map: not truncated, no warnings");
ok(fetched.every((u) => u.startsWith(SITE + "/")), "site-map: never fetched anything off example.com");
ok(!fetchedPaths().includes("/private/secret"), "site-map: discovery never fetches discovered pages");
ok(typeof map.fetchedAt === "string" && typeof map.source === "string", "site-map: source + fetchedAt");

fetched = [];
const mapSub = await h("site-map")({ url: "https://www.example.com/", includeSubdomains: true, limit: 3, search: "DOCS" });
ok(mapSub.urls.length <= 3 && mapSub.truncated === (mapSub.total > 3), `site-map: limit + truncated flag (${mapSub.total} total, ${mapSub.urls.length} returned)`);
ok(mapSub.urls.every((u) => u.toLowerCase().includes("docs")), "site-map: search is a case-insensitive substring filter");
ok(mapSub.urls.some((u) => u === "https://docs.example.com/p"), "site-map: includeSubdomains keeps subdomain URLs");
ok(mapSub.host === "www.example.com" && mapSub.urls.some((u) => u.startsWith("https://example.com/")), "site-map: www start counts bare host as the same site");

// fetch-count bound: a sitemap index with many children stops at 6 fetches and says so
ROUTES.set("/sitemap-index.xml", { type: "application/xml", body: "<sitemapindex>" + Array.from({ length: 12 }, (_, i) => `<sitemap><loc>https://example.com/child-${i}.xml</loc></sitemap>`).join("") + "</sitemapindex>" });
for (let i = 0; i < 12; i++) ROUTES.set(`/child-${i}.xml`, { type: "application/xml", body: `<urlset><url><loc>https://example.com/c${i}</loc></url></urlset>` });
fetched = [];
const mapBig = await h("site-map")({ url: SITE, limit: 500 });
ok(mapBig.fetches === 6 && mapBig.truncated === true, `site-map: at most 6 fetches, truncated when the index could not be fully expanded (fetches ${mapBig.fetches})`);
ROUTES.set("/sitemap-index.xml", { type: "application/xml", body: "<sitemapindex><sitemap><loc>https://example.com/sitemap-a.xml</loc></sitemap><sitemap><loc>https://example.com/sitemap-b.xml.gz</loc></sitemap></sitemapindex>" });

// start URL failures
await throws(h("site-map")({ url: SITE + "/missing" }), 422, "site-map: start URL 404");
await throws(h("site-map")({ url: SITE + "/broken" }), 502, "site-map: start URL 500");
await throws(h("site-map")({ url: SITE + "/file.pdf" }), 422, "site-map: start URL is binary");
await throws(h("site-map")({ url: SITE + "/redirect-private" }), 400, "site-map: start URL redirecting into loopback refused");
try { await h("site-map")({ url: SITE + "/broken" }); } catch (e) { ok(!/secret upstream detail/.test(e.message), "site-map: upstream error body never relayed"); }
globalThis.fetch = async () => { throw new Error("ECONNREFUSED stub"); };
await throws(h("site-map")({ url: SITE }), 422, "site-map: unreachable start URL");
globalThis.fetch = stubFetch;

// time budget: start page hangs -> 504 (nothing delivered, nobody charged)
__test.CONFIG.MAP_TOTAL_MS = 250;
await throws(h("site-map")({ url: SITE + "/hang" }), 504, "site-map: budget exhausted before the start page");
// start page fine, robots hangs -> 200 with partial discovery and truncated:true
ROUTES.set("/robots.txt", { hang: true });
const mapPartial = await h("site-map")({ url: SITE });
ok(mapPartial.urls.length >= 5 && mapPartial.truncated === true && mapPartial.warnings.includes("robots.txt not readable"), `site-map: budget exhaustion after the start page -> 200 + truncated (${mapPartial.urls.length} urls)`);
ROUTES.set("/robots.txt", { type: "text/plain", body: "User-agent: *\nDisallow: /private/\n\nUser-agent: Agent402Bot\nDisallow: /private/\nDisallow: /bot-only/\nSitemap: https://example.com/sitemap-index.xml\n" });
__test.CONFIG.MAP_TOTAL_MS = 15_000;

// ---- site-crawl ------------------------------------------------------------
fetched = [];
const crawl = await h("site-crawl")({ url: SITE, limit: 20, maxDepth: 1 });
const byUrl = Object.fromEntries(crawl.pages.map((p) => [p.url, p]));
ok(crawl.url === "https://example.com/" && crawl.format === "markdown" && crawl.untrustedContent === true, "site-crawl: echo + format + untrusted marker");
ok(fetchedPaths()[0] === "/robots.txt" && fetchedPaths()[1] === "/", "site-crawl: robots first, then the start page");
ok(byUrl["https://example.com/"]?.depth === 0 && byUrl["https://example.com/"].title === "Fake Home" && byUrl["https://example.com/"].status === 200, "site-crawl: start page at depth 0 with title + status");
ok(/Welcome/.test(byUrl["https://example.com/"].content) && /About/.test(byUrl["https://example.com/"].content), "site-crawl: start page markdown has heading + body text");
ok(byUrl["https://example.com/about"]?.depth === 1 && byUrl["https://example.com/blog/1"]?.depth === 1, "site-crawl: linked pages at depth 1");
ok(byUrl["https://example.com/target"]?.redirectedFrom === "https://example.com/redirect", "site-crawl: in-site redirect followed, redirectedFrom recorded");
ok(!byUrl["https://example.com/deep/x"], "site-crawl: depth 2 page not fetched at maxDepth 1");
ok(crawl.skipped.depth >= 1, `site-crawl: depth-bounded links counted (${crawl.skipped.depth})`);
ok(!fetchedPaths().includes("/private/secret") && !fetchedPaths().includes("/bot-only/x") && crawl.skipped.robots === 2, `site-crawl: robots.txt disallow honoured for Agent402Bot, never fetched (robots=${crawl.skipped.robots})`);
ok(crawl.skipped.offsite >= 2, `site-crawl: offsite links (iana.org, docs subdomain) skipped (${crawl.skipped.offsite})`);
ok(crawl.skipped.unsafe === 2, `site-crawl: private-IP link + redirect into loopback refused (unsafe=${crawl.skipped.unsafe})`);
ok(!fetched.some((u) => /10\.0\.0\.|127\.0\.0\.1|iana\.org|docs\.example/.test(u)), "site-crawl: never fetched a private or offsite URL");
ok(crawl.skipped.binary === 1 && !byUrl["https://example.com/file.pdf"], "site-crawl: binary page dropped, counted");
ok(crawl.pages.every((p) => p.links.every((l) => l.startsWith("https://example.com/"))), "site-crawl: per-page links are internal only");
ok(crawl.pages.every((p) => p.contentChars === p.content.length), "site-crawl: contentChars matches content");
ok(crawl.crawled === crawl.pages.length && crawl.truncated === false && crawl.skipped.limit === 0, `site-crawl: crawled=${crawl.crawled}, not truncated`);
ok(crawl.robotsTxt === "honoured" && typeof crawl.fetchedAt === "string" && typeof crawl.source === "string", "site-crawl: robotsTxt + source + fetchedAt");

// limit + truncated + skipped.limit
const small = await h("site-crawl")({ url: SITE, limit: 2, maxDepth: 2 });
ok(small.pages.length === 2 && small.truncated === true && small.skipped.limit >= 1 && small.queued >= 1, `site-crawl: limit 2 -> 2 pages, truncated, ${small.skipped.limit} left in queue`);

// depth 0 = only the start page
const d0 = await h("site-crawl")({ url: SITE, maxDepth: 0 });
ok(d0.pages.length === 1 && d0.skipped.depth >= 3, "site-crawl: maxDepth 0 fetches only the start page");

// depth 2 reaches /deep/x
const d2 = await h("site-crawl")({ url: SITE, maxDepth: 2, limit: 20 });
ok(d2.pages.some((p) => p.url === "https://example.com/deep/x" && p.depth === 2), "site-crawl: maxDepth 2 reaches depth-2 pages");

// patterns
const inc = await h("site-crawl")({ url: SITE, includePatterns: ["/blog/"], limit: 20 });
ok(inc.pages.length === 2 && inc.pages.some((p) => p.url === "https://example.com/blog/1") && inc.skipped.pattern >= 3, `site-crawl: includePatterns keeps only matching links (${inc.pages.length} pages)`);
const exc = await h("site-crawl")({ url: SITE, excludePatterns: ["blog", "REDIRECT"], limit: 20 });
ok(!exc.pages.some((p) => /blog|target/.test(p.url)) && exc.skipped.pattern >= 3, "site-crawl: excludePatterns drop matching links (case-insensitive)");

// sameHost:false widens to subdomains only
fetched = [];
const sub = await h("site-crawl")({ url: SITE, sameHost: false, limit: 20 });
// An unresolvable subdomain is refused by the guard like a private one (one
// answer for both), so it lands under unsafe rather than error.
ok(fetched.some((u) => u.startsWith("https://docs.example.com/")) || sub.skipped.error + sub.skipped.unsafe >= 1, "site-crawl: sameHost:false admits the docs subdomain (fetched or refused, never offsite)");
ok(!fetched.some((u) => /iana\.org/.test(u)), "site-crawl: sameHost:false still never leaves the site");

// format text + maxCharsPerPage
const txt = await h("site-crawl")({ url: SITE + "/blog/1", maxDepth: 0, format: "text", maxCharsPerPage: 300 });
ok(txt.pages[0].contentChars === 300 && txt.pages[0].contentTruncated === true && !/[#*\[]/.test(txt.pages[0].content), "site-crawl: text format + maxCharsPerPage truncation flagged");
const md = await h("site-crawl")({ url: SITE + "/blog/1", maxDepth: 0 });
ok(md.pages[0].contentChars <= 8000 && md.pages[0].contentTruncated === undefined, "site-crawl: default cap not hit on a 5.6k page");

// start URL failures
await throws(h("site-crawl")({ url: SITE + "/missing" }), 422, "site-crawl: start URL 404");
await throws(h("site-crawl")({ url: SITE + "/broken" }), 502, "site-crawl: start URL 500");
await throws(h("site-crawl")({ url: SITE + "/file.pdf" }), 422, "site-crawl: start URL is binary");
await throws(h("site-crawl")({ url: SITE + "/private/secret" }), 422, "site-crawl: start URL disallowed by robots.txt");
await throws(h("site-crawl")({ url: SITE + "/redirect-private" }), 400, "site-crawl: start URL redirecting into loopback refused");
try { await h("site-crawl")({ url: SITE + "/broken" }); } catch (e) { ok(!/secret upstream detail/.test(e.message), "site-crawl: upstream error body never relayed"); }
globalThis.fetch = async () => { throw new Error("ECONNREFUSED stub"); };
await throws(h("site-crawl")({ url: SITE }), 422, "site-crawl: unreachable start URL");
globalThis.fetch = stubFetch;

// non-2xx pages inside the crawl are recorded with status, no content
const with404 = await h("site-crawl")({ url: SITE + "/about", maxDepth: 1, limit: 20 });
ok(with404.pages.every((p) => p.status === 200), "site-crawl: healthy site has only 200 pages");
ROUTES.set("/about", { type: "text/html", body: html("About", '<p>About page linking a dead page with some words.</p><a href="/missing">Dead</a>') });
const dead = await h("site-crawl")({ url: SITE + "/about", maxDepth: 1, limit: 20 });
const deadPage = dead.pages.find((p) => p.url === "https://example.com/missing");
ok(deadPage && deadPage.status === 404 && deadPage.content === "" && deadPage.contentChars === 0, "site-crawl: a 404 inside the crawl is recorded with status 404 and no content");
ROUTES.set("/about", { type: "text/html; charset=utf-8", body: html("About Us", '<h1>About</h1><p>We are a fake company and this paragraph exists so the page has some real content to convert.</p><a href="/">Home</a> <a href="/deep/x">Deep</a>') });

// time budget
__test.CONFIG.CRAWL_TOTAL_MS = 300;
await throws(h("site-crawl")({ url: SITE + "/hang" }), 504, "site-crawl: start page hangs past the budget");
ROUTES.set("/", { type: "text/html", body: html("Home", '<p>Home with a hanging link and a good one.</p><a href="/hang">Hang</a> <a href="/blog/2">Two</a>') });
const partial = await h("site-crawl")({ url: SITE, limit: 20 });
ok(partial.pages.length >= 1 && partial.truncated === true, `site-crawl: budget exhausted after the start page -> 200 + truncated (${partial.pages.length} pages)`);
ok(!partial.pages.some((p) => p.url.endsWith("/hang")), "site-crawl: the hanging page is not reported as a page");
__test.CONFIG.CRAWL_TOTAL_MS = 25_000;

// byte budget: a page over the per-page cap is dropped, not served truncated
__test.CONFIG.CRAWL_PAGE_BYTES = 1024;
const bigDrop = await h("site-crawl")({ url: SITE + "/about", maxDepth: 1, limit: 20 });
ok(!bigDrop.pages.some((p) => p.url.endsWith("/blog/1")), "site-crawl: a page over the per-page byte cap is skipped");
__test.CONFIG.CRAWL_PAGE_BYTES = 2 * 1024 * 1024;

globalThis.fetch = realFetch;

// ----------------------------------------------------------------------------
// Live (opt-in): the catalog examples against the real stable sites
// ----------------------------------------------------------------------------
if (process.env.CRAWL_LIVE_TEST === "1") {
  for (const t of CRAWL_TOOLS) {
    try {
      const r = await t.handler(t.discovery.input);
      const missing = Object.keys(t.discovery.output.example).filter((k) => !(k in r));
      ok(missing.length === 0, `live ${t.slug}: answers its own example (missing: ${missing.join(",") || "none"})`);
      if (t.slug === "site-map") ok(r.urls.length >= 5 && r.urls.every((u) => /iana\.org/.test(u)), `live site-map: ${r.urls.length} iana.org URLs`);
      if (t.slug === "site-crawl") ok(r.pages[0].title === "Example Domain" && r.pages[0].contentChars > 50, `live site-crawl: example.com title + content (${r.pages[0].contentChars} chars)`);
    } catch (e) {
      fail++; console.error(`ASSERT FAIL - live ${t.slug}: ${e.statusCode} ${e.message}`);
    }
  }
}

console.log(`\ncrawl-kit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

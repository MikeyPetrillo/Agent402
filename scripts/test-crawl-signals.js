#!/usr/bin/env node
// What a search crawler is told, page by page, agrees with itself. Each check
// is a class a site audit found (2026-11-23):
//   - crawl traps: /playground?slug=<tool> was one indexable copy of a large
//     page per tool, linked twice from every tool page
//   - open URL spaces: /marketplace/tools took any category string (seller
//     text) into an indexable, self-canonical, titled page
//   - one structured-data node ("Agent402 on Base") on every page
//   - articles with no dates and og:type website everywhere
//   - sitemaps from two hand lists, non-HTML entries, unlisted /docs pages,
//     one module date on every page of a family
//   - degraded entity pages whose header said noindex while the meta tag and
//     the sitemap said index
//   - 404 and 410 pages canonical to the home page
// Boots FREE_MODE on a free port; the degraded-entity checks run offline.
//
//   node scripts/test-crawl-signals.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getFreePort } from "./lib/free-port.js";
import { ownStoreEnv } from "./lib/own-stores.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SITE = "https://agent402.tools";

const meta = (html, re) => (html.match(re) || [])[1];
const robotsOf = (html) => meta(html, /<meta name="robots" content="([^"]*)"/) || "";
const canonOf = (html) => meta(html, /<link rel="canonical" href="([^"]*)"/) || null;
const h1Of = (html) => [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim());
const ldNodes = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  .map((m) => JSON.parse(m[1])).flatMap((j) => (Array.isArray(j["@graph"]) ? j["@graph"] : [j]));

// --- offline: a degraded entity page agrees with itself and leaves the sitemap ----
{
  const pp = await import("../src/programmatic-pages.js");
  const { sitemapXml } = await import("../src/seo.js");
  const { isSeededTicker, SEED_TICKERS } = await import("../src/programmatic-seeds.js");
  const t = SEED_TICKERS[0];
  const path = `/reports/insider/${t}`;
  ok(isSeededTicker(t), `${t} is a seeded ticker`);
  const before = sitemapXml(SITE, {}).includes(`<loc>${SITE}${path}</loc>`);
  ok(before, `${path} is in the sitemap before any render`);
  const r = await pp.loadTeaser("insider", t, { seeded: true, builders: { insider: async () => { throw new Error("EDGAR unreachable"); } } });
  ok(r.status === "degraded" && pp.entityDegraded(path), "a seeded entity EDGAR could not read is marked degraded");
  ok(!sitemapXml(SITE, {}).includes(`<loc>${SITE}${path}</loc>`), `${path} leaves the sitemap while degraded`);
  const html = pp.insiderPage({ ticker: t, data: null, baseUrl: SITE, degraded: true });
  ok(/noindex/.test(robotsOf(html)), `the degraded page's meta robots says noindex, as its header does (${robotsOf(html)})`);
  const good = { name: "Test Co", rows: [], filingsInWindow: 0, windowDays: 90, filingsRead: 0, startDate: "2026-01-01", endDate: "2026-03-31", cik: "1", latestFiledDate: "2026-03-01" };
  const r2 = await pp.loadTeaser("insider", t, { seeded: true, builders: { insider: async () => good } });
  ok(r2.status === "ok" && !pp.entityDegraded(path), "a complete build clears the mark");
  ok(sitemapXml(SITE, {}).includes(`<loc>${SITE}${path}</loc>`), `${path} returns to the sitemap after a complete build`);
  const okHtml = pp.insiderPage({ ticker: t, data: good, baseUrl: SITE });
  ok(!/noindex/.test(robotsOf(okHtml)), "a complete page is indexable");
}

// --- booted ------------------------------------------------------------------
const PORT = await getFreePort();
const BASE = `http://127.0.0.1:${PORT}`;
const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, ...ownStoreEnv("crawl-signals"), FREE_MODE: "true", PORT: String(PORT), BASE_URL: SITE, X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0" },
  stdio: "ignore",
});
const get = async (p, opts = {}) => { const r = await fetch(`${BASE}${p}`, { redirect: "manual", ...opts }); return { status: r.status, headers: r.headers, text: await r.text() }; };
try {
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch {} await sleep(500); }
  ok(up, "server booted");

  // Crawl trap.
  const robots = (await get("/robots.txt")).text;
  const groups = robots.split(/\n\s*\n/).filter((g) => /^User-agent:/m.test(g));
  ok(groups.length > 5 && groups.every((g) => /^Disallow: \/playground\?$/m.test(g)), `every robots group disallows /playground? (${groups.length} groups)`);
  for (const bot of ["Claude-SearchBot", "Claude-User", "Perplexity-User"]) ok(new RegExp(`User-agent: ${bot}\\nAllow: /\\n`).test(robots), `robots names ${bot} with Allow: / like the other AI crawlers`);
  const tool = (await get("/tools/hash")).text;
  const pgLinks = [...tool.matchAll(/<a\b[^>]*href="\/playground\?slug=[^"]*"[^>]*>/g)].map((m) => m[0]);
  ok(pgLinks.length >= 1 && pgLinks.every((a) => /rel="nofollow"/.test(a)), `every /playground?slug= link on a tool page is nofollow (${pgLinks.length})`);
  const variant = (await get("/playground?slug=hash")).text;
  ok(/noindex/.test(robotsOf(variant)) && canonOf(variant) === `${SITE}/playground`, "a /playground?slug= variant is noindex with the bare playground as canonical");
  ok(!/noindex/.test(robotsOf((await get("/playground")).text)), "the bare /playground stays indexable");

  // Open URL space.
  const { CATEGORIES } = await import("../src/pages.js");
  const own = "web";
  const mk = async (q) => (await get(`/marketplace/tools${q}`)).text;
  const junk = await mk("?category=wave7");
  ok(/noindex/.test(robotsOf(junk)) && !/wave7/.test(meta(junk, /<title>([^<]*)/) || ""), "a category we do not define is noindex and stays out of the title");
  const cat = await mk(`?category=${own}`);
  ok(!/noindex/.test(robotsOf(cat)) && canonOf(cat) === `${SITE}/marketplace/tools?category=${own}`, "one of our categories is an indexable, self-canonical page");
  ok(h1Of(cat)[0]?.startsWith(CATEGORIES[own].label) && (meta(cat, /<meta name="description" content="([^"]*)"/) || "").includes(CATEGORIES[own].label.replace(/&/g, "&amp;")), "its H1 and description name the category");
  const p2 = await mk("?page=2");
  ok(/noindex/.test(robotsOf(p2)) || /Nothing matched/.test(p2), "a page after the first is noindex");
  const src = await mk(`?category=${own}&source=ours`);
  ok(/noindex/.test(robotsOf(src)) && !/source=/.test(canonOf(src) || ""), "a source view is noindex and its canonical drops source");
  ok(/noindex/.test(robotsOf(await mk("?q=hash"))), "a search result is noindex");

  // Structured data scoped to the pages it describes.
  const baseApp = (html) => ldNodes(html).some((n) => n.name === "Agent402 on Base");
  ok(baseApp((await get("/")).text) && baseApp((await get("/base")).text), "the Base application node is on / and /base");
  ok(!baseApp(tool) && !baseApp((await get("/docs")).text) && !baseApp((await get("/faq")).text), "and nowhere else");

  // Sitemaps.
  const smText = (await get("/sitemap.xml")).text;
  const sm = new Map([...smText.matchAll(/<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?/g)].map((m) => [m[1].slice(SITE.length), m[2] || null]));
  const pagesSub = new Set([...(await get("/sitemap-pages.xml")).text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].slice(SITE.length)));
  const machine = [...sm.keys()].filter((p) => /^\/(api|\.well-known)\/|\.(json|txt|md|xml)$/.test(p));
  const machineOff = machine.filter((p) => !pagesSub.has(p));
  ok(machine.length >= 10 && machineOff.length === 0, `the machine-readable documents are listed in both sitemaps from one list (${machine.length}${machineOff.length ? `; only in sitemap.xml: ${machineOff.join(", ")}` : ""})`);
  ok(sm.has("/tools.md"), "the markdown catalog index is listed");
  const { docsSlugs, DOCS_SITE_ROUTES } = await import("../src/docs.js");
  const docs = docsSlugs().filter((s) => s !== "Home" && !Object.hasOwn(DOCS_SITE_ROUTES, s)).map((s) => `/docs/${s}`);
  const missingDocs = docs.filter((p) => !sm.has(p) || !pagesSub.has(p));
  ok(docs.length >= 30 && missingDocs.length === 0, `every /docs page is in sitemap.xml and sitemap-pages.xml (${docs.length}${missingDocs.length ? `; missing ${missingDocs.slice(0, 5).join(", ")}` : ""})`);
  for (const p of ["/proof", "/compare", "/pay-per-call-api", "/paid-mcp-tools"]) ok(sm.has(p) && pagesSub.has(p), `${p} is in both sitemaps`);
  const docsDated = docs.filter((p) => sm.get(p));
  ok(docsDated.length === docs.length, `every /docs page carries its wiki file's date (${docsDated.length} of ${docs.length})`);
  for (const fam of ["/skills/", "/guides/", "/integrations/"]) {
    const dates = [...sm].filter(([p]) => p.startsWith(fam)).map(([, d]) => d);
    ok(dates.length > 3 && dates.every(Boolean) && new Set(dates).size >= 3, `${fam} pages are dated one by one (${new Set(dates).size} distinct dates over ${dates.length})`);
  }
  ok(["/reports/insider", "/reports/fund", "/reports/dossier"].every((p) => sm.get(p)), "the report hubs are dated");

  // Articles: og:type article, both dates, the same date the sitemap gives.
  const { BLOG_POSTS } = await import("../src/blog.js");
  const { guideSlugs } = await import("../src/guides.js");
  const { learnSlugs } = await import("../src/learn.js");
  for (const p of [`/blog/${BLOG_POSTS[0].slug}`, `/guides/${guideSlugs()[0]}`, `/learn/${learnSlugs()[0]}`, "/what-is-x402", "/docs", "/pay-per-call-api"]) {
    const html = (await get(p)).text;
    const art = ldNodes(html).find((n) => /^(Article|TechArticle|BlogPosting)$/.test(n["@type"]));
    const pub = meta(html, /<meta property="article:published_time" content="([^"]*)"/);
    const mod = meta(html, /<meta property="article:modified_time" content="([^"]*)"/);
    ok(meta(html, /<meta property="og:type" content="([^"]*)"/) === "article", `${p}: og:type article`);
    ok(art && art.headline && art.image && art.datePublished && art.dateModified && art.datePublished <= art.dateModified, `${p}: its Article node has headline, image and both dates (${art?.datePublished} / ${art?.dateModified})`);
    ok(pub === art?.datePublished && mod === art?.dateModified, `${p}: the meta tags state the same dates`);
    if (sm.has(p) && sm.get(p)) ok(sm.get(p) === art?.dateModified, `${p}: dateModified equals its sitemap lastmod (${sm.get(p)})`);
  }
  ok(meta(tool, /<meta property="og:type" content="([^"]*)"/) === "website", "a tool page stays og:type website");

  // New landing pages and the x402 page.
  for (const p of ["/pay-per-call-api", "/paid-mcp-tools", "/compare"]) {
    const r = await get(p);
    const d = meta(r.text, /<meta name="description" content="([^"]*)"/) || "";
    ok(r.status === 200 && canonOf(r.text) === `${SITE}${p}` && h1Of(r.text).length === 1 && /[.!?]$/.test(d) && d.length <= 155 && !/noindex/.test(robotsOf(r.text)), `${p}: 200, self-canonical, one H1, a whole-sentence description`);
  }
  const x = (await get("/what-is-x402")).text;
  ok(/^x402 on Agent402/.test(meta(x, /<title>([^<]*)/) || ""), "/what-is-x402 is titled for x402");

  // Error pages name no canonical.
  const nf = await get("/no-such-page-crawl-signals");
  ok(nf.status === 404 && canonOf(nf.text) === null && !/og:url/.test(nf.text), "a 404 page carries no canonical");
  const nfTool = await get("/tools/no-such-tool-crawl-signals");
  ok(nfTool.status === 404 && canonOf(nfTool.text) === null, "a tool 404 carries no canonical");
  const { RETIRED_TOOLS } = await import("../src/retired-tools.js");
  const retired = Object.keys(RETIRED_TOOLS)[0];
  const gone = await get(`/tools/${retired}`);
  ok(gone.status === 410 && canonOf(gone.text) === null, `a retired tool page (410) carries no canonical (${retired})`);

  // Orphans: linked from the company page.
  const co = (await get("/company")).text;
  ok(/href="\/press"/.test(co) && /href="\/wholesale"/.test(co), "/press and /wholesale are linked from /company");
} catch (e) {
  ok(false, e.stack || e.message);
} finally {
  proc.kill("SIGKILL");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

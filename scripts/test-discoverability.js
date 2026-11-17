#!/usr/bin/env node
// Every tool must be findable by an agent, on every surface an agent uses.
//
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-discoverability.js
//
// WHY: a tool that exists but cannot be found earns nothing, and the failure is
// silent - the catalog count still looks right. That is not hypothetical here.
// CATEGORIES was short by ten keys covering 195 entries, and because llms.txt is
// built by iterating that map, 292 of 526 tools were absent from the
// agent-readable catalog: ten category pages 404'd, and the chain-read
// primitives and seller-trust, both added specifically to be discovered, could
// not be. Everything still passed, because nothing asserted completeness.
//
// So this asserts it, per tool, on every surface an agent actually reads:
//   * /api/pricing            the machine catalog
//   * /openapi.json           the spec crawlers and directories consume
//   * /llms.txt               the agent-readable catalog
//   * /.well-known/x402       the x402 service manifest
//   * /sitemap.xml            search and AI crawlers: the tool page's CANONICAL
//                             URL (a skill-pack alias tool's page is canonical to
//                             its /skills/<pack> page, which the sitemap lists)
//   * /tools/<slug>           the human/SEO page must render, not 404
//   * /api/find?q=<slug>      the resolver must return the tool it was asked for
//
// The find check uses the slug, which is the strongest form a caller can give.
// Natural-language ranking is a softer property and is covered by
// scripts/test-find.js; this one is about REACHABILITY, and a tool that cannot
// be reached by its own name is unreachable by anything.
//
// Load shedding: every read here is a free request, which the server refuses
// with its load-shed answer while its event loop is saturated (src/load-shed.js).
// This suite's own burst did that on a slow runner (run 43828629618: every
// page and find after the first 216 tools, and every category page after
// them, read the lag gate's 503). So the burst is kept small, and a shed
// answer is waited out as it asks (scripts/lib/shed-answer.js, bounded); a
// read still shed at the bound fails with that named, and any other non-200
// fails as before.
import { fetchHonoringShed } from "./lib/shed-answer.js";

const TARGET = (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};
let shedWaits = 0, stillShed = 0;
const read = async (p) => {
  const r = await fetchHonoringShed(`${TARGET}${p}`);
  shedWaits += r.shed;
  if (r.stillShed) stillShed++;
  return r;
};
const statusOf = (r) => `${r.res.status}${r.stillShed ? " (still shed at the bound)" : ""}`;
const get = async (p) => (await read(p)).text;

const pricing = JSON.parse(await get("/api/pricing"));
const catalog = pricing.endpoints || [];
ok(catalog.length > 400, `catalog loaded (${catalog.length} entries)`);

const [llms, specRaw, manifestRaw, sitemap] = await Promise.all([
  get("/llms-full.txt"), get("/openapi.json"), get("/.well-known/x402"), get("/sitemap.xml"),
]);
const specPaths = new Set(Object.keys(JSON.parse(specRaw).paths || {}));
const manifest = manifestRaw;

const absent = { "llms-full.txt": [], "openapi.json": [], "/.well-known/x402": [] };
for (const e of catalog) {
  if (!llms.includes(`/tools/${e.slug}`)) absent["llms-full.txt"].push(e.slug);
  if (!specPaths.has(e.path)) absent["openapi.json"].push(e.slug);
  if (!manifest.includes(e.path)) absent["/.well-known/x402"].push(e.slug);
}
for (const [surface, missing] of Object.entries(absent)) {
  ok(missing.length === 0,
    `every catalog entry appears in ${surface}${missing.length ? ` (${missing.length} absent, e.g. ${missing.slice(0, 3).join(", ")})` : ""}`);
}
// The sitemap lists each page once, at its canonical URL, so each entry is
// checked by the canonical its own /tools/<slug> page declares (read below).
const sitemapLocs = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
const canonicalOf = (html) => (html.match(/<link rel="canonical" href="([^"]+)">/) || [])[1] || null;

// Pages and the resolver, per tool. Batched so 500+ round trips stay quick,
// and small enough that the burst does not saturate the server it reads.
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const pageFails = [], findFails = [], sitemapMissing = [];
let aliasCanonicals = 0;
for (const batch of chunk(catalog, 8)) {
  await Promise.all(batch.map(async (e) => {
    const page = await read(`/tools/${e.slug}`);
    if (page.res.status !== 200) pageFails.push(`${e.slug}:${statusOf(page)}`);
    const canonical = canonicalOf(page.text);
    // A tool page is canonical to itself; only a skill-<pack> alias may point
    // at its pack page, so a stray canonical cannot hide a missing tool page.
    const own = canonical && canonical.endsWith(`/tools/${e.slug}`);
    const viaPack = canonical && e.slug.startsWith("skill-") && canonical.endsWith(`/skills/${e.slug.slice(6)}`);
    if (viaPack) aliasCanonicals++;
    if (!(own || viaPack) || !sitemapLocs.has(canonical)) sitemapMissing.push(`${e.slug}${canonical ? "" : "(no canonical)"}`);
    try {
      const r = JSON.parse(await get(`/api/find?q=${encodeURIComponent(e.slug)}`));
      const found = [...(r.results || []), ...(r.packs || [])].some((x) => x.slug === e.slug);
      if (!found) findFails.push(e.slug);
    } catch { findFails.push(`${e.slug}(error)`); }
  }));
}
ok(pageFails.length === 0, `every /tools/<slug> page renders${pageFails.length ? ` (${pageFails.length} failed: ${pageFails.slice(0, 4).join(", ")})` : ""}`);
ok(sitemapMissing.length === 0,
  `every catalog entry's canonical page appears in sitemap.xml (${aliasCanonicals} via a skill-pack page)${sitemapMissing.length ? ` (${sitemapMissing.length} absent, e.g. ${sitemapMissing.slice(0, 3).join(", ")})` : ""}`);
ok(findFails.length === 0, `/api/find returns every tool when asked for it by slug${findFails.length ? ` (${findFails.length} unfindable: ${findFails.slice(0, 4).join(", ")})` : ""}`);

// Every category the catalog uses must be renderable, or its tools are orphaned
// from the browsable surface even while present in the machine catalogs.
const categories = [...new Set(catalog.map((e) => e.category).filter(Boolean))];
const catFails = [];
for (const c of categories) {
  const page = await read(`/tools/category/${encodeURIComponent(c)}`);
  if (page.res.status !== 200) catFails.push(`${c}:${statusOf(page)}`);
}
ok(catFails.length === 0, `every category in use has a page (${categories.length} categories${catFails.length ? `, failing: ${catFails.join(", ")}` : ""})`);
ok(Object.keys(pricing.categories || {}).length >= categories.length,
  `every category in use is labelled in /api/pricing (${Object.keys(pricing.categories || {}).length} labels for ${categories.length} categories)`);

console.log(`load-shed answers waited out: ${shedWaits}; reads still shed at the bound: ${stillShed}`);
console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

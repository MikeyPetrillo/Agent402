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
//   * /sitemap.xml            search and AI crawlers
//   * /tools/<slug>           the human/SEO page must render, not 404
//   * /api/find?q=<slug>      the resolver must return the tool it was asked for
//
// The find check uses the slug, which is the strongest form a caller can give.
// Natural-language ranking is a softer property and is covered by
// scripts/test-find.js; this one is about REACHABILITY, and a tool that cannot
// be reached by its own name is unreachable by anything.
const TARGET = (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};
const get = async (p) => (await fetch(`${TARGET}${p}`)).text();

const pricing = JSON.parse(await get("/api/pricing"));
const catalog = pricing.endpoints || [];
ok(catalog.length > 400, `catalog loaded (${catalog.length} entries)`);

const [llms, specRaw, manifestRaw, sitemap] = await Promise.all([
  get("/llms-full.txt"), get("/openapi.json"), get("/.well-known/x402"), get("/sitemap.xml"),
]);
const specPaths = new Set(Object.keys(JSON.parse(specRaw).paths || {}));
const manifest = manifestRaw;

const absent = { "llms-full.txt": [], "openapi.json": [], "/.well-known/x402": [], "sitemap.xml": [] };
for (const e of catalog) {
  if (!llms.includes(`/tools/${e.slug}`)) absent["llms-full.txt"].push(e.slug);
  if (!specPaths.has(e.path)) absent["openapi.json"].push(e.slug);
  if (!manifest.includes(e.path)) absent["/.well-known/x402"].push(e.slug);
  if (!sitemap.includes(`/tools/${e.slug}<`)) absent["sitemap.xml"].push(e.slug);
}
for (const [surface, missing] of Object.entries(absent)) {
  ok(missing.length === 0,
    `every catalog entry appears in ${surface}${missing.length ? ` (${missing.length} absent, e.g. ${missing.slice(0, 3).join(", ")})` : ""}`);
}

// Pages and the resolver, per tool. Batched so 500+ round trips stay quick.
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const pageFails = [], findFails = [];
for (const batch of chunk(catalog, 24)) {
  await Promise.all(batch.map(async (e) => {
    const res = await fetch(`${TARGET}/tools/${e.slug}`);
    if (res.status !== 200) pageFails.push(`${e.slug}:${res.status}`);
    try {
      const r = JSON.parse(await get(`/api/find?q=${encodeURIComponent(e.slug)}`));
      const found = [...(r.results || []), ...(r.packs || [])].some((x) => x.slug === e.slug);
      if (!found) findFails.push(e.slug);
    } catch { findFails.push(`${e.slug}(error)`); }
  }));
}
ok(pageFails.length === 0, `every /tools/<slug> page renders${pageFails.length ? ` (${pageFails.length} failed: ${pageFails.slice(0, 4).join(", ")})` : ""}`);
ok(findFails.length === 0, `/api/find returns every tool when asked for it by slug${findFails.length ? ` (${findFails.length} unfindable: ${findFails.slice(0, 4).join(", ")})` : ""}`);

// Every category the catalog uses must be renderable, or its tools are orphaned
// from the browsable surface even while present in the machine catalogs.
const categories = [...new Set(catalog.map((e) => e.category).filter(Boolean))];
const catFails = [];
for (const c of categories) {
  const res = await fetch(`${TARGET}/tools/category/${encodeURIComponent(c)}`);
  if (res.status !== 200) catFails.push(`${c}:${res.status}`);
}
ok(catFails.length === 0, `every category in use has a page (${categories.length} categories${catFails.length ? `, failing: ${catFails.join(", ")}` : ""})`);
ok(Object.keys(pricing.categories || {}).length >= categories.length,
  `every category in use is labelled in /api/pricing (${Object.keys(pricing.categories || {}).length} labels for ${categories.length} categories)`);

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

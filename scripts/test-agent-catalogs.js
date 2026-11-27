#!/usr/bin/env node
// The machine catalogs can be read in parts. /openapi.json is megabytes and
// answered the same bytes whatever ?tag= or ?category= said, so an agent with
// one task had to load the whole catalog. Now:
//   - /openapi.json?category=<key> and ?tag=<word> answer a valid OpenAPI
//     document holding only the matching operations; an unknown value is a 404
//     that lists the categories
//   - /tools.md lists one markdown catalog per category, /tools/<key>.md
//     lists every tool of that category with its route and catalog price
//   - size budgets: every category file within CATEGORY_MD_BUDGET_BYTES and
//     every category subset of the OpenAPI document well under the whole
// Boots FREE_MODE on a free port.
//
//   node scripts/test-agent-catalogs.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";
import { CATEGORY_MD_BUDGET_BYTES } from "../src/category-markdown.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
// A category subset may take at most this share of the whole document.
const SUBSET_MAX_SHARE = 0.5;

const SITE = "https://agent402.tools";
// Port 0, read back: the port is the one the server bound (scripts/lib/boot-server.js).
const srv = await bootServer({
  stores: "agent-catalogs",
  env: { FREE_MODE: "true", BASE_URL: SITE, X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0" },
});
const BASE = srv.url;
try {
  ok(srv.port > 0, "server booted");
  const pricing = await (await fetch(`${BASE}/api/pricing`)).json();
  const rows = pricing.endpoints || [];
  const fullText = await (await fetch(`${BASE}/openapi.json`)).text();
  const full = JSON.parse(fullText);
  const fullOpsList = Object.values(full.paths).flatMap((p) => Object.values(p));
  const fullOps = fullOpsList.length;
  const cats = [...new Set(rows.map((r) => r.category))].filter(Boolean);
  ok(cats.length > 5, `the catalog uses ${cats.length} categories`);
  const fixedIds = new Set(fullOpsList.filter((o) => !(o.tags || []).some((t) => cats.includes(t))).map((o) => o.operationId));
  ok(fixedIds.size < 20, `the document's fixed routes outside the catalog are few (${fixedIds.size})`);

  // OpenAPI subsets.
  let biggest = 0;
  const failsBefore = fail;
  for (const c of cats) {
    const r = await fetch(`${BASE}/openapi.json?category=${encodeURIComponent(c)}`);
    if (r.status !== 200) { ok(false, `?category=${c} answers 200 (got ${r.status})`); continue; }
    const text = await r.text();
    const doc = JSON.parse(text);
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
    const mine = ops.filter((o) => (o.tags || []).includes(c));
    const others = ops.filter((o) => !(o.tags || []).includes(c));
    const wantOps = fullOpsList.filter((o) => (o.tags || []).includes(c)).length;
    // Beside the category's own operations, only the document's fixed free
    // routes (no catalog category) may appear.
    if (!(doc.openapi === full.openapi && mine.length === wantOps && mine.length > 0 && others.every((o) => fixedIds.has(o.operationId)) && ops.length < fullOps)) {
      ok(false, `?category=${c}: an OpenAPI document of only that category's operations (${mine.length} of ${wantOps}, ${others.length} others)`);
    }
    if (doc.info?.["x-subset"]?.category !== c) ok(false, `?category=${c}: info.x-subset names the filter`);
    biggest = Math.max(biggest, text.length);
  }
  ok(fail === failsBefore, `every one of ${cats.length} category subsets holds exactly that category's operations`);
  ok(biggest > 0 && biggest <= fullText.length * SUBSET_MAX_SHARE, `every category subset is at most ${SUBSET_MAX_SHARE * 100}% of the whole document (largest ${biggest} of ${fullText.length} bytes)`);
  // A tag that is not a category: the tools that carry it, from every category.
  {
    const r = await fetch(`${BASE}/openapi.json?tag=pdf`);
    const doc = r.status === 200 ? await r.json() : null;
    const ops = doc ? Object.values(doc.paths).flatMap((p) => Object.values(p)).filter((o) => !fixedIds.has(o.operationId)) : [];
    const cats2 = new Set(ops.flatMap((o) => o.tags || []));
    ok(doc && ops.length > 1 && ops.length < 60 && ops.some((o) => /pdf/.test(o.operationId)) && doc.info?.["x-subset"]?.tag === "pdf", `?tag=pdf answers the tools tagged pdf (${ops.length} ops across ${cats2.size} categories)`);
  }
  const bad = await fetch(`${BASE}/openapi.json?category=no-such-category`);
  const badBody = bad.status === 404 ? await bad.json() : null;
  ok(bad.status === 404 && Array.isArray(badBody?.categories) && badBody.categories.length === cats.length, `an unknown category is a 404 listing the ${cats.length} categories`);
  ok((await fetch(`${BASE}/openapi.json?tag=%3Cscript%3E`)).status === 404, "a value outside the slug alphabet is a 404");
  ok((await fetch(`${BASE}/openapi.json`)).headers.get("etag") !== (await fetch(`${BASE}/openapi.json?category=${cats[0]}`)).headers.get("etag"), "a subset has its own ETag");

  // Markdown catalogs.
  const idx = await fetch(`${BASE}/tools.md`);
  const idxText = await idx.text();
  ok(idx.status === 200 && /markdown/.test(idx.headers.get("content-type") || ""), "/tools.md answers markdown");
  const listed = [...idxText.matchAll(/\/tools\/([a-z0-9-]+)\.md\)/g)].map((m) => m[1]);
  ok(listed.length > 5 && listed.every((c) => cats.includes(c)), `/tools.md links one file per category (${listed.length})`);
  let worst = 0;
  for (const c of listed) {
    const r = await fetch(`${BASE}/tools/${c}.md`);
    const text = await r.text();
    worst = Math.max(worst, Buffer.byteLength(text));
    const want = rows.filter((x) => x.category === c);
    const missing = want.filter((x) => !text.includes(`(${SITE}/tools/${x.slug})`));
    const priced = want.filter((x) => typeof x.price === "string" && !x.quoteRange).every((x) => text.includes(`${x.price}`));
    if (!(r.status === 200 && missing.length === 0 && priced)) ok(false, `/tools/${c}.md lists every tool of the category with its price (${want.length}; missing ${missing.slice(0, 3).map((x) => x.slug).join(", ")})`);
  }
  ok(worst > 0 && worst <= CATEGORY_MD_BUDGET_BYTES, `every category file is within its ${CATEGORY_MD_BUDGET_BYTES}-byte budget (largest ${worst})`);
  ok((await fetch(`${BASE}/tools/no-such-category.md`)).status === 404, "an unknown category file is a 404");
  {
    // A hostile name in the slug alphabet is answered as plain text that echoes no part of it.
    const hostile = "zz-script-alert-1-onerror";
    const r = await fetch(`${BASE}/tools/${hostile}.md`);
    const body = await r.text();
    ok(r.status === 404 && /^text\/plain/.test(r.headers.get("content-type") || "") && r.headers.get("x-content-type-options") === "nosniff" && !body.includes(hostile), "an unknown category file answers plain text that does not echo the requested name");
  }
  ok((await fetch(`${BASE}/tools/hash`)).status === 200, "a tool page still answers at /tools/<slug>");
} catch (e) {
  ok(false, e.stack || e.message);
} finally {
  await srv.stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

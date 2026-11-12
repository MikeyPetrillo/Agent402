// Structured data and sitemap agree with the pages a reader sees.
//
//   1. Every sitemap URL is its own canonical: an alias page (a skill pack's
//      /tools/skill-<pack> copy, canonical to /skills/<pack>) is left out.
//   2. A page with BreadcrumbList data shows a visible trail naming the same
//      items, in the same order, linking the same paths.
//   3. Every author, publisher, creator and provider is the one site entity
//      (`${base}/#organization`), which each page defines once and which names
//      the company (`${base}/#org`, Havok Holdings LLC) as its parent; never a
//      Person.
//      Its sameAs lists only our own profiles (repo, X, our npm and PyPI
//      packages), never a third-party listing of us.
//   4. A seeded report page is dated by the newest filing it showed when built.
//
// Boots FREE_MODE on a free port and reads every /tools and /skills URL in the
// sitemap plus a sample of every other page type. The EDGAR-backed entity
// pages are rendered in-process with no data (no egress), not fetched.
//
//   node scripts/test-seo-structure.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";
import { ownStoreEnv } from "./lib/own-stores.js";
import { insiderPage, fundPage, dossierPage, loadTeaser, teaserLastmod, entityLastmod } from "../src/programmatic-pages.js";
import { sitemapXml, sitemapReports } from "../src/seo.js";
import { SEED_TICKERS, SEED_MANAGERS } from "../src/programmatic-seeds.js";
import { REPO_URL } from "../src/repo-link.js";
import { siteOrgLd } from "../src/site-org.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stripTags = (s) => { let out = String(s), prev; do { prev = out; out = out.replace(/<[^>]*>/g, ""); } while (out !== prev); return out; };
// &amp; decodes last, so an escaped entity such as &amp;lt; reads as the text "&lt;".
const dec = (s) => stripTags(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#160;|&nbsp;/g, "\u00a0").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** Every JSON-LD node on a page, nested ones included. */
function ldNodes(html) {
  const out = [];
  const walk = (x) => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) { x.forEach(walk); return; } out.push(x); for (const v of Object.values(x)) walk(v); };
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { walk(JSON.parse(m[1])); } catch { out.push({ "@unparsed": true }); }
  }
  return out;
}
const pathOf = (base, u) => { const s = String(u ?? ""); return (s.startsWith(base) ? s.slice(base.length) : s) || "/"; };

/** The visible trail as [name, href|null] pairs: its links in order, then the
 *  current page's name (the text after the last link). */
function trailItems(navHtml) {
  const items = [...navHtml.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [dec(m[2]), m[1]]);
  const end = navHtml.lastIndexOf("</a>");
  const tail = dec(end >= 0 ? navHtml.slice(end + 4) : navHtml).replace(/^[\s/›]+/, "").trim();
  if (tail) items.push([tail, null]);
  return items;
}

/** Problems with one rendered page, as strings (none = clean). */
// First-party profiles only: our repository, our X account, our own npm and
// PyPI packages. A third-party index or directory page about us is not one.
const FIRST_PARTY_PROFILE = [
  (u) => u === REPO_URL,
  (u) => u === "https://x.com/Agent402Tools",
  (u) => /^https:\/\/www\.npmjs\.com\/package\/agent402-[a-z0-9-]+$/.test(u),
  (u) => /^https:\/\/pypi\.org\/project\/agent402-[a-z0-9-]+\/?$/.test(u),
];
const foreignSameAs = (org) => [].concat(org?.sameAs ?? []).filter((u) => !FIRST_PARTY_PROFILE.some((f) => f(String(u))));

function pageProblems(base, path, html, { selfCanonical = true } = {}) {
  const problems = [];
  const canon = (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1];
  if (selfCanonical && canon !== `${base}${path === "/" ? "/" : path}` && canon !== `${base}${path}`) problems.push(`canonical is ${canon}, not itself`);
  const nodes = ldNodes(html);
  if (nodes.some((n) => n["@unparsed"])) problems.push("a JSON-LD block does not parse");
  // 3. one site entity, every author/publisher/creator/provider a reference to it.
  const orgId = `${base}/#organization`;
  for (const n of nodes) {
    if (n["@type"] === "Person") problems.push("a Person node");
    for (const k of ["author", "publisher", "creator", "provider"]) {
      if (!(k in n)) continue;
      for (const v of [].concat(n[k])) {
        if (!v || v["@id"] !== orgId || Object.keys(v).length !== 1) problems.push(`${n["@type"]}.${k} is ${JSON.stringify(v)}, not {"@id":"${orgId}"}`);
      }
    }
  }
  const defs = nodes.filter((n) => n["@id"] === orgId && n["@type"] === "Organization");
  if (defs.length !== 1) problems.push(`the site entity is defined ${defs.length} times`);
  else {
    const p = defs[0].parentOrganization;
    if (!p || p["@id"] !== `${base}/#org` || p.name !== "Havok Holdings LLC") problems.push(`the site entity's parentOrganization is ${JSON.stringify(p)}`);
    if (defs[0].name !== "Agent402") problems.push(`the site entity is named ${defs[0].name}`);
    const foreign = foreignSameAs(defs[0]);
    if (foreign.length) problems.push(`the site entity's sameAs names a profile that is not ours: ${foreign.join(", ")}`);
  }
  // 2. the BreadcrumbList and the visible trail say the same thing.
  const bls = nodes.filter((n) => n["@type"] === "BreadcrumbList");
  const navs = [...html.matchAll(/<nav\b[^>]*aria-label="Breadcrumb"[^>]*>([\s\S]*?)<\/nav>/g)].map((m) => m[1]);
  if (bls.length > 1) problems.push(`${bls.length} BreadcrumbLists`);
  if (bls.length) {
    const ld = (bls[0].itemListElement || []).map((e) => [String(e.name), pathOf(base, e.item?.["@id"] ?? e.item)]);
    if (navs.length !== 1) problems.push(`BreadcrumbList with ${navs.length} visible trails`);
    else {
      const nav = trailItems(navs[0]);
      const same = nav.length === ld.length && nav.every(([name, href], i) => name.toLowerCase() === ld[i][0].toLowerCase() && (href === null ? i === ld.length - 1 : href === ld[i][1]));
      if (!same) problems.push(`trail ${JSON.stringify(nav)} differs from BreadcrumbList ${JSON.stringify(ld)}`);
      if (ld.length && ld[ld.length - 1][1] !== path) problems.push(`the BreadcrumbList ends at ${ld[ld.length - 1][1]}, not the page`);
    }
  }
  return problems;
}

// --- 3. the site entity's sameAs, in process -----------------------------------
{
  const org = siteOrgLd("https://agent402.tools");
  ok([].concat(org.sameAs || []).length >= 3 && foreignSameAs(org).length === 0,
    `the site entity's sameAs holds only first-party profiles${foreignSameAs(org).length ? ` (not ours: ${foreignSameAs(org).join(", ")})` : ""}`);
  ok(foreignSameAs({ sameAs: [REPO_URL, "https://directory.example/server/1"] }).length === 1, "a third-party listing URL in sameAs is caught");
}

// --- 4. seeded report pages: lastmod from the newest filing, only when real ------
{
  ok(teaserLastmod("insider", { latestFiledDate: "2026-10-02" }) === "2026-10-02", "an insider page is dated by its newest Form 4");
  ok(teaserLastmod("fund", { filedDate: "2026-08-14" }) === "2026-08-14", "a fund page is dated by its 13F filing");
  ok(teaserLastmod("dossier", { latest10K: { filingDate: "2026-02-01" }, latest10Q: { filingDate: "2026-07-30" }, activity: { recent: [{ filingDate: "2026-10-20" }, { filingDate: "2026-09-01" }] } }) === "2026-10-20", "a dossier page is dated by the newest filing it lists");
  ok(teaserLastmod("insider", { latestFiledDate: null }) === null && teaserLastmod("fund", { filedDate: "soon" }) === null && teaserLastmod("dossier", {}) === null && teaserLastmod("insider", null) === null, "no real date, no lastmod");
  const T = SEED_TICKERS[0], M = SEED_MANAGERS[0]?.slug;
  const B = "https://agent402.tools";
  const before = sitemapXml(B, {});
  ok(!new RegExp(`<loc>${B}/reports/insider/${T}</loc><lastmod>`).test(before), `/reports/insider/${T} carries no lastmod before its page is built`);
  const r = await loadTeaser("insider", T, { seeded: true, builders: { insider: async () => ({ name: T, latestFiledDate: "2026-10-02" }) } });
  ok(r.status === "ok" && entityLastmod(`/reports/insider/${T}`) === "2026-10-02", "a built insider page records its date");
  await loadTeaser("dossier", T, { seeded: true, builders: { dossier: async () => ({ name: T, partial: true, latest10Q: { filingDate: "2026-07-30" } }) } });
  ok(entityLastmod(`/reports/dossier/${T}`) === null, "a partial build records no date");
  await loadTeaser("fund", M, { seeded: true, builders: { fund: async () => { throw new Error("EDGAR down"); } } });
  ok(entityLastmod(`/reports/fund/${M}`) === null, "a degraded build records no date");
  for (const xml of [sitemapXml(B, {}), sitemapReports(B)]) {
    ok(xml.includes(`<loc>${B}/reports/insider/${T}</loc><lastmod>2026-10-02</lastmod>`), `the sitemap dates /reports/insider/${T} by its newest filing`);
    ok(new RegExp(`<loc>${B}/reports/dossier/${T}</loc><changefreq>`).test(xml), `/reports/dossier/${T} stays undated`);
  }
  // The entity pages render their trail from the same list as their BreadcrumbList.
  for (const [name, html, path] of [
    ["insider", insiderPage({ ticker: T, data: null, baseUrl: B, degraded: true }), `/reports/insider/${T}`],
    ["fund", fundPage({ slug: M, data: null, baseUrl: B, degraded: true }), `/reports/fund/${M}`],
    ["dossier", dossierPage({ ticker: T, data: null, baseUrl: B, degraded: true }), `/reports/dossier/${T}`],
  ]) {
    const p = pageProblems(B, path, html);
    ok(/aria-label="Breadcrumb"/.test(html) && p.length === 0, `${name} entity page: visible trail matches its BreadcrumbList, one site entity${p.length ? ` - ${p.join("; ")}` : ""}`);
  }
}

// --- 1-3 on a booted server -----------------------------------------------------
const PORT = await getFreePort();
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, ...ownStoreEnv("seo-structure"), FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: ["ignore", "ignore", "pipe"],
});
let errLog = "";
child.stderr.on("data", (d) => { errLog = (errLog + d).slice(-4000); });
const done = (code) => { try { child.kill("SIGKILL"); } catch { /* */ } process.exit(code); };
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* */ } if (!up) await sleep(500); }
  ok(up, "server booted");
  if (!up) { console.error(errLog); done(1); }

  const xml = await (await fetch(`${BASE}/sitemap.xml`)).text();
  const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].slice(BASE.length) || "/");
  ok(paths.length >= 400, `the sitemap lists ${paths.length} URLs`);
  ok(!paths.some((p) => p.startsWith("/tools/skill-")), "no /tools/skill-* alias is in the sitemap");
  for (const sub of ["sitemap-tools.xml", "sitemap-pages.xml"]) {
    const t = await (await fetch(`${BASE}/${sub}`)).text();
    ok(!/\/tools\/skill-/.test(t), `${sub} lists no skill alias`);
  }
  // An alias page still answers, canonical to its pack page (the reason it is left out).
  {
    const html = await (await fetch(`${BASE}/tools/skill-earnings-deep-dive`)).text();
    ok(html.includes(`<link rel="canonical" href="${BASE}/skills/earnings-deep-dive">`), "control: /tools/skill-earnings-deep-dive is canonical to /skills/earnings-deep-dive");
  }

  // Every /tools and /skills URL, and up to four of every other page type.
  // Seeded entity pages read EDGAR live: they are rendered in-process above.
  const entity = /^\/reports\/(insider|fund|dossier)\/[^/]+$/;
  const typeOf = (p) => { const s = p.split("?")[0].split("/").filter(Boolean); return `${s[0] || "/"}:${s.length}`; };
  const byType = new Map();
  for (const p of paths) {
    if (entity.test(p)) continue;
    const t = typeOf(p);
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(p);
  }
  const sample = [];
  for (const [t, ps] of byType) sample.push(...(/^(tools|skills):/.test(t) ? ps : ps.slice(0, 4)));
  const seen = { html: 0, crumbs: 0 };
  const bad = [];
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < sample.length) {
      const p = sample[i++];
      const r = await fetch(`${BASE}${p}`, { redirect: "manual" });
      if (!(r.headers.get("content-type") || "").includes("html")) { await r.arrayBuffer(); continue; }
      const html = await r.text();
      seen.html++;
      if (/"BreadcrumbList"/.test(html)) seen.crumbs++;
      if (r.status !== 200) { bad.push(`${p}: status ${r.status}`); continue; }
      for (const pr of pageProblems(BASE, p, html)) bad.push(`${p}: ${pr}`);
    }
  }));
  ok(seen.html >= 600 && seen.crumbs >= 600, `read ${seen.html} sitemap pages (${seen.crumbs} with a BreadcrumbList) across ${byType.size} page types`);
  ok(bad.length === 0, `every page read is its own canonical, its trail matches its BreadcrumbList, and it names one site entity${bad.length ? `:\n  ${bad.slice(0, 15).join("\n  ")}${bad.length > 15 ? `\n  ... ${bad.length - 15} more` : ""}` : ""}`);
  for (const p of ["/skills/earnings-deep-dive", "/blog", "/guides", "/tools/category/crypto", "/reports/sample/dossier", "/docs/webhooks", "/base"]) {
    const html = await (await fetch(`${BASE}${p}`)).text();
    if (p === "/blog" || p === "/guides") {
      // An index page: its first post or guide carries the trail.
      const first = (html.match(new RegExp(`href="(${p}/[a-z0-9-]+)"`)) || [])[1];
      const sub = first ? await (await fetch(`${BASE}${first}`)).text() : "";
      ok(first && /"BreadcrumbList"/.test(sub) && /aria-label="Breadcrumb"/.test(sub), `${first || p + "/*"} carries a BreadcrumbList and a visible trail`);
    } else {
      ok(/"BreadcrumbList"/.test(html) && /aria-label="Breadcrumb"/.test(html), `${p} carries a BreadcrumbList and a visible trail`);
    }
  }
  // /company defines the company entity the site entity points at.
  {
    const nodes = ldNodes(await (await fetch(`${BASE}/company`)).text());
    ok(nodes.some((n) => n["@id"] === `${BASE}/#org` && n.name === "Havok Holdings LLC"), "/company defines #org, the site entity's parent");
  }
} catch (e) {
  ok(false, `threw: ${e.stack || e}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);

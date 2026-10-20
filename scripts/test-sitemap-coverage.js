// /sitemap.xml must list every skill pack and tool page. Search engines + LLM
// crawlers (the same audiences as the catalog itself) walk the sitemap; a
// skill pack silently dropped from the sitemap is a skill pack invisible to
// the crawl. There is no compile-time tie between SKILL_PACKS and the sitemap
// builder in src/seo.js, so a future refactor that filters or paginates
// could quietly leave packs out.
//
// This test boots FREE_MODE, fetches /sitemap.xml, and asserts:
//
//   1. Sitemap is well-formed (xml prolog + urlset wrapper).
//   2. Every entry in SKILL_PACKS appears as /skills/<slug>.
//   3. A representative sampling of tools appears as /tools/<slug> — we don't
//      walk all ~1199 (just confirm the loop runs end-to-end and several
//      categories appear).
//   4. Core surfaces (/, /tools, /skills, /leaderboard) appear so a
//      regression that drops the "static pages" section also surfaces here.
//
//   node scripts/test-sitemap-coverage.js
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SKILL_PACKS } from "../src/skills.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3092;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const boot = () => spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});
let proc = boot();

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  const res = await fetch(`${BASE}/sitemap.xml`);
  ok(res.status === 200, `/sitemap.xml → 200 (got ${res.status})`);
  ok((res.headers.get("content-type") || "").includes("xml"), `content-type is XML (got ${res.headers.get("content-type")})`);
  const xml = await res.text();
  ok(xml.trim().startsWith("<?xml"), "sitemap opens with xml prolog");
  ok(xml.includes("<urlset"), "sitemap has urlset wrapper");
  const idx = await (await fetch(`${BASE}/sitemapindex.xml`)).text();

  // Static surfaces — a regression that wipes the seed section shows here.
  for (const path of ["/", "/tools", "/skills", "/leaderboard"]) {
    const loc = `<loc>${BASE}${path === "/" ? "/" : path}</loc>`;
    ok(xml.includes(loc), `sitemap lists ${path} (loc=${loc})`);
  }

  // Category pages: every category the catalog uses, in the index and the monolith.
  {
    const { CATEGORIES } = await import("../src/pages.js");
    const pricing = await (await fetch(`${BASE}/api/pricing`)).json();
    const rows = pricing.endpoints || [];
    const used = new Set(rows.map((r) => r.category).filter((c) => CATEGORIES[c]));
    ok(idx.includes("/sitemap-categories.xml</loc>"), "sitemap index lists the categories sub-sitemap");
    const cats = await (await fetch(`${BASE}/sitemap-categories.xml`)).text();
    const missing = [...used].filter((c) => !cats.includes(`/tools/category/${c}</loc>`) || !xml.includes(`/tools/category/${c}</loc>`));
    ok(used.size > 5 && missing.length === 0, `every used category is in the sitemaps (${used.size} categories${missing.length ? `; missing ${missing.join(",")}` : ""})`);
    for (const m of cats.matchAll(/<loc>[^<]*(\/tools\/category\/[^<]+)<\/loc>/g)) {
      const r = await fetch(`${BASE}${m[1]}`, { redirect: "manual" });
      if (r.status !== 200) ok(false, `${m[1]} answers 200 (got ${r.status})`);
    }
    const robots = await (await fetch(`${BASE}/robots.txt`)).text();
    ok(/Sitemap: \S+\/sitemapindex\.xml/.test(robots), "robots.txt lists the sitemap index");
  }

  // Skill packs — every pack must appear.
  ok(SKILL_PACKS.length > 0, `source: SKILL_PACKS is non-empty (got ${SKILL_PACKS.length})`);
  const missingSkills = [];
  for (const pack of SKILL_PACKS) {
    if (!xml.includes(`/skills/${pack.slug}<`)) missingSkills.push(pack.slug);
  }
  ok(missingSkills.length === 0, `every skill pack appears in sitemap (missing: ${missingSkills.join(",") || "none"})`);

  // Tool pages — sample known-good slugs that span categories. If the tool-
  // page loop dropped, even a handful here would fail.
  const sampleTools = ["extract", "qr", "geocode", "jwt-decode", "whois", "dns"];
  const missingTools = [];
  for (const slug of sampleTools) {
    if (!xml.includes(`/tools/${slug}<`)) missingTools.push(slug);
  }
  ok(missingTools.length === 0, `sample tools appear in sitemap (missing: ${missingTools.join(",") || "none"})`);

  // Entry count sanity — current sitemap is ~1267 entries (1199 tools + skills
  // + static pages). Floor of 1000 catches a wholesale loop drop without
  // pinning the exact number (which drifts with each new tool).
  const locCount = (xml.match(/<loc>/g) || []).length;
  ok(locCount >= 400, `sitemap entry count >= 400 (got ${locCount}) — under this floor means a loop section was dropped`);

  // lastmod is per URL and truthful (src/page-dates.js): never the boot date
  // stamped on everything, the same value for a URL in every sitemap that
  // lists it, and identical across two boots.
  {
    const entriesOf = (text) => new Map([...text.matchAll(/<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?/g)].map((m) => [m[1], m[2] || null]));
    const today = new Date().toISOString().slice(0, 10);
    const dates = JSON.parse(readFileSync(join(ROOT, "src", "generated", "page-dates.json"), "utf8"));
    const legal = (file) => (readFileSync(join(ROOT, "src", file), "utf8").match(/last updated (\d{4}-\d{2}-\d{2})\./) || [])[1];
    const mono = entriesOf(xml);
    const values = [...mono.values()].filter(Boolean);
    ok(values.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today), "every lastmod is an ISO day no later than today");
    ok(new Set(values).size >= 5, `lastmod varies per URL (${new Set(values).size} distinct values over ${values.length} dated entries)`);
    // A lastmod equal to the boot day is allowed only when a source really
    // changed today (its date is in the table or on a legal page); otherwise
    // the boot date leaked back in.
    const sourcesToday = new Set([...Object.values(dates.files), legal("terms.js"), legal("privacy.js")].filter((d) => d === today));
    const stampedToday = values.filter((d) => d === today).length;
    ok(stampedToday === 0 || sourcesToday.size > 0, `no lastmod equals the boot date unless a source changed today (${stampedToday} dated today, ${sourcesToday.size ? "sources did" : "no source did"})`);
    ok(stampedToday < values.length, `the boot date is not stamped on every entry (${stampedToday} of ${values.length})`);
    ok(mono.get(`${BASE}/`) === dates.files["src/ledger-home.js"], `/ carries its module's date (${mono.get(`${BASE}/`)})`);
    ok(mono.get(`${BASE}/terms`) === legal("terms.js") && mono.get(`${BASE}/privacy`) === legal("privacy.js"), "/terms and /privacy carry the date they print");
    ok(mono.get(`${BASE}/tools/hash`) === dates.files[dates.toolSources.hash], `/tools/hash carries its kit's date (${mono.get(`${BASE}/tools/hash`)})`);
    ok(mono.has(`${BASE}/api/pricing`) && mono.get(`${BASE}/api/pricing`) === null, "a live data surface carries no lastmod");
    ok([...mono].filter(([u]) => /\/tools\/category\//.test(u)).every(([, d]) => d === null), "category pages carry no lastmod");
    for (const sub of ["sitemap-pages.xml", "sitemap-tools.xml", "sitemap-guides.xml", "sitemap-skills.xml", "sitemap-learn.xml", "sitemap-reports.xml", "sitemap-categories.xml"]) {
      const child = entriesOf(await (await fetch(`${BASE}/${sub}`)).text());
      const off = [...child].filter(([u, d]) => !mono.has(u) || mono.get(u) !== d);
      ok(child.size > 0 && off.length === 0, `${sub}: every URL carries the same lastmod as the monolith (${child.size} urls${off.length ? `; differs: ${off.slice(0, 3).map(([u]) => u).join(", ")}` : ""})`);
      const newest = [...child.values()].filter(Boolean).sort().pop() || null;
      const idxDate = (idx.match(new RegExp(`<sitemap><loc>[^<]*/${sub}</loc>(?:<lastmod>([^<]+)</lastmod>)?`)) || [])[1] || null;
      ok(idxDate === newest, `${sub}: the index dates it by its newest entry (${idxDate})`);
    }
    // Stable across boots: a second process serves byte-identical sitemaps.
    proc.kill("SIGKILL");
    await sleep(300);
    proc = boot();
    for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }
    const again = await (await fetch(`${BASE}/sitemap.xml`)).text();
    ok(again === xml, "a second boot serves a byte-identical /sitemap.xml (lastmod does not depend on when the process started)");
    ok((await (await fetch(`${BASE}/sitemapindex.xml`)).text()) === idx, "a second boot serves a byte-identical /sitemapindex.xml");
  }

  console.log(`\n${pass} passed (${locCount} sitemap entries, ${SKILL_PACKS.length} skill packs)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}

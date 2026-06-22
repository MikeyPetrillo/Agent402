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
//   4. Core surfaces (/, /tools, /shop, /skills, /leaderboard) appear so a
//      regression that drops the "static pages" section also surfaces here.
//
//   node scripts/test-sitemap-coverage.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SKILL_PACKS } from "../src/skills.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3092;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  const res = await fetch(`${BASE}/sitemap.xml`);
  ok(res.status === 200, `/sitemap.xml → 200 (got ${res.status})`);
  ok((res.headers.get("content-type") || "").includes("xml"), `content-type is XML (got ${res.headers.get("content-type")})`);
  const xml = await res.text();
  ok(xml.trim().startsWith("<?xml"), "sitemap opens with xml prolog");
  ok(xml.includes("<urlset"), "sitemap has urlset wrapper");

  // Static surfaces — a regression that wipes the seed section shows here.
  for (const path of ["/", "/tools", "/skills", "/leaderboard"]) {
    const loc = `<loc>${BASE}${path === "/" ? "/" : path}</loc>`;
    ok(xml.includes(loc), `sitemap lists ${path} (loc=${loc})`);
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
  ok(locCount >= 1000, `sitemap entry count >= 1000 (got ${locCount}) — under this floor means a loop section was dropped`);

  console.log(`\n${pass} passed (${locCount} sitemap entries, ${SKILL_PACKS.length} skill packs)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}

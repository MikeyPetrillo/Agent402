// Tool pages (/tools/<slug>) backlink to the skill packs that include the tool.
// An agent landing on extract or whois sees the broader workflows it slots
// into — e.g. extract → structured-scrape / fraud-signals / content-extraction —
// not just the atomic tool description.
//
// The backlink section is rendered conditionally inside toolPage()
// (src/pages.js:222) and is easy to silently drop in a future refactor — there
// is no compile-time tie between SKILL_PACKS.toolSlugs and the rendered HTML.
// This test boots a FREE_MODE server, fetches a tool page that is provably in
// multiple packs, and asserts:
//
//   1. The "Part of these workflows" section is present.
//   2. Each pack the source-of-truth (SKILL_PACKS) says includes the tool has
//      a backlink to /skills/<pack-slug>.
//   3. A tool that is in *zero* packs renders no backlink section — so a
//      refactor that accidentally always-renders the section also fails here.
//
//   node scripts/test-tool-page-backlinks.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SKILL_PACKS } from "../src/skills.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3095;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); proc.kill("SIGKILL"); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

const packsContaining = (slug) =>
  SKILL_PACKS.filter((p) => (p.toolSlugs || []).includes(slug)).map((p) => p.slug);

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  // extract is widely re-used across workflows. If this list ever shrinks to
  // <2 packs, swap to another well-covered tool — but extract being in many
  // packs is a deliberate cross-cutting property of the catalog, so a single-
  // pack future would itself be a regression signal.
  const TOOL = "extract";
  const expectedPacks = packsContaining(TOOL);
  ok(expectedPacks.length >= 2, `source: ${TOOL} is in >=2 skill packs (got ${expectedPacks.length}: ${expectedPacks.join(",")})`);

  const html = await (await fetch(`${BASE}/tools/${TOOL}`)).text();
  ok(html.includes("Part of these workflows"), `/tools/${TOOL} renders the backlink section header`);

  // Every pack the source-of-truth says includes this tool must have a link in
  // the rendered HTML. A future refactor that filters out some packs (e.g. by
  // hidden flag) without touching the source list would fail here.
  for (const slug of expectedPacks) {
    ok(html.includes(`href="/skills/${slug}"`), `/tools/${TOOL} backlinks to /skills/${slug}`);
  }

  // Negative case: a tool in zero packs must not render the section at all.
  // Pick a slug that's almost certainly tied to no workflow — `hello-world`
  // doesn't exist, so let's find a real one with zero matches.
  const candidates = ["x402-quote", "uuid-validate", "gas-estimate"];
  const orphan = candidates.find((s) => packsContaining(s).length === 0);
  ok(orphan, `source: at least one zero-pack tool exists for the negative test (candidates: ${candidates.join(",")})`);
  if (orphan) {
    const orphanHtml = await (await fetch(`${BASE}/tools/${orphan}`)).text();
    ok(!orphanHtml.includes("Part of these workflows"), `/tools/${orphan} has no workflow section (in zero packs)`);
  }

  console.log(`\n${pass} passed`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}

// /skills/<slug> renders a pack's full workflow contract: title, tagline, use
// case, every workflow step text, every tool in the pack (each linked to its
// /tools/<slug> page with name + price + route), the installable npx command,
// and the copy-paste claudePrompt. This is the page an agent maintainer lands
// on after `/api/find` recommends a pack — if any section is silently dropped
// in a future refactor (template change, conditional that filters by some
// flag, accidental slice), the pack becomes unusable from the browser even
// though /api/skill-packs.json still serves it.
//
// This test boots FREE_MODE, walks every SKILL_PACKS entry, fetches
// /skills/<slug>, and asserts the rendered HTML carries:
//
//   1. Title + tagline + useCase strings (from the source pack).
//   2. Every workflow step text appears (escaped). A future refactor that
//      truncates the workflow list (e.g. only renders the first 3 steps)
//      shows here as a missing step.
//   3. Every toolSlug appears linked to /tools/<slug>.
//   4. The install command + claudePrompt copy box are present (the actionable
//      payoff of the page).
//   5. JSON-LD HowTo block is present — search/LLM crawlers consume it.
//
// We also assert a negative: /skills/<unknown-slug> returns 404, so a future
// refactor that always-renders an empty pack page also fails here.
//
//   node scripts/test-skill-page-contract.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SKILL_PACKS } from "../src/skills.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3091;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirror src/skills.js esc(): escape &, <, >, " — apostrophes are passed
// through verbatim because the render output uses double-quoted attributes.
// Re-implemented here (instead of imported) so the test stays self-contained,
// and so a future divergence in escape behavior surfaces as a test failure on
// the first pack that has any of these characters in a rendered string.
const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  ok(SKILL_PACKS.length > 0, `source: SKILL_PACKS is non-empty (${SKILL_PACKS.length} packs)`);

  // Walk every pack — render contract should hold for all of them. If one
  // breaks (e.g. a missing field or a bad esc on some specific string), it
  // surfaces by name.
  let perPackPass = 0;
  for (const pack of SKILL_PACKS) {
    const res = await fetch(`${BASE}/skills/${pack.slug}`);
    if (res.status !== 200) { fail(`/skills/${pack.slug} → ${res.status}`); break; }
    const html = await res.text();

    if (!html.includes(esc(pack.title))) { fail(`/skills/${pack.slug} missing title (${pack.title})`); break; }
    if (!html.includes(esc(pack.tagline))) { fail(`/skills/${pack.slug} missing tagline`); break; }
    if (!html.includes(esc(pack.useCase))) { fail(`/skills/${pack.slug} missing useCase`); break; }

    // Every workflow step text must appear (esc-encoded). The renderer iterates
    // pack.workflow into <li> entries; a future slice/filter regression surfaces here.
    for (const step of pack.workflow) {
      if (!html.includes(esc(step))) { fail(`/skills/${pack.slug} missing workflow step: ${step.slice(0, 80)}`); break; }
    }

    // Every tool the pack lists must be linked to its tool page.
    for (const slug of pack.toolSlugs) {
      if (!html.includes(`href="/tools/${esc(slug)}"`)) { fail(`/skills/${pack.slug} missing tool link to /tools/${slug}`); break; }
    }

    if (!html.includes("claude mcp add agent402")) { fail(`/skills/${pack.slug} missing install command`); break; }
    if (!html.includes(esc(pack.claudePrompt))) { fail(`/skills/${pack.slug} missing claudePrompt copy box`); break; }
    if (!html.includes("application/ld+json") || !html.includes('"HowTo"')) { fail(`/skills/${pack.slug} missing JSON-LD HowTo`); break; }

    perPackPass++;
  }
  ok(perPackPass === SKILL_PACKS.length, `every skill pack renders the full contract (${perPackPass}/${SKILL_PACKS.length})`);

  // Negative: an unknown slug must 404, not render an empty pack. A regression
  // that defaults to rendering the first pack (or an empty shell) would
  // silently degrade the page; this guards it.
  const unknown = await fetch(`${BASE}/skills/this-pack-does-not-exist-zzz`);
  ok(unknown.status === 404, `/skills/<unknown> → 404 (got ${unknown.status})`);

  console.log(`\n${pass} passed (walked ${SKILL_PACKS.length} packs)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}

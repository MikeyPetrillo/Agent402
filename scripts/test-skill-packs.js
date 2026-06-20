// Skill-pack invariants — guards against the silent failure mode where a pack
// references a tool slug that's been renamed or removed from the catalog. When
// that happens the HTML page shows "tool not currently in catalog" and the MCP
// prompt instructs the agent to call_tool a slug that 404s — neither of which
// breaks at boot time. This test catches the drift in CI.
//
// Boots a FREE_MODE server (same pattern as scripts/test-all.js), pulls
// /api/pricing for the live slug truth, then asserts every pack's toolSlugs
// resolve, required fields are present, substitution actually substitutes,
// and prompt rendering succeeds end-to-end.
//
//   node scripts/test-skill-packs.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SKILL_PACKS, buildPromptMessages } from "../src/skills.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3098;
const BASE = `http://localhost:${PORT}`;

const fail = (m) => { console.error("FAIL:", m); proc.kill("SIGKILL"); process.exit(1); };
let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  // 1. Live catalog slug truth.
  const pricing = await fetch(`${BASE}/api/pricing`).then((r) => r.json());
  const catalogSlugs = new Set((pricing.endpoints || []).map((e) => e.slug));
  ok(catalogSlugs.size > 100, `catalog has >100 slugs (got ${catalogSlugs.size})`);

  // 2. Every pack has the required public shape.
  for (const pack of SKILL_PACKS) {
    ok(typeof pack.slug === "string" && /^[a-z0-9-]+$/.test(pack.slug), `${pack.slug}: slug is kebab-case`);
    ok(pack.title && pack.tagline && pack.useCase, `${pack.slug}: title/tagline/useCase present`);
    ok(Array.isArray(pack.toolSlugs) && pack.toolSlugs.length >= 3, `${pack.slug}: >=3 toolSlugs`);
    ok(Array.isArray(pack.workflow) && pack.workflow.length >= 3, `${pack.slug}: >=3 workflow steps`);
    ok(typeof pack.claudePrompt === "string" && pack.claudePrompt.length > 50, `${pack.slug}: claudePrompt non-trivial`);
    ok(Array.isArray(pack.promptArgs), `${pack.slug}: promptArgs is an array (possibly empty)`);
  }

  // 3. Every toolSlug must resolve in the live catalog — the bug class this test
  // exists to catch. A rename or deletion would make a pack silently degrade.
  for (const pack of SKILL_PACKS) {
    const missing = pack.toolSlugs.filter((s) => !catalogSlugs.has(s));
    ok(missing.length === 0, `${pack.slug}: every tool slug resolves in catalog (missing: ${missing.join(", ") || "none"})`);
  }

  // 4. Substitute strings must actually appear in the prompt body, otherwise the
  // arg passes silently with no effect — a worse UX than failing loudly. The
  // crypto-research pack hit this exact class of bug pre-commit (the substitute
  // string "BTC" appeared in a metric name "BTC dominance" that shouldn't have
  // been substituted) — assert at minimum the substitution touches *something*.
  for (const pack of SKILL_PACKS) {
    for (const arg of pack.promptArgs || []) {
      if (!arg.substitute) continue;
      ok(
        pack.claudePrompt.includes(arg.substitute) || pack.useCase.includes(arg.substitute),
        `${pack.slug}.${arg.name}: substitute "${arg.substitute}" appears in claudePrompt or useCase`
      );
    }
  }

  // 5. buildPromptMessages renders without throwing for every pack (with no
  // freeSlugs context — same path the HTTP /api/skill-packs/<slug>/prompt route
  // takes when no per-session freeSlugs filter is available).
  for (const pack of SKILL_PACKS) {
    let rendered;
    try { rendered = buildPromptMessages(pack, {}, {}); }
    catch (e) { fail(`${pack.slug}: buildPromptMessages threw — ${e.message}`); }
    ok(rendered?.messages?.[0]?.content?.text?.length > 100, `${pack.slug}: renders a non-trivial prompt`);
  }

  // 6. End-to-end: hit /api/skill-packs/<slug>/prompt with the first required
  // arg to confirm substitution flows through the HTTP path the SDK + MCP both
  // use. Pick one canonical example value per arg so the test is deterministic.
  const examples = { domain: "stripe.com", ticker: "AAPL", coin: "ETH", urls: "https://example.com" };
  for (const pack of SKILL_PACKS) {
    const required = (pack.promptArgs || []).filter((a) => a.required !== false);
    if (!required.length) continue; // packs without args (macro-economics) skip this assertion
    const qs = new URLSearchParams(required.map((a) => [a.name, examples[a.name] || "test"])).toString();
    const r = await fetch(`${BASE}/api/skill-packs/${pack.slug}/prompt?${qs}`);
    ok(r.ok, `${pack.slug}: HTTP /prompt returns 200 with ${qs}`);
    const j = await r.json();
    const text = j.messages?.[0]?.content?.text || "";
    // Each required arg's value should appear in the rendered text — proves the
    // substitution chain (route → buildPromptMessages → response) is intact.
    for (const a of required) {
      const v = examples[a.name] || "test";
      ok(text.includes(v), `${pack.slug}: rendered text includes ${a.name}=${v}`);
    }
  }

  console.log(`\n${pass} passed`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}

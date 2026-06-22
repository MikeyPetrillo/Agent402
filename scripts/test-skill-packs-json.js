// /api/skill-packs.json is the machine-readable surface the stdio
// agent402-mcp npm package fetches at startup to register its prompts
// (per src/skills.js:1708 — `skillPacksJson()`). It deliberately strips
// internal-only fields like `substitute` (a render hint) and exposes only
// the public schema the npm package + any MCP client consumes.
//
// If this shape drifts — a renamed field, a dropped key, a type change —
// every installed copy of agent402-mcp@latest silently breaks the next
// time it boots. There is no tie between this code path and a regression
// test today.
//
// This test boots FREE_MODE and locks:
//
//   1. Top-level envelope is `{ packs: [...] }` — one stable key.
//   2. Pack count matches SKILL_PACKS (the source-of-truth). A regression
//      that filters packs out before serving would surface here.
//   3. Every pack carries the exact public-schema keys: slug, title,
//      tagline, useCase, toolSlugs[], workflow[], claudePrompt, promptArgs[].
//   4. Internal-only `substitute` is NOT exposed (it's a render hint
//      meant for the HTML page; the MCP client doesn't need it).
//   5. Per-pack invariants hold across all 39 packs: toolSlugs is non-empty
//      array, workflow is non-empty array, claudePrompt is a non-empty string.
//   6. promptArgs entries carry exactly { name, description, required } —
//      and `required` is always a boolean (defaulted at server-side; MCP
//      schema needs it).
//
//   node scripts/test-skill-packs-json.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SKILL_PACKS } from "../src/skills.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3086;
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

  const res = await fetch(`${BASE}/api/skill-packs.json`);
  ok(res.status === 200, `/api/skill-packs.json → 200 (got ${res.status})`);
  ok((res.headers.get("content-type") || "").includes("application/json"), `content-type is application/json (got ${res.headers.get("content-type")})`);
  const body = await res.json();

  // Envelope.
  ok(Array.isArray(body.packs), "envelope is { packs: [...] }");
  ok(body.packs.length === SKILL_PACKS.length, `pack count matches SKILL_PACKS (served=${body.packs.length}, source=${SKILL_PACKS.length}) — filtering regression surfaces here`);

  // Public schema keys — exactly these, no more no less in terms of what npm
  // package consumers can rely on. We assert "all present" + "no internal-only".
  const EXPECTED_KEYS = ["slug", "title", "tagline", "useCase", "toolSlugs", "workflow", "claudePrompt", "promptArgs"];
  const INTERNAL_KEYS = ["substitute"]; // render hint; must not leak

  let perPackOk = 0;
  for (const pack of body.packs) {
    for (const k of EXPECTED_KEYS) {
      if (!(k in pack)) { fail(`pack '${pack.slug}' missing ${k} (got keys: ${Object.keys(pack).join(",")})`); break; }
    }
    if (!Array.isArray(pack.toolSlugs) || pack.toolSlugs.length === 0) { fail(`pack '${pack.slug}' toolSlugs is not a non-empty array`); break; }
    if (!Array.isArray(pack.workflow) || pack.workflow.length === 0) { fail(`pack '${pack.slug}' workflow is not a non-empty array`); break; }
    if (typeof pack.claudePrompt !== "string" || pack.claudePrompt.length === 0) { fail(`pack '${pack.slug}' claudePrompt is not a non-empty string`); break; }

    // promptArgs entries — MCP client reads { name, description, required:boolean }
    if (!Array.isArray(pack.promptArgs)) { fail(`pack '${pack.slug}' promptArgs is not an array`); break; }
    for (const arg of pack.promptArgs) {
      if (typeof arg.name !== "string") { fail(`pack '${pack.slug}' promptArg.name is not string (got ${typeof arg.name})`); break; }
      if (typeof arg.description !== "string") { fail(`pack '${pack.slug}' promptArg.description is not string (got ${typeof arg.description})`); break; }
      if (typeof arg.required !== "boolean") { fail(`pack '${pack.slug}' promptArg.required is not boolean (got ${typeof arg.required}) — MCP schema requires boolean`); break; }
      // Internal-only fields must not leak. substitute is a render hint for
      // the HTML page only; the npm package doesn't need it.
      for (const k of INTERNAL_KEYS) {
        if (k in arg) { fail(`pack '${pack.slug}' promptArg leaked internal-only key '${k}'`); break; }
      }
    }

    perPackOk++;
  }
  ok(perPackOk === body.packs.length, `every pack (${perPackOk}/${body.packs.length}) has the full public schema and no internal-only leaks`);

  // Cross-check: at least one pack in the source DOES carry `substitute` on a
  // promptArg, so the "we strip it" assertion above is meaningful (not vacuous
  // because nothing in the source has substitute). If no pack ever has
  // substitute, this test would pass even if the stripping logic broke.
  const sourceHasSubstitute = SKILL_PACKS.some((p) => (p.promptArgs || []).some((a) => "substitute" in a));
  ok(sourceHasSubstitute, "source: at least one SKILL_PACKS pack has a promptArg with `substitute` (so the strip-test is non-vacuous)");

  console.log(`\n${pass} passed (${body.packs.length} packs)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}

// A live skill pack's copy must not send a reader to a retired pack. Three
// pack pages recommended investment-decision, savings-goal, rag-prep and
// webhook-debug for weeks after each answered 410 (truth audit 2026-10-02):
// the retirement guard checks the catalog, never the prose about it.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { SKILL_PACKS, packPageCopy } from "../src/skills.js";
import { RETIRED_PACKS, RETIRED_TOOLS } from "../src/retired-tools.js";
import { PACK_STEPS } from "../src/tools/skill-runner.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const retired = Object.keys(RETIRED_PACKS);
const re = new RegExp(`(?<![\\w-])(${retired.map((s) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|")})(?![\\w-])`);
ok(re.test("Pairs with rag-prep when needed") && !re.test("Pairs with rag-prepared docs"), "control: a retired slug is found as a whole word and not inside a longer one");
const hits = [];
for (const p of SKILL_PACKS) {
  const text = JSON.stringify({ ...p, slug: undefined, toolSlugs: undefined, page: packPageCopy(p) });
  const m = text.match(re);
  if (m) hits.push(`${p.slug} names retired pack "${m[1]}"`);
}
ok(hits.length === 0, `no live pack's copy names a retired pack${hits.length ? ` - ${hits.join("; ")}` : ""}`);
// No pack runs or names a retired TOOL either: every step a pack lists
// (toolSlugs) and every step its runner calls (PACK_STEPS) is a live tool, and
// its copy does not name a retired tool by slug. Plain-word slugs (market,
// stablecoins) are read only as steps, since prose uses the word.
{
  const tools = new Set(Object.keys(RETIRED_TOOLS));
  const steps = [];
  for (const p of SKILL_PACKS) for (const s of p.toolSlugs || []) if (tools.has(s)) steps.push(`${p.slug} lists ${s}`);
  for (const [slug, def] of Object.entries(PACK_STEPS)) for (const st of def?.steps || []) if (tools.has(st?.slug)) steps.push(`${slug} runs ${st.slug}`);
  ok(steps.length === 0, `no pack step calls a retired tool${steps.length ? ` - ${steps.join("; ")}` : ""}`);
  const named = [...tools].filter((s) => s.includes("-"));
  const reTool = new RegExp(`(?<![\\w-])(${named.map((s) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|")})(?![\\w-])`);
  ok(reTool.test("then call sol-swap-quote") && !reTool.test("call sol-swap-quotes-live"), "control: a retired tool slug is found as a whole word");
  const prose = [];
  for (const p of SKILL_PACKS) {
    const m = JSON.stringify({ ...p, slug: undefined, toolSlugs: undefined, page: packPageCopy(p) }).match(reTool);
    if (m) prose.push(`${p.slug} names retired tool "${m[1]}"`);
  }
  ok(prose.length === 0, `no live pack's copy names a retired tool${prose.length ? ` - ${prose.join("; ")}` : ""}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

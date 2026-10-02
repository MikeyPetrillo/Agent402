// A live skill pack's copy must not send a reader to a retired pack. Three
// pack pages recommended investment-decision, savings-goal, rag-prep and
// webhook-debug for weeks after each answered 410 (truth audit 2026-10-02):
// the retirement guard checks the catalog, never the prose about it.
import { SKILL_PACKS } from "../src/skills.js";
import { RETIRED_PACKS } from "../src/retired-tools.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const retired = Object.keys(RETIRED_PACKS);
const re = new RegExp(`(?<![\\w-])(${retired.map((s) => s.replace(/[-]/g, "\\-")).join("|")})(?![\\w-])`);
ok(re.test("Pairs with rag-prep when needed") && !re.test("Pairs with rag-prepared docs"), "control: a retired slug is found as a whole word and not inside a longer one");
const hits = [];
for (const p of SKILL_PACKS) {
  const text = JSON.stringify({ ...p, slug: undefined, toolSlugs: undefined });
  const m = text.match(re);
  if (m) hits.push(`${p.slug} names retired pack "${m[1]}"`);
}
ok(hits.length === 0, `no live pack's copy names a retired pack${hits.length ? ` - ${hits.join("; ")}` : ""}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

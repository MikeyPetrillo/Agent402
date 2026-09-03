// /SKILL.md guard - the agent-onboarding sheet (offline, no server).
//
// Pins the shape runtimes match on (YAML frontmatter with name + description,
// the section order of the Agent Skills convention), that every route it
// tells an agent to call is a real catalog/free route (a SKILL.md that names
// a dead route is the exact class test-mcp-self-consistency exists for, on
// the one surface that test does not read), and the house style (no em
// dashes, evergreen count in prose, exact counts only where derived).
import { skillMd } from "../src/skill-md.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const catalog = {
  "POST /api/hash": { route: "POST /api/hash", slug: "hash", category: "crypto", price: "$0.001", description: "Hash text", tags: [], discovery: {}, handler: () => ({}) },
  "POST /api/extract": { route: "POST /api/extract", slug: "extract", category: "web", price: "$0.005", description: "Extract", tags: [], discovery: {}, handler: () => ({}) },
};
const md = skillMd("https://agent402.tools", catalog);

ok(md.startsWith("---\nname: agent402\ndescription: >\n"), "starts with YAML frontmatter carrying name + folded description");
ok(/\n---\n\n# agent402\n/.test(md), "frontmatter closes and the H1 is the skill name");
const sections = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
const expected = ["What I can accomplish", "Required inputs", "Documentation links", "Setup", "After Setup", "Use Services", "Common Issues"];
ok(JSON.stringify(sections) === JSON.stringify(expected), `H2 sections in the Agent Skills order (got ${JSON.stringify(sections)})`);
for (const h3 of ["Setup Rules", "Request Templates", "Response Handling", "Rules"]) ok(md.includes(`### ${h3}`), `has ### ${h3}`);
ok(!md.includes("—"), "no em dashes (house style)");
ok(md.includes("500+"), "evergreen '500+' claim in prose");
ok(md.includes("Call any of 2 tools ("), "exact tool count is derived from the catalog, not hand-typed");
ok(md.includes("curl -fsSL https://agent402.tools/SKILL.md"), "tells a summarizing fetcher how to read it verbatim");
ok(md.includes("npx -y agent402-mcp") && md.includes("npm install agent402-client"), "names both packages");
ok(md.includes("X-Pow-Solution: <token>:<nonce>") && /hash the `challenge`, submit the `token`/i.test(md), "PoW instructions carry the two-field trap");
ok(/Idempotency-Key/.test(md), "retry guidance names Idempotency-Key");
ok(!/(sk-|0x[0-9a-f]{40,})/i.test(md.replace(/0x\.\.\./g, "")), "no key-shaped strings");
// Every /api or /v1 path the sheet tells an agent to call must be a route the
// server registers (source scan, same oracle shape as test-mcp-self-consistency).
const fs = await import("node:fs");
const path = await import("node:path");
const srcDir = new URL("../src/", import.meta.url);
const files = [];
for (const dir of [srcDir, new URL("../src/tools/", import.meta.url)]) for (const f of fs.readdirSync(dir)) if (f.endsWith(".js")) files.push(fs.readFileSync(new URL(f, dir), "utf8"));
const src = files.join("\n");
const registered = new Set([
  ...[...src.matchAll(/app\.(?:get|post|all)\(\s*"([^"]+)"/g)].map((m) => m[1]),
  ...[...src.matchAll(/route:\s*"(?:GET|POST) ([^"]+)"/g)].map((m) => m[1]),
  // template-literal routes (route-execute tiers, skill packs): the literal prefix before the first ${...}
  ...[...src.matchAll(/route(?::|\s*=)\s*`(?:GET|POST) ([^`$]+)\$\{/g)].map((m) => m[1] + "*"),
]);
for (const k of Object.keys(catalog)) registered.add(k.split(" ")[1]);
// A referenced path is satisfied by an exact route or by being a path PREFIX
// of one (tier prefixes like /v1/base, families like /api/skill/<slug>).
const satisfied = (p) => {
  const pre = p.endsWith("/") ? p : p + "/";
  return registered.has(p) || [...registered].some((r) => r.startsWith(pre) || (r.endsWith("*") && p.startsWith(r.slice(0, -1))));
};
const referenced = [...new Set([...md.matchAll(/(?:https:\/\/agent402\.tools)?(\/(?:api|v1)\/[a-z0-9\/_-]+)/g)].map((m) => m[1]))];
const missing = referenced.filter((p) => !satisfied(p));
void path;
ok(missing.length === 0, `every /api and /v1 path named in SKILL.md is a registered route (missing: ${JSON.stringify(missing)})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

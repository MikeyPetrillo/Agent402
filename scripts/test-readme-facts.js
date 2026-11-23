// Facts the README and the wiki state by hand, held to their source (offline):
//   - every "N+ skill packs" / "N+ multi-tool" claim is the floor sync-count.js
//     enforces (PACK_BRAND_FLOOR);
//   - every agent report range is REPORT_TIERS' range, and the IPO digest's
//     price is the ipo-report kit's;
//   - the README's Decide section names the two settings the main server
//     needs to serve /api/decide (the ones src/tools/decide-kit.js reads);
//   - the wiki Home "Start here" table links the pages a reader starts from,
//     and every wiki page is linked from the sidebar or Home;
//   - Self-Hosting's PAYMENT_NETWORKS example names every rail in src/rails.js;
//   - README, the wiki sidebar, Self-Hosting and CONTRIBUTING link the
//     configuration reference and .env.example.
// The README's /v1 table is held to the served catalog by test-docs-truth.js.
//
//   node scripts/test-readme-facts.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACK_BRAND_FLOOR } from "./sync-count.js";
import { agentReportPriceRange } from "../src/report-tiers.js";
import { IPO_TIERS } from "../src/tools/ipo-report-kit.js";
import { RAILS, railKey } from "../src/rails.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const surfaces = ["README.md", "package.json", "llms-install.md", ...readdirSync(join(ROOT, "wiki")).filter((f) => f.endsWith(".md")).map((f) => `wiki/${f}`),
  ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`), "mcp/README.md", "client/README.md"];
const texts = surfaces.map((f) => { try { return [f, read(f)]; } catch { return null; } }).filter(Boolean);

// --- pack count ---
const PACK_CLAIM = /\b(\d+)\+ (?:curated )?(?:multi-tool )?(?:skill packs|multi-tool (?:workflows|skill packs))\b/gi;
const packClaims = texts.flatMap(([f, t]) => [...t.matchAll(PACK_CLAIM)].map((m) => [f, Number(m[1])]));
ok(packClaims.length >= 5, `the pack claim is read on several surfaces (${packClaims.length})`);
const wrongPacks = packClaims.filter(([, n]) => n !== PACK_BRAND_FLOOR);
ok(wrongPacks.length === 0, `every skill-pack claim says ${PACK_BRAND_FLOOR}+, the floor sync-count.js enforces${wrongPacks.length ? `: ${wrongPacks.map(([f, n]) => `${f} ${n}+`).join(", ")}` : ""}`);
ok([..."some 70+ skill packs".matchAll(PACK_CLAIM)].length === 1, "control: a stale claim is read");

// --- report range ---
const r = agentReportPriceRange();
const fmt = (n) => `$${n.toFixed(2)}`;
const RANGE = /(\$\d+\.\d{2}) to (\$\d+\.\d{2})(?= (?:per report over x402|that\s+(?:>\s*)?way))/g;
const ranges = texts.flatMap(([f, t]) => [...t.matchAll(RANGE)].map((m) => [f, m[1], m[2]]));
ok(ranges.length >= 2, `the agent report range is read on the README and wiki (${ranges.length})`);
const wrongRanges = ranges.filter(([, a, b]) => a !== fmt(r.min) || b !== fmt(r.max));
ok(wrongRanges.length === 0, `every agent report range is ${fmt(r.min)} to ${fmt(r.max)} (REPORT_TIERS)${wrongRanges.length ? `: ${wrongRanges.map((x) => x.join(" ")).join("; ")}` : ""}`);
const ipo = texts.flatMap(([f, t]) => [...t.matchAll(/\((\$\d+\.\d{2}) for the IPO digest\)/g)].map((m) => [f, m[1]]));
ok(ipo.length >= 2 && ipo.every(([, p]) => p === IPO_TIERS["ipo-report"].price), `the IPO digest's price beside the range is the kit's ${IPO_TIERS["ipo-report"].price} (${ipo.length} read)`);
const readme = read("README.md");
for (const line of readme.split("\n").filter((l) => /per report over x402|finished \*\*report\*\* costs/.test(l))) {
  ok(/IPO digest/.test(line) || /IPO digest/.test(readme.slice(readme.indexOf(line), readme.indexOf(line) + line.length + 120)), `a README report range names the IPO digest beside it ("${line.trim().slice(0, 60)}...")`);
}

// --- Decide self-hosting ---
const decideKit = read("src/tools/decide-kit.js");
const decideVars = [...decideKit.matchAll(/process\.env\.(DECIDE_[A-Z_]+)/g)].map((m) => m[1]);
const decideSection = readme.slice(readme.indexOf("## Decide"), readme.indexOf("\n## ", readme.indexOf("## Decide") + 5));
ok(decideVars.length >= 2 && decideVars.every((v) => decideSection.includes(`\`${v}\``)), `the README's Decide section names ${decideVars.join(" and ")}`);
ok(/start:decide/.test(decideSection) && /404/.test(decideSection), "it names the service's start script and what the route answers without them");

// --- wiki Home and orphans ---
const wikiLinks = (t) => [...t.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)].map((m) => (m[2] || m[1]).trim().replace(/ /g, "-"));
const home = read("wiki/Home.md");
const startHere = home.slice(home.indexOf("## Start here"), home.indexOf("\n## ", home.indexOf("## Start here") + 5));
const startLinks = new Set(wikiLinks(startHere));
const mustStart = ["AWS-Bedrock-AgentCore", "Buying-at-Volume", "Circle-Gateway", "Seller-Reputation", "Configuration", "Troubleshooting", "Upgrading", "Contributing", "agent402-client", "Self-Hosting"];
const missingStart = mustStart.filter((p) => !startLinks.has(p));
ok(missingStart.length === 0, `wiki Home "Start here" links ${mustStart.length} entry pages${missingStart.length ? ` (missing ${missingStart.join(", ")})` : ""}`);
const linked = new Set([...wikiLinks(read("wiki/_Sidebar.md")), ...wikiLinks(home)]);
const orphans = readdirSync(join(ROOT, "wiki")).filter((f) => f.endsWith(".md") && !f.startsWith("_")).map((f) => f.slice(0, -3)).filter((p) => !linked.has(p));
ok(orphans.length === 0, `every wiki page is linked from the sidebar or Home${orphans.length ? ` (orphans: ${orphans.join(", ")})` : ""}`);

// --- PAYMENT_NETWORKS example ---
const sh = read("wiki/Self-Hosting.md");
const row = sh.split("\n").find((l) => l.startsWith("| `PAYMENT_NETWORKS`")) || "";
const example = (/e\.g\. `([a-z,]+)`/.exec(row) || [])[1] || "";
const keys = RAILS.map(railKey);
const missingNets = keys.filter((k) => !example.split(",").includes(k));
ok(example && missingNets.length === 0, `Self-Hosting's PAYMENT_NETWORKS example names every rail (${keys.length})${missingNets.length ? `; missing ${missingNets.join(", ")}` : ""}`);

// --- configuration reference links ---
const CONF = /docs\/configuration\.md/;
const ENV = /\.env\.example/;
for (const f of ["README.md", "CONTRIBUTING.md", "wiki/Self-Hosting.md", "wiki/Configuration.md"]) {
  const t = read(f);
  ok(CONF.test(t) && ENV.test(t), `${f} links the configuration reference and .env.example`);
}
ok(/\[\[Configuration\]\]/.test(read("wiki/_Sidebar.md")), "the wiki sidebar links the Configuration page");
ok(!/—/.test(read(".env.example")), ".env.example carries no em dash");

console.log(`\ntest-readme-facts: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

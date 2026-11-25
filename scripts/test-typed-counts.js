#!/usr/bin/env node
// CLASS GUARD: a count or value typed by hand where it should be derived.
// The catalog changes (a tool is added, retired, moved between kits), and a
// number typed beside it breaks or lies: test-bazaar-descriptions held
// "fred >= 8" and "jupiter >= 5" until retirements broke CI (batch 7, a
// repeat of a source-count floor in batch 3); the README and the wiki typed
// the macro series count; the Tempo token list was typed on five surfaces
// (batch 6). This suite reads for the shape and holds the count of what is
// left, so nothing new is typed and the old ones only go away.
//
//   node scripts/test-typed-counts.js            check
//   node scripts/test-typed-counts.js --list     print every finding
//
//   1. Tests (scripts/test-*.js): a numeric literal compared against a
//      catalog collection (a kit's *_TOOLS, the CATALOG, a source's tool
//      count, the catalog's endpoint or tool count, a listing's slugs, the
//      supported ids). Derive the number from the collection it describes
//      (the published examples, the listing, the kit), or import the floor
//      constant (scripts/sync-count.js CATALOG_FLOOR, BRAND_FLOOR,
//      PACK_BRAND_FLOOR), which this scan accepts.
//   2. Public markdown (README.md, wiki/, docs/, the package READMEs) and
//      the served page modules (src/pages.js, src/guides.js and the rest): a
//      number typed before what the catalog counts (tools, endpoints, routes,
//      packs, series, indicators, chains, sources). The evergreen "500+
//      tools" is the one public count (CLAUDE.md); anything else is derived
//      at runtime or not stated.
//
// BASELINE holds the findings each file has today. A file over its count
// fails (a new typed number); a file under it fails too until its count is
// lowered here, so the baseline only shrinks.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLASS = "[count or value typed by hand]";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${CLASS} ${m}`); } };
const LIST = process.argv.includes("--list");

// ---- the two scans (exported shapes, so the controls below exercise them) ----
// A catalog collection: a kit's tool list, the catalog, a source count, the
// catalog's tool or endpoint count, a listing, the supported ids.
// An exact pin or a floor on a named collection (a kit's tool list, a
// listing, the supported ids, the catalog); a floor (>=, >, <, <=) on a count
// a catalog summary or a per-source tally reports. A fixture's own count
// (r.count === 10, counts.due === 3) is not read.
const NAMED = String.raw`(?:\b[A-Z][A-Z0-9_]*_(?:TOOLS|SLUGS|LISTED|IDS|PACKS)\b(?:\.length|\.size)|\bSKILL_PACKS\.length|\bCATALOG\b\)?(?:\.length|\.size)?|\b(?:pricing|catalog)\.(?:endpoints|tools|packs)\.length|\bderived\.length|\bmarked\.length)`;
const TALLY = String.raw`(?:\bcounts(?:\.[\w$]+|\[[^\]]+\])|\b(?:toolCount|pricedEndpoints|endpointCount|packCount)\b)`;
const NUM = String.raw`(\d{2,}|[3-9])(?![\d._])`;
export const TEST_TYPED = new RegExp(String.raw`${NAMED}\s*(?:===|==|>=|>|<=|<)\s*${NUM}|\b${NUM}\s*(?:===|==|<=|<|>=|>)\s*${NAMED}|${TALLY}\s*(?:>=|>|<=|<)\s*${NUM}`, "g");
// Accepted: a floor imported from scripts/sync-count.js by name.
const FLOOR_NAMES = /\b(?:CATALOG_FLOOR|BRAND_FLOOR|PACK_BRAND_FLOOR)\b/;
export const MD_TYPED = /(?<![\w$.,/#-])(\d{2,4})(\+?)\s+(?:(?:free|paid|cleared|listed|live|public|supported|priced|government|macro|market|onchain|on-chain|crypto|data|[A-Z][\w.-]*)\s+){0,2}(tools|endpoints|routes|skill packs|packs|series|indicators|chains|sources|sellers|models)\b/g;
// Accepted: the evergreen brand floors with "+" (scripts/sync-count.js
// BRAND_FLOOR, PACK_BRAND_FLOOR, checked there against the catalog), and a
// chain count, which scripts/test-chain-list-copy.js holds to the rails.
const MD_ACCEPT = (m) => (m[2] === "+" && (m[1] === "500" || m[1] === "80")) || m[3] === "chains";

function testFindings(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    for (const m of line.matchAll(TEST_TYPED)) if (!FLOOR_NAMES.test(m[0])) out.push({ line: i + 1, text: m[0].trim() });
  });
  return out;
}
function mdFindings(text) {
  const out = [];
  let fence = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) { fence = !fence; return; }
    if (fence) return;
    for (const m of line.matchAll(MD_TYPED)) if (!MD_ACCEPT(m)) out.push({ line: i + 1, text: m[0].trim() });
  });
  return out;
}

// A served page module (the copy surfaces test-copy-absolutes reads: pages,
// guides, learn, seo, terms, privacy and the rest): the markdown scan on its
// lines, comment lines skipped.
export const PAGE_MODULE = /^src\/[\w-]*(?:page|pages|guides?|learn|seo|blog|skill-md|how-to-pay|what-is-x402|webhooks|terms|privacy|company|glossary|faq|why|docs|integration|front-door)[\w-]*\.js$/;
function pageFindings(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const m of line.matchAll(MD_TYPED)) if (!MD_ACCEPT(m)) out.push({ line: i + 1, text: m[0].trim() });
  });
  return out;
}

// ---- controls: each past instance is caught, the accepted forms are not ----
for (const [t, want] of [
  ["ok(counts.fred >= 8 && counts.jupiter >= 5, \"x\")", 2],
  ["ok(CHAIN_TOOLS.length === 15, \"x\")", 1],
  ["ok(SUPPORTED_IDS.length >= 90, \"x\")", 1],
  ["ok(pricing.endpoints.length >= 400, \"x\")", 1],
  ["ok(new Set(REF_LISTED).size === 73, \"x\")", 0], // a local list (not a collection name the scan knows): the listing suite owns it
  ["ok(pricing.endpoints.length >= CATALOG_FLOOR, \"x\")", 0],
  ["ok(r.count === 10, \"a fixture's own answer\")", 0],
  ["ok(counts.due === 3, \"a fixture's own tally\")", 0],
  ["ok(toolCount > 60_000, \"a stub's size\")", 0],
  ["ok(j.catalog.toolCount >= 400, \"x\")", 1],
]) ok(testFindings(t).length === want, `control (tests): ${JSON.stringify(t.slice(3, 60))} gives ${want} finding(s) (${testFindings(t).length})`);
for (const [t, want] of [
  ["Agent402 serves 500+ tools an agent can pay for.", 0],
  ["The macro tools read 90 series from BLS.", 1],
  ["| us-macro-series | 90 supported series |", 1],
  ["All 73 cleared tools are listed.", 1],
  ["Pay with USDC on 7 chains.", 0], // single digit: below the scan's reach on purpose
  ["Pay with USDC on 12 chains.", 0], // held to the rails by test-chain-list-copy
  ["Over 80+ packs and 500+ endpoints.", 0],
  ["Timeout is 30 seconds.", 0],
]) ok(mdFindings(t).length === want, `control (markdown): ${JSON.stringify(t)} gives ${want} finding(s) (${mdFindings(t).length})`);

for (const [t, want] of [
  ["  <p>Agent402 serves 612 tools an agent can pay for.</p>", 1],
  ["  const lead = `Pay for ${n} tools`;", 0],
  ["  // 612 tools in a comment is not served copy", 0],
  ["  <p>500+ tools on one key.</p>", 0],
]) ok(pageFindings(t).length === want, `control (page modules): ${JSON.stringify(t.trim())} gives ${want} finding(s) (${pageFindings(t).length})`);
ok(PAGE_MODULE.test("src/pages.js") && PAGE_MODULE.test("src/guides.js") && PAGE_MODULE.test("src/integration-pages.js") && !PAGE_MODULE.test("src/server.js") && !PAGE_MODULE.test("src/tools/web-kit.js"), "control (page modules): the served page modules are read, the server and the kits are not");

// ---- the scan ----
const files = [];
for (const f of readdirSync(join(ROOT, "scripts"))) if (/^test-.*\.js$/.test(f) && f !== "test-typed-counts.js") files.push(["test", join(ROOT, "scripts", f)]);
const mdWalk = (d) => { if (!existsSync(d)) return; for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) mdWalk(p); else if (f.endsWith(".md")) files.push(["md", p]); } };
mdWalk(join(ROOT, "wiki"));
mdWalk(join(ROOT, "docs"));
for (const p of ["README.md", "mcp/README.md", "client/README.md", "tollbooth/README.md", "openclaw/README.md"]) if (existsSync(join(ROOT, p))) files.push(["md", join(ROOT, p)]);
for (const f of readdirSync(join(ROOT, "src"))) if (PAGE_MODULE.test(`src/${f}`)) files.push(["page", join(ROOT, "src", f)]);
ok(files.filter(([k]) => k === "page").length >= 20 && files.some(([k, p]) => k === "page" && p.endsWith("/src/pages.js")), `the scan reads the served page modules (${files.filter(([k]) => k === "page").length})`);
for (const d of existsSync(join(ROOT, "adapters")) ? readdirSync(join(ROOT, "adapters")) : []) { const p = join(ROOT, "adapters", d, "README.md"); if (existsSync(p)) files.push(["md", p]); }

const found = {};
for (const [kind, p] of files) {
  const f = (kind === "test" ? testFindings : kind === "page" ? pageFindings : mdFindings)(readFileSync(p, "utf8"));
  if (f.length) found[relative(ROOT, p)] = f;
}
if (LIST) for (const [f, list] of Object.entries(found)) for (const x of list) console.log(`  ${f}:${x.line}: ${x.text}`);

// What is left today, per file. Lower a count when a number is derived; never raise one.
const BASELINE = {
  "scripts/test-b2b-enrich-kit.js": 1,
  "scripts/test-bundle-products.js": 1,
  "scripts/test-cdp-kit.js": 1,
  "scripts/test-chain-kit.js": 1,
  "scripts/test-contract-kit.js": 1,
  "scripts/test-crypto-markets-kit.js": 1,
  "scripts/test-dex-kit.js": 1,
  "scripts/test-enrich-kit.js": 1,
  "scripts/test-images-fast-kit.js": 1,
  "scripts/test-kalshi-copy-off.js": 1,
  "scripts/test-llm-gateway.js": 1,
  "scripts/test-llm-gemini-kit.js": 1,
  "scripts/test-llm-messages.js": 1,
  "scripts/test-llm-responses.js": 1,
  "scripts/test-mev-and-l2-kit.js": 1,
  "scripts/test-non-metered-examples.js": 1,
  "scripts/test-office-create.js": 1,
  "scripts/test-prediction-market-kit.js": 1,
  "scripts/test-referral-gate.js": 1,
  "scripts/test-retired-routes.js": 1,
  "scripts/test-returning-wallet.js": 1,
  "scripts/test-self-funding.js": 1,
  "scripts/test-solana-intel-kit.js": 1,
  "scripts/test-stock-copy-off.js": 1,
  "scripts/test-web-kit.js": 1,
  "scripts/test-x-data-kit.js": 1,
  "src/blog.js": 1, // a dated post's history ("We started with 50 tools in the first week")
  "wiki/AWS-Bedrock-AgentCore.md": 1,
  "wiki/MCP-Connector.md": 1,
  "wiki/Tool-Catalog.md": 1,
};
const total = Object.values(found).reduce((n, l) => n + l.length, 0);
const baseTotal = Object.values(BASELINE).reduce((n, c) => n + c, 0);
const over = Object.entries(found).filter(([f, l]) => l.length > (BASELINE[f] || 0));
ok(over.length === 0, `no file types a new count (${over.map(([f, l]) => `${f}: ${l.length} found, baseline ${BASELINE[f] || 0}: ${l.map((x) => `${x.line} "${x.text}"`).join("; ")}`).join(" | ") || "none"}${over.length ? "; derive it from the collection it counts (or import the floor from scripts/sync-count.js), or in public copy state no count" : ""})`);
const under = Object.entries(BASELINE).filter(([f, c]) => (found[f]?.length || 0) < c);
ok(under.length === 0, `the baseline only shrinks: lower each count a fix brought down (${under.map(([f, c]) => `${f}: ${found[f]?.length || 0} left, baseline ${c}`).join(" | ") || "none"})`);
console.log(`typed counts left: ${total} (baseline ${baseTotal})`);

console.log(`\ntest-typed-counts: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

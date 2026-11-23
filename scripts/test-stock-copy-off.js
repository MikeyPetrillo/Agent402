// test-stock-copy-off - static copy never promises stock data the server does
// not serve. With no active stock data provider (src/tools/stock-provider.js)
// the stock tools, the packs whose answer is the stock step and the
// market.quote flagship are not listed anywhere, so a markdown page or a
// sample report that names them, or promises a live quote or a stock price,
// sends a reader to a route that answers 503.
//
// Scans the markdown trees (README.md, llms-install.md, wiki/, docs/,
// examples/, every package README, the coding-agent plugins under plugins/
// with their skills) and the JSON whose string values reach a reader: the
// sample report fixtures (assets/samples/*.json) and the plugin manifests
// (.claude-plugin/, .codex-plugin/, .cursor-plugin/, plugins/*/.claude-plugin/,
// *.plugin.json), for the stock slugs, the
// hidden pack slugs, market.quote and "live quote" / "stock price" phrasing.
// A line that names the switch itself (STOCK_DATA_PROVIDER, "stock provider",
// "stock data provider") documents the switch and is not a promise. With the
// switch on, the scan is reported and does not fail.
//
// A live control first: synthetic text with each pattern is flagged, and the
// same text naming the switch is not, so a pattern that matches nothing never
// passes silently.
//
//   node scripts/test-stock-copy-off.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { STOCK_SLUGS, stockDataEnabled } from "../src/tools/stock-provider.js";
import { STOCK_CORE_PACK_SLUGS, STOCK_TRIMMED_PACK_SLUGS, PACK_PRICE_TABLE, PACK_PRICES_WITHOUT_STOCK } from "../src/skills.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAMES = [...STOCK_SLUGS, ...STOCK_CORE_PACK_SLUGS, "market.quote", "get_stock_quote"];
const PATTERNS = [
  ...NAMES.map((n) => ({ what: n, re: new RegExp(`(^|[^a-z0-9_-])${esc(n)}(?![a-z0-9_-])`, "i") })),
  { what: "live quote", re: /\blive quotes?\b/i },
  { what: "stock price", re: /\bstock prices?\b/i },
];
const SWITCH = /STOCK_DATA_PROVIDER|\bstock (data )?providers?\b/i;

/** The findings in one text: [{ line, what, text }]. */
function scan(text) {
  const out = [];
  String(text).split("\n").forEach((line, i) => {
    if (SWITCH.test(line)) return;
    for (const p of PATTERNS) if (p.re.test(line)) out.push({ line: i + 1, what: p.what, text: line.trim().slice(0, 140) });
  });
  return out;
}

// ---- live control
ok(STOCK_CORE_PACK_SLUGS.size === 3, `the hidden pack slugs are read from src/skills.js (${[...STOCK_CORE_PACK_SLUGS].join(", ")})`);
for (const p of PATTERNS) {
  const sample = p.what === "live quote" ? "The live quote shows 1.00" : p.what === "stock price" ? "Get Apple's stock price" : `call \`${p.what}\` for it`;
  ok(scan(sample).some((f) => f.what === p.what), `control: "${sample}" is flagged as ${p.what}`);
  ok(scan(`${sample} (with a stock data provider)`).length === 0, `control: the same line naming the switch is not flagged (${p.what})`);
}
ok(scan("stock-quotes-extra and my-stock-quote-x").length === 0, "control: a slug inside a longer token is not flagged");

// ---- the scan
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
const md = tracked.filter((f) => f.endsWith(".md") && (
  f === "README.md" || f === "llms-install.md"
  || /^(wiki|docs|examples|plugins)\//.test(f)
  || /^[^/]+\/README\.md$/.test(f) || /^adapters\/[^/]+\/README\.md$/.test(f)
));
const manifests = tracked.filter((f) => /(^|\/)\.(claude|codex|cursor)-plugin\/[^/]+\.json$/.test(f) || /\.plugin\.json$/.test(f));
const samples = [...tracked.filter((f) => /^assets\/samples\/[^/]+\.json$/.test(f)), ...manifests];
ok(md.includes("README.md") && md.some((f) => f.startsWith("wiki/")) && md.includes("mcp/README.md") && samples.length > manifests.length, `the scan reads the markdown trees and the sample fixtures (${md.length} markdown files, ${samples.length - manifests.length} fixtures)`);
ok(md.includes("plugins/agent402/skills/agent402/SKILL.md") && md.includes("plugins/agent402/README.md") && [".claude-plugin/marketplace.json", "plugins/agent402/.claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json"].every((f) => manifests.includes(f)), `...and the coding-agent plugins: their skill, README and manifests (${manifests.length} manifests)`);

const findings = [];
for (const f of md) for (const x of scan(readFileSync(join(ROOT, f), "utf8"))) findings.push(`${f}:${x.line} ${x.what}: ${x.text}`);
for (const f of samples) {
  const strings = [];
  const walk = (o, path) => {
    if (typeof o === "string") strings.push([path, o]);
    else if (Array.isArray(o)) o.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
  };
  walk(JSON.parse(readFileSync(join(ROOT, f), "utf8")), "");
  for (const [path, s] of strings) for (const x of scan(s)) findings.push(`${f} ${path} line ${x.line} ${x.what}: ${x.text}`);
}

// A pack that runs a stock step only with a provider sells at two prices
// (src/skills.js PACK_PRICE_TABLE with one, PACK_PRICES_WITHOUT_STOCK without),
// so a markdown line pricing it states both, "$a (with a stock data provider:
// $b)", and both match the tables: the docs read true in either state.
{
  const DUAL = /\$(\d+\.\d+) \(with a stock data provider: \$(\d+\.\d+)\)/;
  const bad = [];
  let dual = 0;
  for (const f of md) {
    readFileSync(join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
      const prices = [...line.matchAll(/\$(\d+\.\d+)/g)].map((m) => Number(m[1]));
      if (!prices.length) return;
      const named = [...STOCK_TRIMMED_PACK_SLUGS].filter((s) => new RegExp(`/skills/${esc(s)}(?![a-z0-9-])`).test(line));
      if (named.length !== 1) return;
      const s = named[0], m = line.match(DUAL);
      if (!m) { bad.push(`${f}:${i + 1} ${s}: one price, not the two-state form`); return; }
      dual++;
      if (Number(m[1]) !== PACK_PRICES_WITHOUT_STOCK[s] || Number(m[2]) !== PACK_PRICE_TABLE[s]) bad.push(`${f}:${i + 1} ${s}: says $${m[1]} / $${m[2]}, tables say $${PACK_PRICES_WITHOUT_STOCK[s]} / $${PACK_PRICE_TABLE[s]}`);
    });
  }
  ok(dual > 0 && bad.length === 0, `every markdown price of a pack with a stock step states both prices and both match the tables (${dual} lines${bad.length ? `; ${bad.join("; ")}` : ""})`);
}

// The MCP server description and the llms.txt connector line name the
// flagships; the quote flagship (market.quote, "market data" there) is named
// only while a stock provider is active, as the instructions line already is.
{
  const { mcpServerDescription, MCP_SERVER_DESCRIPTION: HOSTED } = await import("../src/mcp-flagship.js");
  const { MCP_SERVER_DESCRIPTION: STDIO } = await import("../mcp/output-schemas.js");
  const { llmsTxt } = await import("../src/seo.js");
  const flag = (d) => /Flagships:[^;]*\bmarket data\b/.test(d);
  ok(!flag(mcpServerDescription({ stock: false })) && flag(mcpServerDescription({ stock: true })), "the hosted serverInfo description names the market data flagship only with a stock provider");
  ok(!flag(HOSTED) && !flag(STDIO), "the published descriptions (hosted default, stdio package) name no market data flagship");
  ok(/description: mcpServerDescription\(\{[^}]*\bstock: stockDataEnabled\(\)/.test(readFileSync(join(ROOT, "src/mcp-http.js"), "utf8")), "the hosted connector's description reads the stock switch");
  const line = (llmsTxt("https://example.test", []).split("\n").find((l) => l.includes("Hosted MCP connector")) || "");
  ok(line && !/render\/data\//.test(line) && (stockDataEnabled() ? /\/quote\//.test(line) : !/\/quote\//.test(line)), `llms.txt names the quote flagship only with a stock provider (${line.slice(0, 120)})`);
}

if (stockDataEnabled()) {
  console.log(`(a stock data provider is active: ${findings.length} mention(s) allowed)`);
  ok(true, "switch on: static copy may name the stock tools");
} else {
  ok(findings.length === 0, `with no stock data provider, no static copy names a stock tool, a hidden pack, market.quote or promises a live quote or stock price${findings.length ? `:\n  ${findings.join("\n  ")}` : ""}`);
}

console.log(`\ntest-stock-copy-off: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

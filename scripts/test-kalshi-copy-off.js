// test-kalshi-copy-off - static copy never names a Kalshi tool the server does
// not serve. With KALSHI_TOOLS off (src/kalshi-switch.js) the Kalshi tools are
// not listed anywhere, so a markdown page or a sample report that names them
// sends a reader to a route that answers 503.
//
// Scans the markdown trees (README.md, llms-install.md, wiki/, docs/,
// examples/, every package README) and the sample report fixtures
// (assets/samples/*.json, their string values) for the Kalshi slugs and the
// word Kalshi. A line that names the switch itself (KALSHI_TOOLS) documents the
// switch and is not a promise. With the switch on, the scan is reported and
// does not fail.
//
// In either state, the weather-market tools (which read no market feed; the
// caller sends each price) never name Kalshi in their name, description,
// schema, tags or published example.
//
// A live control first: synthetic text with each pattern is flagged, and the
// same text naming the switch is not, so a pattern that matches nothing never
// passes silently.
//
//   node scripts/test-kalshi-copy-off.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KALSHI_SLUGS, kalshiToolsEnabled } from "../src/kalshi-switch.js";
import { WEATHER_PROBABILITY_TOOLS } from "../src/tools/weather-probability-kit.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERNS = [
  ...[...KALSHI_SLUGS].map((n) => ({ what: n, re: new RegExp(`(^|[^a-z0-9_-])${esc(n)}(?![a-z0-9_-])`, "i") })),
  { what: "Kalshi", re: /\bkalshi\b/i },
];
const SWITCH = /KALSHI_TOOLS/;

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
ok(KALSHI_SLUGS.size === 4, `the Kalshi slugs are read from src/kalshi-switch.js (${[...KALSHI_SLUGS].join(", ")})`);
for (const p of PATTERNS) {
  const sample = p.what === "Kalshi" ? "Odds from Kalshi markets" : `call \`${p.what}\` for it`;
  ok(scan(sample).some((f) => f.what === p.what), `control: "${sample}" is flagged as ${p.what}`);
  ok(scan(`${sample} (with KALSHI_TOOLS=on)`).length === 0, `control: the same line naming the switch is not flagged (${p.what})`);
}
ok(scan("my-kalshi-markets-x and kalshi-marketsextra").filter((f) => f.what !== "Kalshi").length === 0, "control: a slug inside a longer token is not flagged");

// ---- the weather-market tools, in either state
{
  const wm = WEATHER_PROBABILITY_TOOLS.filter((t) => ["weather-market-brackets", "weather-market-board"].includes(t.slug));
  const named = wm.filter((t) => /kalshi/i.test(JSON.stringify({ name: t.name, description: t.description, tags: t.tags, discovery: t.discovery })) || /kalshi/i.test(String(t.handler))).map((t) => t.slug);
  ok(wm.length === 2 && named.length === 0, `the weather-market tools name no Kalshi anywhere in their copy, schema, example or handler (${named.join(", ") || "none"})`);
  ok(wm.every((t) => /reads no market feed/.test(t.description)), "the weather-market tools say they read no market feed (the caller sends each price)");
  ok(/kalshi/i.test(JSON.stringify({ description: "From Kalshi" })), "control: the weather-market read flags the word");
}

// ---- the scan
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
const md = tracked.filter((f) => f.endsWith(".md") && (
  f === "README.md" || f === "llms-install.md"
  || /^(wiki|docs|examples)\//.test(f)
  || /^[^/]+\/README\.md$/.test(f) || /^adapters\/[^/]+\/README\.md$/.test(f)
));
const samples = tracked.filter((f) => /^assets\/samples\/[^/]+\.json$/.test(f));
ok(md.includes("README.md") && md.includes("wiki/Self-Hosting.md") && md.includes("mcp/README.md") && samples.length > 0, `the scan reads the markdown trees and the sample fixtures (${md.length} markdown files, ${samples.length} fixtures)`);
ok(readFileSync(join(ROOT, "wiki/Self-Hosting.md"), "utf8").split("\n").some((l) => SWITCH.test(l) && /kalshi-markets/.test(l)), "control: the self-hosting table documents the switch on a line the scan skips");

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

if (kalshiToolsEnabled()) {
  console.log(`(KALSHI_TOOLS is on: ${findings.length} mention(s) allowed)`);
  ok(true, "switch on: static copy may name the Kalshi tools");
} else {
  ok(findings.length === 0, `with KALSHI_TOOLS off, no static copy names a Kalshi tool or Kalshi${findings.length ? `:\n  ${findings.join("\n  ")}` : ""}`);
}

console.log(`\ntest-kalshi-copy-off: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

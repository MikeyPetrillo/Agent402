// Typed chain lists and counts in the docs and package text match the live
// rails (src/rails.js RAILS). Two rules:
//   1. a full x402 chain list (one sentence naming Base, Arc and Stellar) names
//      every rail, so a graduated rail cannot be left out of one list;
//   2. a typed chain count ("14 chains", "fourteen chains", "covers all
//      fourteen", "14 in total") equals the rail count, and "USDC on N chains"
//      the USDC rail count;
//   3. an EVM list (a sentence saying EVM that names Base and Arc) names every
//      EVM USDC rail.
// Subsets (EVM-only lists, chain-read tool networks, router chains) never name
// all three markers, so they are not read as full lists.
// Run: node scripts/test-chain-list-copy.js
import "./lib/offline-stores.js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { RAILS } from "../src/rails.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const md = (dir) => (existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)).filter((f) => /\.md$/.test(f)).map((f) => join(dir, f)) : []);
const FILES = [
  "README.md", "llms-install.md", "mcp/README.md", "mcp/server.json", "mcp/package.json", "client/README.md",
  "openclaw/README.md", "skills/openclaw/agent402/SKILL.md", "package.json",
  ...md("wiki"), ...md("docs"),
  ...readdirSync(join(ROOT, "adapters")).flatMap((a) => [`adapters/${a}/README.md`, `adapters/${a}/package.json`]),
].filter((f) => existsSync(join(ROOT, f)));

const labelOf = (r) => r.label || r.name;
// Copy shortens "Robinhood Chain" to "Robinhood"; match on the first word.
const names = RAILS.map((r) => ({ label: labelOf(r), re: new RegExp(`\\b${String(labelOf(r)).split(" ")[0]}\\b`) }));
const N = RAILS.length;
// EVM USDC rails: an "EVM" list (a sentence that says EVM and names Base and Arc) names each.
const EVM_USDC = RAILS.filter((r) => String(r.caip2).startsWith("eip155:") && r.asset === "USDC").map((r) => ({ label: labelOf(r), re: new RegExp(`\\b${labelOf(r)}\\b`) }));
// "USDC on N chains" counts the USDC rails only (Robinhood Chain settles USDG).
const N_USDC = RAILS.filter((r) => r.asset === "USDC").length;
const USDC_ONLY = new Set(RAILS.filter((r) => r.asset !== "USDC").map(labelOf));
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const numOf = (s) => (/^\d+$/.test(s) ? Number(s) : WORDS.indexOf(String(s).toLowerCase()));

let lists = 0, counts = 0;
for (const f of FILES) {
  // Sentences: split on a period, newline pair or table cell boundary; markdown
  // quote markers and single line wraps stay inside the sentence.
  const text = readFileSync(join(ROOT, f), "utf8").replace(/\n>\s?/g, " ").replace(/([^\n])\n(?!\n)/g, "$1 ");
  for (const s of text.split(/\.\s|\n\n|\s\|\s/)) {
    if (/\bBase\b/.test(s) && /\bArc\b/.test(s) && /\bStellar\b/.test(s)) {
      lists++;
      // A USDC list may leave the non-USDC rails to the next sentence.
      const usdcList = /USDC on Base/.test(s) && !/USDG/.test(s);
      const missing = names.filter((n) => !(usdcList && USDC_ONLY.has(n.label)) && !n.re.test(s)).map((n) => n.label);
      ok(missing.length === 0, `${f}: full chain list names every rail${missing.length ? ` (missing ${missing.join(", ")}): "${s.trim().slice(0, 120)}"` : ""}`);
    }
    if (/\bEVM\b/.test(s) && /\bBase\b/.test(s) && /\bArc\b/.test(s) && !/\bStellar\b.*\bAlgorand\b.*\b(?:USDC|x402)\b on/.test(s)) {
      lists++;
      const missing = EVM_USDC.filter((n) => !n.re.test(s)).map((n) => n.label);
      ok(missing.length === 0, `${f}: EVM chain list names every EVM USDC rail${missing.length ? ` (missing ${missing.join(", ")}): "${s.trim().slice(0, 120)}"` : ""}`);
    }
    for (const m of s.matchAll(/\b(\d{1,2}|[a-z]+teen|twelve|eleven|ten)\s+(?:chains|x402 networks|networks over x402|in total|in all)\b|\bcovers all (\w+)\b/gi)) {
      const word = m[1] || m[2];
      const n = numOf(word);
      if (n < 0) continue;
      // Only x402 chain counts: the sentence talks about chains/networks.
      if (!/chain|network|x402|USDC/i.test(s)) continue;
      counts++;
      const before = s.slice(Math.max(0, m.index - 12), m.index);
      const want = /USDC on\s*$/.test(before) ? N_USDC : N;
      ok(n === want, `${f}: "${before.trim()} ${m[0]}" matches the ${want} ${want === N ? "rails" : "USDC rails"}`);
    }
  }
}
ok(lists >= 5, `found the full chain lists (${lists}); zero would mean the scan is blind`);
ok(counts >= 3, `found the typed chain counts (${counts}); zero would mean the scan is blind`);

console.log(`\ntest-chain-list-copy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// Generates src/generated/public-suffixes.json, the ICANN section of the
// Public Suffix List that src/operator-key.js reads to find an origin's
// registrable domain. The server never fetches the list: it reads the
// committed file, and this script is the only thing that reads the source.
//
//   node scripts/gen-public-suffixes.js                 fetch the list, print a summary
//   node scripts/gen-public-suffixes.js --write         fetch and write the table
//   node scripts/gen-public-suffixes.js --write <file>  read a downloaded copy instead
//
// Staleness: registries add second-level suffixes a few times a year, and a
// suffix missing here only groups that suffix's sellers as one operator for
// the crawl's politeness budgets (src/seller-load.js) until the next run.
// Regenerate when the stored `generatedAt` is more than a few months old.
// The list is Mozilla Public License 2.0 data (https://publicsuffix.org).
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "https://publicsuffix.org/list/public_suffix_list.dat";
const OUT = join(ROOT, "src", "generated", "public-suffixes.json");

const args = process.argv.slice(2);
const write = args.includes("--write");
const file = args.find((a) => !a.startsWith("--"));

const text = file ? readFileSync(file, "utf8") : await (async () => {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${SOURCE} answered ${res.status}`);
  return res.text();
})();

const begin = text.indexOf("// ===BEGIN ICANN DOMAINS===");
const end = text.indexOf("// ===END ICANN DOMAINS===");
if (begin < 0 || end < begin) throw new Error("ICANN section markers not found");

// A rule as the server matches it: ASCII (punycode) labels, a leading "*."
// for a wildcard and a leading "!" for an exception kept as written.
function asciiRule(line) {
  let prefix = "";
  let body = line;
  if (body.startsWith("!")) { prefix = "!"; body = body.slice(1); }
  if (body.startsWith("*.")) { prefix += "*."; body = body.slice(2); }
  else if (body === "*") return "*";
  const ascii = domainToASCII(body);
  if (!ascii) throw new Error(`rule not convertible to ASCII: ${line}`);
  return prefix + ascii;
}

const rules = new Set();
for (const raw of text.slice(begin, end).split("\n")) {
  const line = raw.trim().split(/\s/)[0];
  if (!line || line.startsWith("//")) continue;
  const rule = asciiRule(line);
  // A plain one-label rule (a top-level domain) says what the default rule
  // already says, that the last label is a suffix, so it is not stored.
  if (!rule.includes(".")) continue;
  rules.add(rule);
}
if (rules.size < 4000) throw new Error(`only ${rules.size} ICANN rules read; refusing to write a short table`);

const table = {
  source: SOURCE,
  license: "MPL-2.0",
  section: "ICANN",
  generatedAt: new Date().toISOString().slice(0, 10),
  sha256: createHash("sha256").update(text).digest("hex"),
  rules: [...rules].sort(),
};

console.log(`${table.rules.length} ICANN rules (source sha256 ${table.sha256.slice(0, 12)})`);
if (write) {
  writeFileSync(OUT, `${JSON.stringify(table, null, 1)}\n`);
  console.log(`wrote ${OUT}`);
}

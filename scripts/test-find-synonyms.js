// The /api/find synonym table (src/find-synonyms.js). Offline.
//
// What is pinned:
//  - every rule adds a word the catalog names a tool by (a whole slug, a slug
//    word or a tag), so a renamed tool or tag fails here instead of the rule
//    going quiet;
//  - a rule fires only when every word it lists is in the query, adds its
//    words once, keeps the buyer's words, and reports which words it stands for;
//  - each rule's own words rank its tool first (the reason the rule exists).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FIND_SYNONYMS, FIND_OPERATION_WORDS, applySynonyms } from "../src/find-synonyms.js";
import { findTools } from "../src/find.js";
import { SKILL_PACKS } from "../src/skills.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// The catalog's tool kits, as the server lists them, plus the skill packs' slugs.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const C = {};
// Worker entry points (*-worker.js) run only inside a worker thread.
for (const f of readdirSync(join(ROOT, "src", "tools")).filter((f) => f.endsWith(".js") && !f.endsWith("-worker.js")).sort()) {
  const m = await import(pathToFileURL(join(ROOT, "src", "tools", f)).href);
  for (const v of Object.values(m)) if (Array.isArray(v)) for (const t of v) if (t && typeof t === "object" && typeof t.route === "string" && typeof t.slug === "string" && !C[t.route]) C[t.route] = t;
}
const names = new Set();
for (const t of Object.values(C)) {
  names.add(t.slug);
  for (const w of t.slug.split("-")) names.add(w);
  for (const tg of t.tags || []) names.add(String(tg).toLowerCase());
}
for (const p of SKILL_PACKS) for (const w of `skill-${p.slug}`.split("-")) names.add(w);
ok(Object.keys(C).length > 400, `the tool kits load (${Object.keys(C).length} tools)`);

ok(FIND_SYNONYMS.length >= 10 && Object.isFrozen(FIND_SYNONYMS), "the table is frozen and holds its rules");
for (const r of FIND_SYNONYMS) {
  ok(r.when.length && r.add.length && [...r.when, ...r.add].every((w) => /^[a-z0-9-]+$/.test(w)), `rule ${r.when.join("+")} is lower-case words`);
  for (const a of r.add) ok(names.has(a), `"${a}" (for ${r.when.join(" ")}) names a tool: a slug, slug word or tag`);
}

// Firing.
const t1 = ["decode", "base64", "plaintext"];
const from = applySynonyms(t1);
ok(t1.join(" ") === "decode base64 plaintext", `an added word already in the query is not added twice (${t1.join(" ")})`);
ok(JSON.stringify(from.get("decode")) === '["plaintext"]', "the answer says which words an added word stands for");
const t2 = ["duration", "parse"];
applySynonyms(t2);
ok(t2.join(" ") === "duration parse", `a two-word rule needs both words ("duration" alone parses a duration): ${t2.join(" ")}`);
const t3 = ["time", "zones", "tokyo"];
applySynonyms(t3);
ok(t3.includes("timezone") && t3.includes("zones") && t3.includes("time"), `"time zones" adds "timezone" and keeps the buyer's words (${t3.join(" ")})`);

// Each rule's reason.
const top = (q) => findTools(C, q, {}).results?.[0]?.slug;
for (const [q, want] of [
  ["base64 string into plaintext", "base64"],
  ["calculator", "calc"],
  ["multiply two numbers", "calc"],
  ["duration between two dates", "date-diff"],
  ["convert measurement units", "unit-convert"],
  ["convert time zones", "timezone-convert"],
  ["count the rows and columns of a csv", "csv-lint"],
]) ok(top(q) === want, `"${q}" -> ${want} (got ${top(q)})`);

// Operation words: a top hit that never mentions the operation is not served.
ok(Object.isFrozen(FIND_OPERATION_WORDS) && FIND_OPERATION_WORDS.has("sum"), "the operation words are a frozen set");
{
  const O = {
    "POST /api/csv-to-json": { name: "CSV to JSON", slug: "csv-to-json", category: "data", price: "$0.001", description: "Parse CSV into a JSON array of objects.", tags: ["csv", "json", "parse"], discovery: { example: {} } },
    "POST /api/csv-sum": { name: "CSV column sums", slug: "csv-sum", category: "data", price: "$0.001", description: "Sum each numeric column of a CSV.", tags: ["csv"], discovery: { example: {} } },
  };
  const only = { "POST /api/csv-to-json": O["POST /api/csv-to-json"] };
  const gap = findTools(only, "parse a csv into json objects with a sum", {});
  ok(gap.results[0]?.slug === "csv-to-json" && gap.rarestTermCovered === false, `a hit that does not mention the operation reads as a miss (covered ${gap.rarestTermCovered})`);
  const served = findTools(O, "parse csv and sum a column", {});
  ok(served.results[0]?.slug === "csv-sum" && served.rarestTermCovered !== false, `a hit that names the operation is served (top ${served.results[0]?.slug}, covered ${served.rarestTermCovered})`);
}
// An operation word is covered by the word a tool doing it writes instead:
// "clean html" is what an HTML stripper does, and it is served.
{
  const H = {
    "POST /api/html-strip": { name: "HTML strip to text", slug: "html-strip", category: "text", price: "$0.001", description: "Strip all HTML tags and return plain text.", tags: ["html", "strip", "text"], discovery: { example: {} } },
    "POST /api/json-clean": { name: "JSON clean", slug: "json-clean", category: "data", price: "$0.001", description: "Clean a JSON document.", tags: ["json", "clean"], discovery: { example: {} } },
    "POST /api/csv-clean": { name: "CSV clean", slug: "csv-clean", category: "data", price: "$0.001", description: "Clean a CSV file.", tags: ["csv", "clean"], discovery: { example: {} } },
  };
  const r = findTools(H, "clean html tags to text", {});
  ok(r.results[0]?.slug === "html-strip" && r.rarestTermCovered !== false, `"clean html tags to text" is served by a stripper (covered ${r.rarestTermCovered})`);
  const log = { "POST /api/dedupe-lines": { name: "Dedupe lines", slug: "dedupe-lines", category: "text", price: "$0.001", description: "Remove duplicate lines.", tags: ["dedupe", "lines", "text"], discovery: { example: {} } } };
  const g = findTools(log, "clean up a log file and drop junk lines", {});
  ok(g.rarestTermCovered === false, `"clean up a log file" stays a miss on a tool that only removes duplicates (covered ${g.rarestTermCovered})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

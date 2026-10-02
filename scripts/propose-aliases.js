#!/usr/bin/env node
// Turn "find ranked the wrong tool" into an alias you can approve in one pass.
//
// The re-rank's index-miss verdict says: a real caller searched for X, we SELL
// something that does X, and /api/find ranked it below something else. The fix
// in this codebase is a curated alias on the tool, never a score boost - an
// alias is a name the tool also answers to, and it lands in find's haystack
// (find.js:178) where it helps every future query for free.
//
// THE PROMOTION STAYS HUMAN. This prints a diff; it does not write one. An
// alias is a permanent change to a public discovery surface, and a model that
// can edit what /api/find returns is a model that can quietly make the catalog
// answer to anything. Approving a one-line diff costs seconds and keeps the
// authorship where it belongs.
//
//   node scripts/propose-aliases.js rerank-full.json          # print proposals
//   node scripts/propose-aliases.js rerank-full.json --terms  # just the terms
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: propose-aliases.js <rerank-output.json> [--terms]"); process.exit(1); }
const rows = JSON.parse(readFileSync(file, "utf8")).filter((r) => r?.rerank?.kind === "index-miss" && r.rerank.slug);

// Stopwords plus the words that describe an ACTION generically enough to match
// half the catalog. An alias made of these is worse than none: it would pull
// the tool into queries it does not serve, which is the failure find already
// has. Drawn from find.js's own tokenizer reasoning.
const STOP = new Set(("a an the to from for of and or with in on by into as is are be get my me please can you i we need want "
  + "how do does what which when where why that this it its use using make made new all any some more most "
  + "data thing things stuff item items value values").split(/\s+/));

/** The terms worth adding: what the caller said, minus noise, minus anything
 *  the tool's own slug already contains (find scores the slug higher anyway). */
export function aliasTermsFor(query, slug) {
  const slugWords = new Set(String(slug).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const kept = words.filter((w) => w.length > 2 && !STOP.has(w) && !slugWords.has(w));
  // The whole phrase is the most useful alias when it is short enough to be a
  // name; otherwise the distinctive words are.
  const phrase = kept.join("-");
  return { phrase: phrase.length <= 40 && kept.length >= 2 ? phrase : null, words: [...new Set(kept)] };
}

const bySlug = new Map();
for (const r of rows) {
  const { slug } = r.rerank;
  const { phrase, words } = aliasTermsFor(r.text, slug);
  const e = bySlug.get(slug) || { slug, queries: [], phrases: new Set(), words: new Set(), hits: 0, minConf: 1 };
  e.queries.push(r.text);
  e.hits += Number(r.count) || 0;
  e.minConf = Math.min(e.minConf, r.rerank.confidence);
  if (phrase) e.phrases.add(phrase);
  for (const w of words) e.words.add(w);
  bySlug.set(slug, e);
}

const out = [...bySlug.values()].sort((a, b) => b.hits - a.hits);
if (!out.length) { console.log("No index-miss verdicts in that file. Nothing to propose."); process.exit(0); }

if (process.argv.includes("--terms")) {
  for (const e of out) console.log(`${e.slug}\t${[...e.phrases].join(",")}`);
  process.exit(0);
}

console.log(`${out.length} tool${out.length === 1 ? "" : "s"} that find is under-ranking, ${rows.length} queries, ordered by hits.\n`);
for (const e of out) {
  console.log(`── ${e.slug}   (${e.hits} hits across ${e.queries.length} quer${e.queries.length === 1 ? "y" : "ies"}, lowest confidence ${e.minConf.toFixed(2)})`);
  for (const q of e.queries.slice(0, 5)) console.log(`     searched: "${q}"`);
  if (e.queries.length > 5) console.log(`     ... and ${e.queries.length - 5} more`);
  const add = [...e.phrases];
  if (add.length) {
    console.log(`\n   add to the tool's definition:`);
    console.log(`     aliases: [${add.map((a) => `"${a}"`).join(", ")}],`);
  } else {
    console.log(`\n   no clean phrase; distinctive words were: ${[...e.words].join(", ")}`);
    console.log(`   (write the alias by hand, or leave it: a bad alias is worse than none)`);
  }
  console.log("");
}
console.log("Approve by editing the tool definitions. Nothing here writes to the catalog.");

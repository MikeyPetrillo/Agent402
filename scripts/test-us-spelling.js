#!/usr/bin/env node
// Public copy is written in US English. This reads the prose a visitor, a
// package user or an agent sees: the README, the wiki and docs trees, the
// package READMEs, the legal and guide page modules, and every tool
// description, and fails on a British spelling. Code comments and
// identifiers are not read: a status token such as "cancelled" is a contract
// and stays as it is.
//
//   node scripts/test-us-spelling.js
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Each entry is the British form; the US form is given beside it so a hit
// says what to write. Words that are the same in both, or that are US words
// in their own right (fulfilled, program as a noun), are not listed.
const BRITISH = {
  honour: "honor", honours: "honors", honoured: "honored", honouring: "honoring",
  colour: "color", colours: "colors", coloured: "colored",
  behaviour: "behavior", behaviours: "behaviors",
  labelled: "labeled", labelling: "labeling", unlabelled: "unlabeled",
  cancelled: "canceled", cancelling: "canceling",
  modelled: "modeled", modelling: "modeling", travelling: "traveling",
  recognise: "recognize", recognises: "recognizes", recognised: "recognized", recognising: "recognizing",
  catalogue: "catalog", catalogues: "catalogs",
  optimise: "optimize", optimised: "optimized", optimising: "optimizing", optimisation: "optimization",
  organise: "organize", organised: "organized", organisation: "organization", organisations: "organizations",
  analyse: "analyze", analysed: "analyzed", analysing: "analyzing",
  normalise: "normalize", normalised: "normalized", normalising: "normalizing", normalisation: "normalization",
  minimise: "minimize", minimised: "minimized", maximise: "maximize", maximised: "maximized",
  summarise: "summarize", summarised: "summarized", customise: "customize", customised: "customized",
  authorise: "authorize", authorised: "authorized", authorisation: "authorization",
  prioritise: "prioritize", prioritised: "prioritized", standardise: "standardize", standardised: "standardized",
  initialise: "initialize", initialised: "initialized", serialise: "serialize", serialised: "serialized",
  centre: "center", centred: "centered", centres: "centers",
  favour: "favor", favoured: "favored", favourite: "favorite",
  flavour: "flavor", flavours: "flavors", neighbour: "neighbor", neighbours: "neighbors",
  defence: "defense", offence: "offense", licence: "license", licences: "licenses",
  enquiry: "inquiry", enquiries: "inquiries", programme: "program", programmes: "programs",
  grey: "gray", metre: "meter", metres: "meters", litre: "liter", litres: "liters",
  judgement: "judgment", fulfil: "fulfill", instalment: "installment", aluminium: "aluminum",
};
const WORD = new RegExp(`\\b(${Object.keys(BRITISH).join("|")})\\b`, "gi");

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
const md = (dir) => walk(join(ROOT, dir)).filter((f) => f.endsWith(".md"));

// Markdown trees: every line is prose.
const markdown = [
  join(ROOT, "README.md"), ...md("wiki"), ...md("docs"),
  ...["mcp", "client", "tollbooth", "openclaw"].map((d) => join(ROOT, d, "README.md")),
  ...walk(join(ROOT, "adapters")).filter((f) => f.endsWith("README.md")),
];
// Page modules whose template text is served as a page: comment lines are
// skipped, every other line is read.
const pageModules = ["terms.js", "privacy.js", "security-page.js", "company.js", "guides.js", "crawler-page.js"].map((f) => join(ROOT, "src", f));
// Tool kits: only the description a buyer reads in the catalog, the 402 and
// the MCP listing.
const kits = walk(join(ROOT, "src", "tools")).filter((f) => f.endsWith(".js"));

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);
const hits = [];
const scan = (file, keep) => {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!keep(line)) return;
    for (const m of line.matchAll(WORD)) hits.push(`${relative(ROOT, file)}:${i + 1}: "${m[1]}" (US: ${BRITISH[m[1].toLowerCase()]})`);
  });
};
for (const f of markdown) scan(f, () => true);
for (const f of pageModules) scan(f, (line) => !isComment(line));
for (const f of kits) scan(f, (line) => !isComment(line) && /\bdescription:\s*["'`]/.test(line));

ok(markdown.length >= 40 && kits.length >= 40, `read ${markdown.length} markdown files, ${pageModules.length} page modules and ${kits.length} tool kits`);
// Controls: the scanner sees a British word in prose and ignores a comment.
{
  const seen = [];
  const probe = (text, keep) => { for (const [i, line] of text.split("\n").entries()) if (keep(line)) for (const m of line.matchAll(WORD)) seen.push(`${i + 1}:${m[1]}`); };
  probe("The crawler honours robots.txt.\n// a comment that honours nothing\n  description: \"Colours a map\",", (l) => !isComment(l));
  ok(seen.join() === "1:honours,3:Colours", `control: prose and a description are read, a comment is not (${seen.join()})`);
}
ok(hits.length === 0, `no British spelling in public copy${hits.length ? `:\n    ${hits.join("\n    ")}` : ""}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

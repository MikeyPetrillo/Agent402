#!/usr/bin/env node
// Public copy is written in US English. This reads the prose a visitor, a
// package user or an agent sees: the README, the wiki and docs trees, the
// package READMEs, every served page module (legal, guides, FAQ, home, the
// explainer and product pages, llms.txt and the connector's instructions), and
// every tool description, and fails on a British spelling. Code comments and
// identifiers are not read, and neither is a quoted token or an object key: a
// status token such as "cancelled" is a contract and stays as it is.
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
  colour: "color", colours: "colors", coloured: "colored", colouring: "coloring",
  behaviour: "behavior", behaviours: "behaviors",
  labelled: "labeled", labelling: "labeling", unlabelled: "unlabeled",
  cancelled: "canceled", cancelling: "canceling",
  modelled: "modeled", modelling: "modeling", travelling: "traveling",
  catalogue: "catalog", catalogues: "catalogs",
  organisation: "organization", organisations: "organizations",
  optimisation: "optimization", normalisation: "normalization", authorisation: "authorization",
  analyse: "analyze", analysed: "analyzed", analysing: "analyzing",
  centre: "center", centred: "centered", centres: "centers",
  favour: "favor", favoured: "favored", favours: "favors", favourite: "favorite",
  flavour: "flavor", flavours: "flavors", neighbour: "neighbor", neighbours: "neighbors",
  defence: "defense", offence: "offense", licence: "license", licences: "licenses",
  enquiry: "inquiry", enquiries: "inquiries", programme: "program", programmes: "programs",
  grey: "gray", metre: "meter", metres: "meters", litre: "liter", litres: "liters",
  judgement: "judgment", fulfil: "fulfill", instalment: "installment", aluminium: "aluminum",
  artefact: "artifact", artefacts: "artifacts", whilst: "while", amongst: "among",
};
// The -ise verbs, in their four forms each.
for (const stem of ["recognise", "optimise", "organise", "normalise", "minimise", "maximise", "summarise",
  "customise", "authorise", "prioritise", "standardise", "initialise", "serialise", "realise", "utilise",
  "specialise", "emphasise", "finalise", "synchronise", "sanitise", "visualise", "monetise", "tokenise", "categorise"]) {
  const us = stem.replace(/ise$/, "ize");
  BRITISH[stem] = us; BRITISH[`${stem}s`] = `${us}s`; BRITISH[`${stem}d`] = `${us}d`;
  BRITISH[stem.replace(/e$/, "ing")] = us.replace(/e$/, "ing");
}
const WORD = new RegExp(`\\b(${Object.keys(BRITISH).join("|")})\\b`, "gi");
// A quoted token ("cancelled") or an object key (cancelled:) is an identifier
// or a contract value, not prose.
const isToken = (text, m) => {
  const before = text[m.index - 1] || "", after = text[m.index + m[0].length] || "";
  return (/["'`]/.test(before) && after === before) || /^:(?!\/)/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 2));
};
const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

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
// Page modules whose template text is served as a page, in llms.txt or in the
// connector's instructions: comment lines are skipped, every other line is read.
const pageModules = [...new Set([
  ...["terms.js", "privacy.js", "company.js", "guides.js", "pages.js", "seo.js", "mcp-http.js", "ledger-home.js", "what-is-mpp.js", "what-is-x402.js"].map((f) => join(ROOT, "src", f)),
  ...readdirSync(join(ROOT, "src")).filter((f) => f.endsWith("-page.js")).map((f) => join(ROOT, "src", f)),
])];
// Tool kits: only the description a buyer reads in the catalog, the 402 and
// the MCP listing.
const kits = walk(join(ROOT, "src", "tools")).filter((f) => f.endsWith(".js"));

/** The string expression after a `description:` key, across lines and `+`
 *  joins: [start, end) offsets of the text read, or null when the value is not
 *  a literal. */
function descriptionSpan(src, from) {
  let i = from, start = -1;
  for (;;) {
    while (/\s/.test(src[i] || "")) i++;
    const q = src[i];
    if (!/["'`]/.test(q || "")) break;
    if (start < 0) start = i;
    for (i++; i < src.length && src[i] !== q; i++) if (src[i] === "\\") i++;
    i++;
    let j = i;
    while (/\s/.test(src[j] || "")) j++;
    if (src[j] !== "+") return [start, i];
    i = j + 1;
  }
  return start < 0 ? null : [start, i];
}

const hits = [];
const report = (file, text, m, offset = 0) => hits.push(`${relative(ROOT, file)}:${lineOf(text, m.index + offset)}: "${m[1]}" (US: ${BRITISH[m[1].toLowerCase()]})`);
const scanProse = (file, text, keep) => {
  // Line by line so a comment line can be skipped; token checks read the line.
  let offset = 0;
  for (const line of text.split("\n")) {
    if (keep(line)) for (const m of line.matchAll(WORD)) if (!isToken(line, m)) report(file, text, m, offset);
    offset += line.length + 1;
  }
};
const scanDescriptions = (file, src) => {
  for (const key of src.matchAll(/\bdescription:/g)) {
    const line = src.slice(src.lastIndexOf("\n", key.index) + 1, key.index + key[0].length);
    if (isComment(line)) continue;
    const span = descriptionSpan(src, key.index + key[0].length);
    if (!span) continue;
    const text = src.slice(span[0], span[1]);
    for (const m of text.matchAll(WORD)) if (!isToken(text, m)) report(file, src, m, span[0]);
  }
};
ok(markdown.length >= 40 && pageModules.length >= 20 && kits.length >= 40, `read ${markdown.length} markdown files, ${pageModules.length} page modules and ${kits.length} tool kits`);
// Controls: the scanner sees a British word in prose, in a description that
// starts on the next line or is joined with +, and in a wiki sentence; it
// ignores a comment, a quoted token and an object key.
{
  const seen = [];
  const probe = (text) => { hits.length = 0; scanProse("/probe", text, (l) => !isComment(l)); seen.push(hits.map((h) => h.replace(/^.*?:(\d+): "([^"]+)".*$/, "$1:$2")).join()); };
  probe("The crawler honours robots.txt.\n// a comment that honours nothing\n  description: \"Colours a map\",");
  probe("We realise you may monetise an artefact whilst it is indexed.");
  probe("status: \"cancelled\", { cancelled: true } and 'cancelled' are tokens; a cancelled charge is prose.");
  ok(seen[0] === "1:honours,3:Colours", `control: prose and a description are read, a comment is not (${seen[0]})`);
  ok(seen[1] === "1:realise,1:monetise,1:artefact,1:whilst", `control: the -ise verbs, artefact and whilst are read (${seen[1]})`);
  ok(seen[2] === "1:cancelled", `control: a quoted token and an object key are skipped, the prose use is read (${seen[2]})`);
  hits.length = 0;
  scanDescriptions("/probe", "  {\n    description:\n      \"Honours robots.txt \" +\n      `and colours the map`,\n    // description: \"a colour in a comment\"\n    other: \"behaviour\",\n  }");
  const desc = hits.map((h) => h.replace(/^.*?:(\d+): "([^"]+)".*$/, "$1:$2")).join();
  ok(desc === "3:Honours,4:colours", `control: a description that starts on the next line and continues with + is read, a comment and another key are not (${desc})`);
  hits.length = 0;
}
// The real surfaces, after the controls emptied the list.
for (const f of markdown) scanProse(f, readFileSync(f, "utf8"), () => true);
for (const f of pageModules) scanProse(f, readFileSync(f, "utf8"), (line) => !isComment(line));
for (const f of kits) scanDescriptions(f, readFileSync(f, "utf8"));
ok(hits.length === 0, `no British spelling in public copy${hits.length ? `:\n    ${hits.join("\n    ")}` : ""}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

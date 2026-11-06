#!/usr/bin/env node
// No em dash in anything shipped or shown to a model.
//
// The published packages (their `files` allowlists, every README beside them
// and the deploy templates a user copies whole), the Python adapter's module,
// and the text a workflow writes into a public issue are read by buyers, by
// models (tool descriptions, prompts, error strings) and by anyone on the
// issue tracker. House style is a colon,
// a comma or a period where an em dash would go. The shipped set is read from
// each package.json (scripts/lib/shipped-files.js) rather than a folder list,
// so a new shipped module is covered the day it is listed. The changelog is
// read too: CHANGELOG.md ships on GitHub and npm readers follow it, and
// src/changelog.js is served as /changelog and /changelog.xml, so both are
// scanned as raw text (an escaped dash counts) and the served entries and
// rendered page are scanned after evaluation.
import "./lib/offline-stores.js"; // first: src/changelog.js pulls modules that read store env at import
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, packageDirs, shippedFiles } from "./lib/shipped-files.js";
import { issueBodyTexts } from "./lib/issue-bodies.js";
import { CHANGELOG_ENTRIES, changelogPage, changelogRss } from "../src/changelog.js";

const EM_DASH = "—";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- packages: every file the allowlist ships, plus every README beside it ----
const PACKAGE_DIRS = packageDirs();
ok(PACKAGE_DIRS.length >= 10, `found ${PACKAGE_DIRS.length} package trees`);
const hits = [];
let scanned = 0;
for (const d of PACKAGE_DIRS) {
  const files = shippedFiles(d);
  ok(files.length > 0, `${d}: ${files.length} shipped file(s) resolved from its package metadata`);
  for (const f of files) {
    scanned++;
    readFileSync(f, "utf8").split("\n").forEach((line, i) => { if (line.includes(EM_DASH)) hits.push(`${relative(ROOT, f)}:${i + 1}`); });
  }
}
ok(scanned >= 40, `scanned ${scanned} shipped files`);
ok(hits.length === 0, `no shipped file carries an em dash${hits.length ? `:\n    ${hits.join("\n    ")}` : ""}`);

// --- workflow issue bodies ----------------------------------------------------
{
  const control = issueBodyTexts(`gh issue create --body "one ${EM_DASH} two"\nBODY="three\n${EM_DASH} four"\nX_BODY=$(printf 'five ${EM_DASH}' "$a")`);
  ok(control.length === 3 && control.every((t) => t.includes(EM_DASH)), "control: direct, variable and printf bodies are all read");
  const wfDir = join(ROOT, ".github", "workflows");
  const bad = [];
  let bodies = 0;
  for (const f of readdirSync(wfDir).filter((x) => /\.ya?ml$/.test(x))) {
    const texts = issueBodyTexts(readFileSync(join(wfDir, f), "utf8"));
    bodies += texts.length;
    for (const t of texts) if (t.includes(EM_DASH)) bad.push(`${f}: "${t.replace(/\s+/g, " ").slice(0, 70)}"`);
  }
  ok(bodies >= 20, `read ${bodies} issue bodies across the workflows`);
  ok(bad.length === 0, `no workflow issue body carries an em dash${bad.length ? `:\n    ${bad.join("\n    ")}` : ""}`);
}

// --- changelog: CHANGELOG.md and the served /changelog entries ---------------
{
  // The literal character, its JS escape and its HTML entities all render as one.
  const DASH_FORMS = /\u2014|\\u2014|&mdash;|&#8212;|&#x2014;/i;
  const lineHits = (label, text) => text.split("\n").flatMap((line, i) => (DASH_FORMS.test(line) ? [`${label}:${i + 1}`] : []));
  const ctl = lineHits("ctl", `a\nb ${EM_DASH} c\nd \\u2014 e\nf &mdash; g`);
  ok(ctl.length === 3, "control: a literal, an escaped and an entity dash are each caught");

  const md = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  const mdGroups = (md.match(/^### \d{4}-\d{2}-\d{2}/gm) || []).length;
  ok(mdGroups >= 20, `CHANGELOG.md: read ${mdGroups} dated groups`);
  const js = readFileSync(join(ROOT, "src", "changelog.js"), "utf8");
  const items = CHANGELOG_ENTRIES.flatMap((e) => [e.title, ...e.items]);
  ok(CHANGELOG_ENTRIES.length >= 20 && items.length >= 100, `src/changelog.js: read ${CHANGELOG_ENTRIES.length} served entries, ${items.length} strings`);
  // Every served string is on the page the scan reads, so the page scan covers them.
  const page = changelogPage("https://example.test");
  ok(items.every((t) => page.includes(t.split(/[&<>"']/)[0])), "control: every served entry string is on the rendered page");

  const bad = [
    ...lineHits("CHANGELOG.md", md),
    ...lineHits("src/changelog.js", js),
    ...items.filter((t) => t.includes(EM_DASH)).map((t) => `entry: "${t.slice(0, 70)}"`),
    ...lineHits("/changelog", page),
    ...lineHits("/changelog.xml", changelogRss("https://example.test")),
  ];
  ok(bad.length === 0, `no changelog entry carries an em dash${bad.length ? `:\n    ${bad.join("\n    ")}` : ""}`);
}

console.log(`\ntest-no-em-dash-shipped: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

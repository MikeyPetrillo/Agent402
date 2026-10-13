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
// so a new shipped module is covered the day it is listed.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, packageDirs, shippedFiles } from "./lib/shipped-files.js";
import { issueBodyTexts } from "./lib/issue-bodies.js";

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

console.log(`\ntest-no-em-dash-shipped: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

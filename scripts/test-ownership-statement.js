#!/usr/bin/env node
// One ownership statement: NOTICE, the README, CONTRIBUTING.md and
// /llms-full.txt (src/seo.js) carry the same sentence, word for word once
// line wrapping and markdown are set aside, so no surface says less (or
// more) than the others about who owns the code.
import "./lib/offline-stores.js";
import { readFileSync } from "node:fs";

const SENTENCE = "Cardhavok LLC (doing business as Havok Holdings LLC) owns the code in this repository except a small number of trivial lines (seed URLs, a badge line, punctuation) contributed earlier under AGPL-3.0 or MIT, whose authors keep their copyright";
const flat = (t) => t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*>]/g, "").replace(/\s+/g, " ");
let pass = 0, fail = 0;
for (const file of ["NOTICE", "README.md", "CONTRIBUTING.md", "src/seo.js"]) {
  const text = flat(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
  if (text.includes(SENTENCE)) { pass++; console.log(`ok - ${file} carries the ownership statement`); }
  else { fail++; console.error(`FAIL - ${file} does not carry the ownership statement word for word`); }
}
console.log(`\ntest-ownership-statement: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

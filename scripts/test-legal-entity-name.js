// The legal entity's name has one spelling, LEGAL_ENTITY_NAME in
// src/legal-entity.js. Every tracked text file that names it (pages, terms,
// LICENSE and NOTICE files, package.json authors, markdown) must use exactly
// that spelling: another casing of the same name fails here, so a correction to
// the registered spelling is one edit in the constant followed by the files
// this test names. The pages that name the contracting party (/terms,
// /company) read the constant rather than typing the name.
//
//   node scripts/test-legal-entity-name.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LEGAL_ENTITY_NAME, LEGAL_ENTITY_SENTENCE, TRADE_NAME } from "../src/legal-entity.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

// The distinctive word of the legal name (the part before " LLC"), matched in
// any casing and with an optional space or hyphen inside, so "Card Havok" and
// "CARD-HAVOK" are caught as well as a changed capital.
const word = LEGAL_ENTITY_NAME.replace(/\s+LLC$/i, "");
const split = word.match(/^([A-Za-z]{4})(.+)$/);
const ANY_CASING = new RegExp(`${split[1]}[\\s-]?${split[2]}`, "gi");
const wrongIn = (text) => [...String(text).matchAll(ANY_CASING)].map((m) => m[0]).filter((m) => m !== word);

// Controls: the matcher sees every other casing and passes the right one.
{
  const upper = word.toUpperCase();
  const camel = word.slice(0, 4) + word[4].toUpperCase() + word.slice(5);
  ok(wrongIn(`${upper} LLC`).length === 1 && wrongIn(`${camel} LLC`).length === 1 && wrongIn(`${word.slice(0, 4)} ${word.slice(4)}`).length === 1, "control: other casings and a split name are caught");
  ok(wrongIn(`${LEGAL_ENTITY_NAME} and ${LEGAL_ENTITY_SENTENCE}`).length === 0, "control: the constant's own spelling passes");
}
ok(LEGAL_ENTITY_SENTENCE === `${LEGAL_ENTITY_NAME} (doing business as ${TRADE_NAME})`, "the sentence is built from the name and the trade name");

// Every tracked text file.
{
  const TEXT = /\.(js|mjs|cjs|ts|json|md|txt|html|css|yml|yaml|toml|sh)$|(^|\/)(LICENSE|NOTICE)[^/]*$/;
  const SELF = "scripts/test-legal-entity-name.js";
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter((f) => f && TEXT.test(f) && f !== SELF);
  ok(files.length > 100, `read ${files.length} tracked text files`);
  const bad = [];
  let named = 0;
  for (const f of files) {
    let text;
    try { text = read(f); } catch { continue; }
    const hits = [...text.matchAll(ANY_CASING)];
    if (hits.length) named++;
    for (const w of wrongIn(text)) bad.push(`${f}: ${w}`);
  }
  ok(named > 5, `${named} files name the legal entity`);
  ok(bad.length === 0, `every file spells the legal name "${LEGAL_ENTITY_NAME}"${bad.length ? `: ${bad.slice(0, 20).join("; ")}` : ""}`);
}

// The pages that name the contracting party read the constant.
for (const f of ["src/terms.js", "src/company.js"]) {
  const src = read(f);
  ok(src.includes("./legal-entity.js") && !src.includes(LEGAL_ENTITY_NAME), `${f} reads the name from src/legal-entity.js and does not type it`);
}
{
  const { termsPage } = await import("../src/terms.js");
  const { companyPage } = await import("../src/company.js");
  for (const [name, html] of [["/terms", termsPage("https://agent402.tools")], ["/company", companyPage("https://agent402.tools")]]) {
    ok(html.includes(LEGAL_ENTITY_NAME) && wrongIn(html).length === 0, `${name} names ${LEGAL_ENTITY_NAME} in that spelling only`);
  }
}
// The marks belong to the legal entity, in the repository's legal text.
for (const f of ["TRADEMARKS.md", "README.md", "NOTICE", "CONTRIBUTING.md"]) {
  const flat = read(f).replace(/\s+/g, " ");
  ok(flat.includes(`trademarks of ${LEGAL_ENTITY_NAME} (doing business as ${TRADE_NAME})`) || flat.includes(`trademarks of **${LEGAL_ENTITY_NAME}** (doing business as ${TRADE_NAME})`), `${f}: the marks are the legal entity's`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

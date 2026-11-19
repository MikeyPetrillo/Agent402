// The configuration reference covers every environment variable the server reads.
//   - every name src/ reads (scripts/lib/env-reads.js) has a purpose line in
//     docs/configuration.json, or is listed there as not a setting (notEnv);
//   - every purpose line and notEnv entry names something the code still has;
//   - every name built at run time has its pattern listed;
//   - docs/configuration.md is what scripts/gen-config-reference.js writes now;
//   - no purpose line carries a dollar figure or an em dash.
// Controls: planted sources prove the scan sees each read shape and ignores a
// name that is only mentioned in a comment.
//
//   node scripts/test-config-reference.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSource, scanTree, envNames } from "./lib/env-reads.js";
import { buildReference, CONFIG_PATH, DOC_PATH, defaultOf } from "./gen-config-reference.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const list = (a) => (a.length ? `:\n  ${a.slice(0, 40).join("\n  ")}${a.length > 40 ? `\n  ... and ${a.length - 40} more` : ""}` : "");

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const { text, scan, names } = buildReference({ config });

ok(names.length >= 500, `the scan sees the server's settings (${names.length} names)`);
const undocumented = names.filter((n) => !String(config.vars[n] || "").trim());
ok(undocumented.length === 0, `every environment variable src/ reads has a purpose line in docs/configuration.json (add it, then node scripts/gen-config-reference.js --write)${list(undocumented)}`);
const stale = Object.keys(config.vars).filter((n) => !scan.vars.has(n));
ok(stale.length === 0, `every purpose line names a variable src/ still reads (delete the others)${list(stale)}`);
const staleNot = Object.keys(config.notEnv || {}).filter((n) => !scan.vars.has(n));
ok(staleNot.length === 0, `every notEnv entry is a literal src/ still has${list(staleNot)}`);
const both = Object.keys(config.notEnv || {}).filter((n) => n in config.vars);
ok(both.length === 0, `no name is both a setting and not one${list(both)}`);
const missingPatterns = [...scan.templates.keys()].filter((t) => !String(config.patterns?.[t] || "").trim());
const stalePatterns = Object.keys(config.patterns || {}).filter((t) => !scan.templates.has(t));
ok(missingPatterns.length === 0 && stalePatterns.length === 0, `every name built at run time has its pattern listed, and no listed pattern is gone${list([...missingPatterns, ...stalePatterns])}`);
const dollars = Object.entries(config.vars).filter(([, d]) => /\$\s?\d|—/.test(d)).map(([n]) => n);
ok(dollars.length === 0, `no purpose line carries a dollar figure or an em dash${list(dollars)}`);
let cur = ""; try { cur = readFileSync(DOC_PATH, "utf8"); } catch { /* missing */ }
ok(cur === text, "docs/configuration.md is current (node scripts/gen-config-reference.js --write)");
ok(!/—/.test(text), "the generated reference has no em dash");

// Controls: each read shape is seen; a name in a comment is not.
const planted = scanSource([
  "const a = process.env.PLANTED_MEMBER || 5;",
  "const b = env[\"PLANTED_BRACKET\"];",
  "const { PLANTED_DESTRUCTURED, other } = process.env;",
  "const c = envMs(\"PLANTED_HELPER\", 1000);",
  "const d = process.env?.PLANTED_OPTIONAL;",
  "// PLANTED_COMMENT_ONLY is mentioned here",
  "/* process.env.PLANTED_BLOCK_COMMENT */",
  "const e = env[`PLANTED_TEMPLATE_${id}`];",
].join("\n"));
for (const n of ["PLANTED_MEMBER", "PLANTED_BRACKET", "PLANTED_DESTRUCTURED", "PLANTED_HELPER", "PLANTED_OPTIONAL"]) ok(planted.names.has(n), `control: the scan sees ${n}`);
ok(!planted.names.has("PLANTED_COMMENT_ONLY") && !planted.names.has("PLANTED_BLOCK_COMMENT"), "control: a name only in a comment is not a read");
ok(planted.templates.includes("PLANTED_TEMPLATE_<X>"), "control: a name built at run time is reported by its template");
ok(defaultOf("PLANTED_MEMBER", ["const a = process.env.PLANTED_MEMBER || 5;"]) === "5" && defaultOf("PLANTED_HELPER", ["envMs(\"PLANTED_HELPER\", 10_000)"]) === "10000", "control: the default is read from both fallback shapes");

// Control: a planted tree with a new read fails the coverage check.
const dir = mkdtempSync(join(tmpdir(), "a402-config-ref-"));
try {
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.js"), "export const x = process.env.PORT || 3000; export const y = process.env.PLANTED_NEW_SETTING;\n");
  const t = scanTree(join(dir, "src"), dir);
  const miss = envNames(t, config).filter((n) => !config.vars[n]);
  ok(miss.length === 1 && miss[0] === "PLANTED_NEW_SETTING", `control: a new variable with no purpose line is reported (${miss.join(", ")})`);
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

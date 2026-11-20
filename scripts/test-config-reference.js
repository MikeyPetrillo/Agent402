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
import { scanSource, scanTree, envNames, stripComments } from "./lib/env-reads.js";
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
// Comment markers inside a string, a template or a regular expression are
// text, not comments: the read after them is still seen, and a real comment
// after a quote-bearing comment still hides its name.
const literals = scanSource([
  "const accept = \"image/*\";",
  "const a = process.env.PLANTED_AFTER_STRING_STAR;",
  "const glob = 'a//b', b = process.env.PLANTED_AFTER_STRING_SLASHES;",
  "const t = `x/*${process.env.PLANTED_IN_TEMPLATE_EXPR}/*`, u = `${ { k: 1 }.k }//`;",
  "const c = process.env.PLANTED_AFTER_TEMPLATE;",
  "const re = /\\/*x/g, re2 = /[/*]/;",
  "const d = process.env.PLANTED_AFTER_REGEX;",
  "const q = n / 2 / 3; const e = process.env.PLANTED_AFTER_DIVISION;",
  "// it's a comment with a quote and process.env.PLANTED_QUOTED_COMMENT",
  "const f = process.env.PLANTED_AFTER_QUOTED_COMMENT; /* ' \" ` */",
  "const g = process.env.PLANTED_AFTER_BLOCK; /* closes */ x = 1;",
].join("\n"));
for (const n of ["PLANTED_AFTER_STRING_STAR", "PLANTED_AFTER_STRING_SLASHES", "PLANTED_IN_TEMPLATE_EXPR", "PLANTED_AFTER_TEMPLATE", "PLANTED_AFTER_REGEX", "PLANTED_AFTER_DIVISION", "PLANTED_AFTER_QUOTED_COMMENT", "PLANTED_AFTER_BLOCK"]) ok(literals.names.has(n), `a comment marker inside a string, template or regex hides no read: the scan sees ${n}`);
ok(!literals.names.has("PLANTED_QUOTED_COMMENT"), "control: a comment that holds a quote character is still a comment");
ok(stripComments("const s = \"/*\"; /* gone */ const t = 1; // gone too").replace(/\s+/g, " ").trim() === "const s = \"/*\"; const t = 1;", "stripComments keeps string text and removes only real comments");
ok(defaultOf("PLANTED_MEMBER", ["const a = process.env.PLANTED_MEMBER || 5;"]) === "5" && defaultOf("PLANTED_HELPER", ["envMs(\"PLANTED_HELPER\", 10_000)"]) === "10000", "control: the default is read from both fallback shapes");

// A default that is not a plain literal at the read site (a named constant,
// an expression, a branch) is given in docs/configuration.json `defaults`,
// and each one must equal what the code falls back to with the variable
// unset, read here from the code itself. A name the literal scan already
// reads takes no entry, and an entry with no check here fails.
{
  const srcText = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  const unset = async (names, fn) => {
    const before = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    for (const n of names) delete process.env[n];
    try { return await fn(); } finally { for (const n of names) if (before[n] !== undefined) process.env[n] = before[n]; }
  };
  const CODE_DEFAULTS = {
    COINGECKO_UNSETTLED_PER_CALLER_HOUR: async () => {
      const m = await import("../src/tools/coingecko-rate.js");
      // The read falls back to the module's exported constant.
      return /COINGECKO_UNSETTLED_PER_CALLER_HOUR\);\s*return [^;]*\?\s*n\s*:\s*CG_UNSETTLED_PER_CALLER_HOUR_DEFAULT;/.test(srcText("src/tools/coingecko-rate.js")) ? String(m.CG_UNSETTLED_PER_CALLER_HOUR_DEFAULT) : null;
    },
    // Unset reads as on: only "off" leaves the build to an operator.
    CREDITS_INDEXES: async () => (/String\(process\.env\.CREDITS_INDEXES \|\| ""\)\.toLowerCase\(\) !== "off"/.test(srcText("src/credits.js")) ? "on" : null),
    FUNNEL_FOUND_CAP: async () => unset(["FUNNEL_FOUND_CAP"], async () => String((await import("../src/funnel-sources.js?cap")).FOUND_CAP)),
    FUNNEL_FOUND_WINDOW_MS: async () => unset(["FUNNEL_FOUND_WINDOW_MS"], async () => String((await import("../src/funnel-sources.js?window")).FOUND_WINDOW_MS)),
    ROBINHOOD_RELAYER_MIN_PRICE_USD: async () => String((await import("../src/network-floors.js")).robinhoodRelayerMinPriceUsd({})),
  };
  const explicit = config.defaults || {};
  const texts = new Map();
  const literalOf = (n) => defaultOf(n, [...(scan.vars.get(n)?.files || [])].map((f) => { if (!texts.has(f)) texts.set(f, stripComments(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"))); return texts.get(f); }));
  const unknown = Object.keys(explicit).filter((n) => !(n in config.vars));
  ok(unknown.length === 0, `every defaults entry names a documented variable${list(unknown)}`);
  const shadow = Object.keys(explicit).filter((n) => literalOf(n) !== null);
  ok(shadow.length === 0, `no defaults entry stands in for a literal the scan reads at the read site${list(shadow)}`);
  const unchecked = Object.keys(explicit).filter((n) => !CODE_DEFAULTS[n]);
  ok(unchecked.length === 0, `every defaults entry has a check against the code here${list(unchecked)}`);
  for (const [n, read] of Object.entries(CODE_DEFAULTS)) {
    const code = await read();
    ok(code !== null && explicit[n] === code, `${n}: the documented default is what the code falls back to (doc ${JSON.stringify(explicit[n])}, code ${JSON.stringify(code)})`);
  }
  // The rows the code gives a default carry it in the reference.
  const rowDefault = (n) => { const line = text.split("\n").find((l) => l.startsWith(`| \`${n}\` |`)); const cells = line ? line.split(" | ") : []; return cells.length >= 4 ? cells[2].trim() : null; };
  const blank = [...Object.keys(CODE_DEFAULTS), "CREDITS_INDEX_DELAY_MS"].filter((n) => !/^`[^`]+`$/.test(rowDefault(n) || ""));
  ok(blank.length === 0, `each of these rows carries its default in docs/configuration.md${list(blank)}`);
  ok(rowDefault("FUNNEL_FOUND_CAP") === "`50000`" && rowDefault("ROBINHOOD_RELAYER_MIN_PRICE_USD") === "`0.004`", `the rows read the code's values (${rowDefault("FUNNEL_FOUND_CAP")}, ${rowDefault("ROBINHOOD_RELAYER_MIN_PRICE_USD")})`);
}

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

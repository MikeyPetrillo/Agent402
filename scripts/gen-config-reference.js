// Generate docs/configuration.md, the configuration reference: every
// environment variable the server's code (src/) names, with its purpose from
// docs/configuration.json, the default the code falls back to when that is a
// plain literal at the read site (else docs/configuration.json `defaults`,
// which scripts/test-config-reference.js checks against the code), and the
// files that read it.
//
//   node scripts/gen-config-reference.js           print what would be written
//   node scripts/gen-config-reference.js --write   write docs/configuration.md
//   node scripts/gen-config-reference.js --check   exit 1 when the file is stale
//
// A new variable is documented by adding its line to docs/configuration.json
// (`vars`), then running --write. scripts/test-config-reference.js fails on a
// variable the code reads that has no line, on a line no code reads, and on a
// stale docs/configuration.md. Values are never written here: a purpose line
// says what a setting does, and a secret's value lives only on the host.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanTree, envNames, stripComments, walk } from "./lib/env-reads.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_PATH = join(ROOT, "docs", "configuration.json");
export const DOC_PATH = join(ROOT, "docs", "configuration.md");

const LIT = String.raw`(-?\d[\d_]*(?:\.\d+)?|"[^"\n]{0,60}"|'[^'\n]{0,60}'|true|false)`;

const NUM = String.raw`\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const num = (x) => Number(x.replace(/_/g, ""));

// A numeric literal followed by arithmetic binds tighter than the `||`, `??`
// or argument it sits in, so `X || 24 * 3600_000` falls back to 86400000, not
// 24. The tail is evaluated when every operand is a number literal (* and /
// before + and -); a tail that names a constant or opens a call has no plain
// value here, so null (docs/configuration.json `defaults` gives it).
export function arithmeticTail(first, rest) {
  if (!/^\s*[*/%+-]/.test(rest)) return /^\s*[eE.]/.test(rest) ? null : first;
  const m = new RegExp(String.raw`^(?:\s*[*/%+-]\s*${NUM})+`).exec(rest);
  if (!m) return null;
  const after = rest.slice(m[0].length);
  if (/^\s*(?:[*/%+-]|\.|\(|\[|\*\*|[A-Za-z_$])/.test(after)) return null;
  const toks = [num(first)];
  for (const t of m[0].matchAll(new RegExp(String.raw`([*/%+-])\s*(${NUM})`, "g"))) toks.push(t[1], num(t[2]));
  const terms = [toks[0]];
  for (let i = 1; i < toks.length; i += 2) {
    const op = toks[i], v = toks[i + 1];
    if (op === "*") terms[terms.length - 1] *= v;
    else if (op === "/") terms[terms.length - 1] /= v;
    else if (op === "%") terms[terms.length - 1] %= v;
    else terms.push(op, v);
  }
  let v = terms[0];
  for (let i = 1; i < terms.length; i += 2) v = terms[i] === "+" ? v + terms[i + 1] : v - terms[i + 1];
  return Number.isFinite(v) ? v : null;
}

/** The first plain-literal fallback for `name` in the source texts, or null. */
export function defaultOf(name, texts) {
  const res = [
    new RegExp(String.raw`\b${name}\b["'\x60]?\]?\s*(?:\|\||\?\?)\s*${LIT}`),
    new RegExp(String.raw`\(\s*["']${name}["']\s*,\s*${LIT}`),
  ];
  for (const t of texts) {
    for (const re of res) {
      const m = re.exec(t);
      if (!m) continue;
      const raw = m[1];
      if (/^-?\d/.test(raw)) {
        const v = arithmeticTail(raw.replace(/_/g, ""), t.slice(m.index + m[0].length));
        return v === null ? null : String(v);
      }
      const v = raw.replace(/^["']|["']$/g, "");
      if (v === "") continue;
      return v;
    }
  }
  return null;
}

// A default that reads as a cost is never printed. A name is cost-shaped when
// it names a margin or markup, or a money figure (USD, BPS) of a gas, fee,
// query, relayer, exchange or vendor cost; a low-water alarm threshold is not
// a cost. Such a variable is listed in docs/configuration.json
// `withheldDefaults` and its row reads WITHHELD_DEFAULT_TEXT
// (scripts/test-config-reference.js fails a printed one).
export const WITHHELD_DEFAULT_TEXT = "not listed";
const COST_WORDS = new Set(["GAS", "COST", "COSTS", "FEE", "FEES", "QUERY", "RELAYER", "ETH", "RATE", "RATES", "VENDOR"]);
export function isCostShapedName(name) {
  const t = String(name).split("_");
  if (t.includes("MARGIN") || t.includes("MARKUP")) return true;
  if (!(t.includes("USD") || t.includes("BPS")) || t.includes("LOW")) return false;
  return t.some((w) => COST_WORDS.has(w));
}

const GROUP_MIN = 3;
const esc = (s) => String(s).replace(/[\\|]/g, "\\$&");

export function buildReference({ root = ROOT, config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) } = {}) {
  const scan = scanTree(join(root, "src"), root);
  const names = envNames(scan, config);
  const texts = new Map(walk(join(root, "src")).map((f) => [f.slice(root.length + 1), stripComments(readFileSync(f, "utf8"))]));
  const prefix = (n) => n.split("_")[0];
  const counts = new Map();
  for (const n of names) counts.set(prefix(n), (counts.get(prefix(n)) || 0) + 1);
  const groups = new Map();
  for (const n of names) {
    const g = counts.get(prefix(n)) >= GROUP_MIN ? prefix(n) : "Other";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(n);
  }
  const order = [...groups.keys()].filter((g) => g !== "Other").sort();
  if (groups.has("Other")) order.push("Other");

  const out = [];
  out.push("# Configuration reference", "");
  out.push("Generated by `node scripts/gen-config-reference.js --write` from the server's source (`src/`) and the");
  out.push("purpose lines in `docs/configuration.json`. Do not edit this file by hand:");
  out.push("`scripts/test-config-reference.js` fails when it is stale, when the code reads a variable that has no");
  out.push("purpose line, and when a purpose line names a variable no code reads.", "");
  out.push(`Scope: ${config.scope}`, "");
  out.push("Every value is set on the host, never in the repository. \"Default\" is the plain literal the code falls back to at");
  out.push("its first read site when there is one, else the value `docs/configuration.json` `defaults` gives for a fallback that is a");
  out.push("named constant, an expression or a branch (checked against the code by `scripts/test-config-reference.js`); a helper");
  out.push("may still clamp it, and the read site is the reference. A default marked \"" + WITHHELD_DEFAULT_TEXT + "\" is kept off this page; the read site");
  out.push("holds it.", "");
  out.push(`${names.length} variables in ${order.length} groups.`, "");
  out.push("## Contents", "");
  out.push(order.map((g) => `[${g}](#${g.toLowerCase()})`).join(" · "), "");
  for (const g of order) {
    out.push(`## ${g}`, "");
    out.push("| Variable | Purpose | Default | Read in |", "| --- | --- | --- | --- |");
    for (const n of groups.get(g)) {
      const files = [...scan.vars.get(n).files].sort();
      const withheld = Object.hasOwn(config.withheldDefaults || {}, n);
      const d = withheld ? null : defaultOf(n, files.map((f) => texts.get(f)).filter(Boolean)) ?? config.defaults?.[n] ?? null;
      const where = files.length > 3 ? `${files.slice(0, 3).map((f) => `\`${f}\``).join(", ")} and ${files.length - 3} more` : files.map((f) => `\`${f}\``).join(", ");
      out.push(`| \`${n}\` | ${esc(config.vars[n] || "(no purpose line)")} | ${withheld ? WITHHELD_DEFAULT_TEXT : d === null ? "" : `\`${esc(d)}\``} | ${where} |`);
    }
    out.push("");
  }
  out.push("## Names built at run time", "");
  out.push("| Pattern | Purpose | Read in |", "| --- | --- | --- |");
  for (const [t, files] of [...scan.templates].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`| \`${t}\` | ${esc(config.patterns?.[t] || "(no purpose line)")} | ${[...files].sort().map((f) => `\`${f}\``).join(", ")} |`);
  }
  out.push("");
  return { text: out.join("\n"), scan, names };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { text } = buildReference();
  if (process.argv.includes("--write")) { writeFileSync(DOC_PATH, text); console.log(`wrote ${DOC_PATH}`); }
  else if (process.argv.includes("--check")) {
    let cur = ""; try { cur = readFileSync(DOC_PATH, "utf8"); } catch { /* missing */ }
    if (cur !== text) { console.error("docs/configuration.md is stale: run node scripts/gen-config-reference.js --write"); process.exit(1); }
    console.log("docs/configuration.md is current");
  } else process.stdout.write(text);
}

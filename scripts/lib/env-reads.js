// Every environment variable the server's own code names, read statically
// from src/ (the service that runs as `node src/server.js`; facilitator/,
// workers/ and the published packages are separate programs with their own
// configuration and are not scanned).
//
// A name counts when the source
//   - reads it from an environment object: `process.env.NAME`, `env.NAME`,
//     `ENV.NAME`, or the bracket forms with a quoted NAME;
//   - destructures it from `process.env`;
//   - spells it as a quoted ALL_CAPS literal with an underscore (the shape
//     every helper takes: envMs("NAME", 5000), { env: "NAME" }, cred("NAME")),
//     unless docs/configuration.json lists that literal under `notEnv` (an
//     error code, a constant, a variable written for a child process).
// A name built at run time (`EVM_RPC_${id}`) is listed by its template under
// `patterns` in docs/configuration.json; the scan reports each template it
// finds so a new one cannot go unlisted.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const NAME = "[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*";
const MEMBER = new RegExp(`(?:process\\.env|\\benv|\\bENV)\\??\\.(${NAME})\\b`, "g");
const BRACKET = new RegExp(`(?:process\\.env|\\benv|\\bENV)\\[\\s*["'\`](${NAME})["'\`]\\s*\\]`, "g");
const DESTRUCTURE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\.env\b/g;
const LITERAL = /["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["'`]/g;
const TEMPLATE = /(?:process\.env|\benv|\bENV)\[\s*`([^`]*\$\{[^`]*)`\s*\]/g;

export function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== "generated" && f !== "node_modules") walk(p, out); }
    else if (/\.(c|m)?js$/.test(f)) out.push(p);
  }
  return out;
}

// After one of these words a "/" starts a regular expression, not a division.
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/**
 * Strip // and block comments so a name only mentioned in prose is not a read.
 * A single pass over the source: string, template and regular-expression
 * literals are copied whole (a "/*" or "//" inside one is text), and code
 * inside a template's ${...} is read as code.
 */
export function stripComments(src) {
  const n = src.length;
  let out = "";
  let i = 0;
  let prev = ""; // the last significant code character ("w" for a word or number, "x" after a closing literal)
  let word = ""; // that word, when prev is "w"
  let depth = 0; // brace depth in code
  const templates = []; // brace depth at each open ${ of a template
  const isWord = (ch) => /[A-Za-z0-9_$]/.test(ch);
  // Copy a template's text from i (just after a backtick or a closing brace
  // of ${...}) to its closing backtick or its next ${.
  const templateText = () => {
    while (i < n) {
      const ch = src[i];
      if (ch === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
      if (ch === "`") { out += ch; i++; prev = "x"; return; }
      if (ch === "$" && src[i + 1] === "{") { out += "${"; i += 2; templates.push(depth); depth++; prev = "("; return; }
      out += ch; i++;
    }
  };
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") { const j = src.indexOf("\n", i); i = j < 0 ? n : j; continue; }
    if (ch === "/" && next === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? n : j + 2; out += " "; continue; }
    if (ch === "\"" || ch === "'") {
      let j = i + 1;
      while (j < n && src[j] !== ch && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1; prev = "x"; continue;
    }
    if (ch === "`") { out += ch; i++; templateText(); continue; }
    if (ch === "/" && !(prev === "x" || prev === ")" || prev === "]" || prev === "}" || (prev === "w" && !REGEX_AFTER_WORD.has(word)))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        const c = src[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++;
      out += src.slice(i, j); i = j; prev = "x"; continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (templates.length && depth === templates[templates.length - 1]) {
        templates.pop(); out += ch; i++; templateText(); continue;
      }
    }
    if (isWord(ch)) {
      let j = i;
      while (j < n && isWord(src[j])) j++;
      word = src.slice(i, j); out += word; i = j; prev = "w"; continue;
    }
    if (!/\s/.test(ch)) prev = ch;
    out += ch; i++;
  }
  return out;
}

/**
 * Scan source text. Returns { names: Map<name, kind>, templates: string[] }
 * where kind is "read" (an environment-object read) or "literal".
 */
export function scanSource(text) {
  const src = stripComments(text);
  const names = new Map();
  const add = (n, kind) => { if (n && (kind === "read" || !names.has(n))) names.set(n, kind); };
  for (const m of src.matchAll(MEMBER)) add(m[1], "read");
  for (const m of src.matchAll(BRACKET)) add(m[1], "read");
  for (const m of src.matchAll(DESTRUCTURE)) {
    for (const part of m[1].split(",")) {
      const key = part.split(/[:=]/)[0].trim();
      if (new RegExp(`^${NAME}$`).test(key)) add(key, "read");
    }
  }
  for (const m of src.matchAll(LITERAL)) add(m[1], "literal");
  const templates = [...src.matchAll(TEMPLATE)].map((m) => m[1].replace(/\$\{[^}]*\}/g, "<X>"));
  return { names, templates };
}

/** Scan a tree. Returns { vars: Map<name, { files:Set, kind }>, templates: Map<template, Set<file>> }. */
export function scanTree(root, rel = root) {
  const vars = new Map();
  const templates = new Map();
  for (const file of walk(root)) {
    const r = relative(rel, file);
    const { names, templates: t } = scanSource(readFileSync(file, "utf8"));
    for (const [n, kind] of names) {
      const v = vars.get(n) || { files: new Set(), kind };
      v.files.add(r);
      if (kind === "read") v.kind = "read";
      vars.set(n, v);
    }
    for (const x of t) { const s = templates.get(x) || new Set(); s.add(r); templates.set(x, s); }
  }
  return { vars, templates };
}

/** The variables a description file must cover: every scanned name minus the listed non-variables. */
export function envNames(scan, config) {
  const notEnv = new Set(Object.keys(config.notEnv || {}));
  return [...scan.vars.keys()].filter((n) => !notEnv.has(n)).sort();
}

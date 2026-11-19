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

/** Strip // and block comments so a name only mentioned in prose is not a read. */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
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

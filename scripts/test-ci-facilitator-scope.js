// The facilitator gate in deploy.yml (~60 s of real Stellar testnet payments)
// runs only when facilitator/** changed. That is honest ONLY while
// facilitator/test.js and everything it imports live entirely inside
// facilitator/ - a src/ change can then never break what the gate proves.
// This pins both halves: the import closure never leaves facilitator/, and
// the workflow step still carries the scope + fail-open logic.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Every relative import/require reachable from `entry`, as absolute paths.
export function importClosure(entry) {
  const seen = new Set(); const stack = [resolve(entry)];
  while (stack.length) {
    const f = stack.pop(); if (seen.has(f)) continue;
    seen.add(f); // recorded even when missing: a dangling ../src reference is still an escape
    if (!existsSync(f)) continue;
    const src = readFileSync(f, "utf8");
    // from "./x", import "./x" (side-effect), import("./x"), require("./x")
    for (const m of src.matchAll(/(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)["']((?:\.\.?\/)[^"']+)["']/g)) {
      stack.push(resolve(dirname(f), m[1]));
    }
  }
  return [...seen];
}
export function leavesDir(files, dir) {
  const d = resolve(dir) + "/";
  return files.filter((f) => !f.startsWith(d));
}

// (1) the real closure stays inside facilitator/
const closure = importClosure(join(ROOT, "facilitator/test.js"));
ok(closure.length >= 2, `facilitator/test.js closure resolved (${closure.length} files)`);
const outside = leavesDir(closure, join(ROOT, "facilitator"));
ok(outside.length === 0, `facilitator/test.js imports nothing outside facilitator/ (found: ${outside.join(", ") || "none"})`);
const pkg = JSON.parse(readFileSync(join(ROOT, "facilitator/package.json"), "utf8"));
ok(!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((d) => d.startsWith("file:") || /agent402/.test(d)), "facilitator package depends on no local workspace package");

// (2) control: the walker SEES an escape (a walker that cannot see one proves nothing)
const tmp = mkdtempSync(join(tmpdir(), "fac-scope-"));
writeFileSync(join(tmp, "test.js"), 'import "./a.js";\n');
writeFileSync(join(tmp, "a.js"), 'import { x } from "../src/server.js";\n');
const esc = leavesDir(importClosure(join(tmp, "test.js")), tmp);
ok(esc.some((f) => f.endsWith("src/server.js")), "control: an import reaching ../src is detected through a transitive hop");

// (3) the workflow step carries the scope logic AND fails open
const yml = readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8");
const step = yml.slice(yml.indexOf("- name: Gate agent402-facilitator"), yml.indexOf("TEST_PAYER_STELLAR_SECRET: ${{ secrets.TEST_PAYER_STELLAR_SECRET }}"));
ok(/compare\/\$DIFF_BASE\.\.\.\$GITHUB_SHA/.test(step), "gate diffs DIFF_BASE...GITHUB_SHA");
ok(/\^\(facilitator\/\|Dockerfile\\\.facilitator\$\)/.test(step), "gate watches facilitator/** and its Dockerfile");
ok(!/railway\\\.facilitator/.test(step), "gate names no retired Railway config file");
ok((step.match(/fail-open/g) || []).length >= 2, "both the no-base and the unreadable-diff branches run the gate (fail-open)");
ok(/grep -qE '\^0\+\$'/.test(step), "an all-zero before SHA (first push / force-push) counts as no base");
const envStart = yml.indexOf("TEST_PAYER_STELLAR_SECRET: ${{ secrets.TEST_PAYER_STELLAR_SECRET }}");
const env = yml.slice(envStart, yml.indexOf("\n\n", envStart));
ok(/GH_TOKEN: \$\{\{ github\.token \}\}/.test(env), "step env carries GH_TOKEN");
const exprMatch = /^\s*DIFF_BASE: \$\{\{ (.*) \}\}\s*$/m.exec(env);
ok(exprMatch, "step env carries DIFF_BASE as one expression");

// (4) evaluate DIFF_BASE per event, with the expression language's rules
// (&& yields the left side when it is falsy, else the right; || the left when
// truthy, else the right; '' and null are falsy; a missing property is null).
export function evalGhExpr(src, ctx) {
  const toks = src.match(/'(?:[^']|'')*'|==|!=|&&|\|\||[()!]|[A-Za-z_][\w.-]*/g) || [];
  let i = 0;
  const peek = () => toks[i];
  const lookup = (path) => path.split(".").reduce((o, k) => (o == null ? null : (o[k] ?? null)), ctx);
  const primary = () => {
    const t = toks[i++];
    if (t === "(") { const v = or(); if (toks[i++] !== ")") throw new Error("missing )"); return v; }
    if (t === "!") return !primary();
    if (t?.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (t === "true" || t === "false") return t === "true";
    if (t === "null") return null;
    if (t && /^[A-Za-z_]/.test(t)) return lookup(t);
    throw new Error(`unexpected token ${t}`);
  };
  const cmp = () => {
    let l = primary();
    while (peek() === "==" || peek() === "!=") { const op = toks[i++]; const r = primary(); l = op === "==" ? l === r : l !== r; }
    return l;
  };
  const and = () => { let l = cmp(); while (peek() === "&&") { i++; const r = cmp(); l = l ? r : l; } return l; };
  const or = () => { let l = and(); while (peek() === "||") { i++; const r = and(); l = l ? l : r; } return l; };
  const v = or();
  if (i !== toks.length) throw new Error(`trailing tokens at ${toks[i]}`);
  return v;
}
const diffBase = (ctx) => { const v = evalGhExpr(exprMatch[1], ctx); return v == null || v === false ? "" : String(v); };
const MAIN = "refs/heads/main", DEV = "refs/heads/claude/sweet-brown-i99jl3";
// control: the evaluator reads the expression language the way the runner does
ok(evalGhExpr("a && 'x' || 'y'", { a: "" }) === "y" && evalGhExpr("a && 'x' || 'y'", { a: "1" }) === "x" && evalGhExpr("a.b.c || ''", {}) === "", "control: evaluator follows && / || / missing-property rules");
ok(diffBase({ github: { event_name: "pull_request", ref: "refs/pull/9/merge", event: { pull_request: { base: { sha: "b".repeat(40) } } } } }) === "b".repeat(40), "pull_request diffs against the PR base");
ok(diffBase({ github: { event_name: "push", ref: MAIN, event: { before: "a".repeat(40) } } }) === "a".repeat(40), "push to main diffs against the previous head");
ok(diffBase({ github: { event_name: "push", ref: DEV, event: { before: "c".repeat(40) } } }) === "main", "a dev-branch push diffs the batch against main, so a cancelled run never hides a facilitator change");
ok(diffBase({ github: { event_name: "workflow_dispatch", ref: MAIN, event: {} } }) === "", "workflow_dispatch on main has no diff base, so the gate runs (fail-open)");
ok(diffBase({ github: { event_name: "workflow_dispatch", ref: DEV, event: {} } }) === "", "workflow_dispatch on the dev branch has no diff base, so the gate runs (fail-open)");
ok(diffBase({ github: { event_name: "push", ref: MAIN, event: { before: "" } } }) === "", "a main push with no before has no diff base (never main...SHA, an empty compare)");

console.log(`ci-facilitator-scope: ${passed} passed, 0 failed`);

// The facilitator gate in deploy.yml (~60 s of real Stellar testnet payments)
// runs only when facilitator/** changed. That is honest ONLY while
// facilitator/test.js and everything it imports live entirely inside
// facilitator/ - a src/ change can then never break what the gate proves.
// This pins both halves: the import closure never leaves facilitator/, and
// the workflow step still carries the scope + fail-open logic.
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const ROOT = resolve(new URL("..", import.meta.url).pathname);

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
const env = yml.slice(yml.indexOf("TEST_PAYER_STELLAR_SECRET: ${{ secrets.TEST_PAYER_STELLAR_SECRET }}"), yml.indexOf("TEST_PAYER_STELLAR_SECRET: ${{ secrets.TEST_PAYER_STELLAR_SECRET }}") + 400);
ok(/GH_TOKEN: \$\{\{ github\.token \}\}/.test(env) && /DIFF_BASE: .*pull_request\.base\.sha.*github\.event\.before/.test(env), "step env carries GH_TOKEN and DIFF_BASE (PR base or push before)");

console.log(`ci-facilitator-scope: ${passed} passed, 0 failed`);

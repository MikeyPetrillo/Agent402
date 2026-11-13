#!/usr/bin/env node
// Every test script must actually RUN in CI.
//
//   node scripts/test-ci-coverage.js
//
// WHY: four suites written in one day — covering a paywall bypass, a router
// spend gate, a wish-board input filter and a new payment scheme — were never
// referenced in deploy.yml. Each was proven to fail under a mutation of the
// defect it guards, and each guarded nothing, because nothing ran it. A test
// that exists but is not invoked is worse than no test: it looks like coverage
// on the file listing and in the commit message, and it is the same class of
// error as a green result that means nothing.
//
// Writing a test and wiring a test are separate acts, and only one of them was
// ever enforced. This enforces the other.
//
// Suites that legitimately do not belong in the main test job are listed in
// EXEMPT with a REASON — a named exemption is a decision, an unreferenced file
// is an accident, and the point is to make the two distinguishable.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expandedDeployWorkflow, laneManifestProblems } from "./lib/ci-workflow.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Deliberately not in the main test job. Each needs a reason, not just a slot.
const EXEMPT = new Map([
  ["test-all.js", "invoked with TARGET_URL against a booted server by its own step"],
  ["test-gates.js", "mutation runner; boots servers and rewrites files — runs in its own step"],
  ["test-ci-coverage.js", "this file"],
]);

const scripts = readdirSync(join(ROOT, "scripts"))
  .filter((f) => /^test-.*\.js$/.test(f))
  .sort();
ok(scripts.length > 100, `found the test corpus (${scripts.length} suites)`);

// Any workflow may invoke a suite, not only deploy.yml. deploy.yml's test lists
// live in scripts/ci/lanes and count only through a step that runs them, so it
// is read expanded (scripts/lib/ci-workflow.js): a section no step runs is not
// coverage.
const workflowText = readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => (f === "deploy.yml" ? expandedDeployWorkflow() : readFileSync(join(WORKFLOWS, f), "utf8")))
  .join("\n");
const manifest = laneManifestProblems();
ok(manifest.length === 0, manifest.length ? `scripts/ci/lanes and deploy.yml agree: ${manifest.join("; ")}` : "every scripts/ci/lanes section is run by exactly one deploy.yml step of its own lane");
ok(workflowText.length > 0, "workflow files are readable");

const orphaned = scripts.filter((f) => !EXEMPT.has(f) && !workflowText.includes(`scripts/${f}`));
ok(
  orphaned.length === 0,
  orphaned.length
    ? `every test script is invoked by a workflow — ${orphaned.length} ORPHANED: ${orphaned.join(", ")}`
    : `every test script is invoked by a workflow (${scripts.length - EXEMPT.size} wired, ${EXEMPT.size} exempt)`
);

// An exemption for a file that no longer exists is stale bookkeeping, and a
// stale exemption list is how a real orphan hides later.
const stale = [...EXEMPT.keys()].filter((f) => !scripts.includes(f));
ok(stale.length === 0, stale.length ? `EXEMPT names a missing file: ${stale.join(", ")}` : "no stale exemptions");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

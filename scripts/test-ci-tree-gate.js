#!/usr/bin/env node
// The tree gate lets a push to main SKIP the full suite when the tree it is
// about to deploy already went green on the dev branch. That is 13 minutes off
// every change and one wrong answer away from shipping untested code, so every
// assertion here is about REFUSING to skip.
//
// It also checks the workflow wiring, which is where the actual danger is: a
// SKIPPED `needs` job skips its dependents unless they carry a status function,
// and adding one removes the implicit success() that was the whole "cannot ship
// without tests" guarantee. Both directions are pinned.
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { decideSkip } from "./ci-tree-gate.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };
const T = "a".repeat(40), U = "b".repeat(40);
const base = { eventName: "push", ref: "refs/heads/main", currentTree: T, passedTrees: [U, T] };

// --- the one case it exists for ---------------------------------------------
ok(decideSkip(base).skip === true, "an identical tree that already passed was not skipped");

// --- refuses on anything less than proof ------------------------------------
ok(decideSkip({ ...base, passedTrees: [U] }).skip === false, "skipped a tree that never passed");
ok(decideSkip({ ...base, passedTrees: [] }).skip === false, "skipped with no green run to compare against");
ok(decideSkip({ ...base, passedTrees: null }).skip === false, "skipped on an unreadable green-run list");
ok(decideSkip({ ...base, currentTree: "" }).skip === false, "skipped without knowing its own tree");
ok(decideSkip({ ...base, currentTree: undefined }).skip === false, "skipped on an undefined tree");
ok(decideSkip({}).skip === false, "skipped on empty input");

// A short or malformed hash must never satisfy the comparison. Git abbreviates
// to different lengths at different repo sizes, and "close enough" is not a
// property that may skip a test suite.
ok(decideSkip({ ...base, currentTree: T.slice(0, 12), passedTrees: [T.slice(0, 12)] }).skip === false,
  "an abbreviated hash was accepted as proof");
ok(decideSkip({ ...base, currentTree: T.toUpperCase(), passedTrees: [T.toUpperCase()] }).skip === false,
  "a non-canonical (uppercase) hash was accepted");
// One bad entry means the lookup itself is suspect - do not cherry-pick the
// well-formed rows out of a result we have reason to distrust.
ok(decideSkip({ ...base, passedTrees: [T, "not-a-hash"] }).skip === false,
  "skipped from a green-run list containing an unreadable entry");

// --- only a push to main is ever eligible -----------------------------------
ok(decideSkip({ ...base, eventName: "pull_request" }).skip === false,
  "skipped a pull_request run - that IS the required status check on the PR");
ok(decideSkip({ ...base, eventName: "workflow_dispatch" }).skip === false,
  "skipped a dispatch - a human explicitly asked for a run");
ok(decideSkip({ ...base, eventName: "schedule" }).skip === false, "skipped a scheduled run");
ok(decideSkip({ ...base, ref: "refs/heads/claude/sweet-brown-i99jl3" }).skip === false,
  "skipped a dev-branch push - that run is what EARNS the green tree");
ok(decideSkip({ ...base, ref: "refs/heads/other" }).skip === false, "skipped a push to some other branch");
ok(decideSkip({ ...base, ref: undefined }).skip === false, "skipped without knowing the ref");

// --- workflow wiring --------------------------------------------------------
const wf = load(readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"));
const jobs = wf.jobs;
// Derived, not listed. A hardcoded copy here would have gone stale the moment
// test-unit-c was added and quietly stopped checking the new lane - the exact
// drift this file exists to catch in the workflow.
const LANES = Object.entries(jobs)
  .filter(([n, j]) => /^test(-|$)/.test(n) &&
    (j.steps || []).some((s) => /node\s+scripts\/test-[\w.-]+\.js/.test(String(s.run || ""))))
  .map(([n]) => n);

ok(jobs["tree-gate"], "the tree-gate job is gone");
ok(String(jobs["tree-gate"].if).includes("refs/heads/main"),
  "tree-gate can run outside a push to main");

for (const lane of LANES) {
  const j = jobs[lane];
  ok([].concat(j.needs).includes("tree-gate"), `${lane} does not depend on tree-gate`);
  // Without a status function, tree-gate being SKIPPED (every dev-branch and PR
  // run) would skip the lane too - the suite would silently stop running.
  ok(String(j.if).includes("!cancelled()"),
    `${lane} has no status function, so a skipped tree-gate would skip it on every dev-branch run`);
  ok(String(j.if).includes("needs.tree-gate.outputs.skip != 'true'"),
    `${lane} does not honour the gate`);
}

for (const gate of ["deploy", "publish"]) {
  const cond = String(jobs[gate].if);
  ok([].concat(jobs[gate].needs).includes("tree-gate"), `${gate} does not depend on tree-gate`);
  // Adding !cancelled() drops the implicit success() on `needs`. If the success
  // requirement is not then written out, a FAILING lane no longer blocks a
  // release - the exact way a speed change becomes a safety change.
  if (cond.includes("!cancelled()")) {
    for (const lane of LANES) {
      ok(cond.includes(`needs.${lane}.result == 'success'`),
        `${gate} uses !cancelled() but never requires ${lane} to have SUCCEEDED - a failing lane would not block the release`);
    }
    ok(cond.includes("needs.tree-gate.outputs.skip == 'true'"),
      `${gate} allows skipped lanes without requiring the gate's proof`);
  }
}

// --- a candidate SHA must be shape-checked before it becomes an argv entry --
// Nothing here is injectable today (execFileSync, no shell) and GitHub returns
// real 40-hex SHAs, but `git fetch ... origin <value>` reads a leading-dash
// value as a FLAG, so without this the safety of that call rests on an upstream
// output format rather than on anything we verify. Raised as hardening in the
// 2026-08-24 security review.
const gateSrc = readFileSync(new URL("./ci-tree-gate.js", import.meta.url), "utf8");
const loop = gateSrc.slice(gateSrc.indexOf("const passedTrees = []"), gateSrc.indexOf("const verdict = decideSkip"));
ok(/if \(!isSha\(sha\)\) continue;/.test(loop),
  "candidate SHAs reach `git fetch`/`git rev-parse` without a shape check");
ok(loop.indexOf("isSha(sha)") < loop.indexOf("git(\"cat-file\""),
  "the shape check must run BEFORE the value is passed to git, not after");

// Every subprocess is bounded and the read has a deadline (2026-09-22): a gh
// call that stalled on GitHub's secondary rate limit held the job to its
// 5-minute limit, which reads as a cancelled run on a green main. Fail-closed
// on "" already, so the timeout costs nothing but the skip.
const helpers = gateSrc.slice(gateSrc.indexOf("const git = "), gateSrc.indexOf("const currentTree"));
ok((helpers.match(/timeout: CALL_TIMEOUT_MS/g) || []).length === 2, "both subprocess helpers carry a timeout");
ok(/for \(const r of runs\) \{\s*\n\s*if \(Date\.now\(\) > DEADLINE\)/.test(gateSrc), "the run-listing loop stops at the deadline");
ok(/for \(const sha of shas\) \{\s*\n\s*if \(Date\.now\(\) > DEADLINE\)/.test(gateSrc), "the tree-resolving loop stops at the deadline");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// Splitting the test suite into parallel lanes is a speed change that can
// silently become a SAFETY change: a lane that nothing depends on still shows
// its own red X while `deploy` sails past it. That is how a money guard stops
// blocking a release without anyone editing the guard.
//
// This asserts the property directly - every lane that runs tests gates deploy
// and publish - so the next lane split fails here instead of in production.
import { readFileSync, existsSync } from "node:fs";
import { load } from "js-yaml";

const wf = load(readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };

const jobs = wf.jobs || {};
// A "test lane" is any job whose steps actually run scripts/test-*.js. Derived,
// never a list: a hand-kept list is the thing that just went wrong one layer up.
const laneRunsTests = (j) =>
  (j.steps || []).some((s) => /node\s+scripts\/test-[\w.-]+\.js/.test(String(s.run || "")));
// Scoped to the `test*` lanes: paytest, publish and deploy also run scripts,
// but they are opt-in or post-deploy jobs, not the gating suite.
const lanes = Object.entries(jobs)
  .filter(([n, j]) => /^test(-|$)/.test(n) && laneRunsTests(j))
  .map(([n]) => n);

ok(lanes.length >= 4, `expected the split test lanes, found: ${lanes.join(", ")}`);
ok(lanes.includes("test-pricing"), "the pricing-margin lane is not detected as a test lane");

for (const gate of ["deploy", "publish"]) {
  const needs = [].concat(jobs[gate]?.needs || []);
  for (const lane of lanes) {
    ok(needs.includes(lane),
      `${gate} does not gate on the "${lane}" lane - that lane's failures cannot stop a release`);
  }
}

// The lanes must also be reachable at all: a lane whose `if:` never fires on a
// push to main is a guard that silently never runs.
for (const lane of lanes) {
  const cond = String(jobs[lane]?.if || "");
  ok(cond.includes("refs/heads/main"),
    `lane "${lane}" has no push-to-main condition, so a merge would skip it`);
}

// Chromium is expensive and only one lane needs it. Assert the pairing rather
// than the absence, so adding a browser test to a lane without the install
// fails here instead of at runtime.
// Whether a script drives a browser is read from the SCRIPT ITSELF, never from
// a name pattern. The first draft matched /reveal-[\w-]+/ and flagged
// test-reveal-no-hero-flash.js, which only reads source files - a name-shaped
// oracle inventing a dependency that does not exist. The import list is the
// only thing that actually decides whether Chromium is needed.
const scriptsIn = (j) => (j.steps || [])
  .flatMap((s) => [...String(s.run || "").matchAll(/scripts\/([\w.-]+\.js)/g)].map((m) => m[1]));
const needsBrowser = (file) => {
  const path = new URL(`../scripts/${file}`, import.meta.url);
  if (!existsSync(path)) return false;
  return /from\s+["'](playwright|puppeteer)|require\(["'](playwright|puppeteer)/.test(readFileSync(path, "utf8"));
};

for (const [name, j] of Object.entries(jobs)) {
  const steps = j.steps || [];
  const usesBrowser = scriptsIn(j).some(needsBrowser);
  const installs = steps.some((s) => /playwright install/.test(String(s.run || "")));
  if (usesBrowser) ok(installs, `job "${name}" runs a browser-driven script without installing Chromium`);
  if (installs) ok(usesBrowser, `job "${name}" installs Chromium but runs no browser-driven script - pure wasted minutes`);
}

// --- a job that runs our scripts must be able to run them ------------------
// tree-gate shipped without an install step and its first real run died on a
// missing dependency. It failed closed so nothing was released untested, but a
// guard that cannot execute saves nothing, and nothing here would have noticed
// - the job simply went red beside a green suite.
//
// "Needs node_modules" is read from the SCRIPTS, transitively through their own
// relative imports, never from the job's name. The first draft asked only "does
// this job run node scripts/" and flagged `probe`, whose script imports nothing
// but node:url - the same name-shaped guessing this file already had to remove
// once for Chromium.
const bareImportsIn = (file, seen = new Set()) => {
  const path = new URL(`../${file}`, import.meta.url);
  if (seen.has(path.href) || !existsSync(path)) return false;
  seen.add(path.href);
  const src = readFileSync(path, "utf8");
  // Static AND dynamic. The first version matched only `from "x"` / `import "x"`
  // and so missed `await import("x")` - which is exactly how ci-tree-gate.js
  // loads js-yaml, meaning the guard did not catch the very bug it was written
  // for. The mutation that removes the gate's install step passed a green run.
  const specs = [
    ...[...src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...src.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
    ...[...src.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
  ];
  for (const spec of specs) {
    if (spec.startsWith("node:")) continue;
    if (!spec.startsWith(".")) return true;           // a real package
    const rel = new URL(spec, path);
    const relFile = rel.pathname.slice(new URL("../", import.meta.url).pathname.length);
    if (bareImportsIn(relFile, seen)) return true;
  }
  return false;
};
for (const [name, j] of Object.entries(jobs)) {
  const steps = j.steps || [];
  const files = steps.flatMap((s) => [...String(s.run || "").matchAll(/(scripts\/[\w.-]+\.js)/g)].map((m) => m[1]));
  if (!files.length) continue;
  const needsModules = files.some((f) => bareImportsIn(f));
  if (!needsModules) continue;
  const installs = steps.some((s) => /npm (ci|install)/.test(String(s.run || "")));
  ok(installs, `job "${name}" runs a script that imports a package but never installs dependencies - it dies on the first import`);
}

// --- the sweep hand-over must be a hand-over, not a drop ---------------------
// test-all.js skips every route the strict non-metered sweep asserts on when
// TEST_ALL_SKIP_STRICT_COVERED=1. That is only sound if the strict sweep runs
// in the SAME job, BEFORE it, against the same server, and can fail the job.
// Move either step, or give the strict one continue-on-error, and ~450 routes
// are quietly swept by nobody - so the pairing is asserted here, not assumed.
for (const [name, j] of Object.entries(jobs)) {
  const steps = j.steps || [];
  const idxAll = steps.findIndex((s) => /TEST_ALL_SKIP_STRICT_COVERED=1[^\n]*scripts\/test-all\.js/.test(String(s.run || "")));
  if (idxAll < 0) continue;
  const idxStrict = steps.findIndex((s) => /scripts\/test-non-metered-examples\.js/.test(String(s.run || "")));
  ok(idxStrict >= 0 && idxStrict < idxAll,
    `job "${name}" runs test-all with the strict hand-over but the strict sweep does not run earlier in the same job`);
  if (idxStrict >= 0) ok(!steps[idxStrict]["continue-on-error"],
    `job "${name}": the strict sweep is continue-on-error, so the routes handed to it could fail without failing the lane`);
}

// --- the marker has to live where `markers` actually looks ----------------
// PR #1336 shipped with [test][publish] in its TITLE, every check green, and
// the publish job SKIPPED: `markers` parses SUBJECT LINES ONLY over the push
// range, and merge-on-green.sh merges with `--merge`, which puts the PR title
// in the merge commit's BODY. The fix that reached prod never reached npm.
// Pinned from source in both directions so the two cannot drift apart again.
{
  const wfText = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  const mog = readFileSync(new URL("./merge-on-green.sh", import.meta.url), "utf8");
  const subjectsOnly = /git log[^\n]*--format='%s'/.test(wfText);
  ok(subjectsOnly, "markers parses commit SUBJECT lines (the constraint the docs have to match)");
  const mergeStyle = /gh pr merge[^\n]*--squash/.test(mog) ? "squash" : "merge";
  ok(mergeStyle === "merge", "merge-on-green.sh merges with --merge (PR title lands in the BODY)");
  // If either side ever changes, the guidance below is what has to change with it.
  const claude = readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8");
  ok(/marker in a COMMIT SUBJECT/.test(claude),
     "CLAUDE.md tells the next author to put the marker in a commit SUBJECT, not the PR title");
  ok(!/put the marker in the PR TITLE so the merge commit carries it/.test(claude),
     "...and no longer carries the advice that silently skipped a publish");

  // The helper reads production's ledgerDeadLetter word before it merges and
  // refuses on the two words the deploy job's quiet gate holds on (a money
  // journal entry waiting on a container's local disk); an unreadable word
  // continues, because the gate in CI is the enforcement. Pinned to the order:
  // the read has to come before `gh pr merge`, or it reads nothing in time.
  const mergeAt = mog.indexOf("gh pr merge ");
  const readAt = mog.indexOf(".ledgerDeadLetter.status");
  ok(readAt > 0 && mergeAt > readAt, "merge-on-green.sh reads ledgerDeadLetter.status from /api/gateway-status before gh pr merge");
  ok(/\n\s*local\|stuck\)[^\n]*exit 1/.test(mog), "...and exits 1 without merging on local or stuck");
  ok(/\n\s*""\)[^\n]*continuing/.test(mog), "...and continues when the word is unreadable");
  const gate = readFileSync(new URL("./deploy-quiet-gate.js", import.meta.url), "utf8");
  ok(/LEDGER_HOLD_WORDS = new Set\(\["local", "stuck"\]\)/.test(gate), "the quiet gate holds on the same two words");
}

console.log(`${pass} passed, ${fail} failed`);


process.exit(fail ? 1 : 0);

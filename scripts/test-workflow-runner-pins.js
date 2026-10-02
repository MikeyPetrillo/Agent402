// Every workflow job runs on a NAMED runner image, never a moving `-latest`
// label.
//
//   node scripts/test-workflow-runner-pins.js
//
// WHY: a floating label changes the operating system under a job on GitHub's
// schedule rather than ours (ubuntu-latest moves to the next LTS image in a
// rollout window), and the first sign is a step that stops finding a package
// or a tool. Every runs-on site was pinned to ubuntu-24.04 in one sweep, and a
// workflow added after that sweep shipped with ubuntu-latest anyway, because
// nothing checked. A sweep with no guard behind it only fixes the files that
// existed on the day it ran.
//
// A job that calls a reusable workflow (`uses:` at job level) has no runs-on of
// its own: the called workflow picks its runner, so it is counted and skipped.
// An expression (`${{ matrix.os }}`) is refused too - it cannot be read here,
// and a matrix entry is the same pin written somewhere else; spell the images
// out, or extend this rule deliberately.
//
// Offline: reads .github/workflows only.
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, ".github", "workflows");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// A GitHub-hosted image named by version. Anything else (a -latest label, an
// expression, a self-hosted label) is refused until someone decides otherwise.
const PINNED = /^(ubuntu-\d{2}\.\d{2}(-arm)?|macos-\d+(-intel|-large|-xlarge)?|windows-\d{4}(-arm)?)$/;

// Returns one problem string per unpinned runs-on label in a workflow document.
function runnerProblems(text, file = "workflow") {
  const doc = load(text) || {};
  const problems = [];
  const stats = { jobs: 0, reusable: 0, pinned: 0 };
  for (const [name, job] of Object.entries(doc.jobs || {})) {
    stats.jobs++;
    if (job && typeof job.uses === "string") { stats.reusable++; continue; }
    const raw = job ? job["runs-on"] : undefined;
    if (raw === undefined) { problems.push(`${file}: job "${name}" has no runs-on`); continue; }
    const labels = Array.isArray(raw) ? raw
      : raw && typeof raw === "object" ? [].concat(raw.labels || [], raw.group ? [`group:${raw.group}`] : [])
      : [raw];
    const bad = labels.map(String).filter((l) => !PINNED.test(l.trim()));
    if (bad.length) problems.push(`${file}: job "${name}" runs-on ${bad.map((l) => JSON.stringify(l)).join(", ")} (name a versioned image, e.g. ubuntu-24.04)`);
    else stats.pinned++;
  }
  return { problems, stats };
}

// --- control: the checker must see the defect before a clean sweep counts ---
const planted = [
  "jobs:",
  "  a:",
  "    runs-on: ubuntu-latest",
  "    steps: [{ run: 'true' }]",
  "  b:",
  "    runs-on: ${{ matrix.os }}",
  "    steps: [{ run: 'true' }]",
  "  c:",
  "    runs-on: [macos-latest]",
  "    steps: [{ run: 'true' }]",
  "  d:",
  "    runs-on: ubuntu-24.04",
  "    steps: [{ run: 'true' }]",
  "  e:",
  "    uses: owner/repo/.github/workflows/x.yml@0123456789abcdef0123456789abcdef01234567",
].join("\n");
const control = runnerProblems(planted, "control.yml");
ok(control.problems.length === 3, `control: ubuntu-latest, an expression and macos-latest are all refused (found ${control.problems.length})`);
ok(control.stats.pinned === 1 && control.stats.reusable === 1, "control: a pinned image passes and a reusable-workflow call is skipped");

// --- the real sweep ---------------------------------------------------------
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
ok(files.length > 50, `found the workflow directory (${files.length} files)`);
const totals = { jobs: 0, reusable: 0, pinned: 0 };
const problems = [];
for (const f of files) {
  const r = runnerProblems(readFileSync(join(DIR, f), "utf8"), f);
  problems.push(...r.problems);
  for (const k of Object.keys(totals)) totals[k] += r.stats[k];
}
ok(totals.pinned > 90, `read the runs-on of every job (${totals.pinned} pinned, ${totals.reusable} reusable-workflow calls, ${totals.jobs} jobs)`);
for (const p of problems) ok(false, p);
if (!problems.length) ok(true, `every job names a versioned runner image (${files.length} workflows)`);

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// deploy.yml with its test lists put back in place, for the workflow guards.
//
// The long per-lane test lists live in scripts/ci/lanes/<lane>.sh (one
// "# @step N" section per workflow step) and a step runs its list with
// `run: bash scripts/ci/run-step.sh <lane> N`, which keeps deploy.yml under
// GitHub's 500 KB workflow limit. A guard that reads which scripts a lane runs
// reads expandedDeployWorkflow(): each runner step becomes the `run: |` block
// it stands for (`set -euo pipefail`, the runner's own `t` line for a sharded or
// an unsharded lane, then the section), so the guards read the same text the
// steps carried inline before the move.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { load } from "js-yaml";

const ROOT = new URL("../../", import.meta.url);
export const RUNNER = "scripts/ci/run-step.sh";
export const LANES_DIR = "scripts/ci/lanes";
const RUN_LINE = /^(\s*)run: bash scripts\/ci\/run-step\.sh (\S+) (\S+)\s*$/;

/** The two `t` definitions the runner chooses between, read from the runner itself. */
export function runnerTDefs(root = ROOT) {
  const defs = readFileSync(new URL(RUNNER, root), "utf8").split("\n").map((l) => l.trim()).filter((l) => /^t\(\) \{/.test(l));
  if (defs.length !== 2 || !/CI_SHARDS/.test(defs[0]) || /CI_SHARDS/.test(defs[1])) throw new Error(`${RUNNER} must define t twice: the sharded one first, then the plain one`);
  return { sharded: defs[0], plain: defs[1] };
}

/** Sections of one lane file: Map(id -> body lines), the same split the runner's awk makes. */
export function laneSections(lane, root = ROOT) {
  const path = new URL(`${LANES_DIR}/${lane}.sh`, root);
  if (!existsSync(path)) throw new Error(`${LANES_DIR}/${lane}.sh does not exist`);
  const out = new Map(), seen = new Map();
  let cur = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.startsWith("# @step ")) {
      const id = line.split(/\s+/)[2].replace(/:$/, "");
      seen.set(id, (seen.get(id) || 0) + 1);
      cur = [];
      out.set(id, cur);
      continue;
    }
    if (cur) cur.push(line);
  }
  for (const [id, n] of seen) if (n !== 1) throw new Error(`${LANES_DIR}/${lane}.sh has ${n} sections "# @step ${id}"`);
  for (const lines of out.values()) while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return out;
}

/** Every lane file and its section ids. */
export function allLaneSections(root = ROOT) {
  const dir = new URL(`${LANES_DIR}/`, root);
  if (!existsSync(dir)) return new Map();
  return new Map(readdirSync(dir).filter((f) => f.endsWith(".sh")).sort().map((f) => [f.slice(0, -3), laneSections(f.slice(0, -3), root)]));
}

/**
 * Expand every runner step of a workflow's text. Throws when a step names a
 * lane other than its own job, or a section that does not exist.
 * Returns { text, refs: [{ lane, step }] }.
 */
export function expandWorkflow(text, root = ROOT) {
  const wf = load(text) || {};
  const defs = runnerTDefs(root);
  const cache = new Map();
  const refs = [];
  const out = [];
  let inJobs = false, job = null;
  for (const line of text.split("\n")) {
    if (/^jobs:/.test(line)) inJobs = true;
    const jm = inJobs && /^ {2}([\w-]+):\s*$/.exec(line);
    if (jm) job = jm[1];
    const m = RUN_LINE.exec(line);
    if (!m) { out.push(line); continue; }
    const [, ind, lane, step] = m;
    if (lane !== job) throw new Error(`job ${job} runs the list of lane ${lane}: a step runs only its own lane's list`);
    if (!cache.has(lane)) cache.set(lane, laneSections(lane, root));
    const body = cache.get(lane).get(step);
    if (!body) throw new Error(`${LANES_DIR}/${lane}.sh has no section "# @step ${step}"`);
    refs.push({ lane, step });
    const sharded = wf.jobs?.[job]?.env?.CI_SHARDS !== undefined;
    const pad = `${ind}  `;
    out.push(`${ind}run: |`, `${pad}set -euo pipefail`, `${pad}${sharded ? defs.sharded : defs.plain}`, ...body.map((b) => (b.trim() === "" ? "" : pad + b)));
  }
  return { text: out.join("\n"), refs };
}

/** deploy.yml as committed (the size GitHub reads). */
export function rawDeployWorkflow(root = ROOT) {
  return readFileSync(new URL(".github/workflows/deploy.yml", root), "utf8");
}

/** deploy.yml with every test list in place: what a guard reads to see which scripts run where. */
export function expandedDeployWorkflow(root = ROOT) {
  return expandWorkflow(rawDeployWorkflow(root), root).text;
}

/** Problems linking the lane files to deploy.yml: a section no step runs, a step run twice, a lane file with no job. */
export function laneManifestProblems(root = ROOT) {
  const problems = [];
  let refs = [];
  try { refs = expandWorkflow(rawDeployWorkflow(root), root).refs; } catch (e) { return [e.message]; }
  const count = new Map();
  for (const { lane, step } of refs) count.set(`${lane} ${step}`, (count.get(`${lane} ${step}`) || 0) + 1);
  for (const [k, n] of count) if (n > 1) problems.push(`deploy.yml runs section ${k} ${n} times`);
  let all;
  try { all = allLaneSections(root); } catch (e) { return [...problems, e.message]; }
  for (const [lane, sections] of all) {
    if (!refs.some((r) => r.lane === lane)) problems.push(`${LANES_DIR}/${lane}.sh is run by no deploy.yml step`);
    for (const id of sections.keys()) if (!count.has(`${lane} ${id}`)) problems.push(`${LANES_DIR}/${lane}.sh section "# @step ${id}" is run by no deploy.yml step`);
  }
  return problems;
}

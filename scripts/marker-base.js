#!/usr/bin/env node
// Prints the commit the markers job of deploy.yml reads subjects FROM on a push
// to main: the head of the newest earlier push run on this branch whose
// `markers` job finished (so its commit subjects were read), or nothing.
//
// Why: nothing on main is canceled in progress, and GitHub keeps one pending
// run per concurrency group. Of two merges queued behind a running release only
// the newer run starts, and its push range (before..after) holds only its own
// commits: a marker in a subject of the replaced push ([publish], [paytest],
// [drain], [probe], [purl]) was read by no run. Reading from the last run that
// did read its range covers the replaced pushes, and a subject is read by
// exactly one run: the next run starts from this one's head.
//
// A run counts as having read its range when its `markers` job concluded
// success. A run replaced while pending never started that job; a run that
// failed later (a red lane) still read its markers, as it does today.
//
// Reads (GITHUB_TOKEN with actions: read):
//   GET /repos/{repo}/actions/workflows/{file}/runs?branch=&event=push
//   GET /repos/{repo}/actions/runs/{id}/jobs
// Prints one 40-hex SHA and exits 0, or prints nothing and exits 0 when no such
// run is found or GitHub cannot be read (the reason goes to stderr); the caller
// then reads the pushed range alone, as before. It never fails the job: a
// release is not held on this lookup. The whole lookup has one deadline
// (MARKER_BASE_DEADLINE_MS, default 40 s, well inside the markers job's
// timeout): past it the pushed range is read, as on an API error, however
// many reads are still waiting.
//
//   GITHUB_REPOSITORY, GITHUB_RUN_NUMBER, GITHUB_REF_NAME, GITHUB_API_URL,
//   GH_TOKEN, MARKER_WORKFLOW_FILE (default deploy.yml), MARKER_BASE_DEADLINE_MS
import { fileURLToPath } from "node:url";

const SHA_RE = /^[0-9a-f]{40}$/;
export const MAX_RUNS_READ = 10;   // earlier runs whose jobs are read before giving up
const RUNS_PAGE = 50;
const JOB_PAGES = 3;
export const DEADLINE_MS_DEFAULT = 40_000;
/** The whole lookup's deadline: a positive MARKER_BASE_DEADLINE_MS up to the default, else the default. */
export function deadlineMs(env = process.env) {
  const n = Number(env.MARKER_BASE_DEADLINE_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, DEADLINE_MS_DEFAULT) : DEADLINE_MS_DEFAULT;
}

/**
 * The newest earlier push run that read its markers.
 * @param {object} o
 * @param {Array<{id:number,run_number:number,head_sha:string,event?:string,head_branch?:string}>} o.runs  the branch's runs, any order
 * @param {number} o.runNumber   this run's number; only lower numbers are earlier
 * @param {(run:object)=>Promise<Array<{name:string,conclusion:string|null}>>} o.jobsOf
 * @returns {Promise<{sha:string|null, read:number, skipped:Array<number>}>}
 */
export async function lastReadRun({ runs, runNumber, jobsOf, maxRead = MAX_RUNS_READ }) {
  const earlier = (runs || [])
    .filter((r) => r && Number.isInteger(r.run_number) && r.run_number < runNumber && (r.event === undefined || r.event === "push") && SHA_RE.test(String(r.head_sha || "")))
    .sort((a, b) => b.run_number - a.run_number);
  const skipped = [];
  let read = 0;
  for (const run of earlier) {
    if (read >= maxRead) break;
    read++;
    const jobs = await jobsOf(run);
    if ((jobs || []).some((j) => j && j.name === "markers" && j.conclusion === "success")) return { sha: run.head_sha, read, skipped };
    skipped.push(run.run_number);
  }
  return { sha: null, read, skipped };
}

async function getJson(url, token) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(15_000) });
      if (r.status === 200) return await r.json();
      await r.arrayBuffer().catch(() => {});
      last = new Error(`HTTP ${r.status}`);
      if (r.status >= 400 && r.status < 500 && r.status !== 429) break;
    } catch (e) { last = e; }
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
  throw last;
}

async function main() {
  const api = String(process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const repo = String(process.env.GITHUB_REPOSITORY || "");
  const branch = String(process.env.GITHUB_REF_NAME || "");
  const runNumber = Number(process.env.GITHUB_RUN_NUMBER);
  const file = String(process.env.MARKER_WORKFLOW_FILE || "deploy.yml");
  const token = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !branch || !Number.isInteger(runNumber) || !/^[\w.-]+$/.test(file)) {
    console.error("marker-base: repository, branch or run number missing; reading the pushed range only");
    return;
  }
  const base = `${api}/repos/${repo}/actions`;
  const list = await getJson(`${base}/workflows/${encodeURIComponent(file)}/runs?branch=${encodeURIComponent(branch)}&event=push&per_page=${RUNS_PAGE}`, token);
  const jobsOf = async (run) => {
    const all = [];
    for (let page = 1; page <= JOB_PAGES; page++) {
      const j = await getJson(`${base}/runs/${encodeURIComponent(String(run.id))}/jobs?per_page=100&page=${page}`, token);
      const got = Array.isArray(j.jobs) ? j.jobs : [];
      all.push(...got);
      if (got.length < 100) break;
    }
    return all;
  };
  const { sha, read, skipped } = await lastReadRun({ runs: list.workflow_runs, runNumber, jobsOf });
  console.error(`marker-base: read ${read} earlier run(s); ${skipped.length} did not read their markers${skipped.length ? ` (run ${skipped.join(", ")})` : ""}; base ${sha || "none"}`);
  if (sha) console.log(sha);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ms = deadlineMs();
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => { console.error(`marker-base: no answer within the ${Math.round(ms / 1000)} s deadline; reading the pushed range only`); resolve(); }, ms); });
  Promise.race([
    main().catch((e) => { console.error(`marker-base: GitHub could not be read (${String(e && e.message || e).slice(0, 200)}); reading the pushed range only`); }),
    deadline,
  ]).finally(() => { clearTimeout(timer); process.exit(0); });
}

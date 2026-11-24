#!/usr/bin/env node
// How many scheduled runs of the 402 Index price sync in a row, before this
// one, ended with the index unavailable (exit 4: no answer, 429 or 5xx,
// asked twice). The sync step marks such a run with a warning annotation
// titled UNAVAILABLE_TITLE; this reads the newest completed scheduled runs of
// the workflow (this run excluded) and counts those marks back to the first
// run without one. The workflow pages once this streak plus the current run
// reaches INDEX402_UNAVAILABLE_PAGE_RUNS, so an index that stays down, or
// refuses us every run, is not silent.
//
// Prints the count, or "unknown" when the runs cannot be read (the workflow
// then opens and closes nothing).
//   GH_TOKEN=... GITHUB_REPOSITORY=owner/repo GITHUB_RUN_ID=123 node scripts/index402-outage-streak.js
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const UNAVAILABLE_TITLE = "402 Index unavailable";
export const WORKFLOW_FILE = "index402-sync.yml";
export const LOOKBACK_RUNS = 10;

/** `runs`, newest first, each { unavailable: true | false | null } -> the
 *  count of leading unavailable runs, or null when one before the first
 *  clean run could not be read. */
export function streakOf(runs) {
  let n = 0;
  for (const r of runs) {
    if (r?.unavailable === true) { n++; continue; }
    if (r?.unavailable === false) return n;
    return null;
  }
  return n;
}

/** Whether a run's annotations carry the unavailable mark. */
export function markedUnavailable(annotations) {
  return Array.isArray(annotations) && annotations.some((a) => a && a.title === UNAVAILABLE_TITLE);
}

function gh(args) {
  return JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }));
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const self = String(process.env.GITHUB_RUN_ID || "");
  if (!repo) { console.log("unknown"); return; }
  const list = gh([`repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?event=schedule&status=completed&per_page=${LOOKBACK_RUNS + 1}`]);
  const runs = (list.workflow_runs || []).filter((r) => String(r.id) !== self).slice(0, LOOKBACK_RUNS);
  const read = runs.map((r) => {
    try {
      const jobs = gh([`repos/${repo}/actions/runs/${r.id}/jobs`]).jobs || [];
      const job = jobs.find((j) => j.name === "sync") || jobs[0];
      if (!job?.check_run_url) return { unavailable: null };
      const id = String(job.check_run_url).split("/").pop();
      return { unavailable: markedUnavailable(gh([`repos/${repo}/check-runs/${id}/annotations`])) };
    } catch { return { unavailable: null }; }
  });
  const n = streakOf(read);
  console.log(n === null ? "unknown" : String(n));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch { console.log("unknown"); }
}

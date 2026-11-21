#!/usr/bin/env node
// Gives an open issue that a scheduled check filed under a previous title the
// check's current title, so the step that looks the issue up by exact title
// finds it (and comments on it or closes it as its own).
//
//   node scripts/adopt-issue-titles.js      (GH_TOKEN and GITHUB_REPOSITORY set)
//
// Every workflow job that looks an issue up runs this first. The titles are
// in one list, workers/status-probe/src/previous-issue-titles.js, which the
// status Worker reads as well. Only an issue filed by the Actions bot or the
// repository owner is touched: anyone can file an issue under any title. An
// issue under a previous title whose check already has an open issue under
// the current one is closed with the checks' fixed closing comment; the
// current one carries on.
//
// It never fails the job it runs in: the check that follows matters more
// than the rename, so a read or write that fails is a warning in the log and
// the next run tries again. No title is printed (an issue number only).
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { planTitleAdoption } from "../workers/status-probe/src/previous-issue-titles.js";

const LIST_LIMIT = 500;

/** Run the adoption against `repo` through `gh` (or `run`, a stand-in taking the argument list). */
export function adoptIssueTitles({ repo, owner = String(repo || "").split("/")[0], runUrl = "", run = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }), log = console.log } = {}) {
  const out = { retitled: [], closed: [], failed: [] };
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ""))) { log("::warning::adopt-issue-titles: GITHUB_REPOSITORY is not set; nothing read"); return out; }
  let rows;
  try { rows = JSON.parse(run(["issue", "list", "--repo", repo, "--state", "open", "--limit", String(LIST_LIMIT), "--json", "number,title,author"])); } catch { log("::warning::adopt-issue-titles: the open issues could not be read; the next run tries again"); return out; }
  const issues = (Array.isArray(rows) ? rows : []).map((x) => ({ number: x?.number, title: x?.title, author: x?.author?.login }));
  const plan = planTitleAdoption(issues, { trusted: [owner] });
  for (const a of plan.retitle) {
    try { run(["issue", "edit", String(a.number), "--repo", repo, "--title", a.to]); out.retitled.push(a.number); log(`issue #${a.number}: filed under a previous title, now under the check's current one`); } catch { out.failed.push(a.number); log(`::warning::adopt-issue-titles: issue #${a.number} could not be retitled; the next run tries again`); }
  }
  for (const a of plan.close) {
    try { run(["issue", "close", String(a.number), "--repo", repo, "--comment", `Closed by the scheduled check at ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}. Run: ${runUrl}`]); out.closed.push(a.number); log(`issue #${a.number}: filed under a previous title while the check's current issue is open; closed`); } catch { out.failed.push(a.number); log(`::warning::adopt-issue-titles: issue #${a.number} could not be closed; the next run tries again`); }
  }
  if (!plan.retitle.length && !plan.close.length) log("no open issue is filed under a previous title");
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const e = process.env;
  const runUrl = e.GITHUB_SERVER_URL && e.GITHUB_REPOSITORY && e.GITHUB_RUN_ID ? `${e.GITHUB_SERVER_URL}/${e.GITHUB_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}` : "";
  try { adoptIssueTitles({ repo: e.GITHUB_REPOSITORY, runUrl }); } catch { console.log("::warning::adopt-issue-titles: stopped early; the next run tries again"); }
  process.exit(0);
}

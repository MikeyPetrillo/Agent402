#!/usr/bin/env node
// Files a scheduled check's issue: the one place a workflow opens one.
//
//   node scripts/check-issue.js --title "$TITLE" [--body-file out/body.md] [--trust-owner]
//   (GH_TOKEN, GITHUB_REPOSITORY, and the run variables set)
//
// An open issue under the exact title gets the fixed "still needs review"
// comment (or, with --body-file, the check's saved state as its body). Else
// the most recent one closed within the reopen window
// (workers/status-probe/src/reopen-window.js, the rule the status Worker
// reads too) is reopened with that comment, so a check that fails again
// keeps its issue number. Else a new issue is filed with the fixed opening
// text. Only an issue the Actions bot filed is taken; with --trust-owner,
// one the repository owner's account filed too (the account the status
// Worker posts as). A step passes --trust-owner exactly when its own lookup
// of the title keeps the owner's issues, so the step and the opener always
// take the same issue (scripts/test-monitor-issue-wording.js holds them to
// it); an issue outside that set is never commented on, edited or reopened.
// The text is scripts/lib/monitor-issue-text.js's; no reading is passed in.
// A reopen that fails files a new issue instead. It exits non-zero only
// when no issue could be filed or reopened.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { OPEN_BODY, STILL_BODY, RUN_LINK } from "./lib/monitor-issue-text.js";
import { reopenCandidate, trustedAuthor } from "../workers/status-probe/src/reopen-window.js";

const isoNow = (now) => new Date(now).toISOString().replace(/\.\d+Z$/, "Z");
export const openText = (runUrl) => OPEN_BODY.replace(RUN_LINK, runUrl);
export const stillText = (runUrl, now) => STILL_BODY.replace(RUN_LINK, runUrl).replace("$(date -u +%FT%TZ)", isoNow(now));

const ghRun = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });

/** Comment on, reopen or file the issue for `title`. Returns { action, number? }. */
export function fileCheckIssue({ repo, title, bodyFile = "", trustOwner = false, owner = String(repo || "").split("/")[0], runUrl = "", now = Date.now(), run = ghRun, log = console.log } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ""))) throw new Error("GITHUB_REPOSITORY is not set");
  if (!title) throw new Error("--title is required");
  const trusted = trustOwner && owner ? [owner] : [];
  const list = (state) => {
    const rows = JSON.parse(run(["issue", "list", "--repo", repo, "--state", state, "--search", `in:title "${title}" sort:updated-desc`, "--limit", "30", "--json", "number,title,author,closedAt,state"]));
    return (Array.isArray(rows) ? rows : []).map((x) => ({ number: x?.number, title: x?.title, author: x?.author?.login, closedAt: x?.closedAt, state: x?.state }));
  };
  const own = (r) => r.title === title && trustedAuthor(r.author, trusted);
  const still = ["--body", stillText(runUrl, now)];
  let open = null;
  try { open = list("open").find(own)?.number ?? null; } catch { log("::warning::check-issue: the open issues could not be read"); }
  if (open) {
    if (bodyFile) run(["issue", "edit", String(open), "--repo", repo, "--body-file", bodyFile]);
    else run(["issue", "comment", String(open), "--repo", repo, ...still]);
    log(`already tracked in #${open}`);
    return { action: "commented", number: open };
  }
  let closed = null;
  try { closed = reopenCandidate(list("closed"), { title, trusted, now }); } catch { log("::warning::check-issue: the closed issues could not be read; filing a new one"); }
  if (closed) {
    // The body starts over (a state mark a closing run left is dropped): the
    // check's saved state, or the fixed opening text with this run's link.
    // A reopen that fails files a new issue: a second number is better than
    // an alarm that never reaches anyone.
    try {
      run(["issue", "edit", String(closed), "--repo", repo, ...(bodyFile ? ["--body-file", bodyFile] : ["--body", openText(runUrl)])]);
      run(["issue", "reopen", String(closed), "--repo", repo, "--comment", stillText(runUrl, now)]);
      log(`reopened #${closed}`);
      return { action: "reopened", number: closed };
    } catch { log(`::warning::check-issue: #${closed} could not be reopened; filing a new one`); }
  }
  const out = run(["issue", "create", "--repo", repo, "--title", title, ...(bodyFile ? ["--body-file", bodyFile] : ["--body", openText(runUrl)])]);
  log(String(out || "").trim() || "filed");
  return { action: "created" };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const e = process.env;
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] || "" : ""; };
  const runUrl = `${e.GITHUB_SERVER_URL || ""}/${e.GITHUB_REPOSITORY || ""}/actions/runs/${e.GITHUB_RUN_ID || ""}`;
  try { fileCheckIssue({ repo: e.GITHUB_REPOSITORY, title: arg("--title"), bodyFile: arg("--body-file"), trustOwner: argv.includes("--trust-owner"), runUrl }); } catch (err) { console.error(`check-issue: ${String(err?.message || err).split("\n")[0].slice(0, 200)}`); process.exit(1); }
}

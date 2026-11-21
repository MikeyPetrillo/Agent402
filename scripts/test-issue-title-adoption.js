#!/usr/bin/env node
// An issue a scheduled check opened before its title was renamed is still
// found: every lookup's job first gives it the check's current title.
//
// The scheduled checks' issues carry one neutral title shape. A lookup by
// exact title cannot see an issue opened under the title a check had before,
// so that issue would stay open after the check recovers, and a check whose
// state is in its issue would start over. The previous titles are in ONE
// list (workers/status-probe/src/previous-issue-titles.js); the status Worker
// reads it when it lists the open issues, and scripts/adopt-issue-titles.js
// reads it in every workflow job, before the job's first issue lookup.
//
// Checked here, offline (a stand-in `gh` on PATH that keeps its issues in a file):
//   1. the list: every check title a workflow, the status Worker or the
//      presence script uses has an entry, no previous title is claimed by two
//      checks, none is itself a current title;
//   2. the plan: whose issues are touched, which is retitled, which is closed;
//   3. the script, end to end: an issue under a previous title is retitled and
//      the workflows' own lookup line then finds it; a stranger's is left
//      alone; a failed read or write never fails the job;
//   4. every job that looks an issue up runs the script before its first
//      issue step, on every outcome, and can never fail on it;
//   5. the status Worker reads the same list.
// (The Worker's own adoption is run in scripts/test-status-probe-worker.js.)
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";
import { TITLE_PREFIX as TEXT_PREFIX, TITLE_RE, CLOSE_BODY_RE } from "./lib/monitor-issue-text.js";
import { PREVIOUS_TITLES, TITLE_PREFIX, currentTitleFor, planTitleAdoption } from "../workers/status-probe/src/previous-issue-titles.js";
import { adoptIssueTitles } from "./adopt-issue-titles.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WF = join(ROOT, ".github/workflows");
const NOT_A_CHECK = new Set(["wish-issues.yml", "wish-reports.yml"]); // a buyer's own wish or report, never a check's alarm
const workflows = readdirSync(WF).filter((f) => f.endsWith(".yml") && !NOT_A_CHECK.has(f)).sort();

// ---- 1. the list ---------------------------------------------------------------
const titlesOf = (text) => {
  const out = [];
  for (const m of text.matchAll(/^[ \t]*[A-Z_]*TITLE[0-9]*="([^"\n]*)"[ \t]*$/gm)) out.push(m[1]);
  for (const m of text.matchAll(/^[ \t]*[A-Z_]*TITLE[0-9]*: "?([^"\n]*?)"?[ \t]*$/gm)) out.push(m[1]);
  for (const m of text.matchAll(/--title "([^"$\n][^"\n]*)"/g)) out.push(m[1]);
  for (const m of text.matchAll(/ISSUE_TITLE='([^'\n]*)'/g)) out.push(m[1]);
  return out;
};
const used = new Map(); // current title -> where
for (const f of workflows) for (const t of titlesOf(readFileSync(join(WF, f), "utf8"))) if (t.startsWith(TITLE_PREFIX) && !used.has(t)) used.set(t, f);
const workerText = readFileSync(join(ROOT, "workers/status-probe/src/index.js"), "utf8");
for (const m of workerText.matchAll(/"(Scheduled check needs review: [^"\n]*)"/g)) if (!used.has(m[1])) used.set(m[1], "the status Worker");
for (const m of readFileSync(join(ROOT, "scripts/bazaar-presence.js"), "utf8").matchAll(/"(Scheduled check needs review: [^"\n]*)"/g)) if (!used.has(m[1])) used.set(m[1], "scripts/bazaar-presence.js");
// A title with a period in it (a month, a day) is one issue per period: the
// month's has a pattern in the list, the dated report is filed and never looked up.
const PER_PERIOD = { "search-call-reconciliation ($MONTH)": "Brave reconciliation: 2026-10", "listing-usage-report ($(date -u +%Y-%m-%d))": null };
const noEntry = [];
for (const [t, where] of used) {
  const check = t.slice(TITLE_PREFIX.length);
  if (check in PER_PERIOD) continue;
  if (!Array.isArray(PREVIOUS_TITLES[check])) noEntry.push(`${check} (${where})`);
}
ok(TITLE_PREFIX === TEXT_PREFIX && used.size >= 115, `the titles in use are read: ${used.size} across ${workflows.length} workflows, the status Worker and the presence script`);
ok(noEntry.length === 0, `every check title in use has an entry in the one list of previous titles, an empty one for a check that never had another (${noEntry.join("; ") || `${Object.keys(PREVIOUS_TITLES).length} entries`})`);
const unused = Object.keys(PREVIOUS_TITLES).filter((c) => !used.has(TITLE_PREFIX + c));
ok(unused.length === 0, `every entry is a check some workflow or the Worker still files issues for (${unused.join(", ") || "none stale"})`);
{
  const claimed = new Map(), twice = [], current = [], shaped = [];
  for (const [check, olds] of Object.entries(PREVIOUS_TITLES)) {
    if (!TITLE_RE.test(TITLE_PREFIX + check)) shaped.push(check);
    for (const o of olds) {
      if (claimed.has(o)) twice.push(`${o} (${claimed.get(o)}, ${check})`);
      claimed.set(o, check);
      if (String(o).startsWith(TITLE_PREFIX) || used.has(o)) current.push(o);
    }
  }
  ok(twice.length === 0 && current.length === 0 && shaped.length === 0 && claimed.size >= 115, `no previous title is claimed by two checks or is a current title, and every entry is a neutral check name (${[...twice, ...current, ...shaped].join("; ") || `${claimed.size} previous titles`})`);
  ok(currentTitleFor("Bazaar MCP listing presence check") === `${TITLE_PREFIX}mcp-listing-presence` && currentTitleFor("Heartbeat: production DOWN") === `${TITLE_PREFIX}availability` && currentTitleFor(`${TITLE_PREFIX}availability`) === null && currentTitleFor("Some other issue") === null && currentTitleFor(undefined) === null, "a previous title reads as its check's current title; a current title and any other title read as neither");
  ok(currentTitleFor(PER_PERIOD["search-call-reconciliation ($MONTH)"]) === `${TITLE_PREFIX}search-call-reconciliation (2026-10)` && currentTitleFor("Brave reconciliation: $(id)") === null && currentTitleFor("Brave reconciliation: 2026-10; x") === null, "a month's reconciliation issue reads as that month's current title; anything but a month in that place reads as no title");
}

// ---- 2. the plan ----------------------------------------------------------------
{
  const OLD = "Bazaar MCP listing presence check", NEW = `${TITLE_PREFIX}mcp-listing-presence`;
  const bot = (number, title) => ({ number, title, author: "app/github-actions" });
  const p1 = planTitleAdoption([bot(2047, OLD), bot(9, "Unrelated"), { number: 10, title: OLD, author: "stranger" }], { trusted: ["owner"] });
  ok(JSON.stringify(p1) === JSON.stringify({ retitle: [{ number: 2047, from: OLD, to: NEW }], close: [] }), `the check's issue under a previous title is retitled; a stranger's under the same title and an unrelated issue are not touched (${JSON.stringify(p1)})`);
  const p2 = planTitleAdoption([bot(5, OLD), bot(6, NEW)]);
  ok(p2.retitle.length === 0 && p2.close.length === 1 && p2.close[0].number === 5, "with the check's current issue open, the one under the previous title is closed and the current one is left");
  const p3 = planTitleAdoption([bot(8, OLD), bot(7, OLD)]);
  ok(p3.retitle.length === 1 && p3.retitle[0].number === 7 && p3.close.length === 1 && p3.close[0].number === 8, "of two under one previous title the older is retitled and the newer closed: a check has one issue");
  const p4 = planTitleAdoption([{ number: 3, title: OLD, author: "Owner" }, { number: 4, title: OLD, author: "github-actions[bot]" }], { trusted: ["owner"] });
  ok(p4.retitle[0]?.number === 3 && p4.close[0]?.number === 4 && planTitleAdoption([{ number: 3, title: OLD, author: "Owner" }]).retitle.length === 0, "the repository owner's issue counts when the caller names the owner, in any letter case, and not otherwise");
  ok(JSON.stringify(planTitleAdoption(null)) === JSON.stringify({ retitle: [], close: [] }) && planTitleAdoption([{ title: OLD, author: "app/github-actions" }, bot(1, NEW)]).retitle.length === 0, "an unreadable list, a row with no number and an issue already under the current title plan nothing");
}

// ---- 3. the script, against a stand-in gh ---------------------------------------
const dir = mkdtempSync(join(tmpdir(), "a402-adopt-"));
try {
  const STATE = join(dir, "issues.json"), CALLS = join(dir, "calls.jsonl");
  // `gh issue list|edit|close` over a JSON file. `--jq` is applied with the real jq, as gh applies it.
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs"), cp = require("node:child_process");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(a) + "\\n");
if (process.env.GH_STUB_FAIL && a[1] === process.env.GH_STUB_FAIL) { console.error("gh: refused"); process.exit(1); }
const issues = JSON.parse(fs.readFileSync(${JSON.stringify(STATE)}, "utf8"));
const flag = (n) => { const i = a.indexOf(n); return i < 0 ? null : a[i + 1]; };
if (a[0] !== "issue") process.exit(2);
if (a[1] === "list") {
  const rows = issues.filter((x) => x.state === "open").map((x) => ({ number: x.number, title: x.title, author: { login: x.author } }));
  const jq = flag("--jq");
  if (!jq) { console.log(JSON.stringify(rows)); process.exit(0); }
  const r = cp.spawnSync("jq", ["-r", jq], { input: JSON.stringify(rows), encoding: "utf8", env: process.env });
  process.stdout.write(r.stdout); process.exit(r.status || 0);
}
const it = issues.find((x) => String(x.number) === a[2]);
if (!it) process.exit(1);
if (a[1] === "edit") it.title = flag("--title") ?? it.title;
else if (a[1] === "close") { it.state = "closed"; it.closeComment = flag("--comment"); }
else process.exit(2);
fs.writeFileSync(${JSON.stringify(STATE)}, JSON.stringify(issues));
`);
  chmodSync(join(dir, "gh"), 0o755);
  const OLD = "Bazaar MCP listing presence check", NEW = `${TITLE_PREFIX}mcp-listing-presence`;
  const seed = (rows) => { writeFileSync(STATE, JSON.stringify(rows)); writeFileSync(CALLS, ""); };
  const issues = () => JSON.parse(readFileSync(STATE, "utf8"));
  const calls = () => readFileSync(CALLS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const env = (over = {}) => ({ PATH: `${dir}:${process.env.PATH}`, HOME: dir, GITHUB_REPOSITORY: "owner/repo", GITHUB_SERVER_URL: "https://github.test", GITHUB_RUN_ID: "77", GH_TOKEN: "t", ...over });
  const adopt = (over) => spawnSync(process.execPath, [join(ROOT, "scripts/adopt-issue-titles.js")], { env: env(over), encoding: "utf8", timeout: 60_000 });
  // The lookup line the workflows use, taken from the heartbeat itself.
  const hb = readFileSync(join(WF, "heartbeat.yml"), "utf8");
  const lookupLine = hb.split("\n").map((l) => l.trim()).find((l) => /^[A-Z_0-9]+=\$\(([A-Z_]+)="\$TITLE" gh issue list --repo "\$GITHUB_REPOSITORY" --state open .* --jq '\[\.\[\] \| select\(\.title == env\.\1\)\]\[0\]\.number \/\/ empty'\)$/.test(l)) || "";
  const lookupVar = lookupLine.split("=")[0];
  const lookup = (title) => spawnSync("bash", ["-c", ["set -euo pipefail", lookupLine, `echo "found=\${${lookupVar}}"`].join("\n")], { env: env({ TITLE: title }), encoding: "utf8", timeout: 60_000 });
  ok(lookupLine.length > 0, "the heartbeat's own lookup line is read (by exact title)");

  seed([{ number: 2047, title: OLD, author: "app/github-actions", state: "open" }, { number: 2050, title: OLD, author: "stranger", state: "open" }, { number: 2051, title: "Unrelated", author: "app/github-actions", state: "open" }]);
  const before = lookup(NEW);
  ok(before.status === 0 && before.stdout.trim() === "found=", `before the step, a lookup by the current title does not see the issue filed under the previous one (${before.stdout.trim()})`);
  const run1 = adopt();
  const after = lookup(NEW);
  const edits = calls().filter((c) => c[1] === "edit" || c[1] === "close");
  ok(run1.status === 0 && edits.length === 1 && JSON.stringify(edits[0]) === JSON.stringify(["issue", "edit", "2047", "--repo", "owner/repo", "--title", NEW]), `the step retitles the check's issue and nothing else (${JSON.stringify(edits)})`);
  ok(after.status === 0 && after.stdout.trim() === "found=2047", `after it, the workflow's lookup finds that issue (${after.stdout.trim()})`);
  ok(issues().find((x) => x.number === 2050).title === OLD && issues().find((x) => x.number === 2051).title === "Unrelated", "a stranger's issue under the previous title and an unrelated issue keep their titles");
  ok(!run1.stdout.includes(OLD) && !run1.stdout.includes(NEW) && /#2047/.test(run1.stdout), "the log names the issue by number, never by title");
  const run2 = adopt();
  ok(run2.status === 0 && calls().filter((c) => c[1] === "edit" || c[1] === "close").length === 1 && /no open issue is filed under a previous title/.test(run2.stdout), "a second run changes nothing");

  seed([{ number: 11, title: OLD, author: "owner", state: "open" }, { number: 12, title: NEW, author: "app/github-actions", state: "open" }]);
  const run3 = adopt();
  const closedRow = issues().find((x) => x.number === 11);
  ok(run3.status === 0 && closedRow.state === "closed" && CLOSE_BODY_RE.test(closedRow.closeComment || "") && issues().find((x) => x.number === 12).state === "open" && lookup(NEW).stdout.trim() === "found=12", `with the current issue open, the one under the previous title is closed with the checks' closing text and the lookup finds the current one (${closedRow.closeComment})`);

  // Nothing here fails the job the step runs in.
  seed([{ number: 21, title: OLD, author: "app/github-actions", state: "open" }]);
  const listDown = adopt({ GH_STUB_FAIL: "list" });
  const editDown = adopt({ GH_STUB_FAIL: "edit" });
  const noRepo = adopt({ GITHUB_REPOSITORY: "" });
  ok(listDown.status === 0 && /::warning::/.test(listDown.stdout) && editDown.status === 0 && /::warning::.*#21/.test(editDown.stdout) && noRepo.status === 0 && issues()[0].title === OLD, "a list that cannot be read, a retitle that is refused and a missing repository each end 0 with a warning, and the issue is as it was");
  const again = adopt();
  ok(again.status === 0 && issues()[0].title === NEW, "the next run retitles it");
  // The function itself, with the runner handed in: a title is never part of a shell line.
  const seen = [];
  const hostile = "Brave reconciliation: 2026-10\"; echo reached #";
  adoptIssueTitles({ repo: "owner/repo", log: () => {}, run: (args) => { seen.push(args); return args[1] === "list" ? JSON.stringify([{ number: 1, title: hostile, author: { login: "app/github-actions" } }, { number: 2, title: "Brave reconciliation: 2026-10", author: { login: "app/github-actions" } }]) : ""; } });
  ok(seen.length === 2 && seen[1][1] === "edit" && seen[1][2] === "2" && seen[1].at(-1) === `${TITLE_PREFIX}search-call-reconciliation (2026-10)`, "only an issue whose whole title is a previous title is retitled, to a title built from the list, as one argument of an argument list");
} finally { rmSync(dir, { recursive: true, force: true }); }

// ---- 4. every job that looks an issue up runs the step first ---------------------
{
  const STEP_NAME = "Adopt an open issue filed under a previous title";
  const missing = [], wrong = [];
  let jobs = 0;
  for (const f of workflows) {
    const doc = yamlLoad(readFileSync(join(WF, f), "utf8"));
    for (const [job, j] of Object.entries(doc.jobs || {})) {
      const steps = j.steps || [];
      if (!steps.some((s) => /gh issue list/.test(String(s.run || "")))) continue;
      jobs++;
      const first = steps.findIndex((s) => /gh issue (list|create|comment|close|edit)\b/.test(String(s.run || "")) || /bazaar-presence\.js/.test(String(s.run || "")));
      const at = steps.findIndex((s) => s.name === STEP_NAME);
      if (at < 0 || at > first) { missing.push(`${f}:${job}`); continue; }
      const s = steps[at];
      const checkout = steps.slice(0, at).some((x) => /^actions\/checkout@[0-9a-f]{40}$/.test(String(x.uses || "")));
      if (String(s.run).trim() !== "node scripts/adopt-issue-titles.js" || s.if !== "always()" || s["continue-on-error"] !== true || s.env?.GH_TOKEN !== "${{ github.token }}" || Object.keys(s.env || {}).length !== 1 || !checkout) wrong.push(`${f}:${job}`);
    }
  }
  ok(jobs >= 27 && missing.length === 0, `every job that looks an issue up runs the adoption step before its first issue step (${missing.join(", ") || `${jobs} jobs`})`);
  ok(wrong.length === 0, `each such step runs the one script after a checkout, on every outcome, holds only the job's token, and cannot fail the job (${wrong.join(", ") || "all"})`);
}

// ---- 5. the Worker reads the same list -------------------------------------------
ok(/^import \{ planTitleAdoption \} from "\.\/previous-issue-titles\.js";$/m.test(workerText) && /planTitleAdoption\(ours\.map/.test(workerText), "the status Worker plans its adoption from the same list when it lists the open issues");

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

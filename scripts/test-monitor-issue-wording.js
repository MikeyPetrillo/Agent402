#!/usr/bin/env node
// Every issue a scheduled check opens says the same neutral thing.
//
// The repository's issues are public, so an issue a workflow or the status
// Worker opens carries a fixed title shape ("Scheduled check needs review:
// <check name>") and a fixed body (that a check needs review, and the run
// link). Which reading, route, model or upstream it was is in the run log.
// This suite reads every workflow and the status Worker:
//   1. every issue title is the neutral shape, with no state word and no
//      vendor name in the check name;
//   2. every `gh issue create`, `comment` and `close` passes the fixed text
//      (a comment may end with one state mark the next run reads back);
//   3. `gh issue edit` appears only where a state mark is added to or taken
//      off the body the issue already has, or in a workflow listed below;
//   4. every issue lookup filters by the exact title (the titles share a prefix);
//   5. the status Worker's titles are the same shape and the body it posts is
//      the fixed text, with the reading's detail nowhere in it;
//   6. every issue a check files goes through the one opener,
//      scripts/check-issue.js (open: comment; closed within the reopen
//      window: reopen; else create), and the Worker applies the same rule:
//      no workflow calls `gh issue create` or `gh issue reopen` itself.
// The workflows listed in STATE_BODY keep their own body: it is the check's
// saved state (read back by the next run), or a buyer's own report.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { load as yamlLoad } from "js-yaml";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandWords, ghIssueCalls, unquoted } from "./lib/shell-words.js";
import { TITLE_PREFIX, TITLE_RE, OPEN_BODY, STILL_BODY, CLOSE_BODY, STILL_SUFFIXES, NAMES_OUT, RUN_LINK, OPENER, OPEN_BODY_RE, STILL_BODY_RE } from "./lib/monitor-issue-text.js";
import { openText, stillText } from "./check-issue.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WF = join(ROOT, ".github/workflows");
let pass = 0;
const failures = [];
const check = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

// Workflows whose issue is not a scheduled check's alarm, each with the reason.
const NOT_A_CHECK = {
  "wish-issues.yml": "files a buyer's own tool wish under the tool-wish label",
  "wish-reports.yml": "files a buyer's own fault report; the bodies already filed are read back to tell a new report from a judged one",
};
// Workflows whose issue body is the check's saved state: the title is neutral,
// the body is written by the check's script and read back by the next run.
const STATE_BODY = {
  "bazaar-presence.yml": "the body lists the routes the open issue is about; a run that lost its cache reads it back",
  "bazaar-rank.yml": "the body lists the current set; the next run compares against it",
  "bazaar-mcp-listings.yml": "the body lists the listings the open issue is about; the next run reads it back",
};

const files = readdirSync(WF).filter((f) => f.endsWith(".yml")).sort();
const withIssues = files.filter((f) => /gh issue (create|comment|close|edit)\b|node scripts\/check-issue\.js/.test(readFileSync(join(WF, f), "utf8")));
// The opener's calls in a text: { words, index } (the words after the script name).
const openerCalls = (text) => [...text.matchAll(/node scripts\/check-issue\.js\b/g)].map((m) => ({ index: m.index, words: commandWords(text, m.index + m[0].length) }));
check(withIssues.length >= 20, `at least 20 workflows open issues (found ${withIssues.length})`);
for (const f of [...Object.keys(NOT_A_CHECK), ...Object.keys(STATE_BODY)]) check(withIssues.includes(f), `${f} is listed as an exception and still opens issues`);

// ---- 1. titles ---------------------------------------------------------------
const titlesOf = (text) => {
  const out = [];
  for (const m of text.matchAll(/^[ \t]*[A-Z_]*TITLE[0-9]*="([^"\n]*)"[ \t]*$/gm)) out.push(m[1]);
  for (const m of text.matchAll(/^[ \t]*[A-Z_]*TITLE[0-9]*: "?([^"\n]*?)"?[ \t]*$/gm)) out.push(m[1]);
  for (const m of text.matchAll(/--title "([^"$\n][^"\n]*)"/g)) out.push(m[1]);
  for (const m of text.matchAll(/ISSUE_TITLE='([^'\n]*)'/g)) out.push(m[1]);
  return out;
};
let titleCount = 0;
const workflowTitles = new Set();
for (const f of withIssues) {
  if (NOT_A_CHECK[f]) continue;
  const text = readFileSync(join(WF, f), "utf8");
  const titles = titlesOf(text);
  check(titles.length > 0, `${f}: an issue title is found`);
  for (const t of titles) {
    titleCount++;
    workflowTitles.add(t);
    check(TITLE_RE.test(t), `${f}: title "${t}" is not the neutral shape`);
    const name = t.slice(TITLE_PREFIX.length).toLowerCase();
    for (const n of NAMES_OUT) check(!name.includes(n), `${f}: title "${t}" names ${n}`);
  }
  // A title passed as a variable is one of the file's own TITLE variables.
  for (const c of [...ghIssueCalls(text, ["create"]), ...openerCalls(text)]) {
    const i = c.words.indexOf("--title");
    check(i >= 0, `${f}: a create call passes --title`);
    const w = c.words[i + 1] || "";
    check(/^"\$\{?[A-Z_]*TITLE[0-9]*\}?"$/.test(w) || TITLE_RE.test(unquoted(w) || ""), `${f}: create --title ${w} is a TITLE variable or a neutral literal`);
  }
}
check(titleCount >= 120, `at least 120 issue titles read (found ${titleCount})`);

// ---- 2 and 3. bodies -----------------------------------------------------------
const MARK_EDIT = [/^"\$\{BODY_NOW%%\$'\\n\\n'"\$MARK"\*\}"$/, /^"\$\{BODY_NOW\}"\$'\\n\\n'"\$\{MARK\}\$\(date -u \+%FT%TZ\); closes on the next ok read\."$/];
let calls = 0;
for (const f of withIssues) {
  if (NOT_A_CHECK[f]) continue;
  const text = readFileSync(join(WF, f), "utf8");
  for (const c of ghIssueCalls(text)) {
    calls++;
    const at = `${f} (gh issue ${c.verb} near offset ${c.index})`;
    const flagAt = c.words.findIndex((w) => ["--body", "--comment", "--body-file", "-b", "-c", "-F"].includes(w));
    const flag = flagAt >= 0 ? c.words[flagAt] : null;
    const value = flagAt >= 0 ? c.words[flagAt + 1] : null;
    if (STATE_BODY[f]) {
      // The saved-state body comes from the check's script; a close comment is fixed text with the run link.
      if (c.verb === "close") check(flag === "--comment" && /Run: \$RUN_URL"$|at \$\(date -u \+%FT%TZ\)\."$/.test(value || ""), `${at}: a close comment that ends with the run link or the time`);
      else if (c.verb === "comment") check(flag === "--body" && /Run: \$RUN_URL"$/.test(value || ""), `${at}: a comment that ends with the run link`);
      else check(flag === "--body-file" && /^out\/[a-z-]+\.md$/.test(value || ""), `${at}: the body is the script's state document`);
      continue;
    }
    if (c.verb === "create") check(flag === "--body" && unquoted(value) === OPEN_BODY, `${at}: the body is the fixed opening text, found ${String(value).slice(0, 90)}`);
    else if (c.verb === "comment") {
      const v = unquoted(value) || "";
      check(flag === "--body" && (v === STILL_BODY || STILL_SUFFIXES.some((s) => v === STILL_BODY + s)), `${at}: the comment is the fixed text, found ${String(value).slice(0, 90)}`);
    } else if (c.verb === "close") check(flag === "--comment" && unquoted(value) === CLOSE_BODY, `${at}: the close comment is the fixed text, found ${String(value).slice(0, 90)}`);
    else check(flag === "--body" && MARK_EDIT.some((re) => re.test(value || "")), `${at}: an edit only adds or removes the state mark on the body the issue has, found ${String(value).slice(0, 90)}`);
  }
}
// ---- 6. every check's issue is filed through the one opener ----------------------
let openers = 0;
for (const f of withIssues) {
  if (NOT_A_CHECK[f]) continue;
  const text = readFileSync(join(WF, f), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  check(!/gh issue (create|reopen)\b/.test(text), `${f}: files its issue through ${OPENER}, never gh issue create or reopen itself`);
  check(!/gh api [^\n]*issues/.test(text) || !/(-X|--method) (POST|PATCH)/.test(text), `${f}: opens no issue through gh api`);
  for (const c of openerCalls(text)) {
    openers++;
    const at = `${f} (${OPENER} near offset ${c.index})`;
    const rest = c.words.slice(2).filter((w) => !/^(>|2>|>\/dev\/null|2>&1)/.test(w));
    if (STATE_BODY[f]) check(rest.length === 0 || (rest.length === 2 && rest[0] === "--body-file" && /^out\/[a-z-]+\.md$/.test(rest[1])), `${at}: the saved-state body file only`);
    else check(rest.length === 0, `${at}: passes the title only (the opener writes the fixed text), found ${rest.join(" ")}`);
  }
}
check(openers >= 110, `every check's create goes through the opener (found ${openers})`);
check(calls + openers >= 250, `at least 250 issue calls read (found ${calls + openers})`);
// ---- 6b. every job that runs the opener checks out the opener and all it imports ----
// A sparse checkout that leaves one imported file out makes the opener throw
// before it files anything, so the alarm is silent. The closure is read from
// the files' own relative imports, so a new import is covered the day it lands.
const importClosure = (start) => {
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = readFileSync(join(ROOT, rel), "utf8");
    for (const m of src.matchAll(/^\s*(?:import|export)\b[^"'`;]*?(?:from\s*)?["'](\.{1,2}\/[^"']+)["']/gm)) walk(join(dirname(rel), m[1]).split("\\").join("/"));
    for (const m of src.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) walk(join(dirname(rel), m[1]).split("\\").join("/"));
  };
  walk(start);
  return [...seen].sort();
};
const OPENER_CLOSURE = importClosure("scripts/check-issue.js");
check(OPENER_CLOSURE.includes("scripts/lib/monitor-issue-text.js") && OPENER_CLOSURE.includes("workers/status-probe/src/reopen-window.js"), `the opener's import closure is read (${OPENER_CLOSURE.join(", ")})`);
/** The files a job's checkout before step `i` leaves out of `need` (null when nothing checks the repository out). */
const missingFromCheckout = (steps, i, need) => {
  const co = steps.slice(0, i).filter((s) => /^actions\/checkout@/.test(String(s?.uses || ""))).at(-1);
  if (!co) return null;
  const sparse = co.with?.["sparse-checkout"];
  if (!sparse) return [];
  const pats = String(sparse).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return need.filter((f) => !pats.some((p) => p === f || (p.endsWith("/") && f.startsWith(p)) || (p.endsWith("/*") && f.startsWith(p.slice(0, -1)))));
};
let openerJobs = 0;
for (const f of withIssues) {
  const doc = yamlLoad(readFileSync(join(WF, f), "utf8"));
  for (const [name, job] of Object.entries(doc?.jobs || {})) {
    const steps = job?.steps || [];
    steps.forEach((s, i) => {
      if (!/node scripts\/check-issue\.js/.test(String(s?.run || ""))) return;
      openerJobs++;
      const miss = missingFromCheckout(steps, i, OPENER_CLOSURE);
      check(miss !== null && miss.length === 0, `${f}:${name}: the checkout before "${s.name}" holds the opener and every file it imports (${miss === null ? "no checkout" : miss.join(", ") || "all"})`);
    });
  }
}
check(openerJobs >= 30, `every job that runs the opener was read (found ${openerJobs})`);
{
  const run = "https://github.com/o/r/actions/runs/1";
  check(OPEN_BODY_RE.test(openText(run)) && openText(run) === OPEN_BODY.replace(RUN_LINK, run), "the opener files the fixed opening text");
  check(STILL_BODY_RE.test(stillText(run, Date.UTC(2026, 10, 1))), "the opener comments and reopens with the fixed still-needs-review text");
  const src = readFileSync(join(ROOT, "scripts/check-issue.js"), "utf8");
  check(/from "\.\.\/workers\/status-probe\/src\/reopen-window\.js"/.test(src) && /reopenCandidate\(/.test(src), "the opener reads the reopen window the Worker reads");
  const worker = readFileSync(join(ROOT, "workers/status-probe/src/index.js"), "utf8");
  check(/from "\.\/reopen-window\.js"/.test(worker) && (worker.match(/method: "POST", body: JSON\.stringify\(\{ title/g) || []).length === 1 && /reopenCandidate\(closedList/.test(worker), "the Worker files every issue through its one opener, which applies the same reopen rule");
}
for (const s of [OPEN_BODY, STILL_BODY, CLOSE_BODY]) check(s.includes(RUN_LINK), "each fixed text links the run");

// ---- 4. lookups filter by the exact title -----------------------------------------
for (const f of withIssues) {
  if (NOT_A_CHECK[f]) continue;
  const lines = readFileSync(join(WF, f), "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!/gh issue list\b/.test(line) || /^\s*#/.test(line)) return;
    const stmt = lines.slice(i, i + 3).join("\n");
    check(/select\(\.title == /.test(stmt) || /\.title===|i\.title ===|\.title==/.test(stmt), `${f}:${i + 1}: an issue lookup filters by the exact title`);
  });
}

// ---- 4b. every lookup acts only on an issue the check itself could have filed ------
// Anyone can open an issue under any title, so a lookup by title keeps only
// an issue authored by the Actions bot or the repository owner (as
// scripts/adopt-issue-titles.js does); a stranger's issue under the same
// title is neither commented on, closed, nor taken as already filed. Every
// workflow, the buyer-report ones included. Each lookup's own jq is run over
// a stranger's issue under its title and over the bot's.
const AUTHOR_SELECT = /select\(\(\.author\.login \/\/ "" \| ascii_downcase\) as \$a \| \$a == "github-actions\[bot\]" or \$a == "app\/github-actions"/;
let authorLookups = 0;
for (const f of withIssues) {
  const lines = readFileSync(join(WF, f), "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!/gh issue list\b/.test(line) || /^\s*#/.test(line)) return;
    authorLookups++;
    const stmt = lines.slice(i, i + 3).join("\n");
    const byNode = /author:app\/github-actions/.test(stmt) && /author\.login/.test(stmt);
    const jq = (stmt.match(/--jq '([^']*)'/) || [])[1];
    if (byNode) return;
    check(Boolean(jq) && AUTHOR_SELECT.test(jq) && /--json [^ ]*\bauthor\b/.test(stmt), `${f}:${i + 1}: an issue lookup keeps only the bot's or the owner's issues`);
    if (!jq || !AUTHOR_SELECT.test(jq)) return;
    const title = "Scheduled check needs review: some-check";
    const env = { ...process.env, ISSUE_TITLE: title, ALARM_NAME: title, TITLE: title, MCP_TITLE: title, ISSUE_OWNER: "owner", ALARM_OWNER: "owner" };
    const run = (rows) => { const r = spawnSync("jq", ["-r", jq], { input: JSON.stringify(rows), env, encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : `jq failed: ${r.stderr}`; };
    const row = (number, login) => ({ number, title, body: `b${number}`, author: { login } });
    const stranger = run([row(5, "stranger")]);
    const bot = run([row(5, "stranger"), row(6, "app/github-actions")]);
    check(stranger === "", `${f}:${i + 1}: a stranger's issue under the check's title is not taken (${stranger})`);
    check(bot !== "" && !/\b5\b|b5/.test(bot), `${f}:${i + 1}: the bot's own issue is (${bot})`);
  });
}
check(authorLookups >= 100, `every issue lookup was read (found ${authorLookups})`);

// ---- 5. the status Worker ----------------------------------------------------------
const { ALARMS, DOWN_TITLE, PAYWALL_UNOBSERVED_TITLE, syncAlarms, syncOutage, neutralIssueBody, NEUTRAL_ISSUE_TEXT } = await import("../workers/status-probe/src/index.js");
check(ALARMS.length >= 40, `the Worker has its alarms (found ${ALARMS.length})`);
for (const t of [...ALARMS.map((a) => a.title), DOWN_TITLE, PAYWALL_UNOBSERVED_TITLE]) {
  check(TITLE_RE.test(t) && !t.includes("$"), `worker: title "${t}" is the neutral shape`);
  check(workflowTitles.has(t), `worker: title "${t}" is a title heartbeat.yml also uses`);
  for (const n of NAMES_OUT) check(!t.slice(TITLE_PREFIX.length).includes(n), `worker: title "${t}" names ${n}`);
}
check(OPEN_BODY.startsWith(NEUTRAL_ISSUE_TEXT), "the Worker's text opens with the workflows' sentence");
{
  // Open every alarm once: the first whose verdict a crafted reading turns bad.
  const realFetch = globalThis.fetch, realLog = console.log;
  const posted = [];
  const logged = [];
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "POST") posted.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ number: 1 }), { status: 201, headers: { "content-type": "application/json" } });
  };
  console.log = (line) => { logged.push(String(line)); };
  try {
    const low = { gateway: { status: "low", upstreamBuyer: { status: "low" }, toolFailures: { status: "failing" } }, status: null };
    const open = new Map(); open.bodies = new Map();
    const r = await syncAlarms({ GITHUB_ISSUES_TOKEN: "t" }, { fetchStatus: async () => low, sleep: async () => {}, confirmDelayMs: 0, openList: open });
    check(r.opened.length >= 2 && posted.length === r.opened.length, `the crafted reading opens issues (opened ${r.opened?.length})`);
    for (const p of posted) {
      check(TITLE_RE.test(p.title), `worker: posted title "${p.title}" is neutral`);
      check(/^A scheduled check reported a result that needs review\. Observed by the status probe at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z, confirmed by a second reading\. This issue closes when the check next passes, or by hand after review\.$/.test(p.body), `worker: posted body is the fixed text, found ${String(p.body).slice(0, 120)}`);
      const alarm = ALARMS.find((a) => a.title === p.title);
      const detail = alarm.body(low);
      check(typeof detail === "string" && detail.length > 40 && !p.body.includes(detail.slice(0, 40)), `worker: the reading's detail is not in the posted body (${p.title})`);
      check(logged.some((l) => l.includes(JSON.stringify(p.title)) && l.includes(JSON.stringify(detail).slice(1, 41))), `worker: the detail goes to the Worker's own log (${p.title})`);
    }
    posted.length = 0;
    const o = await syncOutage({ GITHUB_ISSUES_TOKEN: "t" }, { apiFailed: true, detail: "api: 503 from the edge", sleep: async () => {}, confirmDelayMs: 0, healthRead: async () => false, openList: open });
    check(o.action === "opened" && posted.length === 1, "the outage alarm opens");
    check(posted[0]?.title === DOWN_TITLE && posted[0]?.body === neutralIssueBody(posted[0].body.match(/at (\S+Z),/)?.[1]), "the outage issue is the fixed title and body");
    check(!/503|edge|health|Railway|deploy/i.test(posted[0]?.body || ""), "the outage body names no reading");
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
}

if (failures.length) { for (const f of failures) console.error("FAIL -", f); console.error(`\nmonitor issue wording: ${pass} passed, ${failures.length} failed`); process.exit(1); }
console.log(`monitor issue wording: ${pass} passed`);

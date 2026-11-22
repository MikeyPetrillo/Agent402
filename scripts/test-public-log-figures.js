#!/usr/bin/env node
// A workflow log and an issue on this repo are public, so neither carries a
// sales figure, a payer or call count, a wallet balance, a spend or cost
// figure, or a sentence about what a listing is worth to us.
//
// Two sources are read as the public text they become:
//   1) every workflow's output lines (echo, printf, ::warning:: and friends,
//      console.* inside an inline node -e) and the bodies it hands to
//      `gh issue` (scripts/lib/issue-bodies.js);
//   2) the code of every script a workflow runs (test suites aside: their
//      fixtures are not production figures). A script is read whole, comments
//      stripped, so a figure built in a helper and printed later is still seen.
// A catalog price is public (/api/pricing) and is not refused; a route path
// is public and is not refused. A count of missing routes is a status, not a
// sale, and is not refused.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/shipped-files.js";
import { issueBodyTexts } from "./lib/issue-bodies.js";
import { load, dump } from "js-yaml";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Each rule is [name, regex]. They are read against output text (workflows)
// or against comment-stripped code (scripts).
const COMMON = [
  ["listing usage field", /l30Days|uniquePayers|TotalCalls/i],
  ["payer count", /\bpayers\b|\b(?:unique|outside) (?:buyer|payer)s?\b/i],
  ["per-route figure table", /\|\s*(?:payers|calls|sales|buyers|revenue)\s*\|/i],
  ["strategy sentence", /pure cost|worth its|best[- ]sell|cull window|about to be culled|drop out of the listing/i],
  // An approximate figure or a range is a cost estimate; a single list price
  // is the catalog's own public figure and passes.
  ["typed cost figure", /~\$\d|\$\d+(?:\.\d+)?\s*[-–]\s*\$?\d/],
];
const SCRIPT_RULES = [
  ...COMMON,
  // A dollar sign beside an interpolated balance, spend, total or cost. A
  // configured cap (a name with "max" in it) is a setting, not a figure.
  ["money figure interpolated", /\$\$\{(?![^}]*max)[^}]*(?:spent|balance|holding|lowwater|low_water|credit|cost|remaining|usdce|total)/i],
];
const SHELL_RULES = [
  ...COMMON,
  ["money variable printed", /\$\{?(?:BAL|BALANCE|USD|CREDITS|SPENT|TOTAL|BYCALLER|WEIGHTS|PAYERS|REVENUE|SALES)\}?(?![A-Za-z0-9_])/],
  ["sales count printed", /\b(?:settles|settlements|sales|sold|payers|revenue|credits)\b[^\n]{0,40}\$\{?(?:COUNT|N|NUM|TOTAL|SUM|CREDITS|SETTLES|SALES)\b/i],
];

const OUTPUT_LINE = /^\s*(?:echo|printf)\b|::(?:warning|notice|error)::|console\.(?:log|error|warn|info)\(/;
// A value captured into a variable ($(...)) is not printed by that line.
const printed = (line) => OUTPUT_LINE.test(line) && !/^\s*[A-Z_]+=\$\(/.test(line);

function workflowHits(name, yml) {
  const hits = [];
  yml.split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line) || !printed(line)) return;
    if (/::add-mask::/.test(line)) return;
    for (const [rule, re] of SHELL_RULES) if (re.test(line)) hits.push(`${name}:${i + 1} ${rule}: ${line.trim().slice(0, 100)}`);
  });
  // A step env value is printed in the step's log header, so a figure handed
  // from one step to the next through an output is printed too.
  yml.split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    if (/outputs\.(?:total|bycaller|credits|balance|spent|payers|sales|revenue)\b/i.test(line)) hits.push(`${name}:${i + 1} figure passed through a step output: ${line.trim().slice(0, 100)}`);
    if (/\)x\\\(length\)/.test(line)) hits.push(`${name}:${i + 1} per-route count built for the log: ${line.trim().slice(0, 100)}`);
  });
  for (const t of issueBodyTexts(yml)) {
    for (const [rule, re] of COMMON) if (re.test(t)) hits.push(`${name} issue body ${rule}: ${t.replace(/\s+/g, " ").slice(0, 100)}`);
  }
  return hits;
}

// Comments out, strings kept. A line comment is // preceded by whitespace or
// the line start (a URL inside a string has no space before its //), and it
// goes first, so a "/*" written inside one ("/v1/*/audio") opens nothing. A
// block comment is /* at a line start or after whitespace, { ; or (.
function stripComments(src, isShell) {
  if (isShell) return src.split("\n").map((l) => (/^\s*#/.test(l) ? "" : l)).join("\n");
  return src
    .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n")
    .replace(/(^|[\s{;(])\/\*[\s\S]*?\*\//g, (m, lead) => lead + m.slice(lead.length).replace(/[^\n]/g, ""));
}

function scriptHits(rel, src) {
  const shell = rel.endsWith(".sh");
  const hits = [];
  stripComments(src, shell).split("\n").forEach((line, i) => {
    const rules = shell ? (OUTPUT_LINE.test(line) ? SHELL_RULES : []) : SCRIPT_RULES;
    for (const [rule, re] of rules) if (re.test(line)) hits.push(`${rel}:${i + 1} ${rule}: ${line.trim().slice(0, 100)}`);
  });
  return hits;
}

// --- controls: each rule sees its own shape, and the safe shapes pass ---------
{
  const s = (code) => scriptHits("x.js", code).length > 0;
  const w = (line) => workflowHits("x.yml", line).length > 0;
  ok(s("const p = i.quality?.l30DaysUniquePayers || 0;"), "control: a listing usage field read by a script is seen");
  ok(s("lines.push(`- with an outside buyer (>=2 payers): ${n}`);"), "control: a payer count line is seen");
  ok(s('lines.push("| route | payers | calls |");'), "control: a per-route figure table is seen");
  ok(s("const v = `keeping the packs swept is worth its ~$4-9 a pass`;"), "control: a typed cost range and a strategy sentence are seen");
  ok(s("console.log(`burner is down to $${balanceUsd.toFixed(4)}`);"), "control: an interpolated balance is seen");
  ok(s("console.log(`spent ~$${spentUsd.toFixed(3)}`);"), "control: an interpolated spend is seen");
  ok(!s("console.log(`OK ${t.path} settled at its list price $${t.priceUsd.toFixed(3)}`);"), "control: a catalog list price passes");
  ok(!s("// payers and $4-9 in a comment\nconsole.log('ran');"), "control: a comment is not output");
  ok(s("// the /v1/*/audio routes\nconsole.log(`spent $${spentUsd}`);\n} catch { /* x */ }"), "control: a \"/*\" inside a line comment hides nothing after it");
  ok(!s("console.log(`routes missing: ${missing.length}`);"), "control: a count of missing routes passes");
  ok(!s("log(`ceiling $${opts.maxSpendUsd} per run`);"), "control: a configured cap passes");
  ok(w('          echo "PayAI weighted credits since $CUT: $CREDITS (warn at $THRESH)"'), "control: a printed credit count is seen");
  ok(w('          echo "settles, rolling 30d: $COUNT"'), "control: a printed settlement count is seen");
  ok(w('          echo "month=$MONTH total=$TOTAL byCaller=[$BYCALLER]"'), "control: a printed call total is seen");
  ok(w('          gh issue create --body "outside buyers this month: 3"'), "control: a payer count in an issue body is seen");
  ok(!w('          echo "upstream buyer wallet: $STATUS"'), "control: a status word passes");
  ok(!w('          echo "::add-mask::$BURNER_KEY"'), "control: a mask line passes");
  ok(!w('          # echo "payers $TOTAL"'), "control: a commented line passes");
  ok(w('          TOTAL: ${{ steps.series.outputs.total }}'), "control: a total handed to a later step's env is seen");
  ok(w('            | map("\\(.[0].slug)(\\(.[0].status))x\\(length)")'), "control: a per-route count built in jq is seen");
}

// --- the scheduled jobs and the scripts they run ------------------------------
// A scheduled job runs unattended and its log is public; a job that runs only
// when an operator dispatches it is read by that operator. So the scan reads
// every job a schedule starts: in a workflow with a schedule trigger, each job
// whose `if:` does not limit it to a dispatched input.
const wfDir = join(ROOT, ".github", "workflows");
const workflows = readdirSync(wfDir).filter((x) => /\.ya?ml$/.test(x));
const scripts = new Set();
const hits = [];
let scheduled = 0, jobs = 0;
const scheduledJob = (job) => {
  const cond = typeof job?.if === "string" ? job.if : "";
  return !cond || /schedule/.test(cond) || !/inputs\./.test(cond);
};
for (const f of workflows) {
  const yml = readFileSync(join(wfDir, f), "utf8");
  const doc = load(yml);
  const on = doc?.on ?? doc?.true;
  if (!on || typeof on !== "object" || !("schedule" in on)) continue;
  scheduled++;
  for (const [name, job] of Object.entries(doc.jobs || {})) {
    if (!scheduledJob(job)) continue;
    jobs++;
    const text = dump(job, { lineWidth: -1 });
    hits.push(...workflowHits(`${f} (${name})`, text));
    const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    for (const m of code.matchAll(/\bscripts\/[A-Za-z0-9_./-]+\.(?:m?js|sh)\b/g)) {
      const rel = m[0];
      if (/(?:^|\/)test-[^/]*$/.test(rel) || rel.startsWith("scripts/ci/")) continue;
      if (existsSync(join(ROOT, rel))) scripts.add(rel);
    }
  }
}
for (const rel of scripts) hits.push(...scriptHits(rel, readFileSync(join(ROOT, rel), "utf8")));

ok(scheduled >= 20 && jobs >= scheduled, `read ${jobs} scheduled jobs across ${scheduled} scheduled workflows`);
ok(scripts.size >= 20, `read ${scripts.size} scripts the scheduled jobs run`);
ok(scripts.has("scripts/paid-canary.js") && scripts.has("scripts/refresh-bazaar.js"), "the daily canary and the keep-alive buyer are in the set read");
ok(hits.length === 0, `no workflow log line, issue body or workflow script prints a sales or payer count, a balance, a spend or cost figure, or a strategy sentence${hits.length ? `:\n    ${hits.join("\n    ")}` : ""}`);

console.log(`\ntest-public-log-figures: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

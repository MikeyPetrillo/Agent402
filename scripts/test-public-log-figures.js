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
//      A script that prints dollar figures for an operator running it by hand
//      passes only when it installs scripts/lib/public-log.js and every job
//      that runs it sets PUBLIC_LOG=1, which turns each figure into a word;
//   3) the files a job uploads as an artifact (public too): a script in a job
//      that uploads one, writing a report with an aggregate money key (spent,
//      balance, total ...Usd), writes it through forPublicFile().
// A catalog price is public (/api/pricing) and is not refused; a route path
// is public and is not refused. A count of missing routes is a status, not a
// sale, and is not refused.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/shipped-files.js";
import { issueBodyTexts } from "./lib/issue-bodies.js";
import { load, dump } from "js-yaml";
import { redactFigures, publicCopy, forPublicFile, forPublicText, installPublicLog } from "./lib/public-log.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Each rule is [name, regex]. They are read against output text (workflows)
// or against comment-stripped code (scripts).
const COMMON = [
  ["listing usage field", /l30Days|uniquePayers|TotalCalls/i],
  ["payer count", /\bpayers\b|\b(?:unique|outside) (?:buyer|payer)s?\b/i],
  ["per-route figure table", /\|\s*(?:payers|calls|sales|buyers|revenue)\s*\|/i],
  // Read for a printed answer; a `jq -e ... >/dev/null` assertion prints nothing.
  ["sales field printed", /^(?!.*\bjq -e\b.*>\s*\/dev\/null).*(?:estimatedRevenueUsd|topPaidTools|toolCallsServed)/],
  ["strategy sentence", /pure cost|worth its|best[- ]sell|cull window|about to be culled|drop out of the listing/i],
  // An approximate figure or a range is a cost estimate; a single list price
  // is the catalog's own public figure and passes.
  ["typed cost figure", /~\$\d|\$\d+(?:\.\d+)?\s*[-–]\s*\$?\d/],
];
// A dollar sign beside an interpolated balance, spend, total or cost. A
// configured cap (a name with "max" in it) is a setting, not a figure.
const MONEY_INTERP = ["money figure interpolated", /\$\$\{(?![^}]*max)[^}]*(?:spent|balance|holding|lowwater|low_water|credit|cost|remaining|usdce|total)/i];
// A balance, total or receipt figure printed without its dollar sign.
const BARE_FIGURE = ["bare money figure", /\b(?:balance|total|received|revenue|spent)\b[^`\n]{0,60}(?<!\$)\$\{(?!figure\()[^}]*(?:toFixed|\/ ?1e6)/i];
const WALLET_READ = ["wallet balance printed", /\b(?:USDC|USDG|ALGO|ETH|PathUSD)(?:\.e)?\s+(?:before|after|balance)\b\s*:?\s*\$\{(?!figure\()(?![^}]*\?\s*"unreadable")/];
const SCRIPT_RULES = [...COMMON, MONEY_INTERP, BARE_FIGURE, WALLET_READ];
// The rules that PUBLIC_LOG answers: it withholds a dollar figure, not a word.
const DOLLAR_RULES = new Set(["typed cost figure", "money figure interpolated"]);
// Scripts whose flagged text is not a figure of ours, each with the reason.
const NOT_OURS = new Map([
  ["scripts/proof-card.js", "renders the share card the owner approves before a post; its labels say whose receipt it shows"],
  ["scripts/demo-company-onepager.js", "the demo's sample company report (that company's published financials), not our sales"],
]);
const MONEY_KEY_WRITE = /\b(?:spent|balance|total|revenue|charged|signed|committed|remaining|holding|planned)\w*(?:Usd|Micros|Atomic)\s*:|\.(?:spentUsd|balanceUsd|totalUsd)\s*\+?=/;
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
    // Inline node and jq print too.
    for (const [rule, re] of [MONEY_INTERP, ...COMMON.filter(([r]) => r === "sales field printed")]) if (re.test(line)) hits.push(`${name}:${i + 1} ${rule}: ${line.trim().slice(0, 100)}`);
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
  ok(s("log(`USDC balance of ${WALLET}: ${balanceUsd.toFixed(4)}`);"), "control: a balance printed without its dollar sign is seen");
  ok(s("console.log(`spending wallet USDC.e after: ${after}`);"), "control: a wallet reading printed raw is seen");
  ok(!s('console.log(`spending wallet USDC.e after: ${after == null ? "unreadable" : "read"}`);'), "control: a wallet reading printed as a word passes");
  ok(w('          echo "PayAI weighted credits since $CUT: $CREDITS (warn at $THRESH)"'), "control: a printed credit count is seen");
  ok(w('          echo "settles, rolling 30d: $COUNT"'), "control: a printed settlement count is seen");
  ok(w('          echo "month=$MONTH total=$TOTAL byCaller=[$BYCALLER]"'), "control: a printed call total is seen");
  ok(w('          gh issue create --body "outside buyers this month: 3"'), "control: a payer count in an issue body is seen");
  ok(!w('          echo "upstream buyer wallet: $STATUS"'), "control: a status word passes");
  ok(!w('          echo "::add-mask::$BURNER_KEY"'), "control: a mask line passes");
  ok(!w('          # echo "payers $TOTAL"'), "control: a commented line passes");
  ok(w('          TOTAL: ${{ steps.series.outputs.total }}'), "control: a total handed to a later step's env is seen");
  ok(w('            | map("\\(.[0].slug)(\\(.[0].status))x\\(length)")'), "control: a per-route count built in jq is seen");
  ok(w("          curl -s $PROD/api/stats | jq '{tools, served: .toolCallsServed}'"), "control: a sales field printed by jq is seen");
  ok(!w("          curl -s $PROD/api/stats | jq -e '.toolCallsServed.total >= 1' >/dev/null"), "control: a jq assertion that prints nothing passes");
  ok(w("          node -e 'console.log(`USDC received: total $${(Number(total) / 1e6).toFixed(4)}`)'"), "control: an inline node money figure is seen");
}

// --- the helpers a script prints and writes through -----------------------------
{
  ok(redactFigures("spent ~$0.0123 of $2 (cap $1,000.50)") === "spent ~$[withheld] of $[withheld] (cap $[withheld])", "redactFigures: every dollar figure becomes a word");
  ok(redactFigures("route $PATH and ${x}") === "route $PATH and ${x}", "redactFigures: a shell variable or a template is not a figure");
  const rep = { spentUsd: 1.2, balanceUsd: 3, chargedAtomic: "5", nested: { totalUsd: 2, priceUsd: 0.01 }, rows: [{ usd: 0.01, quoteUsd: 0.02, slug: "x" }] };
  const pub = publicCopy(rep);
  ok(!("spentUsd" in pub) && !("balanceUsd" in pub) && !("chargedAtomic" in pub) && !("totalUsd" in pub.nested), "publicCopy: aggregate money keys are left out, at any depth");
  ok(pub.nested.priceUsd === 0.01 && pub.rows[0].usd === 0.01 && pub.rows[0].quoteUsd === 0.02 && pub.rows[0].slug === "x", "publicCopy: a per-route price and the rest of the report stay");
  ok(forPublicFile(rep, {}) === rep && forPublicText("$1", {}) === "$1", "by hand (no PUBLIC_LOG) a file and a summary keep their figures");
  ok(!("spentUsd" in forPublicFile(rep, { PUBLIC_LOG: "1" })) && forPublicText("$1", { PUBLIC_LOG: "1" }) === "$[withheld]", "under PUBLIC_LOG=1 they do not");
  const seen = [];
  const fake = { log: (...a) => seen.push(a.join(" ")), info() {}, warn() {}, error() {} };
  ok(installPublicLog({}, fake) === false, "installPublicLog: off without PUBLIC_LOG");
  ok(installPublicLog({ PUBLIC_LOG: "1" }, fake) === true, "installPublicLog: on under PUBLIC_LOG=1");
  fake.log(`spent $${(0.5).toFixed(2)}`, { spentUsd: 0.5, slug: "a" });
  ok(seen[0] === "spent $[withheld] { slug: 'a' }", `installPublicLog: a printed figure and an object's money key are withheld (${seen[0]})`);
}

// --- every workflow job and the scripts it runs -------------------------------
const wfDir = join(ROOT, ".github", "workflows");
const workflows = readdirSync(wfDir).filter((x) => /\.ya?ml$/.test(x));
const runners = new Map(); // script -> [{ where, publicLog, uploads }]
const hits = [];
let jobs = 0;
for (const f of workflows) {
  const yml = readFileSync(join(wfDir, f), "utf8");
  const doc = load(yml);
  const wfPublic = String(doc?.env?.PUBLIC_LOG ?? "") === "1";
  for (const [name, job] of Object.entries(doc?.jobs || {})) {
    jobs++;
    const text = dump(job, { lineWidth: -1 });
    hits.push(...workflowHits(`${f} (${name})`, text));
    const jobPublic = wfPublic || String(job?.env?.PUBLIC_LOG ?? "") === "1";
    const uploads = /actions\/upload-artifact@/.test(text);
    const code = text.split("\n").filter((l) => !/^\s*#/.test(l));
    for (const line of code) {
      for (const m of line.matchAll(/\bscripts\/[A-Za-z0-9_./-]+\.(?:m?js|sh)\b/g)) {
        const rel = m[0];
        if (/(?:^|\/)test-[^/]*$/.test(rel) || rel.startsWith("scripts/ci/") || !existsSync(join(ROOT, rel))) continue;
        // A run under `env -i` sees only what its line passes.
        const publicLog = /\benv -i\b/.test(line) ? /\bPUBLIC_LOG=1\b/.test(line) : jobPublic;
        const list = runners.get(rel) || [];
        list.push({ where: `${f} (${name})`, publicLog, uploads });
        runners.set(rel, list);
      }
    }
    // A script copied into its own tree and run there under env -i.
    for (const line of code) {
      const cp = /cp\s+"\$GITHUB_WORKSPACE"\/(scripts\/[^\s"]+\.(?:m?js))/.exec(line);
      if (!cp) continue;
      const runLine = code.find((l) => /\benv -i\b/.test(l) && l.includes(cp[1].split("/").pop()))
        || code.find((l, i) => /\benv -i\b/.test(l) && code.slice(i, i + 4).some((n) => n.includes(cp[1].split("/").pop())));
      if (!runLine) continue;
      const block = code.slice(code.indexOf(runLine), code.indexOf(runLine) + 4).join(" ");
      const list = runners.get(cp[1]) || [];
      list.push({ where: `${f} (${name}) env -i`, publicLog: /\bPUBLIC_LOG=1\b/.test(block), uploads });
      runners.set(cp[1], list);
    }
  }
}
for (const [rel, runs] of runners) {
  if (NOT_OURS.has(rel)) continue;
  const src = readFileSync(join(ROOT, rel), "utf8");
  const installs = /\binstallPublicLog\(\)/.test(src);
  const everyRunPublic = runs.every((r) => r.publicLog);
  // The helpers act only under PUBLIC_LOG=1, so every job that runs a script using them sets it.
  if (/lib\/public-log\.js/.test(src) && !everyRunPublic) hits.push(`${rel}: prints through scripts/lib/public-log.js but runs without PUBLIC_LOG=1 in ${runs.filter((r) => !r.publicLog).map((r) => r.where).join(", ")}`);
  for (const h of scriptHits(rel, src)) {
    const rule = h.split(" ").slice(1).join(" ").split(":")[0];
    if (DOLLAR_RULES.has(rule) && installs && everyRunPublic) continue;
    hits.push(DOLLAR_RULES.has(rule) && installs ? `${h} (run without PUBLIC_LOG=1 in ${runs.filter((r) => !r.publicLog).map((r) => r.where).join(", ")})` : h);
  }
  // A step summary is published with the run.
  if (/GITHUB_STEP_SUMMARY/.test(src) && /\$\$\{|`\$`/.test(stripComments(src, false)) && !/forPublicText\(/.test(src)) hits.push(`${rel}: appends to the step summary text that can carry a dollar figure, without forPublicText()`);
  if (runs.some((r) => r.uploads) && /writeFileSync\(/.test(src) && MONEY_KEY_WRITE.test(stripComments(src, rel.endsWith(".sh")))) {
    if (!/forPublicFile\(/.test(src) && !/spentUsd: _spent/.test(src)) hits.push(`${rel}: writes a report with an aggregate money key in a job that uploads an artifact, without forPublicFile()`);
    else if (!runs.filter((r) => r.uploads).every((r) => r.publicLog) && !/spentUsd: _spent/.test(src)) hits.push(`${rel}: forPublicFile() is used but a job that uploads its file does not set PUBLIC_LOG=1`);
  }
}

ok(workflows.length >= 40 && jobs >= workflows.length, `read ${jobs} jobs across ${workflows.length} workflows`);
ok(runners.size >= 40, `read ${runners.size} scripts the workflows run`);
ok(["scripts/paid-canary.js", "scripts/refresh-bazaar.js", "scripts/refund-run.js", "scripts/seller-sweep.mjs", "scripts/mint-bazaar-rows.js"].every((r) => runners.has(r)),
  "the canary, the keep-alive buyer, the refund run and the copied-tree sweeps are in the set read");
ok(hits.length === 0, `no workflow log line, issue body, workflow script or uploaded report carries a sales or payer count, a balance, a spend or cost figure, or a strategy sentence${hits.length ? `:\n    ${hits.join("\n    ")}` : ""}`);

console.log(`\ntest-public-log-figures: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

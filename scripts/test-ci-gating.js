#!/usr/bin/env node
// Splitting the test suite into parallel lanes is a speed change that can
// silently become a SAFETY change: a lane that nothing depends on still shows
// its own red X while `deploy` sails past it. That is how a money guard stops
// blocking a release without anyone editing the guard.
//
// This asserts the property directly - every lane that runs tests gates deploy
// and publish - so the next lane split fails here instead of in production.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { load } from "js-yaml";
import { spawnSync } from "node:child_process";
import { expandedDeployWorkflow } from "./lib/ci-workflow.js";

const wf = load(expandedDeployWorkflow());
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };

// GitHub starts no run from a workflow file over 500 KB (512,000 bytes): the
// push run fails with zero jobs and "a workflow file issue". Keep headroom so
// a batch that adds tests fails here, locally, instead of on the push.
{
  for (const f of readdirSync(new URL("../.github/workflows/", import.meta.url)).filter((n) => /\.ya?ml$/.test(n))) {
    const bytes = Buffer.byteLength(readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), "utf8"));
    ok(bytes <= 512_000 - 4_096, `${f} is ${bytes} bytes; GitHub runs no workflow over 512000 bytes, keep 4096 of headroom (move logic into scripts or trim comments)`);
  }
  // Test lists live in scripts/ci/lanes and run through scripts/ci/run-step.sh,
  // so a lane's growth never reaches the workflow file.
  const raw = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  ok(!/^\s*t\(\) \{/m.test(raw), "deploy.yml defines no inline t helper: a multi-script step runs its list from scripts/ci/lanes through scripts/ci/run-step.sh");
}

const jobs = wf.jobs || {};
// A "test lane" is any job whose steps actually run scripts/test-*.js. Derived,
// never a list: a hand-kept list is the thing that just went wrong one layer up.
const laneRunsTests = (j) =>
  (j.steps || []).some((s) => /node\s+scripts\/test-[\w.-]+\.js/.test(String(s.run || "")));
// Scoped to the `test*` lanes: paytest, publish and deploy also run scripts,
// but they are opt-in or post-deploy jobs, not the gating suite.
const lanes = Object.entries(jobs)
  .filter(([n, j]) => /^test(-|$)/.test(n) && laneRunsTests(j))
  .map(([n]) => n);

ok(lanes.length >= 4, `expected the split test lanes, found: ${lanes.join(", ")}`);
ok(lanes.includes("test-pricing"), "the pricing-margin lane is not detected as a test lane");

for (const gate of ["deploy", "publish"]) {
  const needs = [].concat(jobs[gate]?.needs || []);
  for (const lane of lanes) {
    ok(needs.includes(lane),
      `${gate} does not gate on the "${lane}" lane - that lane's failures cannot stop a release`);
  }
}

// The lanes must also be reachable at all: a lane whose `if:` never fires on a
// push to main is a guard that silently never runs.
for (const lane of lanes) {
  const cond = String(jobs[lane]?.if || "");
  ok(cond.includes("refs/heads/main"),
    `lane "${lane}" has no push-to-main condition, so a merge would skip it`);
}

// Chromium is expensive and only one lane needs it. Assert the pairing rather
// than the absence, so adding a browser test to a lane without the install
// fails here instead of at runtime.
// Whether a script drives a browser is read from the SCRIPT ITSELF, never from
// a name pattern. The first draft matched /reveal-[\w-]+/ and flagged
// test-reveal-no-hero-flash.js, which only reads source files - a name-shaped
// oracle inventing a dependency that does not exist. The import list is the
// only thing that actually decides whether Chromium is needed.
const scriptsIn = (j) => (j.steps || [])
  .flatMap((s) => [...String(s.run || "").matchAll(/scripts\/([\w.-]+\.js)/g)].map((m) => m[1]));
const needsBrowser = (file) => {
  const path = new URL(`../scripts/${file}`, import.meta.url);
  if (!existsSync(path)) return false;
  return /from\s+["'](playwright|puppeteer)|require\(["'](playwright|puppeteer)/.test(readFileSync(path, "utf8"));
};

for (const [name, j] of Object.entries(jobs)) {
  const steps = j.steps || [];
  const usesBrowser = scriptsIn(j).some(needsBrowser);
  const installs = steps.some((s) => /playwright install|ci-apt-install\.sh --playwright-chromium/.test(String(s.run || "")));
  if (usesBrowser) ok(installs, `job "${name}" runs a browser-driven script without installing Chromium`);
  if (installs) ok(usesBrowser, `job "${name}" installs Chromium but runs no browser-driven script - pure wasted minutes`);
}

// --- a job that runs our scripts must be able to run them ------------------
// tree-gate shipped without an install step and its first real run died on a
// missing dependency. It failed closed so nothing was released untested, but a
// guard that cannot execute saves nothing, and nothing here would have noticed
// - the job simply went red beside a green suite.
//
// "Needs node_modules" is read from the SCRIPTS, transitively through their own
// relative imports, never from the job's name. The first draft asked only "does
// this job run node scripts/" and flagged `probe`, whose script imports nothing
// but node:url - the same name-shaped guessing this file already had to remove
// once for Chromium.
const bareImportsIn = (file, seen = new Set()) => {
  const path = new URL(`../${file}`, import.meta.url);
  if (seen.has(path.href) || !existsSync(path)) return false;
  seen.add(path.href);
  const src = readFileSync(path, "utf8");
  // Static AND dynamic. The first version matched only `from "x"` / `import "x"`
  // and so missed `await import("x")` - which is exactly how ci-tree-gate.js
  // loads js-yaml, meaning the guard did not catch the very bug it was written
  // for. The mutation that removes the gate's install step passed a green run.
  const specs = [
    ...[...src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...src.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
    ...[...src.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
  ];
  for (const spec of specs) {
    if (spec.startsWith("node:")) continue;
    if (!spec.startsWith(".")) return true;           // a real package
    const rel = new URL(spec, path);
    const relFile = rel.href.slice(new URL("../", import.meta.url).href.length);
    if (bareImportsIn(relFile, seen)) return true;
  }
  return false;
};
for (const [name, j] of Object.entries(jobs)) {
  const steps = j.steps || [];
  const files = steps.flatMap((s) => [...String(s.run || "").matchAll(/(scripts\/[\w.-]+\.js)/g)].map((m) => m[1]));
  if (!files.length) continue;
  const needsModules = files.some((f) => bareImportsIn(f));
  if (!needsModules) continue;
  const installs = steps.some((s) => /npm (ci|install)/.test(String(s.run || "")));
  ok(installs, `job "${name}" runs a script that imports a package but never installs dependencies - it dies on the first import`);
}

// --- the sweep hand-over must be a hand-over, not a drop ---------------------
// test-all.js skips every route the strict non-metered sweep asserts on when
// TEST_ALL_SKIP_STRICT_COVERED=1. That is only sound if the strict sweep runs
// in the SAME job, BEFORE it, against the same server, and can fail the job.
// Move either step, or give the strict one continue-on-error, and ~450 routes
// are quietly swept by nobody - so the pairing is asserted here, not assumed.
for (const [name, j] of Object.entries(jobs)) {
  const steps = j.steps || [];
  const idxAll = steps.findIndex((s) => /TEST_ALL_SKIP_STRICT_COVERED=1[^\n]*scripts\/test-all\.js/.test(String(s.run || "")));
  if (idxAll < 0) continue;
  const idxStrict = steps.findIndex((s) => /scripts\/test-non-metered-examples\.js/.test(String(s.run || "")));
  ok(idxStrict >= 0 && idxStrict < idxAll,
    `job "${name}" runs test-all with the strict hand-over but the strict sweep does not run earlier in the same job`);
  if (idxStrict >= 0) ok(!steps[idxStrict]["continue-on-error"],
    `job "${name}": the strict sweep is continue-on-error, so the routes handed to it could fail without failing the lane`);
}

// --- the marker has to live where `markers` actually looks ----------------
// PR #1336 shipped with [test][publish] in its TITLE, every check green, and
// the publish job SKIPPED: `markers` parses SUBJECT LINES ONLY over the push
// range, and merge-on-green.sh merges with `--merge`, which puts the PR title
// in the merge commit's BODY. The fix that reached prod never reached npm.
// Pinned from source in both directions so the two cannot drift apart again.
{
  const wfText = expandedDeployWorkflow();
  const mog = readFileSync(new URL("./merge-on-green.sh", import.meta.url), "utf8");
  const subjectsOnly = /git log[^\n]*--format='%s'/.test(wfText);
  ok(subjectsOnly, "markers parses commit SUBJECT lines (the constraint the docs have to match)");
  const mergeStyle = /gh pr merge[^\n]*--squash/.test(mog) ? "squash" : "merge";
  ok(mergeStyle === "merge", "merge-on-green.sh merges with --merge (PR title lands in the BODY)");
  // If either side ever changes, the guidance below is what has to change with it.
  // The guidance lives in CLAUDE.md or a path-scoped .claude/rules/*.md file,
  // so read them as one text: a paragraph moved between them stays checked.
  const rulesDir = new URL("../.claude/rules/", import.meta.url);
  const claude = [readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8"),
    ...readdirSync(rulesDir).filter((f) => f.endsWith(".md")).sort().map((f) => readFileSync(new URL(f, rulesDir), "utf8"))].join("\n");
  ok(/marker in a COMMIT SUBJECT/.test(claude),
     "CLAUDE.md tells the next author to put the marker in a commit SUBJECT, not the PR title");
  ok(!/put the marker in the PR TITLE so the merge commit carries it/.test(claude),
     "...and no longer carries the advice that silently skipped a publish");

  // The helper reads production's ledgerDeadLetter word before it merges and
  // refuses on the two words the deploy job's quiet gate holds on (a money
  // journal entry waiting on a container's local disk); an unreadable word
  // continues, because the gate in CI is the enforcement. Pinned to the order:
  // the read has to come before `gh pr merge`, or it reads nothing in time.
  const mergeAt = mog.indexOf("gh pr merge ");
  const readAt = mog.indexOf(".ledgerDeadLetter.status");
  ok(readAt > 0 && mergeAt > readAt, "merge-on-green.sh reads ledgerDeadLetter.status from /api/gateway-status before gh pr merge");
  ok(/\n\s*local\|stuck\)[^\n]*exit 1/.test(mog), "...and exits 1 without merging on local or stuck");
  ok(/\n\s*""\)[^\n]*continuing/.test(mog), "...and continues when the word is unreadable");
  const gate = readFileSync(new URL("./deploy-quiet-gate.js", import.meta.url), "utf8");
  ok(/LEDGER_HOLD_WORDS = new Set\(\["local", "stuck"\]\)/.test(gate), "the quiet gate holds on the same two words");
}

// --- every marker the parser knows has an output, and the pass that spends
// --- with the operator token never runs from a push ------------------------
// The MARKERS list and the outputs block are two lists of the same names and
// cannot drift apart. The listing pass (scripts/payai-listing-pass.js) pays
// with the Base and Solana burners AND the operator token (the settle-via gate). A
// job a commit subject can start is a job a branch push can start with a
// modified script, so it is not a deploy.yml job at all: it is a job of
// spend.yml, the one owner-dispatched spend workflow (no schedule, no push
// trigger), and sits in the spending environment.
{
  const wfText = expandedDeployWorkflow();
  const m = wfText.match(/MARKERS="([^"]+)"/);
  ok(!!m, "the markers job declares its MARKERS list");
  const markers = m ? m[1].split(/\s+/).filter(Boolean) : [];
  const outputs = Object.keys(jobs.markers?.outputs || {});
  for (const marker of markers) {
    ok(outputs.includes(marker.replace(/-/g, "_")), `marker [${marker}] has a markers output`);
  }
  ok(!/node scripts\/payai-listing-pass\.js/.test(wfText), "deploy.yml never runs the listing pass: a push could carry a modified script to the operator token");

  const spend = load(readFileSync(new URL("../.github/workflows/spend.yml", import.meta.url), "utf8"));
  // One spend job per choice: a sub-workflow of the jobs a choice runs.
  const jobsFor = (name) => ({ ...spend, jobs: Object.fromEntries(Object.entries(spend.jobs || {}).filter(([, j]) => new RegExp(`inputs\\.job == '${name}'`).test(String(j.if || "")))) });
  const listing = jobsFor("listing-pass");
  const on = spend.on || spend[true] || {};
  ok(Object.keys(on).sort().join() === "schedule,workflow_dispatch", `spend.yml runs on dispatch and one schedule only: no push or pull_request trigger (${Object.keys(on).join(", ")})`);
  ok(Array.isArray(on.schedule) && on.schedule.length === 1, "spend.yml carries exactly one schedule");
  // A scheduled run has no inputs, so only the listing pass and its report may
  // name the schedule; every other job stays dispatch-only.
  for (const [name, j] of Object.entries(spend.jobs || {})) {
    const sched = /github\.event_name == 'schedule'/.test(String(j.if || ""));
    ok(sched === (name === "listing-pass" || name === "listing-pass-report"), `${name}: ${sched ? "runs" : "does not run"} on the weekly schedule`);
  }
  const choices = on.workflow_dispatch?.inputs?.job?.options || [];
  ok(on.workflow_dispatch?.inputs?.job?.type === "choice" && on.workflow_dispatch?.inputs?.job?.required === true && choices.includes("listing-pass") && choices.includes("mint-bazaar-rows"), "a required job choice picks the spend job");
  for (const c of choices) {
    const own = Object.entries(jobsFor(c).jobs);
    // The listing pass alone also runs on the weekly schedule (asserted above).
    const gate = c === "listing-pass" ? `\\(?inputs\\.job == '${c}' \\|\\| github\\.event_name == 'schedule'\\)?` : `inputs\\.job == '${c}'`;
    ok(own.length >= 1 && own.every(([, j]) => new RegExp(`^(always\\(\\) && )?${gate}$`).test(String(j.if || ""))), `choice ${c} runs only its own job(s), each gated on the choice`);
    ok(own.some(([, j]) => j.environment === "spending"), `choice ${c} keeps the spending environment's approval`);
  }
  ok(Object.values(spend.jobs || {}).every((j) => /inputs\.job == '/.test(String(j.if || ""))), "every spend.yml job is gated on the job choice");
  const inputs = on.workflow_dispatch?.inputs || {};
  ok("max_spend_usd" in inputs && "max_price_usd" in inputs, "its dispatch takes the run ceiling and the optional per-route cap");
  ok(String(inputs.max_price_usd?.default ?? "") === "" && Number(inputs.max_spend_usd?.default) >= 20, "no per-route cap by default; a per-run ceiling by default");
  ok(/bazaar-base/.test(String(inputs.legs?.default || "")) && /bazaar-solana/.test(String(inputs.legs?.default || "")) && /payai-solana/.test(String(inputs.legs?.default || "")) && /payai-base/.test(String(inputs.legs?.default || "")), "its default legs cover both registries on both chains");
  const ljobs = listing.jobs || {};
  const spender = Object.values(ljobs).find((j) => (j.steps || []).some((st) => /payai-listing-pass\.js/.test(String(st.run || ""))));
  ok(Object.values(ljobs).length === 2 && Object.values(ljobs).every((j) => JSON.stringify(j.permissions) === JSON.stringify({ contents: "read", issues: "write", actions: "read" })), "its token can read the tree and artifacts and write issues, nothing else");
  ok(!!spender?.concurrency?.group && spender?.concurrency?.["cancel-in-progress"] === false, "one run at a time: a second run queues behind the first instead of racing the burner's nonces");
  ok(!!spender, "a job in the listing workflow runs the pass");
  ok(String(spender?.environment || "") === "spending", "that job carries the spending environment");
  const run = (spender?.steps || []).map((st) => String(st.run || "")).join("\n");
  ok(/scripts\/payai-listing-pass\.js --registry "\$REGISTRY" --chain "\$CHAIN" --live --include-upstream --max-spend "\$MAX_SPEND_USD" \$\{MAX_PRICE_USD:\+--max-price "\$MAX_PRICE_USD"\}/.test(run), "it runs each leg live, vendor-calling routes included, under the run ceiling, with the per-route cap only when one is given");
  // The purchase memory: downloaded before the buy step, with the workflow
  // token only, and handed to every leg with the 14-day window.
  const steps = spender?.steps || [];
  const memAt = steps.findIndex((st) => /node scripts\/listing-pass-memory\.js --out bought --days 14\b/.test(String(st.run || "")));
  const buyAt = steps.findIndex((st) => /payai-listing-pass\.js/.test(String(st.run || "")));
  ok(memAt >= 0 && memAt < buyAt, "the purchase memory is downloaded before the step that spends");
  ok(memAt >= 0 && JSON.stringify(steps[memAt].env || {}) === JSON.stringify({ GH_TOKEN: "${{ github.token }}" }) && !steps[memAt].if && steps[memAt]["continue-on-error"] !== true, "the download carries the workflow token and no wallet secret, and a failed download stops the job");
  ok(/--bought bought --rebuy-after-days 14 /.test(run), "every leg reads the memory with the 14-day window");
  ok(/--inputs scripts\/listing-inputs\.json /.test(run) && existsSync(new URL("./listing-inputs.json", import.meta.url)), "every leg buys with the committed purposeful inputs");
  const uploads = (wf) => Object.values(wf.jobs || {}).flatMap((j) => j.steps || []).filter((st) => /actions\/upload-artifact@/.test(String(st.uses || "")));
  const lUp = uploads(listing);
  ok(lUp.length === 1 && lUp[0].with?.name === "listing-pass" && lUp[0].if === "always()" && Number(lUp[0].with?.["retention-days"]) >= 14 && /pass-\*\.json/.test(String(lUp[0].with?.path)), "the pass records upload as listing-pass on every outcome, kept at least 14 days");
  // The dispatch input checks, run as written: the ceiling is above 0 and at
  // most 100, a per-route cap is above 0 or empty.
  const checks = String(steps[buyAt]?.run || "").split('FAILED=""')[0];
  const inputCheck = (envs) => spawnSync("bash", ["-ec", checks], { env: { PATH: process.env.PATH, BURNER_KEY: "k", SOLANA_BURNER_KEY: "k", AGENT402_OPERATOR_TOKEN: "k", POW_SECRET: "", LEGS: "bazaar-base", ONLY: "", MAX_PRICE_USD: "", MAX_SPEND_USD: "40", ...envs }, encoding: "utf8" }).status;
  ok(checks.length > 100 && inputCheck({}) === 0 && inputCheck({ MAX_SPEND_USD: "100" }) === 0 && inputCheck({ MAX_PRICE_USD: "0.5" }) === 0, "the default inputs, a $100 ceiling and a positive cap pass the input check");
  ok(inputCheck({ MAX_PRICE_USD: "0" }) === 1 && inputCheck({ MAX_PRICE_USD: "0.00" }) === 1, "max_price_usd 0 is refused (empty is the way to say no cap; the pass refuses 0 too)");
  ok(inputCheck({ MAX_SPEND_USD: "100.01" }) === 1 && inputCheck({ MAX_SPEND_USD: "5000" }) === 1 && inputCheck({ MAX_SPEND_USD: "0" }) === 1 && inputCheck({ MAX_SPEND_USD: "abc" }) === 1, "max_spend_usd above 100, zero or unreadable is refused");
  const legsEnv = Object.assign({}, ...(spender?.steps || []).map((st) => st.env || {})).LEGS;
  ok(/inputs\.legs/.test(String(legsEnv || "")) && !/\$\{\{\s*inputs\./.test(run), "the legs list reaches the step through its environment, never interpolated into the script");
  ok("only" in inputs && String(inputs.only?.default ?? "") === "" && inputs.only?.required !== true, "its dispatch takes an optional only list, empty by default (unchanged behavior)");
  const onlyEnv = Object.assign({}, ...(spender?.steps || []).map((st) => st.env || {})).ONLY;
  ok(/inputs\.only/.test(String(onlyEnv || "")) && !/\$\{\{\s*inputs\.only/.test(run) && /\$\{ONLY:\+--only "\$ONLY"\}/.test(run), "the only list reaches the pass through the step environment as --only, never interpolated into the script");
  ok(/add-mask::\$AGENT402_OPERATOR_TOKEN/.test(run) && /add-mask::\$SOLANA_BURNER_KEY/.test(run) && /add-mask::\$BURNER_KEY/.test(run) && /add-mask::\$POW_SECRET/.test(run), "all four secrets are masked in its log");
  const stepEnv = Object.assign({}, ...(spender?.steps || []).map((st) => st.env || {}));
  ok(!spender?.env?.SOLANA_BURNER_KEY && !spender?.env?.BURNER_KEY && !spender?.env?.AGENT402_OPERATOR_TOKEN && !spender?.env?.POW_SECRET, "no secret sits at job scope, where the dependency install could read it");
  const mint = jobsFor("mint-bazaar-rows");
  const mintEnv = Object.assign({}, ...Object.values(mint.jobs || {}).flatMap((j) => (j.steps || []).map((st) => st.env || {})));
  const mUp = uploads(mint);
  const mintRun = Object.values(mint.jobs || {}).flatMap((j) => j.steps || []).map((st) => String(st.run || "")).join("\n");
  ok(/--live --out \/tmp\/mint\/pass-mint\.json/.test(mintRun) && mUp.length === 1 && mUp[0].with?.name === "mint-bazaar-rows" && mUp[0].if === "always()" && Number(mUp[0].with?.["retention-days"]) >= 14 && mUp[0].with?.path === "/tmp/mint/pass-*.json", "a live mint records its buys and keeps them as mint-bazaar-rows for at least 14 days");
  ok(/secrets\.BURNER_KEY\b/.test(String(stepEnv.BURNER_KEY || "")) && /secrets\.BURNER_KEY\b/.test(String(mintEnv.BURNER_KEY || "")), "the Base legs pay from the same EVM burner the Bazaar mint uses");
  ok(/secrets\.AGENT402_OPERATOR_TOKEN/.test(String(stepEnv.AGENT402_OPERATOR_TOKEN || "")) && /secrets\.POW_SECRET/.test(String(stepEnv.POW_SECRET || "")), "the operator token and pow secret come from the same secrets the heartbeat uses");
  const sibling = jobs["bazaar-solana"];
  const siblingEnv = Object.assign({}, ...(sibling?.steps || []).map((st) => st.env || {}));
  ok(!!sibling && /secrets\.SOLANA_BURNER_KEY/.test(String(siblingEnv.SOLANA_BURNER_KEY || "")) && /secrets\.SOLANA_BURNER_KEY/.test(String(stepEnv.SOLANA_BURNER_KEY || "")), "the pass pays from the same Solana burner as bazaar-solana");
  const installOf = (j) => (j?.steps || []).map((st) => String(st.run || "")).find((r) => /npm install --no-save/.test(r)) || "";
  ok(installOf(spender) && installOf(spender) === installOf(sibling), "it installs the same client packages as bazaar-solana, one line to keep pinned");
  const reporter = Object.values(ljobs).find((j) => /gh issue create/.test((j.steps || []).map((st) => String(st.run || "")).join("\n")));
  const report = (reporter?.steps || []).map((st) => String(st.run || "")).join("\n");
  ok(!!reporter && String(reporter.if || "") === "always() && (inputs.job == 'listing-pass' || github.event_name == 'schedule')" && [].concat(reporter.needs || []).length === 1, "a report job runs after the pass whatever its result, and only on a listing-pass dispatch");
  const lp = listing.jobs["listing-pass"] || {};
  ok(lp.outputs?.started === "${{ steps.started.outputs.started }}" && (lp.steps || [])[0]?.id === "started", "the listing pass marks itself started in its first step");
  ok((reporter?.steps || []).some((st) => st.env?.STARTED === "${{ needs.listing-pass.outputs.started }}") && /if \[ "\$STARTED" != "true" \]; then[\s\S]*?exit 0[\s\S]*?if \[ "\$PASS" != "success" \]/.test(report), "a pass that never started (approval not given) pages nothing");
  ok(/TITLE="Listing pass FAILED"/.test(report) && /in:title/.test(report) && /gh issue comment .*Still failing/.test(report) && /gh issue close .*Recovered/.test(report), "it keeps one issue by title: open, Still failing, Recovered on the next green run");

  // The one schedule starts the listing pass, behind the same approval.
  ok(listing.jobs["listing-pass"]?.environment === "spending", "the scheduled listing pass waits for the spending approval");
}

// A run on main is a release and is never canceled by a newer push; the dev
// branch keeps cancel-in-progress. Every job is bounded, and no call to the
// platform API can wait forever.
{
  const raw = expandedDeployWorkflow();
  const conc = wf.concurrency || {};
  // The group is an expression: evaluated here for every event and every
  // dispatch mode a job reads, so a release never shares a group with a
  // manual pass (which would hold it, or replace it while it is pending).
  const groupExpr = String(conc.group || "").match(/^\$\{\{([\s\S]*)\}\}$/)?.[1] || "";
  ok(groupExpr !== "" && !/github\.event\.inputs|\bfromJSON\b|\bcontains\b/.test(groupExpr), "the concurrency group is one expression over github and inputs");
  let groupOf = () => null;
  try {
    // The expression uses only ==, !=, &&, ||, quoted strings and format(), which read the same in JavaScript.
    const fn = new Function("github", "inputs", "format", `return (${groupExpr});`);
    const format = (t, ...a) => t.replace(/\{(\d+)\}/g, (_, i) => String(a[Number(i)]));
    groupOf = (event_name, ref, mode) => fn({ event_name, ref }, { mode: event_name === "workflow_dispatch" ? mode : "" }, format);
  } catch (e) { ok(false, `the concurrency group expression could not be evaluated (${e.message})`); }
  const MAIN = "refs/heads/main", DEV = "refs/heads/claude/sweet-brown-i99jl3";
  const release = groupOf("push", MAIN);
  ok(typeof release === "string" && release.includes(MAIN), `a push to main runs in the release group for main (${release})`);
  ok(groupOf("push", DEV) !== release && String(groupOf("push", DEV)).includes(DEV), "runs are grouped per branch, so a main run only ever queues behind a main run");
  ok(groupOf("pull_request", "refs/pull/7/merge") !== release, "a pull_request run never shares main's release group");
  const modesOf = (j) => [...String(j.if || "").matchAll(/inputs\.mode == '([\w-]+)'/g)].map((m) => m[1]);
  const allModes = new Set(Object.values(jobs).flatMap(modesOf));
  // A release mode is one that starts a job in a deployment environment.
  const releaseModes = new Set(Object.values(jobs).filter((j) => j.environment !== undefined).flatMap(modesOf));
  ok(releaseModes.has("deploy") && releaseModes.has("publish") && releaseModes.size === 2, `the modes that start a production-environment job are deploy and publish (${[...releaseModes].join(", ")})`);
  const releasing = Object.entries(jobs).filter(([, j]) => j.environment === undefined && /npm publish --provenance|mutation\s*\(\$|wrangler deploy|railway (up|redeploy)\b/.test(JSON.stringify(j.steps || []))).map(([n]) => n);
  ok(releasing.length === 0, `no job outside a deployment environment publishes a package or changes the service (${releasing.join(", ") || "none"})`);
  for (const m of releaseModes) ok(groupOf("workflow_dispatch", MAIN, m) === release, `a dispatch with mode=${m} on main stays in the release group`);
  const manual = [...allModes].filter((m) => !releaseModes.has(m));
  ok(manual.length >= 8 && manual.includes("bazaar-sweep") && manual.includes("probe") && manual.includes("test"), `the manual modes are derived from the jobs (${manual.join(", ")})`);
  const manualGroups = new Set(manual.map((m) => groupOf("workflow_dispatch", MAIN, m)));
  ok(!manualGroups.has(release), `no manual dispatch mode shares main's release group (${manual.filter((m) => groupOf("workflow_dispatch", MAIN, m) === release).join(", ") || "none does"})`);
  ok(manualGroups.size === 1 && [...manualGroups][0]?.includes(MAIN), "the manual modes on main share one group of their own (one at a time among themselves)");
  ok(groupOf("workflow_dispatch", DEV, "probe") !== groupOf("workflow_dispatch", MAIN, "probe"), "a manual dispatch on another branch is its own group");
  ok(wf.on?.workflow_dispatch?.inputs?.mode?.default === "deploy", "a dispatch with no mode given is a deploy, in the release group");
  ok(conc["cancel-in-progress"] === "${{ github.ref != 'refs/heads/main' }}",
    `a run on main must not be canceled in progress (cancel-in-progress is ${JSON.stringify(conc["cancel-in-progress"])})`);
  ok(Object.values(jobs).every((j) => j.concurrency === undefined), "no job sets its own concurrency, which would bypass the workflow's rule for main");
  const unbounded = Object.entries(jobs).filter(([, j]) => !(Number.isInteger(j["timeout-minutes"]) && j["timeout-minutes"] >= 1 && j["timeout-minutes"] <= 180)).map(([n]) => n);
  ok(unbounded.length === 0, `every job has a timeout-minutes of at most 180 (missing or out of range: ${unbounded.join(", ") || "none"})`);
  for (const n of ["deploy", "publish", "publish-gate", "probe"]) ok(Number.isInteger(jobs[n]?.["timeout-minutes"]), `the ${n} job is bounded`);
  // The deploy job's bound sits above its own wait loops (quiet gate 20 min,
  // two 15-minute deployment watches, the health and MCP waits), so it never
  // ends a healthy run.
  ok(jobs.deploy?.["timeout-minutes"] >= 90, `the deploy job's bound leaves room for its own wait loops (${jobs.deploy?.["timeout-minutes"]})`);
  // Every curl to the platform API, with its continuation lines, has a limit.
  const lines = raw.split("\n");
  const calls = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\bcurl\b/.test(lines[i]) || /^\s*#/.test(lines[i])) continue;
    let cmd = lines[i], k = i;
    while (/\\\s*$/.test(lines[k]) && k + 1 < lines.length) cmd += "\n" + lines[++k];
    if (/backboard\.railway\.(app|com)/.test(cmd)) calls.push({ line: i + 1, cmd });
  }
  const bare = calls.filter((c) => !/--max-time\s+\d+/.test(c.cmd)).map((c) => c.line);
  ok(calls.length >= 8, `the platform API calls are found (${calls.length})`);
  ok(bare.length === 0, `every platform API curl carries --max-time (bare at line ${bare.join(", ") || "none"})`);
  ok(calls.every((c) => { const m = /--max-time\s+(\d+)/.exec(c.cmd); return m && Number(m[1]) <= 60; }), "each platform API call is bounded at a minute or less");
}

// --- a replaced queued release keeps its markers ---------------------------
// Nothing on main is canceled in progress and GitHub keeps one pending run per
// group, so of two merges queued behind a running release only the newer run
// starts. Its pushed range holds only its own commits; the parse step reads on
// from the head of the last run whose markers job finished
// (scripts/marker-base.js), so the replaced push's markers are read, once.
// Modeled here: the step's own `run:` text, executed in a throwaway repository
// of three pushes against a stub of the two GitHub reads it makes. What the
// stub cannot show is GitHub itself: how a replaced run is listed there.
{
  const markersJob = jobs.markers || {};
  const parse = (markersJob.steps || []).find((s) => s.id === "parse") || {};
  const runText = String(parse.run || "");
  ok(JSON.stringify(markersJob.permissions) === JSON.stringify({ contents: "read", actions: "read" }), `the markers job's token reads the tree and the workflow's runs, nothing else (${JSON.stringify(markersJob.permissions)})`);
  ok(!runText.includes("${{") && (markersJob.steps || []).every((s) => !String(s.run || "").includes("${{")), "no markers step interpolates an expression into its script");
  ok(/node scripts\/marker-base\.js/.test(runText) && /refs\/heads\/main/.test(runText), "the parse step asks scripts/marker-base.js where to read from, on main only");
  ok(/merge-base --is-ancestor/.test(runText), "...and reads on from that commit only when it is an ancestor of the push");

  const { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const http = await import("node:http");
  const repo = mkdtempSync(join(tmpdir(), "a402-markers-"));
  const git = (...a) => { const r = spawnSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
  git("init", "-q", "-b", "main");
  mkdirSync(join(repo, "scripts"));
  copyFileSync(new URL("./marker-base.js", import.meta.url), join(repo, "scripts", "marker-base.js"));
  git("add", "scripts/marker-base.js");
  const commit = (subject, body = "") => { git("commit", "-q", "--allow-empty", "-m", subject, ...(body ? ["-m", body] : [])); return git("rev-parse", "HEAD"); };
  const base = commit("[test] base");
  // Three pushes (each a branch commit and its merge, the way merge-on-green
  // lands them) and a fourth after the release caught up.
  commit("[test] first change");
  const A = commit("Merge pull request #1 from o/dev", "[test] first");
  commit("[test] [publish] second change");
  commit("[paytest] [drain] second change, more");
  const B = commit("Merge pull request #2 from o/dev", "[purl] in a body is not a marker");
  commit("[test] third change");
  const C = commit("Merge pull request #3 from o/dev");
  commit("[test] [probe] fourth change");
  const D = commit("Merge pull request #4 from o/dev");

  // The stub: what GitHub lists for this workflow's push runs on main, and
  // each run's jobs.
  // The parse step's token is the workflow's own (the runs read needs it);
  // the stub answers only a request that carries the token the step was given.
  const STEP_TOKEN = "stub-token";
  ok(String(parse.env?.GH_TOKEN ?? "").replace(/\s+/g, "") === "${{github.token}}", `the parse step passes the workflow token to scripts/marker-base.js (${JSON.stringify(parse.env?.GH_TOKEN ?? null)})`);
  const state = { runs: [], jobs: {}, status: 200, hits: 0, hang: false };
  const hung = [];
  const server = http.createServer((req, res) => {
    state.hits++;
    const u = new URL(req.url, "http://stub");
    const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (state.hang) { hung.push(res); return; }
    if (req.headers.authorization !== `Bearer ${STEP_TOKEN}`) return send(401, { message: "Requires authentication" });
    if (state.status !== 200) return send(state.status, { message: "refused" });
    if (u.pathname === "/repos/o/r/actions/workflows/deploy.yml/runs" && u.searchParams.get("branch") === "main" && u.searchParams.get("event") === "push") return send(200, { workflow_runs: state.runs });
    const m = /^\/repos\/o\/r\/actions\/runs\/(\d+)\/jobs$/.exec(u.pathname);
    if (m) return send(200, { jobs: state.jobs[m[1]] || [] });
    send(404, { message: "not found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${server.address().port}`;
  const ran = (n, sha) => { state.runs.unshift({ id: 100 + n, run_number: n, head_sha: sha, event: "push", head_branch: "main", status: "completed", conclusion: "success" }); state.jobs[100 + n] = [{ name: "markers", conclusion: "success" }, { name: "test", conclusion: "success" }]; };
  const replaced = (n, sha, jobsSeen = []) => { state.runs.unshift({ id: 100 + n, run_number: n, head_sha: sha, event: "push", head_branch: "main", status: "completed", conclusion: "cancelled" }); state.jobs[100 + n] = jobsSeen; };

  const step = (n, before, after, { ref = "refs/heads/main", extra = {} } = {}) => new Promise((resolve) => {
    const out = join(repo, `.out-${n}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(out, "");
    // GH_TOKEN reaches the step only when the workflow names it in the step's env.
    const env = { PATH: process.env.PATH, HOME: repo, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", BEFORE: before, AFTER: after, EVENT_NAME: "push", ...(parse.env?.GH_TOKEN !== undefined ? { GH_TOKEN: STEP_TOKEN } : {}), MARKER_WORKFLOW_FILE: String(parse.env?.MARKER_WORKFLOW_FILE ?? "deploy.yml"),
      GITHUB_OUTPUT: out, GITHUB_REF: ref, GITHUB_REF_NAME: ref.replace("refs/heads/", ""), GITHUB_REPOSITORY: "o/r", GITHUB_RUN_NUMBER: String(n), GITHUB_API_URL: api, ...extra };
    const child = spawn("bash", ["-c", runText], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
    child.on("exit", (code) => {
      const got = Object.fromEntries(readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => l.split("=")));
      resolve({ code, log, on: Object.keys(got).filter((k) => got[k] === "true").sort().join(",") });
    });
  });

  try {
    // Push 1 runs alone: no earlier run, so its own range.
    const r1 = await step(1, base, A);
    ok(r1.code === 0 && r1.on === "test", `the first release reads its own pushed range (${r1.on}; exit ${r1.code})`);
    ran(1, A);
    // Push 2 queues behind run 1 and is replaced by push 3 before it starts.
    replaced(2, B);
    const r3 = await step(3, B, C);
    ok(r3.code === 0 && r3.on === "drain,paytest,publish,test", `the run that replaced a queued release reads the replaced push's subjects too: [publish], [paytest] and [drain] are on (${r3.on}; exit ${r3.code})`);
    {
      // The pushed range and the range since the last read run overlap: the
      // scanned list names each subject once.
      const listed = r3.log.split("Subject lines scanned for markers:")[1]?.split("\n").filter((l) => l.startsWith("  ")) || [];
      ok(listed.includes("  [test] third change") && listed.includes("  [test] [publish] second change") && new Set(listed).size === listed.length, `the subjects scanned are listed once each (${listed.length} lines, ${new Set(listed).size} distinct)`);
    }
    ok(!/(^|,)purl(,|$)/.test(r3.on), "a marker in a replaced merge commit's body is still not read");
    ran(3, C);
    // Push 4 after the release caught up: the replaced push is not read again.
    const r4 = await step(4, C, D);
    ok(r4.code === 0 && r4.on === "probe,test", `the next run starts from that run's head, so each subject is read by one run (${r4.on})`);

    // A replaced run that GitHub lists with a canceled markers job reads the same.
    state.runs = []; state.jobs = {}; ran(1, A); replaced(2, B, [{ name: "markers", conclusion: "cancelled" }]);
    const r3b = await step(3, B, C);
    ok(r3b.on === "drain,paytest,publish,test", `a replaced run listed with a canceled markers job is not counted as read (${r3b.on})`);
    // A run that read its markers and then failed a lane did read them.
    state.runs = []; state.jobs = {}; ran(1, A); ran(2, B); state.runs[0].conclusion = "failure";
    const r3c = await step(3, B, C);
    ok(r3c.on === "test", `a run whose markers job finished counts as read, whatever its later jobs did (${r3c.on})`);
    // The dev branch reads its pushed range and never asks.
    state.runs = []; state.jobs = {}; ran(1, A); replaced(2, B); state.hits = 0;
    const dev = await step(3, B, C, { ref: "refs/heads/claude/sweet-brown-i99jl3" });
    ok(dev.code === 0 && dev.on === "test" && state.hits === 0, `a push to the dev branch reads its pushed range and makes no API read (${dev.on}; ${state.hits} reads)`);
    // GitHub unreadable: the pushed range stands and the job still passes.
    state.status = 403;
    const down = await step(3, B, C);
    ok(down.code === 0 && down.on === "test", `an unreadable API leaves the pushed range and does not fail the job (${down.on}; exit ${down.code})`);
    state.status = 200;
    // A listed head that is not an ancestor of the push is not read from.
    const side = git("commit-tree", "-m", "[publish] elsewhere", `${base}^{tree}`);
    state.runs = []; state.jobs = {}; ran(2, side);
    const off = await step(3, B, C);
    ok(off.code === 0 && off.on === "test", `a listed head outside the push's history is ignored (${off.on}; exit ${off.code})`);
    // An API that takes the connection and never answers: the lookup gives up
    // at its one deadline and the pushed range stands, the job still passing.
    state.runs = []; state.jobs = {}; ran(1, A); replaced(2, B); state.hang = true;
    const hang = await step(3, B, C, { extra: { MARKER_BASE_DEADLINE_MS: "1500" } });
    state.hang = false;
    for (const r of hung.splice(0)) { try { r.destroy(); } catch { /* closed */ } }
    ok(hang.code === 0 && hang.on === "test" && /no answer within the 2 s deadline/.test(hang.log), `an API that never answers is given up at the lookup's deadline, the pushed range stands (${hang.on}; exit ${hang.code}; ${(/marker-base: [^\n]*/.exec(hang.log) || [""])[0]})`);
    // A value that is not a commit id never reaches git as a revision.
    state.runs = []; state.jobs = {}; ran(2, "--all"); state.runs[0].head_sha = "--all";
    const odd = await step(3, B, C);
    ok(odd.code === 0 && odd.on === "test", `a listed head that is not a commit id is ignored (${odd.on})`);
    // The step's own check, apart from the script's: a lookup that printed a
    // revision that is not a 40-hex commit id (here one naming the first
    // push, an ancestor) is not read from.
    state.runs = []; state.jobs = {};
    writeFileSync(join(repo, "scripts", "marker-base.js"), `console.log(${JSON.stringify(`${C}~5`)});\n`);
    let notSha;
    try { notSha = await step(3, B, C); } finally { copyFileSync(new URL("./marker-base.js", import.meta.url), join(repo, "scripts", "marker-base.js")); }
    ok(git("rev-parse", `${C}~5`) === A && notSha.code === 0 && notSha.on === "test", `a printed revision that is not a commit id is ignored by the step itself (${notSha.on})`);
    // The script itself exits 0 on an API error, printing nothing: a release
    // is never held on this lookup.
    {
      state.status = 403;
      const { fileURLToPath } = await import("node:url");
      const child = spawn(process.execPath, [fileURLToPath(new URL("./marker-base.js", import.meta.url))], { cwd: repo, env: { PATH: process.env.PATH, GH_TOKEN: STEP_TOKEN, GITHUB_REPOSITORY: "o/r", GITHUB_REF_NAME: "main", GITHUB_RUN_NUMBER: "3", GITHUB_API_URL: api }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
      const code = await new Promise((r) => child.on("exit", r));
      state.status = 200;
      ok(code === 0 && out === "" && /GitHub could not be read \(HTTP 403\)/.test(err), `marker-base.js exits 0 and prints no commit when GitHub answers an error (exit ${code}; ${err.trim().slice(0, 120)})`);
    }
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(repo, { recursive: true, force: true });
  }

  const { lastReadRun, MAX_RUNS_READ } = await import("./marker-base.js");
  const many = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, run_number: i + 1, head_sha: "a".repeat(40), event: "push" }));
  let asked = 0;
  const none = await lastReadRun({ runs: many, runNumber: 41, jobsOf: async () => { asked++; return []; } });
  ok(none.sha === null && asked === MAX_RUNS_READ, `the lookup reads a bounded number of earlier runs (${asked})`);
  const later = await lastReadRun({ runs: [{ id: 9, run_number: 9, head_sha: "b".repeat(40), event: "push" }, { id: 5, run_number: 5, head_sha: "c".repeat(40), event: "push" }], runNumber: 7, jobsOf: async () => [{ name: "markers", conclusion: "success" }] });
  ok(later.sha === "c".repeat(40), "a run numbered after this one is never read from (a re-run of an older run reads as it first did)");
  const markersRead = async () => [{ name: "markers", conclusion: "success" }];
  const self = await lastReadRun({ runs: [{ id: 7, run_number: 7, head_sha: "d".repeat(40), event: "push" }, { id: 5, run_number: 5, head_sha: "c".repeat(40), event: "push" }], runNumber: 7, jobsOf: markersRead });
  ok(self.sha === "c".repeat(40), `this run itself is never its own base (${self.sha?.slice(0, 7)})`);
  const pr = await lastReadRun({ runs: [{ id: 6, run_number: 6, head_sha: "e".repeat(40), event: "pull_request" }, { id: 5, run_number: 5, head_sha: "c".repeat(40), event: "push" }], runNumber: 7, jobsOf: markersRead });
  ok(pr.sha === "c".repeat(40), `a run of another event is never read from (${pr.sha?.slice(0, 7)})`);
  const shapes = await lastReadRun({ runs: [{ id: 6, run_number: 6, head_sha: "--all", event: "push" }, { id: 4, run_number: 4, head_sha: "F".repeat(40), event: "push" }, { id: 3, run_number: 3, head_sha: "c".repeat(39), event: "push" }, { id: 2, run_number: 2, head_sha: "c".repeat(40), event: "push" }], runNumber: 7, jobsOf: markersRead });
  ok(shapes.sha === "c".repeat(40) && shapes.read === 1, `a listed head that is not 40 lowercase hex is passed over before any jobs read (${shapes.sha?.slice(0, 7)}, ${shapes.read} read)`);
  const { deadlineMs, DEADLINE_MS_DEFAULT } = await import("./marker-base.js");
  const jobLimitMs = Number(markersJob["timeout-minutes"]) * 60_000;
  ok(deadlineMs({}) === DEADLINE_MS_DEFAULT && DEADLINE_MS_DEFAULT <= jobLimitMs / 2, `the lookup's default deadline (${DEADLINE_MS_DEFAULT / 1000} s) is at most half the markers job's limit (${jobLimitMs / 1000} s), leaving the checkout and the scan their time`);
  ok(deadlineMs({ MARKER_BASE_DEADLINE_MS: "1500" }) === 1500 && deadlineMs({ MARKER_BASE_DEADLINE_MS: "999999" }) === DEADLINE_MS_DEFAULT && deadlineMs({ MARKER_BASE_DEADLINE_MS: "nope" }) === DEADLINE_MS_DEFAULT && deadlineMs({ MARKER_BASE_DEADLINE_MS: "0" }) === DEADLINE_MS_DEFAULT, "a deadline setting can shorten the lookup, never lengthen it");
}

// THE REAL HTTP CLIENTS. scripts/test-402-real-clients.js reads a full-rail
// 402 with aiohttp, httpx and requests (python -I) and Go net/http, and fails
// under CI when one is missing. The lane that runs test-challenge-fit.js
// (test-unit-a4, step 2, every shard) installs them first: wheels only, every
// one pinned by version and sha256 with no resolution of its own (no
// dependency code runs at install), in a venv whose interpreter the suites
// read from REAL_CLIENT_PYTHON, and the runner image's newest Go as REAL_CLIENT_GO.
{
  const a4 = jobs["test-unit-a4"]?.steps || [];
  const iInstall = a4.findIndex((st) => /pip install/.test(String(st.run || "")));
  const iFit = a4.findIndex((st) => /scripts\/test-challenge-fit\.js/.test(String(st.run || "")));
  ok(iInstall >= 0 && iFit > iInstall, `test-unit-a4 installs the real HTTP clients before the step that runs test-challenge-fit.js (install ${iInstall}, suites ${iFit})`);
  const st = a4[iInstall] || {};
  const run = String(st.run || "");
  ok(!st.if, "the client install runs on every shard of the lane (no if:)");
  ok(/--require-hashes/.test(run) && /--only-binary=:all:/.test(run) && /--no-deps/.test(run), "the client install is hash-pinned wheels with no resolution of its own (--require-hashes --only-binary=:all: --no-deps)");
  const pins = [...run.matchAll(/^\s*([a-z0-9-]+)==([0-9][\w.]*) --hash=sha256:([0-9a-f]{64})\s*$/gm)].map((m) => m[1]);
  for (const name of ["aiohttp", "httpx", "requests", "httpcore", "h11", "anyio", "yarl", "multidict", "urllib3", "certifi", "idna", "charset-normalizer"]) {
    ok(pins.includes(name), `the client install pins ${name} by version and sha256`);
  }
  ok(/python3 -m venv /.test(run) && /REAL_CLIENT_PYTHON=.*GITHUB_ENV/.test(run) && /REAL_CLIENT_GO=.*GITHUB_ENV/.test(run), "the clients live in a venv the suites read from REAL_CLIENT_PYTHON, and Go is handed over as REAL_CLIENT_GO");
  ok(/import aiohttp, httpx, requests/.test(run) && /version/.test(run), "the install step proves the three clients import under -I, and Go answers its version");
}

// THE SWEEP SERVERS' LOGS. Both sweep lanes boot a server in the background
// and drive it from later steps; its output went to the boot step's log only
// until that step ended, so a failure later in the job had no server log to
// read. Each boot writes to a file under $RUNNER_TEMP, and an if: failure()
// step prints that file's tail through the shared secret redaction.
for (const lane of ["test-sweeps", "test-sweeps2"]) {
  const steps = jobs[lane]?.steps || [];
  const boot = steps.find((st) => /PORT=3000 node [^\n]*src\/server\.js[^\n]*&\s*$/m.test(String(st.run || "")));
  const file = /src\/server\.js > "(\$RUNNER_TEMP\/[\w.-]+\.log)" 2>&1 &/.exec(String(boot?.run || ""))?.[1];
  ok(Boolean(file), `${lane}: the sweep server's output goes to a file under $RUNNER_TEMP (${file || "not redirected"})`);
  const tail = steps.find((st) => String(st.if || "").replace(/\s/g, "") === "failure()" && file && String(st.run || "").includes(file.replace(/^\$RUNNER_TEMP\//, "")));
  ok(Boolean(tail) && /console\.log\(redactSecrets\(l\)\.replace\([^\n]*looksLikeCredential\(/.test(String(tail?.run || "")), `${lane}: a failure prints the server log's tail through the secret redaction`);
  ok(Boolean(tail) && steps.indexOf(tail) > steps.indexOf(boot), `${lane}: the log tail step comes after the boot`);
}

// THE TREE GATE'S BOUND. Run 44012918430 (2026-11-17): the gate job's checkout
// could not reach github.com for 133 s, waited 20 s, fetched in 71 s (3 min 46 s
// in all), and the gate itself then had 73 s of the job's 5 minutes; it was
// cancelled mid-read, which reads as a main run that is not green although every
// lane passed. The job's limit covers the checkout's own three attempts at that
// worst (actions/checkout retries a failed fetch twice, after 10 to 20 s), the
// setup and cache steps, and the gate script's own bound: its read budget
// plus one call in flight at the budget's end and one tree fetch.
{
  const gate = jobs["tree-gate"] || {};
  const src = readFileSync(new URL("./ci-tree-gate.js", import.meta.url), "utf8");
  const budgetMs = Number(/TREE_GATE_BUDGET_MS \|\| ([\d_]+)\)/.exec(src)?.[1]?.replace(/_/g, ""));
  const callMs = Number(/TREE_GATE_CALL_TIMEOUT_MS \|\| ([\d_]+)\)/.exec(src)?.[1]?.replace(/_/g, ""));
  ok(budgetMs > 0 && callMs > 0, `the gate's read budget (${budgetMs} ms) and call bound (${callMs} ms) are read from ci-tree-gate.js`);
  const CHECKOUT_WORST_S = 3 * 133 + 2 * 20 + 71; // three unreachable attempts' connect timeouts, two waits, one slow fetch
  const SETUP_S = 60;
  const gateWorstS = budgetMs / 1000 + 2 * callMs / 1000;
  const limitS = Number(gate["timeout-minutes"]) * 60;
  ok(limitS >= CHECKOUT_WORST_S + SETUP_S + gateWorstS, `the tree-gate job's limit (${limitS} s) covers the checkout's worst (${CHECKOUT_WORST_S} s), setup (${SETUP_S} s) and the gate's own bound (${gateWorstS} s)`);
  ok(limitS <= 20 * 60, `the tree-gate job's limit stays a bound, not a wait (${limitS} s)`);
}

console.log(`${pass} passed, ${fail} failed`);


process.exit(fail ? 1 : 0);

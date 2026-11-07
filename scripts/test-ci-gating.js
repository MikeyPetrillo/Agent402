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

const wf = load(readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };

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
  const wfText = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
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
  const wfText = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
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

console.log(`${pass} passed, ${fail} failed`);


process.exit(fail ? 1 : 0);

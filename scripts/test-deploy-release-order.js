// The deploy job's variable upsert passes skipDeploys, so a changed value
// never starts Railway's own deploy beside the job's trigger (two
// deployments of one commit, the first stopped and marked FAILED). The
// publish job runs ClawHub last, so a refusal on ClawHub's side never holds
// back the npm and MCP Registry releases.
// Offline: reads the workflow text only.
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { expandedDeployWorkflow } from "./lib/ci-workflow.js";

const wf = load(expandedDeployWorkflow());
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const deploySteps = wf.jobs?.deploy?.steps || [];
const upserts = deploySteps.filter((s) => /variableCollectionUpsert/.test(String(s.run || "")));
ok(upserts.length >= 1, `the deploy job holds the variable upsert (${upserts.length})`);
for (const s of upserts) {
  const calls = String(s.run).split("\n").filter((l) => !/^\s*#/.test(l) && /variableCollectionUpsert\(input:/.test(l));
  ok(calls.length >= 1 && calls.every((l) => /skipDeploys:\s*true/.test(l)), `"${s.name}": every upsert call passes skipDeploys: true`);
}
// The verify step prints /api/pricing as a diagnostic under `set -e`: a slow
// read must not end the step before the health and paywall gates decide.
{
  const verify = deploySteps.find((s) => /=== pricing ===/.test(String(s.run || "")));
  const line = String(verify?.run || "").split("\n").find((l) => /curl[^\n]*\/api\/pricing"/.test(l)) || "";
  ok(!!verify && /\|\|\s*echo/.test(line), `the verify step's pricing print cannot fail the step (${line.trim().slice(0, 90)})`);
}
const triggerAt = deploySteps.findIndex((s) => /serviceInstanceDeployV2/.test(String(s.run || "")));
const upsertAt = deploySteps.findIndex((s) => /variableCollectionUpsert/.test(String(s.run || "")));
ok(triggerAt > upsertAt && upsertAt >= 0, "the deploy trigger runs after the upsert, so it carries the new values");

// The new build's Bazaar listings are validated after the deploy is verified:
// the step runs scripts/bazaar-validate.js against production, only when the
// verify step succeeded, with every upstream key blanked (the validator reads
// 402s, and the deploy job's secrets never reach package code).
{
  const verifyAt = deploySteps.findIndex((s) => s.id === "verify");
  const bazaarAt = deploySteps.findIndex((s) => /node scripts\/bazaar-validate\.js/.test(String(s.run || "")));
  const bazaar = deploySteps[bazaarAt] || {};
  ok(verifyAt >= 0 && bazaarAt > verifyAt, `the deploy job runs scripts/bazaar-validate.js after the verify step (verify ${verifyAt}, validate ${bazaarAt})`);
  ok(/steps\.verify\.outcome == 'success'/.test(String(bazaar.if || "")), "the Bazaar validation step runs only on a verified deploy");
  const env = bazaar.env || {};
  const blanked = ["CDP_KEY_ID", "CDP_KEY_SECRET", "MPP_SECRET_KEY", "X_BEARER_TOKEN", "BRAVE_API_KEY", "DATABENTO_API_KEY", "RAILWAY_API_TOKEN"];
  ok(blanked.every((k) => k in env && String(env[k] ?? "") === ""), `the Bazaar validation step blanks the upstream keys (${blanked.filter((k) => !(k in env) || String(env[k] ?? "") !== "").join(", ") || "all blank"})`);
  ok(/TARGET_URL=https:\/\/agent402\.tools/.test(String(bazaar.run || "")), "the validator reads production's 402s");
  ok(/exit 1/.test(String(bazaar.run || "")) && !bazaar["continue-on-error"], "an INVALID verdict with no clean run fails the job");
  // The run's FAIL and unreadable rows are printed on their own before the
  // tail (a default run prints more lines than a short tail keeps), here and
  // in the heartbeat's step; neither says "flagship" of what it checked, and
  // the heartbeat's issue title is the one an open issue is found by.
  const heartbeat = load(readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8"));
  const hbStep = Object.values(heartbeat.jobs || {}).flatMap((j) => j.steps || []).find((s) => /node scripts\/bazaar-validate\.js/.test(String(s.run || ""))) || {};
  const ROWS_LINE = String.raw`echo "$OUT" | grep -E '^(FAIL|\?\?) |INVALID|UNREADABLE' || true`;
  for (const [label, step] of [["deploy", bazaar], ["heartbeat", hbStep]]) {
    const run = String(step.run || "");
    const rowsAt = run.indexOf(ROWS_LINE);
    const tailAt = run.search(/echo "\$OUT" \| tail -\d+/);
    const tail = Number((run.match(/echo "\$OUT" \| tail -(\d+)/) || [])[1] || 0);
    ok(rowsAt >= 0 && tailAt > rowsAt, `the ${label} step prints the validator's FAIL and unreadable rows before its tail`);
    ok(tail >= 40, `the ${label} step's tail keeps a whole default run (${tail} lines)`);
    ok(!/flagship/i.test(`${step.name || ""} ${run}`), `the ${label} step names what it checked as checked routes`);
  }
  ok(/TITLE="Bazaar listing validation FAILED"/.test(String(hbStep.run || "")), "the heartbeat's issue title is unchanged");
  // A non-JSON listing that is valid but not indexed is a warning in both
  // steps (and a job-summary line on the heartbeat), never an issue; an
  // INVALID one adds the listing switch to the deploy error and to the
  // heartbeat's issue body. The two lines are scripts/bazaar-validate.js's.
  const validator = readFileSync(new URL("./bazaar-validate.js", import.meta.url), "utf8");
  ok(validator.includes("`WARN not-indexed ${tag} (last crawl ") && validator.includes("`NONJSON-INVALID ${tag}`"), "the validator prints the two lines the steps grep");
  const LEVER = "If the failing route is a binary listing, X402_BINARY_LISTINGS=off on the service returns every listing to its earlier shape.";
  for (const [label, step] of [["deploy", bazaar], ["heartbeat", hbStep]]) {
    const run = String(step.run || "");
    ok(/grep '\^WARN not-indexed ' \| while IFS= read -r LINE; do echo "::warning::Bazaar: \$LINE"/.test(run), `the ${label} step turns each WARN not-indexed line into a warning`);
    ok(run.includes(`if echo "$OUT" | grep -q '^NONJSON-INVALID '; then HINT=" ${LEVER}"; fi`), `the ${label} step names the listing switch when a non-JSON listing is INVALID`);
  }
  ok(/could not be read\.\$HINT"; exit 1/.test(String(bazaar.run || "")), "the deploy step's error ends with the switch");
  ok(/>> "\$GITHUB_STEP_SUMMARY"/.test(String(hbStep.run || "")) && /A green run closes this\.%s' "\$DETAIL" "\$HINT"\)/.test(String(hbStep.run || "")), "the heartbeat writes the WARN lines to the job summary and ends its issue body with the switch");
  ok(!/gh issue (create|close|comment)[^\n]*not-indexed/.test(String(hbStep.run || "")), "no issue is opened or closed on a not-indexed listing");
}

// The jobs a commit-subject marker starts read the markers job's outputs, so
// the range that job reads (on main, from the last run that read its markers:
// scripts/test-ci-gating.js) is the one thing that decides them.
for (const [job, out] of [["publish", "publish"], ["paytest", "paytest"], ["drain", "drain"], ["purl", "purl"], ["probe", "probe"]]) {
  const j = wf.jobs?.[job] || {};
  ok([].concat(j.needs || []).includes("markers") && new RegExp(`needs\\.markers\\.outputs\\.${out} == 'true'`).test(String(j.if || "")), `the ${job} job starts on the markers job's ${out} output`);
}
ok(!/github\.event\.(commits|head_commit)/.test(JSON.stringify(Object.values(wf.jobs || {}).map((j) => j.if || ""))), "no job reads a marker from the push payload beside the markers job");

const pub = (wf.jobs?.publish?.steps || []).map((s) => String(s.name || ""));
const clawAt = pub.findIndex((n) => /ClawHub/.test(n));
const registryAt = pub.findIndex((n) => /MCP Registry/.test(n));
const npmAt = pub.map((n, i) => (/to npm$/.test(n) ? i : -1)).filter((i) => i >= 0);
ok(clawAt >= 0 && registryAt >= 0, "the publish job holds the ClawHub and MCP Registry steps");
ok(clawAt > registryAt && npmAt.every((i) => i < clawAt), "ClawHub runs after every npm publish and the MCP Registry");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

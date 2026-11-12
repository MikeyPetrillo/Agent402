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

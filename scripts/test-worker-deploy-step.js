// The deploy job redeploys the render/media worker when a push changes its
// code. Checks the path selector (the worker's import closure plus its image
// inputs) on real repository files, and that the deploy job carries the step
// that uses it, after the main app's rollout is confirmed.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { load } from "js-yaml";
import { workerDeployPaths, touchesWorker, lastDeployedBase } from "./worker-deploy-paths.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const paths = workerDeployPaths();
for (const f of ["worker/server.js", "Dockerfile.worker", "docker-entrypoint.sh", "src/tools/render.js", "src/tools/browser-measure-kit.js", "src/tools/media-kit.js", "src/tools/fetch-guard.js"]) {
  ok(paths.includes(f), `${f} is watched`);
}
ok(!paths.includes("src/server.js"), "the main app's server is not in the worker's closure");
ok(!paths.some((f) => /^railway\./.test(f)), "no retired Railway config file is watched");
ok(touchesWorker(["README.md", "src/tools/render.js"]), "a change to render.js selects the worker");
ok(touchesWorker(["worker/new-helper.js"]), "a new file under worker/ selects the worker");
ok(touchesWorker(["src/tools/fetch-guard.js"]), "a change to an import of an import selects the worker");
ok(touchesWorker(["src/tools/html-worker.js"]) && paths.includes("src/tools/html-parse-ops.js"), "a worker thread the closure starts by file URL (and what it imports) selects the worker");
ok(!touchesWorker(["src/server.js", "README.md", "scripts/test-all.js"]), "a change outside the worker leaves it alone");
ok(!touchesWorker([""]), "an empty diff leaves it alone");

const cli = (input) => spawnSync(process.execPath, [new URL("./worker-deploy-paths.js", import.meta.url).pathname, "--check"], { input, encoding: "utf8" }).stdout.trim();
ok(cli("src/server.js\nsrc/tools/media-kit.js\n") === "yes" && cli("src/server.js\n") === "no", "the --check CLI answers yes/no from stdin");

// The diff base is the last SUCCESSFUL deploy run's head, never the push's
// `before`: a deploy that failed before the worker step left its worker change
// unshipped, and the next push must still see that change in its diff.
const sha = (c) => c.repeat(40);
const RUNS = [
  { databaseId: 300, headSha: sha("c"), conclusion: "success" }, // the current run (skipped)
  { databaseId: 200, headSha: sha("b"), conclusion: "failure" }, // failed before the worker step
  { databaseId: 100, headSha: sha("a"), conclusion: "success" },
];
ok(lastDeployedBase(RUNS, 300) === sha("a"), "after a failed deploy the base is the last successful run's head, so the failed push's worker change is in the diff");
ok(lastDeployedBase(RUNS, "300") === sha("a"), "the current run id matches as a string too");
ok(lastDeployedBase([{ databaseId: 1, headSha: "not-a-sha", conclusion: "success" }], 9) === "", "a malformed head is no base (fail-open)");
ok(lastDeployedBase(null, 1) === "" && lastDeployedBase([], 1) === "", "no runs is no base (fail-open)");
const baseCli = (input, id) => spawnSync(process.execPath, [new URL("./worker-deploy-paths.js", import.meta.url).pathname, "--base", String(id)], { input, encoding: "utf8" }).stdout.trim();
ok(baseCli(JSON.stringify(RUNS), 300) === sha("a") && baseCli("not json", 300) === "", "the --base CLI reads gh run list JSON and prints nothing on bad input");
const changedSince = (base) => (base === sha("a") ? ["README.md", "worker/server.js"] : ["README.md"]);
ok(touchesWorker(changedSince(lastDeployedBase(RUNS, 300))), "a worker change in the failed push still selects the worker on the next push");

// Two steps: a SELECTOR that runs the repository script with every job
// secret shadowed (it needs only the workflow token to read runs and the
// diff) and writes `run` to its outputs, and a CLI step, gated on that
// output, that holds the Railway token and runs no repository code.
const wf = load(readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"));
const steps = wf.jobs.deploy.steps;
const idx = steps.findIndex((s) => /railway" up --service agent402-worker --environment production --project "\$RAILWAY_PROJECT_ID" --ci/.test(String(s.run || "")));
ok(idx >= 0, "the deploy job has the worker redeploy step");
const step = steps[idx] || {};
const run = String(step.run || "");
const selIdx = steps.findIndex((s) => /node scripts\/worker-deploy-paths\.js --check/.test(String(s.run || "")));
ok(selIdx >= 0 && selIdx < idx, "a selector step runs worker-deploy-paths.js before the CLI step");
const sel = steps[selIdx] || {};
const selRun = String(sel.run || "");
ok(typeof sel.id === "string" && sel.id && String(step.if || "") === `steps.${sel.id}.outputs.run == 'yes'`, `the CLI step runs only on the selector's run=yes output (if: ${step.if})`);
ok(/echo "run=\$RUN" >> "\$GITHUB_OUTPUT"/.test(selRun) && /RUN=yes/.test(selRun) && /RUN=no/.test(selRun), "the selector writes run=yes|no to its step output, yes by default (fail-open)");
ok(!/github\.event\.before/.test(JSON.stringify(sel)) && !/github\.event\.before/.test(JSON.stringify(step)), "neither step diffs from the push's before");
ok(/gh run list [^\n]*--workflow deploy\.yml[^\n]*--branch main[^\n]*--status success/.test(selRun) && /worker-deploy-paths\.js --base "\$GITHUB_RUN_ID"/.test(selRun), "the selector takes its base from the last successful deploy run on main");
ok(/gh api "repos\/\$GITHUB_REPOSITORY\/compare\/\$DIFF_BASE\.\.\.\$GITHUB_SHA"/.test(selRun) && /worker-deploy-paths\.js --check 2>\/dev\/null \|\| echo yes\)" != "no"/.test(selRun), "the selector diffs base...head through the API and asks the script whether the worker is touched");
// Every job-level secret is shadowed with "" in the selector's env (it runs
// repository code), and the token it does hold is the workflow's own.
const jobSecrets = Object.entries(wf.jobs.deploy.env || {}).filter(([, v]) => /secrets\./.test(String(v))).map(([k]) => k);
ok(jobSecrets.length >= 3 && jobSecrets.includes("RAILWAY_API_TOKEN"), `the deploy job carries secrets at job level (${jobSecrets.join(", ")})`);
const unshadowed = jobSecrets.filter((k) => sel.env?.[k] !== "");
ok(unshadowed.length === 0, `the selector shadows every job secret with "" (${unshadowed.length ? `missing: ${unshadowed.join(", ")}` : "all shadowed"})`);
ok(String(sel.env?.GH_TOKEN || "") === "${{ github.token }}" && !Object.values(sel.env || {}).some((v) => /secrets\./.test(String(v))), "the selector holds the workflow token only, no repository secret");
ok(!/npm (i|install|ci)\b/.test(selRun) && !/railway/.test(selRun), "the selector installs nothing and never runs the Railway CLI");
ok(wf.jobs.deploy.permissions?.actions === "read" && wf.jobs.deploy.permissions?.contents === "read" && Object.keys(wf.jobs.deploy.permissions).length === 2, "the deploy job can read runs (actions: read) and nothing more than contents: read besides");
ok(/sha256sum -c -/.test(run) && /^[0-9a-f]{64}$/.test(String(step.env?.RAILWAY_CLI_SHA256 || "")) && /^\d+\.\d+\.\d+$/.test(String(step.env?.RAILWAY_CLI_VERSION || "")), "the CLI is a pinned version checked against its sha256");
ok(!/npm (i|install|ci)\b/.test(run) && !/\bnode\b/.test(run), "no package install and no repository code in the CLI step");
ok(step.env?.RAILWAY_API_TOKEN === undefined && String(wf.jobs.deploy.env?.RAILWAY_API_TOKEN || "").includes("secrets.RAILWAY_TOKEN"), "the CLI step keeps the job's Railway token (it is not shadowed there)");
const waitIdx = steps.findIndex((s) => /Wait for the NEW deployment/.test(String(s.name || "")));
ok(waitIdx >= 0 && selIdx > waitIdx, "the selector runs after the main app's rollout is confirmed");
ok(!step["continue-on-error"] && !sel["continue-on-error"], "a failed selector or worker deploy fails the job");
const setupNodeIdx = steps.findIndex((s) => /actions\/setup-node/.test(String(s.uses || "")));
ok(setupNodeIdx >= 0 && setupNodeIdx < selIdx, "node is set up before the selector runs the script");

ok(/NFILES" -ge 300/.test(selRun) && /fail-open/.test(selRun), "a diff list long enough to be capped redeploys (fail-open)");

ok(/--check 2>\/dev\/null \|\| echo yes\)" != "no"/.test(selRun), "a selector check that fails or prints anything but no redeploys (fail-open)");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

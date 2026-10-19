// The deploy job redeploys the render/media worker when a push changes its
// code. Checks the path selector (the worker's import closure plus its image
// inputs) on real repository files, and that the deploy job carries the step
// that uses it, after the main app's rollout is confirmed.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { load } from "js-yaml";
import { workerDeployPaths, touchesWorker } from "./worker-deploy-paths.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const paths = workerDeployPaths();
for (const f of ["worker/server.js", "Dockerfile.worker", "railway.worker.json", "src/tools/render.js", "src/tools/browser-measure-kit.js", "src/tools/media-kit.js", "src/tools/fetch-guard.js"]) {
  ok(paths.includes(f), `${f} is watched`);
}
ok(!paths.includes("src/server.js"), "the main app's server is not in the worker's closure");
ok(touchesWorker(["README.md", "src/tools/render.js"]), "a change to render.js selects the worker");
ok(touchesWorker(["worker/new-helper.js"]), "a new file under worker/ selects the worker");
ok(touchesWorker(["src/tools/fetch-guard.js"]), "a change to an import of an import selects the worker");
ok(!touchesWorker(["src/server.js", "README.md", "scripts/test-all.js"]), "a change outside the worker leaves it alone");
ok(!touchesWorker([""]), "an empty diff leaves it alone");

const cli = (input) => spawnSync(process.execPath, [new URL("./worker-deploy-paths.js", import.meta.url).pathname, "--check"], { input, encoding: "utf8" }).stdout.trim();
ok(cli("src/server.js\nsrc/tools/media-kit.js\n") === "yes" && cli("src/server.js\n") === "no", "the --check CLI answers yes/no from stdin");

const wf = load(readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"));
const steps = wf.jobs.deploy.steps;
const idx = steps.findIndex((s) => /railway" up --service agent402-worker --environment production --project "\$RAILWAY_PROJECT_ID" --ci/.test(String(s.run || "")));
ok(idx >= 0, "the deploy job has the worker redeploy step");
const step = steps[idx] || {};
const run = String(step.run || "");
ok(/node scripts\/worker-deploy-paths\.js --check/.test(run), "the step selects on worker-deploy-paths.js");
ok(/sha256sum -c -/.test(run) && /^[0-9a-f]{64}$/.test(String(step.env?.RAILWAY_CLI_SHA256 || "")) && /^\d+\.\d+\.\d+$/.test(String(step.env?.RAILWAY_CLI_VERSION || "")), "the CLI is a pinned version checked against its sha256");
ok(!/npm (i|install|ci)\b/.test(run), "no package install in the step");
const waitIdx = steps.findIndex((s) => /Wait for the NEW deployment/.test(String(s.name || "")));
ok(waitIdx >= 0 && idx > waitIdx, "it runs after the main app's rollout is confirmed");
ok(!step["continue-on-error"], "a failed worker deploy fails the job");
ok(String(wf.jobs.deploy.env?.RAILWAY_API_TOKEN || "").includes("secrets.RAILWAY_TOKEN"), "the CLI reads the job's Railway token");
const setupNodeIdx = steps.findIndex((s) => /actions\/setup-node/.test(String(s.uses || "")));
ok(setupNodeIdx >= 0 && setupNodeIdx < idx, "node is set up before the step runs the selector");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// The deploy job redeploys the decide service only when a push changes its
// code. Checks the path selector (decide's import closure, its image inputs
// and its contract with the main app) on real repository files, and that the
// deploy job gates the decide deploy on it with the worker's base and
// fail-open rules.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { load } from "js-yaml";
import { decideDeployPaths, touchesDecide } from "./decide-deploy-paths.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const paths = decideDeployPaths();
for (const f of ["services/decide/server.js", "Dockerfile", "docker-entrypoint.sh", "start.js", "package-lock.json", "src/decide/tool-rows.js", "src/tools/decide-kit.js", "src/db-ssl.js"]) {
  ok(paths.includes(f), `${f} is watched`);
}
ok(!paths.includes("src/server.js"), "the main app's server is not in decide's closure");
ok(touchesDecide(["README.md", "services/decide/rank.js"]), "a change to decide's own code selects it");
ok(touchesDecide(["services/decide/new-helper.js"]), "a new file under services/decide/ selects it");
ok(touchesDecide(["src/decide/index-export.js"]), "a change to the export's row format selects it");
ok(touchesDecide(["src/tools/decide-kit.js"]), "a change to the kit that calls decide selects it");
ok(touchesDecide(["src/db-ssl.js"]), "a change to an import of decide's server selects it");
ok(!touchesDecide(["src/server.js", "src/revenue-live.js", "README.md", "scripts/test-all.js"]), "a change outside decide leaves it alone");
ok(!touchesDecide([""]), "an empty diff leaves it alone");

const cli = (input) => spawnSync(process.execPath, [new URL("./decide-deploy-paths.js", import.meta.url).pathname, "--check"], { input, encoding: "utf8" }).stdout.trim();
ok(cli("src/server.js\nservices/decide/rank.js\n") === "yes" && cli("src/server.js\n") === "no", "the --check CLI answers yes/no from stdin");
const sha = (c) => c.repeat(40);
const RUNS = [
  { databaseId: 300, headSha: sha("c"), conclusion: "success" },
  { databaseId: 200, headSha: sha("b"), conclusion: "failure" },
  { databaseId: 100, headSha: sha("a"), conclusion: "success" },
];
const baseCli = (input, id) => spawnSync(process.execPath, [new URL("./decide-deploy-paths.js", import.meta.url).pathname, "--base", String(id)], { input, encoding: "utf8" }).stdout.trim();
ok(baseCli(JSON.stringify(RUNS), 300) === sha("a") && baseCli("not json", 300) === "", "the --base CLI takes the last successful deploy run's head and prints nothing on bad input");

const wf = load(readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"));
const steps = wf.jobs.deploy.steps;
const idx = steps.findIndex((s) => s.name === "Deploy the decide service at the same commit");
ok(idx >= 0, "the deploy job has the decide deploy step");
const step = steps[idx] || {};
const selIdx = steps.findIndex((s) => /node scripts\/decide-deploy-paths\.js --check/.test(String(s.run || "")));
ok(selIdx >= 0 && selIdx < idx, "a selector step runs decide-deploy-paths.js before the decide deploy");
const sel = steps[selIdx] || {};
const selRun = String(sel.run || "");
ok(typeof sel.id === "string" && sel.id && String(step.if || "") === `steps.${sel.id}.outputs.run == 'yes'`, `the decide deploy runs only on the selector's run=yes output (if: ${step.if})`);
ok(/echo "run=\$RUN" >> "\$GITHUB_OUTPUT"/.test(selRun) && /RUN=yes/.test(selRun) && /RUN=no/.test(selRun), "the selector writes run=yes|no, yes by default (fail-open)");
ok(/gh run list [^\n]*--workflow deploy\.yml[^\n]*--branch main[^\n]*--status success/.test(selRun) && /decide-deploy-paths\.js --base "\$GITHUB_RUN_ID"/.test(selRun), "the selector takes its base from the last successful deploy run on main");
ok(!/github\.event\.before/.test(JSON.stringify(sel)), "the selector never diffs from the push's before");
const jobSecrets = Object.entries(wf.jobs.deploy.env || {}).filter(([, v]) => /secrets\./.test(String(v))).map(([k]) => k);
const unshadowed = jobSecrets.filter((k) => sel.env?.[k] !== "");
ok(jobSecrets.length >= 3 && unshadowed.length === 0, `the selector shadows every job secret with "" (${unshadowed.length ? `missing: ${unshadowed.join(", ")}` : "all shadowed"})`);
ok(String(sel.env?.GH_TOKEN || "") === "${{ github.token }}" && !Object.values(sel.env || {}).some((v) => /secrets\./.test(String(v))), "the selector holds the workflow token only");
ok(!/npm (i|install|ci)\b/.test(selRun) && !/railway/.test(selRun), "the selector installs nothing and never calls Railway");
const waitIdx = steps.findIndex((s) => /Wait for the NEW deployment/.test(String(s.name || "")));
ok(waitIdx >= 0 && selIdx > waitIdx, "the selector runs after the main app's rollout is confirmed");
ok(!step["continue-on-error"] && !sel["continue-on-error"], "a failed selector or decide deploy fails the job");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// The deploy job's variable upsert passes skipDeploys, so a changed value
// never starts Railway's own deploy beside the job's trigger (two
// deployments of one commit, the first stopped and marked FAILED). The
// publish job runs ClawHub last, so a refusal on ClawHub's side never holds
// back the npm and MCP Registry releases.
// Offline: reads the workflow text only.
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

const wf = load(readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const deploySteps = wf.jobs?.deploy?.steps || [];
const upserts = deploySteps.filter((s) => /variableCollectionUpsert/.test(String(s.run || "")));
ok(upserts.length >= 1, `the deploy job holds the variable upsert (${upserts.length})`);
for (const s of upserts) {
  const calls = String(s.run).split("\n").filter((l) => !/^\s*#/.test(l) && /variableCollectionUpsert\(input:/.test(l));
  ok(calls.length >= 1 && calls.every((l) => /skipDeploys:\s*true/.test(l)), `"${s.name}": every upsert call passes skipDeploys: true`);
}
const triggerAt = deploySteps.findIndex((s) => /serviceInstanceDeployV2/.test(String(s.run || "")));
const upsertAt = deploySteps.findIndex((s) => /variableCollectionUpsert/.test(String(s.run || "")));
ok(triggerAt > upsertAt && upsertAt >= 0, "the deploy trigger runs after the upsert, so it carries the new values");

const pub = (wf.jobs?.publish?.steps || []).map((s) => String(s.name || ""));
const clawAt = pub.findIndex((n) => /ClawHub/.test(n));
const registryAt = pub.findIndex((n) => /MCP Registry/.test(n));
const npmAt = pub.map((n, i) => (/to npm$/.test(n) ? i : -1)).filter((i) => i >= 0);
ok(clawAt >= 0 && registryAt >= 0, "the publish job holds the ClawHub and MCP Registry steps");
ok(clawAt > registryAt && npmAt.every((i) => i < clawAt), "ClawHub runs after every npm publish and the MCP Registry");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// The prepared Railway IaC file (.railway/railway.ts) declares every build and
// deploy setting the facilitator and worker services hold, and cannot reach
// past those two services: a named partial (so resources it does not declare
// are left alone), unmanaged variables, the facilitator's repo source kept,
// the worker's idle sleep kept. The Config as Code files that once carried
// those settings are retired: none is in the repository, and the runbook's
// table records each setting the IaC file declares.
//
// Offline. The file is loaded with Node's type stripping, and `railway/iac` is
// replaced by a recorder, so CI needs no SDK install and no Railway access.
//   node scripts/test-railway-iac.js
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const STUB = `
export const defineRailway = (fn) => fn;
export const project = (name, def) => ({ name, ...def });
export const service = (name, config = {}) => ({ type: "service", name, config });
export const github = (repo, options = {}) => ({ type: "github", repo, ...options });
`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "railway/iac") return { url: `data:text/javascript,${encodeURIComponent(STUB)}`, shortCircuit: true };
    return next(specifier, context);
  },
});

const mod = await import(pathToFileURL(join(ROOT, ".railway/railway.ts")).href);
const proj = mod.default({ environment: "production", isEnvironment: (n) => n === "production" });
const byName = Object.fromEntries((proj.resources || []).map((r) => [r.name, r]));

ok(typeof mod.partial === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(mod.partial), `the file exports a named partial (${mod.partial}), so an apply only manages what it declares`);
ok(proj.variables?.managed === false, "variables are unmanaged: no service variable is declared, changed or deleted");
ok(Object.keys(byName).sort().join(",") === "agent402-facilitator,agent402-worker", `it declares exactly the two services (${Object.keys(byName).join(", ")})`);
ok(!proj.resources.some((r) => r.type !== "service"), "it declares no database, volume or bucket");

// Railway stops reading Config as Code files on 2026-12-01; none is tracked
// here, so no service can read one from this repository.
for (const file of ["railway.facilitator.json", "railway.worker.json", "railway.json", "railway.toml"]) {
  ok(!existsSync(join(ROOT, file)), `${file} is not in the repository`);
}
const runbook = readFileSync(join(ROOT, "docs/railway-iac-migration.md"), "utf8");
const row = (label) => (runbook.split("\n").find((l) => l.startsWith(`| ${label} |`)) || "").split("|").map((c) => c.trim());
for (const [name, col] of [["agent402-facilitator", 2], ["agent402-worker", 3]]) {
  const cfg = byName[name]?.config || {};
  const { build = {}, deploy = {} } = cfg;
  ok(build.builder === "DOCKERFILE", `${name}: builds with its Dockerfile`);
  ok(typeof build.dockerfilePath === "string" && existsSync(join(ROOT, build.dockerfilePath)), `${name}: the Dockerfile path exists (${build.dockerfilePath})`);
  ok(deploy.restartPolicyType === "ON_FAILURE" && deploy.restartPolicyMaxRetries === 5, `${name}: restart policy ON_FAILURE with 5 retries`);
  ok(deploy.numReplicas === 1, `${name}: one replica`);
  ok(deploy.healthcheckPath === "/health" && Number.isInteger(deploy.healthcheckTimeout) && deploy.healthcheckTimeout > 0, `${name}: healthcheck /health (${deploy.healthcheckTimeout} s)`);
  ok(!("env" in cfg) && !("variables" in cfg), `${name}: declares no variables`);
  // The runbook table is the record of the service's settings: each value the
  // IaC file declares is written there, so the two cannot drift apart.
  ok(row("Builder")[col] === `\`${build.builder}\``, `${name}: the runbook records the builder`);
  ok(row("Dockerfile")[col] === `\`${build.dockerfilePath}\``, `${name}: the runbook records the Dockerfile path (${row("Dockerfile")[col]})`);
  const patterns = build.watchPatterns || [];
  ok(row("Watch patterns")[col] === (patterns.length ? patterns.map((p) => `\`${p}\``).join(", ") : "none"), `${name}: the runbook records the watch patterns (${row("Watch patterns")[col]})`);
  ok(row("Healthcheck")[col] === `\`${deploy.healthcheckPath}\`, ${deploy.healthcheckTimeout} s`, `${name}: the runbook records the healthcheck (${row("Healthcheck")[col]})`);
  ok(row("Restart policy")[col] === `\`${deploy.restartPolicyType}\`, ${deploy.restartPolicyMaxRetries} retries`, `${name}: the runbook records the restart policy`);
  ok(row("Replicas")[col] === String(deploy.numReplicas), `${name}: the runbook records the replica count`);
}

const fac = byName["agent402-facilitator"]?.config || {};
ok((fac.build?.watchPatterns || []).includes("facilitator/**"), "facilitator: redeploys on facilitator/** changes");
ok(fac.source?.type === "github" && fac.source?.branch === "main" && /\/Agent402$/.test(fac.source?.repo || ""), "facilitator: keeps building from this repository's main branch (a service without source would be disconnected)");
const wrk = byName["agent402-worker"]?.config || {};
ok(!("source" in wrk), "worker: declares no source (it is deployed by upload)");
ok(wrk.deploy?.sleepApplication === true, "worker: keeps sleeping when idle");

// The SDK the owner installs to plan is pinned exactly, with a lockfile.
const pkg = JSON.parse(readFileSync(join(ROOT, ".railway/package.json"), "utf8"));
ok(/^\d+\.\d+\.\d+$/.test(pkg.dependencies?.railway || ""), `the railway SDK is pinned to an exact version (${pkg.dependencies?.railway})`);
ok(existsSync(join(ROOT, ".railway/package-lock.json")), "the SDK has a lockfile");
const lock = JSON.parse(readFileSync(join(ROOT, ".railway/package-lock.json"), "utf8"));
ok(lock.packages?.["node_modules/railway"]?.version === pkg.dependencies?.railway, "the lockfile resolves the pinned version");

// The runbook names each owner step.
for (const step of ["railway config plan", "0 to destroy", "railway config apply", "outside a CI run", "Config as Code path", "meta.build"]) {
  ok(runbook.includes(step), `the runbook covers "${step}"`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Every job-level secret in deploy.yml is blanked in that job's secretless
// install step and in the adapter step (it installs framework packages from
// the registry). An install runs dependency lifecycle scripts, so a secret
// left in its env is readable by any postinstall a version bump brings in.
// The spending workflows that install packages (spend.yml, every job of it,
// and algorand-rail-canary.yml) keep every secret and the workflow token at
// step scope, never on an install step (npm rebuild runs install scripts too)
// or at job or workflow scope.
// Offline: reads the workflow text only.
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { expandedDeployWorkflow } from "./lib/ci-workflow.js";

const text = expandedDeployWorkflow();
const lines = text.split("\n");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Split into jobs (two-space keys under `jobs:`).
const jobs = [];
let inJobs = false, cur = null;
for (const l of lines) {
  if (l === "jobs:") { inJobs = true; continue; }
  if (!inJobs) continue;
  const m = /^ {2}([a-z0-9-]+):$/.exec(l);
  if (m) { cur = { name: m[1], lines: [] }; jobs.push(cur); continue; }
  if (cur) cur.lines.push(l);
}

const INSTALLS = [/^- name: Install dependencies \(secretless\)$/, /^- name: Adapter tests\b/, /^- name: Install facilitator dependencies \(secretless\)$/];
let checkedSteps = 0, adapterSteps = 0;
for (const job of jobs) {
  // Job-level env: the block right under "    env:".
  const secrets = new Set();
  const envAt = job.lines.indexOf("    env:");
  if (envAt >= 0) {
    for (let i = envAt + 1; i < job.lines.length && /^ {6}\S/.test(job.lines[i]) || (i < job.lines.length && /^ {6}#/.test(job.lines[i])); i++) {
      const kv = /^ {6}([A-Z0-9_]+): .*secrets\./.exec(job.lines[i]);
      if (kv) secrets.add(kv[1]);
    }
  }
  for (let i = 0; i < job.lines.length; i++) {
    const t = job.lines[i].trim();
    if (!INSTALLS.some((re) => re.test(t))) continue;
    checkedSteps++;
    if (INSTALLS[1].test(t)) adapterSteps++;
    const blanked = new Set();
    for (let k = i + 1; k < job.lines.length && !/^ {6}- /.test(job.lines[k]); k++) {
      const b = /^\s+([A-Z0-9_]+): ""\s*$/.exec(job.lines[k]);
      if (b) blanked.add(b[1]);
    }
    const missing = [...secrets].filter((s) => !blanked.has(s));
    ok(missing.length === 0, `${job.name}: "${t.slice(8, 40)}" blanks every job-level secret${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
  }
}
ok(adapterSteps >= 1, `the scan found the adapter step (${adapterSteps})`);
// The class, by what a step runs rather than its name: any deploy.yml step
// that installs packages (npm or pip) with install-time code allowed blanks
// every job-level secret. `npm ci --ignore-scripts` runs no dependency code
// (the repo's supply-chain rule), so it is the one install exempt here.
{
  const wfParsed = load(text);
  const PKG_INSTALL = /\bnpm (ci|install|i)\b|\bpip3? install\b|-m pip install\b/;
  const installsWithCode = (run) => run.split("\n").some((l) => !/^\s*#/.test(l) && PKG_INSTALL.test(l) && !/\bnpm ci --ignore-scripts\b/.test(l));
  let pkgSteps = 0, pipSteps = 0;
  for (const [jn, job] of Object.entries(wfParsed.jobs || {})) {
    const jobSecrets = Object.entries(job.env || {}).filter(([, v]) => /secrets\./.test(String(v))).map(([k]) => k);
    for (const st of job.steps || []) {
      const run = String(st.run || "");
      if (!installsWithCode(run)) continue;
      pkgSteps++;
      if (/pip install/.test(run)) pipSteps++;
      const missing = jobSecrets.filter((k) => String(st.env?.[k] ?? "x") !== "");
      ok(missing.length === 0, `${jn}: "${String(st.name || "").slice(0, 48)}" installs packages with every job-level secret blanked${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
    }
  }
  ok(pkgSteps >= 10 && pipSteps >= 1, `the scan found the package-install steps by what they run (${pkgSteps}, ${pipSteps} pip)`);
}
// A step that runs a repository script which installs from the registry (a
// packed tarball beside third-party packages, or a framework the adapter test
// installs) blanks every credential the workflow maps from a secret, named
// or not at its job's level: such a step's env is the one a dependency's code
// could read, whichever job it moves to.
{
  const wfParsed = load(text);
  const REGISTRY_INSTALL_SCRIPTS = ["scripts/test-package-audit.js", "adapters/eliza/test-runtime.js"];
  const CREDENTIAL = /KEY|TOKEN|SECRET|COSTS/;
  const credentialNames = new Set();
  for (const m of text.matchAll(/^\s+([A-Z0-9_]+): \$\{\{ secrets\.[A-Z0-9_]+/gm)) if (CREDENTIAL.test(m[1])) credentialNames.add(m[1]);
  ok(credentialNames.has("UPSTREAM_COSTS_JSON") && credentialNames.has("BRAVE_API_KEY"), `the credential scan reads the workflow's secret-mapped names (${credentialNames.size})`);
  const seen = new Set();
  for (const [jn, job] of Object.entries(wfParsed.jobs || {})) {
    for (const st of job.steps || []) {
      const run = String(st.run || "");
      const scripts = REGISTRY_INSTALL_SCRIPTS.filter((f) => run.split("\n").some((l) => !/^\s*#/.test(l) && l.includes(f)));
      if (!scripts.length) continue;
      scripts.forEach((f) => seen.add(f));
      const missing = [...credentialNames].filter((k) => String(st.env?.[k] ?? "x") !== "");
      ok(missing.length === 0, `${jn}: "${String(st.name || "").slice(0, 48)}" (${scripts.join(", ")}) blanks every secret-mapped credential${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
    }
  }
  ok(REGISTRY_INSTALL_SCRIPTS.every((f) => seen.has(f)), `every registry-installing script was found in a step (${[...seen].join(", ")})`);
}
ok(checkedSteps >= 10, `the scan found the secretless install steps (${checkedSteps}) - zero would mean it is blind`);

// Package code in a job that holds a deploy-class secret (a job under the
// production environment, or any job whose env names a Railway, MPP or
// backup secret): every step that runs node on a repository script shadows
// every job-level secret the same way, so the code the job runs after the
// install never reads them either.
const DEPLOY_CLASS = /RAILWAY|MPP_SECRET|BACKUP_S3/;
const RUNS_PACKAGE_CODE = /\bnode (scripts\/|--input-type)/;
let scriptSteps = 0;
for (const job of jobs) {
  const secrets = new Set();
  const envAt = job.lines.indexOf("    env:");
  if (envAt >= 0) {
    for (let i = envAt + 1; i < job.lines.length && (/^ {6}\S/.test(job.lines[i]) || /^ {6}#/.test(job.lines[i])); i++) {
      const kv = /^ {6}([A-Z0-9_]+): .*secrets\./.exec(job.lines[i]);
      if (kv) secrets.add(kv[1]);
    }
  }
  const gated = job.lines.some((l) => /^    environment:/.test(l)) || [...secrets].some((k) => DEPLOY_CLASS.test(k));
  if (!gated || !secrets.size) continue;
  // Steps: from each "      - " to the next.
  const starts = job.lines.map((l, i) => (/^ {6}- /.test(l) ? i : -1)).filter((i) => i >= 0);
  for (let si = 0; si < starts.length; si++) {
    const step = job.lines.slice(starts[si], starts[si + 1] ?? job.lines.length);
    const name = (step.find((l) => /^ {6}- name:/.test(l)) || step[0]).replace(/^ {6}- (name: )?/, "").trim();
    if (!step.some((l) => RUNS_PACKAGE_CODE.test(l))) continue;
    scriptSteps++;
    const blanked = new Set(step.map((l) => /^\s+([A-Z0-9_]+): ""\s*$/.exec(l)?.[1]).filter(Boolean));
    const missing = [...secrets].filter((k) => !blanked.has(k));
    ok(missing.length === 0, `${job.name}: "${name.slice(0, 48)}" runs package code with every job-level secret shadowed${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
  }
}
ok(scriptSteps >= 4, `the scan found the package-code steps of the secret-holding jobs (${scriptSteps}) - zero would mean it is blind`);

// The deploy job's variable upsert replaces each named service variable with
// the copy the job holds, so a variable whose source of truth is Railway
// itself must never be in it: the backup bucket is a Railway bucket whose
// credentials Railway issues and can regenerate, and a copy upserted from an
// Actions secret would write the stale value back over the current one on
// every deploy. Neither the job env nor the upsert step may name them.
const RAILWAY_OWNED = ["BACKUP_S3_KEY_ID", "BACKUP_S3_SECRET", "BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET"];
const deployJob = jobs.find((j) => j.name === "deploy");
ok(!!deployJob, "the scan found the deploy job");
if (deployJob) {
  const upsertAt = deployJob.lines.findIndex((l) => /variableCollectionUpsert/.test(l));
  ok(upsertAt >= 0, "the deploy job holds the service variable upsert");
  const envNames = new Set(deployJob.lines.map((l) => /^ {6}([A-Z0-9_]+): /.exec(l)?.[1]).filter(Boolean));
  const stepStart = deployJob.lines.slice(0, upsertAt).map((l, i) => (/^ {6}- /.test(l) ? i : -1)).filter((i) => i >= 0).pop() ?? 0;
  const upsertStep = deployJob.lines.slice(stepStart, upsertAt + 1).filter((l) => !/^\s*#/.test(l)).join("\n");
  for (const name of RAILWAY_OWNED) {
    ok(!envNames.has(name), `deploy job env does not carry ${name} (a Railway-owned credential)`);
    ok(!upsertStep.includes(name), `the variable upsert never names ${name} (a Railway-owned credential)`);
  }
  // Production's trusted proxy hop count is repository config: the upsert's
  // first VARS object carries it as the literal "1" on every deploy, outside
  // any conditional, so a deploy can never leave it unset (src/trust-proxy.js).
  const firstVars = /VARS=\$\(jq -n [^\n]*\\?\n?[^\n]*'(\{[^']*\})'\)/.exec(upsertStep)?.[1] || "";
  ok(/(^|[{,]\s*)TRUST_PROXY_HOPS:"1"\s*[,}]/.test(firstVars), `the variable upsert's base VARS sets TRUST_PROXY_HOPS:"1" unconditionally (${firstVars ? "base object found" : "no base object found"})`);
  ok(!/TRUST_PROXY_HOPS:\$/.test(upsertStep) && (upsertStep.match(/TRUST_PROXY_HOPS/g) || []).length === 1, "TRUST_PROXY_HOPS is named once in the upsert, as a literal, never from a secret or variable");
}

// Spending workflows: an install step runs dependency code with whatever its
// environment holds, so no secret (nor the workflow token) may reach one.
const SECRETISH = /secrets\.|github\.token|GITHUB_TOKEN/;
const INSTALL_RUN = /\bnpm (ci|install|i|rebuild)\b|\bnpx\b|\byarn\b|\bpnpm\b/;
for (const file of ["spend.yml", "algorand-rail-canary.yml"]) {
  const wf = load(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));
  const leaks = (env) => Object.entries(env || {}).filter(([, v]) => SECRETISH.test(String(v))).map(([k]) => k);
  ok(leaks(wf.env).length === 0, `${file}: no secret at workflow scope`);
  let installs = 0;
  for (const [name, job] of Object.entries(wf.jobs || {})) {
    const jobLeaks = leaks(job.env);
    const installsHere = (job.steps || []).filter((st) => INSTALL_RUN.test(String(st.run || "")));
    if (installsHere.length) ok(jobLeaks.length === 0, `${file} ${name}: no secret at job scope, where its install would read it${jobLeaks.length ? ` (${jobLeaks.join(", ")})` : ""}`);
    for (const st of installsHere) {
      installs++;
      const stepLeaks = leaks(st.env);
      ok(stepLeaks.length === 0, `${file} ${name}: "${String(st.name || st.run).slice(0, 50)}" carries no secret${stepLeaks.length ? ` (${stepLeaks.join(", ")})` : ""}`);
    }
  }
  ok(installs >= (file === "spend.yml" ? Object.keys(wf.jobs || {}).length - 1 : 1), `${file}: the scan found its install steps (${installs})`);
}

// The Algorand sweep imports src/payments.js, whose import chain opens a
// SQLite file at load, so its install must build better-sqlite3's binding
// (everything else installs with scripts off), and the token stays on the
// issue steps, after the sweep.
{
  const wf = load(readFileSync(new URL("../.github/workflows/algorand-rail-canary.yml", import.meta.url), "utf8"));
  const steps = wf.jobs?.canary?.steps || [];
  const iInstall = steps.findIndex((st) => /\bnpm ci --ignore-scripts\b/.test(String(st.run || "")));
  const install = String(steps[iInstall]?.run || "");
  ok(iInstall >= 0 && /&& npm rebuild better-sqlite3 &&/.test(install) && !/npm (ci|install)(?![^&]*--ignore-scripts)/.test(install), `algorand-rail-canary.yml: the install rebuilds better-sqlite3 and runs every other install with scripts off (${install.slice(0, 120)})`);
  const iSweep = steps.findIndex((st) => /algorand-rail-canary\.js/.test(String(st.run || "")));
  const tokenSteps = steps.map((st, i) => [i, st]).filter(([, st]) => SECRETISH.test(String(st.env?.GH_TOKEN || ""))).map(([i]) => i);
  // The issue steps: the one that opens or closes the issue, and the one
  // before it that gives an issue under a previous title the current one.
  const issueStep = (st) => /gh issue/.test(String(st.run || "")) || String(st.run || "").trim() === "node scripts/adopt-issue-titles.js";
  ok(iSweep > iInstall && tokenSteps.length >= 1 && tokenSteps.length <= 2 && tokenSteps.every((i) => i > iSweep && issueStep(steps[i])) && tokenSteps.some((i) => /gh issue/.test(String(steps[i].run || ""))), `algorand-rail-canary.yml: the workflow token is on the issue steps alone, after the sweep (steps ${tokenSteps.join(", ")})`);
}

// The other direction: a suite that needs the private cost table
// (scripts/lib/require-upstream-costs.js) fails under CI without it, so every
// deploy.yml step that runs one must hand it the table: the secret, or a
// table file, never a blank. UPSTREAM_COSTS_OPTIONAL is only ever the fork
// expression, so a push run can never skip.
{
  const { readdirSync } = await import("node:fs");
  const wf = load(text);
  const scriptsDir = new URL("../scripts/", import.meta.url);
  const needTable = readdirSync(scriptsDir).filter((f) => f.endsWith(".js") && /(?:require-upstream-costs|stand-in-costs)\.js/.test(readFileSync(new URL(f, scriptsDir), "utf8")));
  const MUST = ["test-leak-guard.js", "test-llm-gateway.js", "test-llm-messages.js", "test-llm-responses.js", "test-async-jobs.js"];
  for (const s of MUST) ok(needTable.includes(s), `${s} requires the cost table (fails under CI without it)`);
  const lib = readFileSync(new URL("lib/require-upstream-costs.js", scriptsDir), "utf8");
  ok(/upstreamCostsRequired = \(\) => Boolean\(process\.env\.CI\) && process\.env\.UPSTREAM_COSTS_OPTIONAL !== "1"/.test(lib) && /if \(upstreamCostsRequired\(\)\) \{\s+console\.error\([^\n]*\n\s+process\.exit\(1\)/.test(lib), "require-upstream-costs fails under CI unless the run is marked optional");
  // A suite on stand-in costs runs what needs no rate and still fails under CI without the table.
  const standIn = readFileSync(new URL("lib/stand-in-costs.js", scriptsDir), "utf8");
  ok(/if \(upstreamCostsRequired\(\)\) \{\s+console\.error\([^\n]*\n\s+if \(!code\) process\.exitCode = 1;/.test(standIn), "stand-in-costs fails a suite under CI without the table unless the run is marked optional");
  const FORK_ONLY = /^\$\{\{ github\.event\.pull_request\.head\.repo\.fork && '1' \|\| '' \}\}$/;
  const runs = new Map();
  for (const [jobName, job] of Object.entries(wf.jobs || {})) {
    for (const st of job.steps || []) {
      const run = String(st.run || "");
      for (const s of needTable) {
        if (!new RegExp(`scripts/${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s;&|)]|$)`, "m").test(run)) continue;
        const env = { ...(wf.env || {}), ...(job.env || {}), ...(st.env || {}) };
        const json = String(env.UPSTREAM_COSTS_JSON ?? "");
        const file = String(env.UPSTREAM_COSTS_FILE ?? "");
        const opt = env.UPSTREAM_COSTS_OPTIONAL;
        const table = /^\$\{\{ secrets\.UPSTREAM_COSTS_JSON \}\}$/.test(json) || file.trim() !== "";
        if (!table || (opt !== undefined && !FORK_ONLY.test(String(opt)))) {
          ok(false, `${s} in ${jobName} "${String(st.name || "").slice(0, 50)}" gets the cost table and is optional only on a fork`);
        }
        runs.set(s, (runs.get(s) || 0) + 1);
      }
    }
  }
  for (const s of MUST) ok((runs.get(s) || 0) >= 1, `deploy.yml runs ${s} with the cost table (${runs.get(s) || 0} step(s))`);
  ok(runs.size >= MUST.length, `every deploy.yml step that runs a cost-table suite hands it the table (${runs.size} suites checked)`);
}

// THE CI DATA KEYS. The production CoinGecko key is not an Actions secret (CI
// must never spend it), so no step reads secrets.COINGECKO_API_KEY. CI holds
// three keys of its own: OPEN_METEO_API_KEY, COINGECKO_CI_API_KEY and
// BLS_API_KEY (the BLS-backed macro tools). Each is
// handed ONLY to the step that boots the server the strict sweep drives (in
// the sweep lane) and to the nightly corpus step, at step scope, never at job
// or workflow scope; every other step, an install included, never sees them.
// The keyed boot maps the CI key onto the server's own variable with the pro
// tier and the sweep's per-run read cap, writes only the words keyed or
// keyless (never a value) to the log and to GITHUB_ENV, and a check after the
// lenient sweep fails the run when that cap is spent or a keyed read was
// refused 429 (scripts/test-non-metered-examples.js --coingecko-run-check).
{
  const { CG_RUN_READ_CAP, CG_RUN_MAX_PER_MIN, CG_NIGHTLY_READ_CAP, BLS_RUN_READ_CAP } = await import("./test-non-metered-examples.js");
  const DATA_KEYS = ["OPEN_METEO_API_KEY", "COINGECKO_CI_API_KEY", "BLS_CI_API_KEY"];
  const KEY_VARS = ["OPEN_METEO_API_KEY", "COINGECKO_API_KEY", "BLS_API_KEY"];
  const wfText = (f) => readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), "utf8");
  for (const f of ["deploy.yml", "corpus-nightly.yml"]) {
    ok(!/secrets\.COINGECKO_API_KEY\b/.test(wfText(f)), `${f}: no step reads secrets.COINGECKO_API_KEY (the production key is not an Actions secret; CI uses COINGECKO_CI_API_KEY)`);
    ok(!/secrets\.BLS_API_KEY\b/.test(wfText(f)), `${f}: no step reads secrets.BLS_API_KEY (CI uses BLS_CI_API_KEY, so a run never spends the production key's daily queries)`);
  }
  // Every place a data key is read, by workflow: [job, step name].
  const readsOf = (wf) => {
    const out = [];
    const scan = (env, where) => { for (const [k, v] of Object.entries(env || {})) for (const s of DATA_KEYS) if (new RegExp(`secrets\\.${s}\\b`).test(String(v))) out.push({ ...where, secret: s, as: k }); };
    scan(wf.env, { scope: "workflow" });
    for (const [jn, job] of Object.entries(wf.jobs || {})) {
      scan(job.env, { scope: "job", job: jn });
      for (const st of job.steps || []) scan(st.env, { scope: "step", job: jn, step: String(st.name || ""), st });
    }
    return out;
  };
  const deploy = load(text);
  const dReads = readsOf(deploy);
  ok(dReads.every((r) => r.scope === "step"), `deploy.yml: the data keys are read at step scope only${dReads.filter((r) => r.scope !== "step").map((r) => ` (${r.secret} at ${r.scope} scope${r.job ? ` in ${r.job}` : ""})`).join("")}`);
  const KEYED_STEP = "Start server in free mode (the strict sweep's server; the CI data keys)";
  const keyedSteps = [...new Set(dReads.map((r) => `${r.job}: ${r.step}`))];
  ok(keyedSteps.length === 1 && keyedSteps[0] === `test-sweeps: ${KEYED_STEP}`, `deploy.yml: only the strict sweep's server step reads the data keys (${keyedSteps.join("; ") || "none"})`);
  const keyed = deploy.jobs?.["test-sweeps"]?.steps?.find((st) => st.name === KEYED_STEP);
  ok(Boolean(keyed), "test-sweeps holds the keyed server step");
  if (keyed) {
    const env = keyed.env || {};
    const run = String(keyed.run || "");
    ok(/^\$\{\{ secrets\.OPEN_METEO_API_KEY \}\}$/.test(String(env.OPEN_METEO_API_KEY)) && /^\$\{\{ secrets\.COINGECKO_CI_API_KEY \}\}$/.test(String(env.COINGECKO_API_KEY)),
      "the keyed step hands the server OPEN_METEO_API_KEY and the CI CoinGecko key as COINGECKO_API_KEY");
    ok(/^\$\{\{ secrets\.BLS_CI_API_KEY \}\}$/.test(String(env.BLS_API_KEY)), "the keyed step hands the server the CI BLS key as BLS_API_KEY (the BLS-backed macro tools; the production key is never an Actions input)");
    ok(String(env.BLS_DAILY_MAX) === String(BLS_RUN_READ_CAP), `the server's BLS read ceiling is the sweep's per-run cap (${env.BLS_DAILY_MAX} vs BLS_RUN_READ_CAP ${BLS_RUN_READ_CAP})`);
    ok(env.COINGECKO_API_TIER === "pro", `the keyed step sets COINGECKO_API_TIER=pro (got ${env.COINGECKO_API_TIER})`);
    ok(String(env.COINGECKO_DAILY_MAX) === String(CG_RUN_READ_CAP), `the server's CoinGecko read ceiling is the sweep's per-run cap (${env.COINGECKO_DAILY_MAX} vs CG_RUN_READ_CAP ${CG_RUN_READ_CAP})`);
    ok(String(env.COINGECKO_MAX_PER_MIN) === String(CG_RUN_MAX_PER_MIN), `the server's CoinGecko minute pacing is the sweep's (${env.COINGECKO_MAX_PER_MIN} vs ${CG_RUN_MAX_PER_MIN})`);
    ok(/src\/server\.js/.test(run), "the keyed step boots the server (the only process that reads the keys)");
    // A key variable is only ever tested for presence, never printed or exported.
    const uses = KEY_VARS.flatMap((v) => [...run.matchAll(new RegExp(`(.{0,6})\\$\\{?${v}\\}?`, "g"))].map((m) => m[1]));
    ok(uses.length >= 3 && uses.every((pre) => /-[nz] "$/.test(pre)), `the keyed step reads each key variable only in a presence test (${uses.length} use(s))`);
    ok(!KEY_VARS.some((v) => new RegExp(`${v}=`).test(run.split("\n").filter((l) => /GITHUB_ENV|GITHUB_OUTPUT/.test(l)).join("\n"))), "the keyed step never writes a key to GITHUB_ENV or GITHUB_OUTPUT");
    ok(/NON_METERED_CG_MODE=\$\w+.*GITHUB_ENV/.test(run) && /NON_METERED_OM_MODE=\$\w+.*GITHUB_ENV/.test(run) && !/NON_METERED_BLS_MODE/.test(run), "the keyed step hands the later steps the words keyed or keyless for each source a later step reads (BLS is capped by BLS_DAILY_MAX, no mode word)");
    ok(/add-mask/.test(run) && /AGENT402_OPERATOR_TOKEN=/.test(run), "the keyed step masks the run's own operator token before the server reads it");
  }
  // The check after the lenient sweep: the cap and a keyed 429 fail the run.
  const sweepSteps = deploy.jobs?.["test-sweeps"]?.steps || [];
  const iCheck = sweepSteps.findIndex((st) => /test-non-metered-examples\.js --coingecko-run-check\b/.test(String(st.run || "")));
  const iAll = sweepSteps.findIndex((st) => /scripts\/test-all\.js/.test(String(st.run || "")));
  ok(iCheck > iAll && iAll >= 0, `test-sweeps checks the CoinGecko reads after the lenient sweep (check step ${iCheck}, test-all step ${iAll})`);
  ok(iCheck >= 0 && /!cancelled\(\)/.test(String(sweepSteps[iCheck].if || "")), "the CoinGecko check runs whatever the sweeps answered (if: !cancelled())");
  // Every other server boot in the deploy workflow is keyless for both sources.
  for (const [jn, job] of Object.entries(deploy.jobs || {})) {
    for (const st of job.steps || []) {
      if (st.name === KEYED_STEP && jn === "test-sweeps") continue;
      const env = { ...(deploy.env || {}), ...(job.env || {}), ...(st.env || {}) };
      const leaked = KEY_VARS.filter((k) => env[k] !== undefined && String(env[k]).trim() !== "");
      if (leaked.length) ok(false, `deploy.yml ${jn} "${String(st.name || "").slice(0, 50)}" carries ${leaked.join(", ")}`);
    }
  }
  // The nightly corpus: the CI key on the corpus step alone, same tier and its own cap.
  const corpus = load(wfText("corpus-nightly.yml"));
  const cReads = readsOf(corpus);
  ok(cReads.length >= 1 && cReads.every((r) => r.scope === "step" && r.job === "corpus" && /^Run the corpus/.test(r.step)), `corpus-nightly.yml: the CI key is read on the corpus step alone (${cReads.map((r) => `${r.scope}:${r.step || r.job}`).join("; ")})`);
  const cStep = corpus.jobs?.corpus?.steps?.find((st) => /^Run the corpus/.test(String(st.name || "")));
  const cEnv = cStep?.env || {};
  ok(/^\$\{\{ secrets\.COINGECKO_CI_API_KEY \}\}$/.test(String(cEnv.COINGECKO_API_KEY)) && cEnv.COINGECKO_API_TIER === "pro" && String(cEnv.COINGECKO_DAILY_MAX) === String(CG_NIGHTLY_READ_CAP),
    `corpus-nightly.yml: the corpus server gets the CI key as COINGECKO_API_KEY, the pro tier and the nightly read cap (${cEnv.COINGECKO_DAILY_MAX} vs ${CG_NIGHTLY_READ_CAP})`);
  ok(/keyed/.test(String(cStep?.run || "")) && !/echo[^\n]*\$\{?COINGECKO_API_KEY/.test(String(cStep?.run || "")), "corpus-nightly.yml: the corpus step logs keyed or keyless, never the key");
}

// npm releases authenticate by trusted publishing (OIDC, the publish job's
// id-token): no workflow holds a long-lived npm token, so no install step,
// lifecycle script or third-party CLI can read one.
{
  const { readdirSync } = await import("node:fs");
  const dir = new URL("../.github/workflows/", import.meta.url);
  const holders = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).filter((f) => readFileSync(new URL(f, dir), "utf8").split("\n").some((l) => !/^\s*#/.test(l) && /secrets\.NPM_TOKEN\b|NODE_AUTH_TOKEN\s*:/.test(l)));
  ok(holders.length === 0, `no workflow reads secrets.NPM_TOKEN or sets NODE_AUTH_TOKEN (${holders.join(", ") || "none"})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

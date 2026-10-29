// Every job-level secret in deploy.yml is blanked in that job's secretless
// install step and in the adapter step (it installs framework packages from
// the registry). An install runs dependency lifecycle scripts, so a secret
// left in its env is readable by any postinstall a version bump brings in.
// The spending workflows that install packages (listing-pass.yml,
// mint-bazaar-rows.yml) keep every secret and the workflow token at step
// scope, never on an install step or at job or workflow scope.
// Offline: reads the workflow text only.
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

const text = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
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

// Spending workflows: an install step runs dependency code with whatever its
// environment holds, so no secret (nor the workflow token) may reach one.
const SECRETISH = /secrets\.|github\.token|GITHUB_TOKEN/;
const INSTALL_RUN = /\bnpm (ci|install|i)\b|\bnpx\b|\byarn\b|\bpnpm\b/;
for (const file of ["listing-pass.yml", "mint-bazaar-rows.yml"]) {
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
  ok(installs >= 1, `${file}: the scan found its install step (${installs})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

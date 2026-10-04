// Every job-level secret in deploy.yml is blanked in that job's secretless
// install step and in the adapter step (it installs framework packages from
// the registry). An install runs dependency lifecycle scripts, so a secret
// left in its env is readable by any postinstall a version bump brings in.
// Offline: reads the workflow text only.
import { readFileSync } from "node:fs";

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

const INSTALLS = [/^- name: Install dependencies \(secretless\)$/, /^- name: Adapter tests\b/];
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

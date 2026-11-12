#!/usr/bin/env node
// A sharded test lane must run every script it names exactly once.
//
//   node scripts/test-ci-shards.js
//
// A lane split across N runners (scripts/lib/ci-shards.js) can lose a script
// without any test going red: a step pinned to a shard that does not exist is
// skipped in every shard, a `t` filter that is off by one skips every Nth
// script everywhere, and a step left unpinned runs N times. Each of those
// reads as a green lane. This runs every shard of every sharded lane in
// deploy.yml as a dry run (each `t` step under bash with `node` stubbed to
// record the script it was handed, each single-script step by its `if:`), and
// requires the union over shards to equal the lane's script list with no
// script in two shards. The same check runs on mutated copies of the workflow
// below, each of which must fail.
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { load } from "js-yaml";
import { shardCount, shardJobName, laneJobNames, inShard, shardFromEnv } from "./lib/ci-shards.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const WF_TEXT = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const wf = load(WF_TEXT);

// Scripts a step runs on every shard because the others need what they leave
// (OCR data, apt packages), and scripts that split their own work by the
// shard rule. Neither may carry a shard `if:`.
const SETUP = new Set(["fetch-tessdata.js"]);
const SELF_SHARDED = new Set(["test-redos-free-tier.js"]);

const live = (run) => String(run || "").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const scriptRefs = (run) => [...live(run).matchAll(/\bnode\s+(?:--?[\w-]+(?:[ =]\S+)?\s+)*scripts\/([\w.-]+\.m?js)\b/g)].map((m) => m[1]);
const definesT = (run) => /^\s*t\(\)\s*\{/m.test(String(run || ""));

const tmp = mkdtempSync(join(tmpdir(), "a402-shards-"));
const bin = join(tmp, "bin");
spawnSync("mkdir", ["-p", bin]);
// `node` records the script it was handed; `docker` and `curl` do nothing.
writeFileSync(join(bin, "node"), '#!/bin/sh\nfor a in "$@"; do case "$a" in scripts/*) echo "${a#scripts/}" >> "$SHARD_REC"; break;; esac; done\nexit 0\n');
writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 0\n");
chmodSync(join(bin, "node"), 0o755);
chmodSync(join(bin, "docker"), 0o755);

let simCount = 0;
/** Problems with one workflow's sharded lanes (empty = sound). */
function analyze(w) {
  const problems = [];
  const sharded = Object.entries(w.jobs || {}).filter(([, j]) => j.strategy?.matrix?.shard !== undefined);
  for (const [key, job] of sharded) {
    const n = shardCount(job);
    const list = job.strategy.matrix.shard;
    if (!(n >= 2 && list.every((v, i) => v === i + 1))) problems.push(`${key}: matrix.shard is not [1..N] (${JSON.stringify(list)})`);
    if (Object.keys(job.strategy.matrix).length !== 1) problems.push(`${key}: the matrix has keys other than shard`);
    if (job.strategy["fail-fast"] !== false) problems.push(`${key}: fail-fast is not false, so one shard's failure would cancel the others`);
    if (job.name !== shardJobName(key, n)) problems.push(`${key}: name is not the shard name (${job.name})`);
    if (job.env?.CI_SHARD !== "${{ matrix.shard }}" || String(job.env?.CI_SHARDS) !== String(n)) problems.push(`${key}: CI_SHARD/CI_SHARDS do not carry the matrix (${job.env?.CI_SHARD}, ${job.env?.CI_SHARDS} for ${n})`);

    const expected = [];
    const ran = new Map();
    const note = (s, k) => { if (!ran.has(s)) ran.set(s, []); ran.get(s).push(k); };
    for (const step of job.steps || []) {
      const refs = scriptRefs(step.run);
      if (definesT(step.run)) expected.push(...refs);
      else for (const r of refs) {
        if (SETUP.has(r) || SELF_SHARDED.has(r)) {
          if (step.if !== undefined) problems.push(`${key}: ${r} carries if: ${step.if}, but it runs in every shard`);
        } else {
          expected.push(r);
          if (step.if === undefined) continue; // counted below as running in every shard
          if (!/^matrix\.shard == \d+$/.test(String(step.if))) problems.push(`${key}: ${r} runs under if: ${step.if}, not a shard pin`);
        }
      }
    }
    for (let k = 1; k <= n; k++) {
      const runnerTemp = mkdtempSync(join(tmp, `${key}-${k}-`));
      const rec = join(runnerTemp, "rec");
      writeFileSync(rec, "");
      for (const step of job.steps || []) {
        const pin = /^matrix\.shard == (\d+)$/.exec(String(step.if ?? ""));
        const runsHere = step.if === undefined || (pin && Number(pin[1]) === k);
        if (definesT(step.run)) {
          if (step.if !== undefined) { problems.push(`${key}: a t step carries if: ${step.if}`); continue; }
          const script = String(step.run).replace(/\$\{\{[^}]*\}\}/g, "x");
          const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, HOME: runnerTemp, RUNNER_TEMP: runnerTemp, CI_SHARD: String(job.env?.CI_SHARD === "${{ matrix.shard }}" ? k : job.env?.CI_SHARD), CI_SHARDS: String(job.env?.CI_SHARDS), SHARD_REC: rec } });
          simCount++;
          if (r.status !== 0) problems.push(`${key} shard ${k}: step "${step.name}" exits ${r.status} in the dry run (${(r.stderr || "").trim().slice(0, 160)})`);
          continue;
        }
        if (!runsHere) continue;
        for (const s of scriptRefs(step.run)) if (!SETUP.has(s) && !SELF_SHARDED.has(s)) note(s, k);
      }
      for (const s of readFileSync(rec, "utf8").split("\n").filter(Boolean)) note(s, k);
    }
    const counts = new Map();
    for (const s of expected) counts.set(s, (counts.get(s) || 0) + 1);
    for (const [s, c] of counts) if (c > 1) problems.push(`${key}: ${s} is listed ${c} times`);
    for (const s of counts.keys()) {
      const where = ran.get(s) || [];
      if (where.length === 0) problems.push(`${key}: ${s} runs in no shard`);
      else if (where.length > 1) problems.push(`${key}: ${s} runs in shards ${where.join(",")}`);
    }
    for (const s of ran.keys()) if (!counts.has(s)) problems.push(`${key}: ${s} ran but is not in the lane's list`);
  }
  return { problems, sharded: sharded.map(([k]) => k) };
}

const clone = () => structuredClone(wf);
try {
  // The workflow as committed.
  const real = analyze(wf);
  for (const p of real.problems) console.error(`  ${p}`);
  ok(real.sharded.length >= 1, `sharded lanes found: ${real.sharded.join(", ")}`);
  ok(real.problems.length === 0, "every script a sharded lane names runs in exactly one of its shards");
  ok(simCount > 0, `the t steps ran as a dry run (${simCount} step runs)`);
  for (const key of real.sharded) {
    const j = wf.jobs[key];
    const names = laneJobNames(key, j);
    ok(names.length === shardCount(j) && names[0] === key && names.every((nm, i) => i === 0 || nm === `${key} (${i + 1}/${names.length})`),
      `${key}: the job names the tree gate requires are ${names.join(" | ")}`);
    for (const gate of ["deploy", "publish"]) {
      ok([].concat(wf.jobs[gate]?.needs || []).includes(key), `${gate} needs ${key} (the matrix result covers every shard)`);
    }
  }
  ok(laneJobNames("test-x", { steps: [] }).join() === "test-x", "an unsharded lane is required under its own name");

  // The round-robin rule over a list: every index in exactly one shard.
  for (const total of [1, 2, 3, 5]) {
    let bad = 0;
    for (let i = 0; i < 1000; i++) {
      const owners = Array.from({ length: total }, (_, k) => k + 1).filter((k) => inShard(i, k, total));
      if (owners.length !== 1) bad++;
    }
    ok(bad === 0, `inShard puts each of 1000 items in exactly one of ${total} shard(s)`);
  }
  ok(JSON.stringify(shardFromEnv({})) === JSON.stringify({ shard: 1, total: 1 }), "no shard variables: the whole run");
  ok(JSON.stringify(shardFromEnv({ CI_SHARD: "2", CI_SHARDS: "3" })) === JSON.stringify({ shard: 2, total: 3 }), "CI_SHARD=2 CI_SHARDS=3 reads as shard 2 of 3");
  for (const env of [{ CI_SHARD: "3", CI_SHARDS: "2" }, { CI_SHARD: "0", CI_SHARDS: "2" }, { CI_SHARD: "1" }, { CI_SHARD: "x", CI_SHARDS: "2" }]) {
    let threw = false; try { shardFromEnv(env); } catch { threw = true; }
    ok(threw, `shardFromEnv refuses ${JSON.stringify(env)}`);
  }
  const redos = readFileSync(new URL("./test-redos-free-tier.js", import.meta.url), "utf8");
  ok(/inShard\(i, SHARD\.shard, SHARD\.total\)/.test(redos) && /const SHARD = shardFromEnv\(\)/.test(redos), "the event-loop guard splits its calls by the same rule");
  const gate = readFileSync(new URL("./ci-tree-gate.js", import.meta.url), "utf8");
  ok(/laneJobNames\(/.test(gate), "the tree gate requires every shard's job name");

  // Each mutation below must be caught. Without these, a check that finds
  // nothing proves nothing.
  const key = real.sharded.find((k) => (wf.jobs[k].steps || []).some((s) => /^matrix\.shard == \d+$/.test(String(s.if ?? ""))));
  const tKey = real.sharded.find((k) => (wf.jobs[k].steps || []).some((s) => definesT(s.run) && scriptRefs(s.run).length >= 2));
  ok(!!key && !!tKey, `mutation targets found (${key}, ${tKey})`);
  const pinned = (w) => w.jobs[key].steps.find((s) => /^matrix\.shard == \d+$/.test(String(s.if ?? "")));
  const tStep = (w) => w.jobs[tKey].steps.find((s) => definesT(s.run) && scriptRefs(s.run).length >= 2);
  const mutants = {
    "a step pinned to a shard that does not exist": (w) => { pinned(w).if = `matrix.shard == ${shardCount(w.jobs[key]) + 1}`; },
    "a single-script step with its pin removed (runs in every shard)": (w) => { delete pinned(w).if; },
    "a script listed twice in a t step": (w) => { const s = tStep(w); const line = s.run.split("\n").find((l) => /^\s*t node scripts\//.test(l)); s.run = s.run.replace(line, `${line}\n${line}`); },
    "a script dropped from every shard by an off-by-one t filter": (w) => { const s = tStep(w); s.run = s.run.replace("% CI_SHARDS + 1 )) -ne", "% CI_SHARDS + 2 )) -ne"); },
    "a t helper that runs every call in every shard": (w) => { const s = tStep(w); s.run = s.run.replace(/then echo "--  [^;]*; return 0; fi; /, "then :; fi; "); },
    "CI_SHARDS that disagrees with the matrix": (w) => { w.jobs[tKey].env.CI_SHARDS = String(shardCount(w.jobs[tKey]) + 1); },
    "a shard name that drops the lane's own name": (w) => { w.jobs[tKey].name = `${tKey} \${{ matrix.shard }}`; },
    "fail-fast left on": (w) => { delete w.jobs[tKey].strategy["fail-fast"]; },
  };
  for (const [label, mutate] of Object.entries(mutants)) {
    const w = clone();
    mutate(w);
    const got = analyze(w).problems;
    ok(got.length > 0, `mutation caught: ${label} (${got[0] || "no problem reported"})`);
  }
} finally {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

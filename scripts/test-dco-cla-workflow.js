#!/usr/bin/env node
// The outside-contribution check (.github/workflows/dco.yml) stays pinned,
// least-privileged, safe with untrusted PR text, exempt for the owner and bots,
// and correct: its two scripts are run here against a scratch repository.
//
//   node scripts/test-dco-cla-workflow.js
//
// Static:
//   - every `uses:` is pinned to a 40-hex commit SHA;
//   - the token holds contents: read and pull-requests: read and nothing else,
//     at workflow and job level; no secret is read; no pull_request_target;
//   - no run block contains a `${{ }}` expression (PR fields reach the scripts
//     only through the event file and the API);
//   - the job skips the owner's PRs and bot PRs, and runs on description edits;
//   - the agreement sentence is the same in the CLA script, CLA.md and
//     CONTRIBUTING.md, and the PR template does not carry it (a template that
//     carried it would agree for every contributor who left it in place).
// Behavior (scripts/ci/dco-check.sh, scripts/ci/cla-check.sh with a stub gh):
//   - a commit signed off by its author passes; an unsigned one fails; one
//     signed off with another email fails; a merge commit is exempt;
//   - the agreement in the description passes, in a comment by the PR author
//     passes, in a comment by someone else fails, and its absence fails;
//   - PR text holding shell syntax is never executed.
// Offline: a temporary git repository and a stub `gh` on PATH.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { load } from "js-yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WF = join(ROOT, ".github", "workflows", "dco.yml");
const DCO = join(ROOT, "scripts", "ci", "dco-check.sh");
const CLA = join(ROOT, "scripts", "ci", "cla-check.sh");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// ---- static -----------------------------------------------------------------
const text = readFileSync(WF, "utf8");
const wf = load(text);
const on = wf.on ?? wf.true;
ok(on && typeof on === "object" && on.pull_request && !("pull_request_target" in on), "runs on pull_request, never pull_request_target");
ok([].concat(on?.pull_request?.types || []).includes("edited") && [].concat(on?.pull_request?.types || []).includes("synchronize"), "runs again when the description is edited and when commits are pushed");
const perms = wf.permissions || {};
ok(JSON.stringify(Object.entries(perms).sort()) === JSON.stringify([["contents", "read"], ["pull-requests", "read"]]), "workflow token: contents read and pull-requests read only");
ok(!/secrets\./.test(text), "reads no secret");
const jobs = Object.entries(wf.jobs || {});
ok(jobs.length === 1 && jobs[0][0] === "dco", "one job, still named dco (the check name is unchanged)");
for (const [name, job] of jobs) {
  ok(!job.permissions || Object.values(job.permissions).every((v) => v === "read"), `${name}: no job-level write permission`);
  const cond = String(job.if || "");
  ok(/github\.event\.pull_request\.user\.login != 'MikeyPetrillo'/.test(cond), `${name}: the owner's PRs are exempt`);
  ok(/github\.event\.pull_request\.user\.type != 'Bot'/.test(cond) && /&&/.test(cond), `${name}: bot PRs are exempt too`);
  for (const step of job.steps || []) {
    if (step.uses) ok(/^[^@\s]+@[0-9a-f]{40}$/.test(String(step.uses).split(" ")[0]), `${name}: ${String(step.uses).split("@")[0]} is pinned to a commit SHA`);
    if (step.run) ok(!/\$\{\{/.test(step.run), `${name}: run block "${step.name || step.run.slice(0, 30)}" interpolates no expression`);
    if (step.with && "persist-credentials" in step.with) ok(step.with["persist-credentials"] === false, `${name}: checkout keeps no credentials`);
  }
  const runs = (job.steps || []).map((s) => s.run || "").join("\n");
  ok(/scripts\/ci\/dco-check\.sh/.test(runs) && /scripts\/ci\/cla-check\.sh/.test(runs), `${name}: runs the DCO and CLA scripts`);
}
const claSrc = readFileSync(CLA, "utf8");
const sentence = (/^AGREEMENT="([^"]+)"$/m.exec(claSrc) || [])[1];
ok(Boolean(sentence), "the CLA script names its agreement sentence");
const flat = (s) => s.replace(/\s+/g, " ");
ok(sentence && flat(readFileSync(join(ROOT, "CLA.md"), "utf8")).includes(`> ${sentence}`), "CLA.md prints the same sentence");
ok(sentence && flat(readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8")).includes(`> ${sentence}`), "CONTRIBUTING.md prints the same sentence");
const tpl = join(ROOT, ".github", "PULL_REQUEST_TEMPLATE.md");
ok(sentence && !flat(readFileSync(tpl, "utf8")).toLowerCase().includes(sentence.toLowerCase()), "the PR template does not carry the sentence");

// ---- behavior ---------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "dco-cla-"));
try {
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  const g = (args, env = {}) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: tmp, ...env } }).trim();
  g(["init", "-q", "-b", "main"]);
  const as = (name, email) => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
  const commit = (file, msg, who) => { writeFileSync(join(repo, file), `${file} ${Math.random()}\n`); g(["add", file]); g(["commit", "-q", "-m", msg], who); return g(["rev-parse", "HEAD"]); };
  const ann = as("Ann Example", "Ann@Example.com");
  const base = commit("base.txt", "base", ann);
  const signed = commit("a.txt", "Add a\n\nSigned-off-by: Ann Example <ann@example.com>", ann);
  const unsigned = commit("b.txt", "Add b", ann);
  g(["checkout", "-q", "-b", "other", signed]);
  const other = commit("c.txt", "Add c\n\nSigned-off-by: Ann Example <ann@example.com>", ann);
  g(["checkout", "-q", "main"]);
  g(["reset", "-q", "--hard", signed]);
  g(["merge", "-q", "--no-ff", "-m", "Merge other", other], ann);
  const merged = g(["rev-parse", "HEAD"]);
  g(["reset", "-q", "--hard", signed]);
  const wrongEmail = commit("d.txt", "Add d\n\nSigned-off-by: Ann Example <someone@else.example>", ann);
  const marker = join(tmp, "pwned");
  const hostile = commit("e.txt", `Add e $(touch ${marker}) \`touch ${marker}\`\n\nSigned-off-by: Ann Example <ann@example.com>`, ann);

  const binDir = join(tmp, "bin");
  mkdirSync(binDir);
  const commentsFile = join(tmp, "comments.json");
  writeFileSync(join(binDir, "gh"), `#!/bin/sh\ncat "${commentsFile}"\n`);
  chmodSync(join(binDir, "gh"), 0o755);

  const run = (script, { baseSha = base, headSha, body = "", login = "ann", comments = [] }) => {
    const ev = join(tmp, "event.json");
    writeFileSync(ev, JSON.stringify({ pull_request: { number: 7, body, user: { login, type: "User" }, base: { sha: baseSha }, head: { sha: headSha } } }));
    writeFileSync(commentsFile, JSON.stringify(comments));
    const r = spawnSync("bash", [script], { cwd: repo, encoding: "utf8", env: { ...process.env, HOME: tmp, GITHUB_EVENT_PATH: ev, GITHUB_REPOSITORY: "owner/repo", PATH: `${binDir}:${process.env.PATH}` } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  let r = run(DCO, { headSha: signed });
  ok(r.code === 0, "DCO: a commit signed off by its author (email case aside) passes");
  r = run(DCO, { baseSha: signed, headSha: unsigned });
  ok(r.code === 1 && /no Signed-off-by line/.test(r.out) && /git commit -s/.test(r.out), "DCO: an unsigned commit fails and says how to sign off");
  r = run(DCO, { baseSha: signed, headSha: wrongEmail });
  ok(r.code === 1 && /author's email/.test(r.out), "DCO: a sign-off with another email than the author's fails");
  r = run(DCO, { headSha: merged });
  ok(r.code === 0, "DCO: a merge commit is exempt and its signed parents pass");
  r = run(DCO, { baseSha: wrongEmail, headSha: hostile });
  ok(r.code === 0 && !existsSync(marker), "DCO: shell syntax in a commit message is never executed");

  const S = sentence || "missing";
  r = run(CLA, { headSha: signed, body: `Fixes a thing.\n\n${S.toUpperCase().replace(/ /g, "  \n")}` });
  ok(r.code === 0 && /description/.test(r.out), "CLA: the sentence in the description passes (case and wrapping aside)");
  r = run(CLA, { headSha: signed, body: "Fixes a thing.", comments: [{ user: { login: "ann" }, body: `Sure. ${S}` }] });
  ok(r.code === 0 && /comment/.test(r.out), "CLA: the sentence in a comment by the PR author passes");
  r = run(CLA, { headSha: signed, body: "Fixes a thing.", comments: [{ user: { login: "mallory" }, body: S }] });
  ok(r.code === 1, "CLA: the sentence in someone else's comment does not count");
  r = run(CLA, { headSha: signed, body: `$(touch ${marker}) \`touch ${marker}\`` });
  ok(r.code === 1 && /CLA\.md/.test(r.out) && r.out.includes(S) && !existsSync(marker), "CLA: no sentence fails, prints the sentence to add, and never executes the description");
  r = run(CLA, { headSha: signed, body: "I have read the Agent402 Contributor License Agreement" });
  ok(r.code === 1, "CLA: part of the sentence does not count");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

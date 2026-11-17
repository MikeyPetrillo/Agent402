#!/usr/bin/env node
// The outside-contribution check (.github/workflows/dco.yml) stays pinned,
// least-privileged, safe with untrusted PR text, exempt for the owner and bots,
// run from the base branch, and correct: its two scripts are run here against
// a stub `gh` that serves a pull request, its commits and its comments.
//
//   node scripts/test-dco-cla-workflow.js
//
// Static:
//   - every `uses:` is pinned to a 40-hex commit SHA;
//   - the token holds contents: read and pull-requests: read and nothing else,
//     at workflow and job level; no secret is read; no pull_request_target;
//   - checkout takes the PR's base SHA (or the default branch for a comment),
//     never the head, so the scripts that judge a PR are the base's;
//   - a comment on a PR re-runs the check (issue_comment), with the owner and
//     bots exempt on both events;
//   - no run block contains a `${{ }}` expression;
//   - the agreement sentence names a version, is the same in the CLA script,
//     CLA.md and CONTRIBUTING.md, CLA.md states that version, and the PR
//     template does not carry the sentence;
//   - CODEOWNERS covers the agreement texts, scripts/ci/ and this workflow.
// Behavior (scripts/ci/dco-check.sh, scripts/ci/cla-check.sh):
//   - DCO: signed off by its author passes; unsigned fails; another email
//     fails; a merge commit is exempt; 250 commits fails; shell syntax in a
//     commit message is never executed;
//   - CLA: the PR author agrees in the description or an own comment; every
//     other commit author must agree in an own comment (a description naming
//     them does not count); owner and bot commits are exempt; a commit with no GitHub
//     account fails; the old unversioned sentence and part of the sentence do
//     not count; PR text is never executed; the comment event works too.
// Offline: a stub `gh` on PATH.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
ok(on?.issue_comment && [].concat(on.issue_comment.types || []).includes("created"), "runs again when a comment is posted (issue_comment)");
const perms = wf.permissions || {};
ok(JSON.stringify(Object.entries(perms).sort()) === JSON.stringify([["contents", "read"], ["pull-requests", "read"]]), "workflow token: contents read and pull-requests read only");
ok(!/secrets\./.test(text), "reads no secret");
const jobs = Object.entries(wf.jobs || {});
ok(jobs.length === 1 && jobs[0][0] === "dco", "one job, still named dco (the check name is unchanged)");
for (const [name, job] of jobs) {
  ok(!job.permissions || Object.values(job.permissions).every((v) => v === "read"), `${name}: no job-level write permission`);
  const cond = String(job.if || "");
  ok(/github\.event\.pull_request\.user\.login != 'MikeyPetrillo'/.test(cond) && /github\.event\.issue\.user\.login != 'MikeyPetrillo'/.test(cond), `${name}: the owner's PRs are exempt on both events`);
  ok(/github\.event\.pull_request\.user\.type != 'Bot'/.test(cond) && /github\.event\.issue\.user\.type != 'Bot'/.test(cond), `${name}: bot PRs are exempt on both events`);
  ok(/github\.event_name == 'issue_comment' && github\.event\.issue\.pull_request/.test(cond), `${name}: a comment runs the check only on a pull request`);
  const checkouts = (job.steps || []).filter((s) => /^actions\/checkout@/.test(String(s.uses || "")));
  ok(checkouts.length === 1, `${name}: one checkout`);
  const ref = String(checkouts[0]?.with?.ref || "");
  ok(ref === "${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}", `${name}: checkout takes the base SHA or the default branch, never the PR head`);
  ok(!/head/.test(JSON.stringify(checkouts[0]?.with || {})), `${name}: checkout names no head ref or SHA`);
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
const version = (/\((CLA v\d+\.\d+, \d{4}-\d{2}-\d{2})\)/.exec(sentence || "") || [])[1];
ok(Boolean(version), "the agreement sentence names the agreement's version");
const flat = (s) => s.replace(/\s+/g, " ");
const claMd = readFileSync(join(ROOT, "CLA.md"), "utf8");
ok(sentence && flat(claMd).includes(`> ${sentence}`), "CLA.md prints the same sentence");
ok(version && claMd.includes(`Version: ${version}`), "CLA.md states the version the sentence names");
ok(!/counsel|draft/i.test(claMd), "CLA.md carries no draft or review-status note");
ok(/Contributions? You submitted to this repository before You agreed/.test(flat(claMd)), "CLA.md: agreeing also covers earlier contributions to this repository");
ok(sentence && flat(readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8")).includes(`> ${sentence}`), "CONTRIBUTING.md prints the same sentence");
const tpl = join(ROOT, ".github", "PULL_REQUEST_TEMPLATE.md");
ok(sentence && !flat(readFileSync(tpl, "utf8")).toLowerCase().includes(sentence.toLowerCase()), "the PR template does not carry the sentence");
const owners = readFileSync(join(ROOT, ".github", "CODEOWNERS"), "utf8").split("\n").filter((l) => /^\//.test(l)).map((l) => l.split(/\s+/)[0]);
for (const p of ["/CLA.md", "/NOTICE", "/CONTRIBUTING.md", "/THIRD_PARTY_NOTICES.txt", "/scripts/ci/", "/.github/workflows/", "/scripts/test-dco-cla-workflow.js", "/scripts/gen-third-party-notices.js", "/scripts/test-third-party-notices.js"]) {
  ok(owners.includes(p), `CODEOWNERS covers ${p}`);
}

// ---- behavior ---------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "dco-cla-"));
try {
  const binDir = join(tmp, "bin");
  mkdirSync(binDir);
  const prFile = join(tmp, "pr.json"), commitsFile = join(tmp, "commits.json"), commentsFile = join(tmp, "comments.json");
  // The stub serves each endpoint; the commits endpoint is matched before the PR.
  writeFileSync(join(binDir, "gh"), `#!/bin/sh
for a in "$@"; do
  case "$a" in
    repos/*/pulls/*/commits) cat "${commitsFile}"; exit 0;;
    repos/*/issues/*/comments) cat "${commentsFile}"; exit 0;;
    repos/*/pulls/*) cat "${prFile}"; exit 0;;
  esac
done
exit 1
`);
  chmodSync(join(binDir, "gh"), 0o755);
  const marker = join(tmp, "pwned");
  let n = 0;
  const sha = () => (++n).toString(16).padStart(40, "a");
  const commit = ({ email = "ann@example.com", login = "ann", type = "User", msg, parents = 1, signoff = email }) => ({
    sha: sha(),
    parents: Array.from({ length: parents }, () => ({ sha: sha() })),
    commit: { author: { name: "X", email }, message: msg ?? `Change\n\nSigned-off-by: X <${signoff}>` },
    author: login === null ? null : { login, type },
  });
  const run = (script, { commits = [], body = "", login = "Ann", comments = [], comment = false }) => {
    const ev = join(tmp, "event.json");
    writeFileSync(ev, JSON.stringify(comment ? { issue: { number: 7, pull_request: {}, user: { login } } } : { pull_request: { number: 7, user: { login, type: "User" } } }));
    writeFileSync(prFile, JSON.stringify({ number: 7, body, user: { login, type: "User" } }));
    writeFileSync(commitsFile, JSON.stringify(commits));
    writeFileSync(commentsFile, JSON.stringify(comments));
    const r = spawnSync("bash", [script], { cwd: tmp, encoding: "utf8", env: { ...process.env, HOME: tmp, GITHUB_EVENT_PATH: ev, GITHUB_REPOSITORY: "owner/repo", PATH: `${binDir}:${process.env.PATH}` } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  let r = run(DCO, { commits: [commit({ email: "Ann@Example.com", signoff: "ann@example.com" })] });
  ok(r.code === 0, "DCO: a commit signed off by its author (email case aside) passes");
  r = run(DCO, { commits: [commit({ msg: "Add b" })] });
  ok(r.code === 1 && /no Signed-off-by line/.test(r.out) && /git commit -s/.test(r.out), "DCO: an unsigned commit fails and says how to sign off");
  r = run(DCO, { commits: [commit({ signoff: "someone@else.example" })] });
  ok(r.code === 1 && /author's email/.test(r.out), "DCO: a sign-off with another email than the author's fails");
  r = run(DCO, { commits: [commit({}), commit({ msg: "Merge other", parents: 2 })] });
  ok(r.code === 0 && /1 commit/.test(r.out), "DCO: a merge commit is exempt and its signed parents pass");
  r = run(DCO, { commits: Array.from({ length: 250 }, () => commit({})) });
  ok(r.code === 1 && /250/.test(r.out), "DCO: a pull request with 250 commits (the API's limit) fails rather than passing unread");
  r = run(DCO, { commits: [commit({ msg: `Add e $(touch ${marker}) \`touch ${marker}\`\n\nSigned-off-by: X <ann@example.com>` })] });
  ok(r.code === 0 && !existsSync(marker), "DCO: shell syntax in a commit message is never executed");
  r = run(DCO, { commits: [commit({})], comment: true });
  ok(r.code === 0, "DCO: the comment event reads the same pull request");

  const S = sentence || "missing";
  const ann = [commit({})];
  r = run(CLA, { commits: ann, body: `Fixes a thing.\n\n${S.toUpperCase().replace(/ /g, "  \n")}` });
  ok(r.code === 0 && /description/.test(r.out), "CLA: the sentence in the description passes (case and wrapping aside)");
  r = run(CLA, { commits: ann, body: "Fixes a thing.", comments: [{ user: { login: "ann" }, body: `Sure. ${S}` }] });
  ok(r.code === 0 && /comment/.test(r.out), "CLA: the sentence in a comment by the PR author passes");
  r = run(CLA, { commits: ann, body: "Fixes a thing.", comments: [{ user: { login: "ann" }, body: `Sure. ${S}` }], comment: true });
  ok(r.code === 0, "CLA: the comment event finds the agreement in the comment");
  r = run(CLA, { commits: ann, body: "Fixes a thing.", comments: [{ user: { login: "mallory" }, body: S }] });
  ok(r.code === 1, "CLA: the sentence in someone else's comment does not count");
  r = run(CLA, { commits: ann, body: `$(touch ${marker}) \`touch ${marker}\`` });
  ok(r.code === 1 && /CLA\.md/.test(r.out) && r.out.includes(S) && !existsSync(marker), "CLA: no sentence fails, prints the sentence to add, and never executes the description");
  r = run(CLA, { commits: ann, body: "I have read the Agent402 Contributor License Agreement" });
  ok(r.code === 1, "CLA: part of the sentence does not count");
  r = run(CLA, { commits: ann, body: "I have read the Agent402 Contributor License Agreement in CLA.md and I agree to its terms." });
  ok(r.code === 1, "CLA: the sentence without the version does not count");

  const withBob = [commit({}), commit({ email: "bob@example.com", login: "Bob" })];
  r = run(CLA, { commits: withBob, body: S });
  ok(r.code === 1 && /authored by bob/.test(r.out), "CLA: another commit author who has not agreed fails, by name");
  r = run(CLA, { commits: withBob, body: S, comments: [{ user: { login: "bob" }, body: S }] });
  ok(r.code === 0, "CLA: another commit author agreeing in a comment of their own passes");
  r = run(CLA, { commits: withBob, body: `${S}\n\n@bob: ${S}` });
  ok(r.code === 1 && /authored by bob/.test(r.out), "CLA: a co-author named with the sentence in the description by the PR author does not pass");
  r = run(CLA, { commits: withBob, body: `${S}\n\n@bob ${S}` });
  ok(r.code === 1, "CLA: a co-author named without a colon in the description does not pass either");
  r = run(CLA, { commits: withBob, body: S, comments: [{ user: { login: "ann" }, body: `@bob: ${S}` }] });
  ok(r.code === 1, "CLA: the PR author cannot agree for another commit author in a comment");
  r = run(CLA, { commits: [commit({}), commit({ login: "MikeyPetrillo" }), commit({ login: "dependabot[bot]", type: "Bot" })], body: S });
  ok(r.code === 0, "CLA: the owner's and bots' commits need no agreement");
  r = run(CLA, { commits: [commit({}), commit({ login: null })], body: S });
  ok(r.code === 1 && /not linked to a GitHub account/.test(r.out), "CLA: a commit whose author has no GitHub account fails");
  r = run(CLA, { commits: [commit({}), commit({ login: null, parents: 2, msg: "Merge" })], body: S });
  ok(r.code === 0, "CLA: a merge commit with no GitHub account is exempt");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

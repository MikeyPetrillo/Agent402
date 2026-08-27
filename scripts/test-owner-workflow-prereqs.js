#!/usr/bin/env node
// Owner-only workflows must skip clearly when their declared prerequisites
// are missing (a fork / unconfigured clone), and must keep running when
// those prerequisites are present. Found 2026-08-27: a fork push to main
// went red after a green suite because deploy treated an empty RAILWAY_TOKEN
// as a hard failure, wiki treated a missing .wiki.git remote as a hard
// failure, and the live self-consistency alarm treated "issues disabled"
// as a hard failure.
//
// Policy is general: gate on the prerequisite (secret, wiki remote, issues
// board / not-a-fork), never a repository-name literal or a one-off SHA.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";

const ROOT = new URL("..", import.meta.url);
const readYaml = (rel) => load(readFileSync(new URL(rel, ROOT), "utf8"));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const deploy = readYaml(".github/workflows/deploy.yml");
const wiki = readYaml(".github/workflows/wiki.yml");
const consistency = readYaml(".github/workflows/self-consistency-alert.yml");

ok(deploy && wiki && consistency, "changed workflows parse as YAML");

const NAME_LITERAL = /MikeyPetrillo|epistemedeus/i;
const condHasNameLiteral = (s) => NAME_LITERAL.test(String(s || ""));

function jobIfs(wf) {
  return Object.values(wf.jobs || {}).map((j) => String(j?.if || ""));
}

// --- deploy: skip when the Railway token is missing; still fail-closed if the job ran without one
// Job-level `if` cannot use the secrets context (GitHub context availability:
// github/needs/vars/inputs). Presence is read in a step and exported as
// needs.deploy-prereq.outputs.ready.
const deployIf = String(deploy.jobs?.deploy?.if || "");
ok(/needs\.deploy-prereq\.outputs\.ready\s*==\s*'true'/.test(deployIf),
  "deploy job if requires deploy-prereq.ready so a missing token skips the job");
ok(/refs\/heads\/main/.test(deployIf),
  "deploy job if still fires on push to main when the token is present");
ok(/workflow_dispatch/.test(deployIf) && /markers\.outputs\.deploy/.test(deployIf),
  "deploy job if still honours dispatch + [deploy] marker when the token is present");
ok(!condHasNameLiteral(deployIf),
  "deploy job if is not keyed on a repository-name literal");
ok(!/\bsecrets\./.test(deployIf),
  "deploy job if does not read secrets (not an allowed job-if context)");

const prereq = deploy.jobs?.["deploy-prereq"];
ok(!!prereq, "deploy-prereq job exists");
ok([].concat(deploy.jobs.deploy.needs || []).includes("deploy-prereq"),
  "deploy needs deploy-prereq");
ok(/refs\/heads\/main/.test(String(prereq?.if || "")),
  "deploy-prereq still runs on push to main (owner path is reachable)");
ok(!condHasNameLiteral(prereq?.if),
  "deploy-prereq if is not keyed on a repository-name literal");
ok(!/\bsecrets\./.test(String(prereq?.if || "")),
  "deploy-prereq job if does not read secrets");
ok(String(prereq?.outputs?.ready || "").includes("steps.gate.outputs.ready"),
  "deploy-prereq ready output is the gate step's ready flag");

const gateStep = (prereq?.steps || []).find((s) => s.id === "gate") || prereq?.steps?.[0];
const gateRun = String(gateStep?.run || "");
ok(/ready=true/.test(gateRun) && /ready=false/.test(gateRun),
  "deploy-prereq exports ready=true|false from token presence");
ok(/exit 1/.test(gateRun) === false,
  "deploy-prereq never fails the job for a missing token");
ok(/add-mask/.test(gateRun),
  "deploy-prereq masks the token when present");

const checkInputs = (deploy.jobs.deploy.steps || []).find((s) => s.name === "Check inputs");
const checkRun = String(checkInputs?.run || "");
ok(/\[ -n "\$RAILWAY_API_TOKEN" \] \|\| \{ echo "No Railway token provided"; exit 1; \}/.test(checkRun),
  "Check inputs still refuses to proceed if this job ran with an empty token (missing secret is not authority)");

function runPrereqGate(token) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-prereq-"));
  const outFile = join(dir, "out");
  writeFileSync(outFile, "");
  const r = spawnSync("bash", ["-e", "-c", gateRun], {
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, RAILWAY_API_TOKEN: token, GITHUB_OUTPUT: outFile },
  });
  return { ...r, outputFile: readFileSync(outFile, "utf8") };
}

{
  const missing = runPrereqGate("");
  ok(missing.status === 0, `hostile: missing RAILWAY_TOKEN is a successful skip (exit ${missing.status})`);
  ok(/ready=false/.test(missing.outputFile), "hostile: missing RAILWAY_TOKEN exports ready=false");
  ok(/skipping owner deploy/i.test(missing.stdout + missing.stderr),
    "hostile: missing RAILWAY_TOKEN names the skip");
  ok(!/ready=true/.test(missing.outputFile),
    "hostile: missing RAILWAY_TOKEN does not export ready=true");
}

{
  const present = runPrereqGate("not-a-real-token");
  ok(present.status === 0, `hostile: present RAILWAY_TOKEN succeeds (exit ${present.status})`);
  ok(/ready=true/.test(present.outputFile), "hostile: present RAILWAY_TOKEN exports ready=true");
  ok(!/ready=false/.test(present.outputFile),
    "hostile: present RAILWAY_TOKEN does not export ready=false");
}

function deployRuns({ ready }) {
  return ready === "true";
}
ok(deployRuns({ ready: "true" }) === true, "hostile: ready=true allows the owner deploy");
ok(deployRuns({ ready: "false" }) === false, "hostile: ready=false skips deploy");
ok(deployRuns({ ready: "" }) === false, "hostile: empty ready (prereq skipped) skips deploy");

// --- wiki: forks skip the owner-only mirror; owner failures stay visible
const wikiStep = (wiki.jobs?.sync?.steps || []).find((s) => /Mirror wiki/.test(s.name || ""));
const wikiRun = String(wikiStep?.run || "");
const cloneBlock = wikiRun.split("rsync")[0] || "";
const wikiIf = String(wiki.jobs?.sync?.if || "");
ok(/github\.event\.repository\.fork\s*!=\s*true/.test(wikiIf),
  "wiki job skips forks, whose wiki repository is not copied");
ok(/git clone "https:\/\/github.com\/\$\{GITHUB_REPOSITORY\}\.wiki\.git"/.test(wikiRun),
  "wiki still clones THIS repo's wiki remote (not a hardcoded origin)");
ok(/exit 1/.test(cloneBlock) && !/exit 0/.test(cloneBlock),
  "owner wiki clone failure remains a hard failure");
ok(/::error::/.test(cloneBlock),
  "owner wiki clone failure emits an error annotation");
ok(/rsync -a --delete --exclude \.git wiki\//.test(wikiRun) && /git push/.test(wikiRun),
  "when the wiki remote exists the job still rsyncs wiki/ and pushes");
ok(!condHasNameLiteral(wiki.jobs?.sync?.if), "wiki job if is not a repository-name literal");

function shouldRunWiki({ fork }) {
  // Mirrors: fork != true. Missing event fields fail open for owner dispatches.
  return fork !== true;
}
ok(shouldRunWiki({ fork: true }) === false, "hostile: fork skips wiki sync");
ok(shouldRunWiki({ fork: false }) === true, "hostile: owner runs wiki sync");
ok(shouldRunWiki({ fork: undefined }) === true, "hostile: incomplete event payload fails open");

function fakeGitDir(cloneFails) {
  const dir = mkdtempSync(join(tmpdir(), "wiki-prereq-git-"));
  writeFileSync(join(dir, "git"), `#!/bin/bash
if [ "$1" = "clone" ]; then
  echo "fatal: could not read Username for 'https://github.com': No such device or address" >&2
  exit ${cloneFails ? 128 : 0}
fi
exit 0
`);
  chmodSync(join(dir, "git"), 0o755);
  return dir;
}

function runWikiCloneGate(cloneFails) {
  const bin = fakeGitDir(cloneFails);
  const script = wikiRun.split("rsync")[0] + "echo CLONE_REACHED_RSYNC\n";
  return spawnSync("bash", ["-e", "-c", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "example/not-a-literal" },
  });
}

const wikiFailure = runWikiCloneGate(true);
ok(wikiFailure.status !== 0, `hostile: owner wiki clone failure stays red (exit ${wikiFailure.status})`);
ok(/::error::Could not clone the wiki remote/.test(wikiFailure.stdout + wikiFailure.stderr),
  "hostile: owner wiki clone failure is named precisely");
ok(!/CLONE_REACHED_RSYNC/.test(wikiFailure.stdout),
  "hostile: failed owner wiki clone does not continue into rsync/push");

const wikiPresent = runWikiCloneGate(false);
ok(wikiPresent.status === 0, `hostile: present wiki remote continues (exit ${wikiPresent.status})`);
ok(/CLONE_REACHED_RSYNC/.test(wikiPresent.stdout),
  "hostile: present wiki remote reaches the mirror/push path");

// --- live self-consistency: skip forks / issues-disabled; fail-open if context is missing
const consIf = String(consistency.jobs?.consistency?.if || "");
ok(/github\.event\.repository\.fork\s*!=\s*true/.test(consIf),
  "self-consistency job if skips when repository.fork == true");
ok(/github\.event\.repository\.has_issues\s*!=\s*false/.test(consIf),
  "self-consistency job if skips when repository.has_issues == false");
ok(!condHasNameLiteral(consIf),
  "self-consistency job if is not keyed on a repository-name literal");

function shouldRunConsistency({ fork, has_issues }) {
  // Mirrors: fork != true && has_issues != false. Missing fields fail-open.
  return fork !== true && has_issues !== false;
}
const worlds = [
  { fork: false, has_issues: true, expect: true, name: "owner (prerequisites present)" },
  { fork: true, has_issues: false, expect: false, name: "ordinary fork, issues disabled" },
  { fork: true, has_issues: true, expect: false, name: "fork with issues enabled still skips the owner alarm" },
  { fork: false, has_issues: false, expect: false, name: "issues disabled on a non-fork" },
  { fork: undefined, has_issues: undefined, expect: true, name: "incomplete event payload fail-opens (owner schedule)" },
];
for (const w of worlds) {
  ok(shouldRunConsistency(w) === w.expect, `hostile: self-consistency ${w.name} => ${w.expect ? "run" : "skip"}`);
}

const issueStep = (consistency.jobs.consistency.steps || []).find((s) => /alert issue/.test(s.name || ""));
const issueRun = String(issueStep?.run || "");
ok(/disabled issues/.test(issueRun) && /exit 0/.test(issueRun),
  "issue step skips successfully when gh reports issues are disabled");
ok(/exit 1/.test(issueRun),
  "issue step still exits 1 on drift when issues work (owner alarm unchanged)");

function runIssueStep({ ghExit, ghErr, status }) {
  const bin = mkdtempSync(join(tmpdir(), "gh-prereq-"));
  writeFileSync(join(bin, "gh"), `#!/bin/bash
echo ${JSON.stringify(ghErr)} >&2
exit ${ghExit}
`);
  chmodSync(join(bin, "gh"), 0o755);
  const script = issueRun.replaceAll("${{ steps.check.outputs.status }}", status);
  return spawnSync("bash", ["-e", "-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "example/not-a-literal",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "1",
      DETAIL: "",
    },
  });
}

const issuesDisabled = runIssueStep({
  ghExit: 1,
  ghErr: "the 'example/not-a-literal' repository has disabled issues",
  status: "up",
});
ok(issuesDisabled.status === 0, `hostile: issues-disabled gh list skips (exit ${issuesDisabled.status})`);
ok(/skipping alert issue management/i.test(issuesDisabled.stdout + issuesDisabled.stderr),
  "hostile: issues-disabled path names the skip");

const issuesDisabledDown = runIssueStep({
  ghExit: 1,
  ghErr: "the 'example/not-a-literal' repository has disabled issues",
  status: "down",
});
ok(issuesDisabledDown.status === 0,
  "hostile: issues-disabled does not fail the job even when the live check is down");

const otherGhFail = runIssueStep({
  ghExit: 1,
  ghErr: "HTTP 502 Bad Gateway",
  status: "up",
});
ok(otherGhFail.status !== 0,
  "hostile: a real gh failure (not disabled-issues) still fails closed");

for (const [name, wf] of [["deploy.yml", deploy], ["wiki.yml", wiki], ["self-consistency-alert.yml", consistency]]) {
  ok(jobIfs(wf).every((c) => !/\bsecrets\./.test(c)),
    `${name} job-level if expressions do not use the secrets context`);
  ok(jobIfs(wf).every((c) => !condHasNameLiteral(c)),
    `${name} job-level if expressions have no owner/fork repository-name literals`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

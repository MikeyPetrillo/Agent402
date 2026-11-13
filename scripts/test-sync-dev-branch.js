// scripts/sync-dev-branch.sh moves the dev branch to main only when nothing on
// it would be lost. Offline: every case builds a throwaway bare "origin" and a
// clone in the OS temp dir and runs the real script against it.
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, copyFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = fileURLToPath(new URL("./sync-dev-branch.sh", import.meta.url));
const DEV = "dev";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

function repo() {
  const root = mkdtempSync(join(tmpdir(), "a402-devsync-"));
  const bare = join(root, "origin.git"), work = join(root, "work");
  const g = (...a) => execFileSync("git", a, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["clone", "-q", bare, work], { stdio: "ignore" });
  g("config", "user.email", "t@example.test"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  const commit = (file, text, msg) => { writeFileSync(join(work, file), text); g("add", file); g("commit", "-q", "-m", msg); return g("rev-parse", "HEAD"); };
  const rm = (file, msg) => { g("rm", "-q", file); g("commit", "-q", "-m", msg); return g("rev-parse", "HEAD"); };
  commit("a.txt", "base\n", "base");
  g("push", "-q", "origin", "main");
  g("checkout", "-q", "-b", DEV);
  const run = (env = {}) => {
    try {
      return execFileSync("bash", [SCRIPT, DEV, "origin"], { cwd: work, encoding: "utf8", env: { ...process.env, DEV_SYNC_OPEN_PRS: "0", ...env }, stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (e) { return `EXIT ${e.status}: ${e.stdout}${e.stderr}`; }
  };
  const remote = (b) => execFileSync("git", ["rev-parse", b], { cwd: bare, encoding: "utf8" }).trim();
  return { root, g, commit, rm, run, remote };
}

// 1. dev is an ancestor of main (a PR from dev merged): fast-forward, no force.
{
  const r = repo();
  r.commit("b.txt", "1\n", "dev work"); r.g("push", "-q", "origin", DEV);
  r.g("checkout", "-q", "main"); r.g("merge", "-q", "--no-ff", "-m", "merge", DEV); r.g("push", "-q", "origin", "main");
  const out = r.run();
  ok(/fast-forwarded/.test(out) && r.remote(DEV) === r.remote("main"), `dev behind main only: fast-forwarded (${out})`);
  rmSync(r.root, { recursive: true, force: true });
}

// 2. dev's commit reached main as a cherry-pick (another branch shipped it): moved.
{
  const r = repo();
  const c = r.commit("b.txt", "1\n", "dev work"); r.g("push", "-q", "origin", DEV);
  r.g("checkout", "-q", "main"); r.commit("m.txt", "main\n", "main moves on"); r.g("cherry-pick", c); r.g("push", "-q", "origin", "main");
  const out = r.run();
  ok(/moved from/.test(out) && r.remote(DEV) === r.remote("main"), `every dev commit patch-equivalent on main: moved (${out})`);
  rmSync(r.root, { recursive: true, force: true });
}

// 3. the 2026-10-04 shape: a file added, edited, then removed on dev (no copy
//    on main, net zero) beside a cherry-picked commit: moved.
{
  const r = repo();
  r.commit("skill.md", "v1\n", "add skill"); r.commit("skill.md", "v2\n", "edit skill"); r.rm("skill.md", "remove skill");
  const c = r.commit("b.txt", "1\n", "real work"); r.g("push", "-q", "origin", DEV);
  r.g("checkout", "-q", "main"); r.g("cherry-pick", c); r.g("push", "-q", "origin", "main");
  const out = r.run();
  ok(/moved from/.test(out) && r.remote(DEV) === r.remote("main"), `add-then-remove work has no net change: moved (${out})`);
  rmSync(r.root, { recursive: true, force: true });
}

// 4. dev carries work main lacks: left exactly where it was.
{
  const r = repo();
  r.commit("b.txt", "unique\n", "unshipped work"); r.g("push", "-q", "origin", DEV);
  r.g("checkout", "-q", "main"); r.commit("m.txt", "main\n", "main moves on"); r.g("push", "-q", "origin", "main");
  const before = r.remote(DEV);
  const out = r.run();
  ok(/left as is/.test(out) && /b\.txt/.test(out) && r.remote(DEV) === before, `unique work on dev: left, and the file is named (${out})`);
  rmSync(r.root, { recursive: true, force: true });
}

// 5. an open PR from dev: left, whatever its content.
{
  const r = repo();
  const c = r.commit("b.txt", "1\n", "dev work"); r.g("push", "-q", "origin", DEV);
  r.g("checkout", "-q", "main"); r.commit("m.txt", "main\n", "main moves on"); r.g("cherry-pick", c); r.g("push", "-q", "origin", "main");
  const before = r.remote(DEV);
  const out = r.run({ DEV_SYNC_OPEN_PRS: "1" });
  ok(/open PR/.test(out) && r.remote(DEV) === before, `open PR from dev: left (${out})`);
  const out2 = r.run({ DEV_SYNC_OPEN_PRS: "unknown" });
  ok(/open PR/.test(out2) && r.remote(DEV) === before, `an unreadable PR check counts as open: left (${out2})`);
  rmSync(r.root, { recursive: true, force: true });
}

// 6. a merge on dev that adds content of its own (an evil merge): every plain
//    commit reached main, so only the merge check can keep this branch. Left.
{
  const r = repo();
  const c = r.commit("b.txt", "1\n", "dev work"); r.g("push", "-q", "origin", DEV);
  r.g("checkout", "-q", "main"); r.commit("m.txt", "main\n", "main moves on"); r.g("push", "-q", "origin", "main");
  r.g("checkout", "-q", DEV); r.g("merge", "-q", "--no-commit", "main");
  writeFileSync(join(r.root, "work", "c.txt"), "written inside the merge\n");
  r.g("add", "c.txt"); r.g("commit", "-q", "-m", "merge main into dev"); r.g("push", "-q", "origin", DEV);
  r.g("checkout", "-q", "main"); r.g("cherry-pick", c); r.g("push", "-q", "origin", "main");
  const before = r.remote(DEV);
  const out = r.run();
  ok(/content of its own/.test(out) && r.remote(DEV) === before, `a merge carrying content of its own: left (${out})`);
  rmSync(r.root, { recursive: true, force: true });
}

// 7. dry run reports the move and pushes nothing.
{
  const r = repo();
  const c = r.commit("b.txt", "1\n", "dev work"); r.g("push", "-q", "origin", DEV);
  r.g("checkout", "-q", "main"); r.commit("m.txt", "main\n", "main moves on"); r.g("cherry-pick", c); r.g("push", "-q", "origin", "main");
  const before = r.remote(DEV);
  const out = r.run({ DEV_SYNC_DRY_RUN: "1" });
  ok(/dry run/.test(out) && r.remote(DEV) === before, `dry run: decision printed, nothing pushed (${out})`);
  rmSync(r.root, { recursive: true, force: true });
}

// 8. the 2026-10-04 shape exactly. An old dev commit O reached main as a copy,
//    and main was merged back into dev, so O's copy is shared history and git
//    cherry calls O unique. A newer dev commit N, touching the SAME file, then
//    reached main through a side branch. The fallback sees O's file changed
//    since the merge base (by N) and refuses; only the merge-tree check sees
//    that merging dev would change nothing. Moved.
{
  const r = repo();
  const o = r.commit("f.txt", "old\n", "old dev work"); r.g("push", "-q", "origin", DEV);
  r.g("checkout", "-q", "main"); r.commit("m0.txt", "first\n", "main moves first"); r.g("cherry-pick", o); r.g("push", "-q", "origin", "main");
  r.g("checkout", "-q", DEV); r.g("merge", "-q", "--no-edit", "main");
  const n = r.commit("f.txt", "new\n", "new dev work on the same file"); r.g("push", "-q", "origin", DEV);
  r.g("checkout", "-q", "main"); r.commit("m1.txt", "second\n", "main moves again");
  r.g("checkout", "-q", "-b", "side"); r.g("cherry-pick", n);
  r.g("checkout", "-q", "main"); r.g("merge", "-q", "--no-ff", "-m", "merge side", "side"); r.g("push", "-q", "origin", "main");
  const cherryPlus = r.g("cherry", "origin/main", `origin/${DEV}`).split("\n").filter((l) => l.startsWith("+")).length;
  const out = r.run();
  ok(cherryPlus > 0, `control: git cherry calls the old dev commit unique (${cherryPlus})`);
  ok(/change nothing/.test(out) && r.remote(DEV) === r.remote("main"), `merging dev would change nothing: moved (${out})`);
  rmSync(r.root, { recursive: true, force: true });
}

// merge-on-green.sh syncs the dev branch only when it ends (an EXIT trap set after the
// merge), never before main's run is watched: the sync push starts a full dev test run
// that would take the runner slots main's deploy job needs.
{
  const mog = readFileSync(fileURLToPath(new URL("./merge-on-green.sh", import.meta.url)), "utf8")
    .split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const merge = mog.indexOf("gh pr merge"), trapAt = mog.search(/trap '[^']*sync-dev-branch\.sh[^']*' EXIT/), watch = mog.indexOf("gh run watch \"$MAIN\"");
  const direct = mog.split("\n").filter((l) => /sync-dev-branch\.sh/.test(l) && !/^\s*trap /.test(l));
  ok(merge > -1 && trapAt > merge && watch > trapAt && direct.length === 0, "merge-on-green runs the dev sync from an EXIT trap set after the merge, with no direct call before main's run is watched");
}

// merge-on-green.sh waits, after CI is green, for Strix's review of the PR
// head SHA. Run end to end against stubbed gh, curl and sleep (no network, no
// GitHub): the script is copied into a temp dir whose scripts/ holds only a
// stub dev sync, so nothing else it reads exists there.
{
  const SHA = "a".repeat(40), OLD = "b".repeat(40), MERGE = "c".repeat(40), PR = "77", BOT = "strix-security[bot]";
  const GH = `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), D = process.env.STUB_DIR, a = process.argv.slice(2), j = a.join(" ");
const out = (s) => { process.stdout.write(String(s) + "\\n"); process.exit(0); };
const file = (n) => { const p = path.join(D, n); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "[]"; };
if (a[0] === "pr" && a[1] === "view") {
  if (j.includes("headRefOid")) out(process.env.STUB_SHA);
  if (j.includes("isCrossRepository")) out("false");
  if (j.includes("headRefName")) out("dev");
  if (j.includes("statusCheckRollup")) out("CodeQL=SUCCESS");
  if (j.includes("mergeCommit")) out(fs.existsSync(path.join(D, "merged")) ? process.env.STUB_MERGE : "");
}
if (a[0] === "pr" && a[1] === "ready") out("");
if (a[0] === "pr" && a[1] === "merge") { fs.writeFileSync(path.join(D, "merged"), j); out("merged"); }
if (a[0] === "run" && a[1] === "list") out(j.includes("--branch main") ? "222" : "111");
if (a[0] === "run" && a[1] === "watch") process.exit(0);
if (a[0] === "run" && a[1] === "view") out("test-unit=success");
if (a[0] === "api" && a[1].endsWith("/rules/branches/main")) out("CodeQL");
if (a[0] === "api" && /\\/pulls\\/\\d+\\/reviews$/.test(a[1])) {
  const n = Number(file("polls") === "[]" ? 0 : file("polls")) + 1; fs.writeFileSync(path.join(D, "polls"), String(n));
  // A failed read: gh may have printed a first page before it failed.
  if (fs.existsSync(path.join(D, "reviews." + n + ".fail")) || fs.existsSync(path.join(D, "reviews.fail"))) { process.stdout.write("[]\\n"); process.exit(1); }
  const seq = path.join(D, "reviews." + n + ".json"); out(fs.existsSync(seq) ? fs.readFileSync(seq, "utf8") : file("reviews.json"));
}
if (a[0] === "api" && /\\/pulls\\/\\d+\\/comments$/.test(a[1])) out(file("review-comments.json"));
if (a[0] === "api" && /\\/issues\\/\\d+\\/comments$/.test(a[1])) {
  const n = file("polls") === "[]" ? 0 : Number(file("polls")); const seq = path.join(D, "issue-comments." + n + ".json");
  out(fs.existsSync(seq) ? fs.readFileSync(seq, "utf8") : file("issue-comments.json"));
}
if (a[0] === "api" && /\\/commits\\/[0-9a-f]{40}$/.test(a[1])) out(process.env.STUB_HEAD_DATE || "2026-11-12T10:00:00Z");
process.stderr.write("stub gh: unexpected " + j + "\\n"); process.exit(2);
`;
  const CURL = `#!/bin/sh
case "$*" in *gateway-status*) echo '{"ledgerDeadLetter":{"status":"ok"}}' ;; *health*) echo '{"build":"${MERGE.slice(0, 7)}"}' ;; esac
`;
  const SLEEP = `#!/bin/sh
echo x >> "$STUB_DIR/sleeps"
`;
  const review = (id, state, commit, body = "Strix flagged findings below.") => ({ id, state, commit_id: commit, body, user: { login: BOT } });
  const comment = (rid, body) => ({ pull_request_review_id: rid, body, user: { login: BOT } });
  const issue = (body, created_at = "2026-11-12T11:00:00Z") => ({ body, created_at, user: { login: BOT } });
  const summary = (sha, lines) => `<!-- strix-pr-review:master -->\n## Strix Security Review\n\n${lines}\n\n<sub>Review 2 on this PR · \`${sha.slice(0, 7)}\` · requested</sub>`;
  const mog = (files, args = [], env = {}) => {
    const root = mkdtempSync(join(tmpdir(), "a402-mog-")), bin = join(root, "bin"), stubs = join(root, "stub"), cwd = join(root, "repo");
    for (const d of [bin, stubs, join(cwd, "scripts")]) mkdirSync(d, { recursive: true });
    copyFileSync(fileURLToPath(new URL("./merge-on-green.sh", import.meta.url)), join(cwd, "scripts", "merge-on-green.sh"));
    writeFileSync(join(cwd, "scripts", "sync-dev-branch.sh"), "echo dev-sync-stub\n");
    for (const [n, body] of [["gh", GH], ["curl", CURL], ["sleep", SLEEP]]) { writeFileSync(join(bin, n), body); chmodSync(join(bin, n), 0o755); }
    for (const [n, v] of Object.entries(files)) writeFileSync(join(stubs, n), typeof v === "string" ? v : JSON.stringify(v));
    let out, code = 0;
    try {
      out = execFileSync("bash", ["scripts/merge-on-green.sh", PR, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_DIR: stubs, STUB_SHA: SHA, STUB_MERGE: MERGE, GATE_WORKFLOW: "Deploy", STRIX_WAIT_SECONDS: "180", STRIX_POLL_SECONDS: "60", TARGET_URL: "http://stub.invalid", ...env } });
    } catch (e) { code = e.status; out = `${e.stdout}${e.stderr}`; }
    const merged = existsSync(join(stubs, "merged")), sleeps = existsSync(join(stubs, "sleeps")) ? readFileSync(join(stubs, "sleeps"), "utf8").trim().split("\n").length : 0;
    rmSync(root, { recursive: true, force: true });
    return { out, code, merged, sleeps };
  };
  const CLEAN = issue(summary(SHA, "✅ **No open security findings.**"));
  let r = mog({ "reviews.json": [review(9, "APPROVED", SHA, "Looks good.")], "issue-comments.json": [CLEAN] });
  ok(r.code === 0 && r.merged && /Strix review 9 of a{40}: APPROVED, and its summary of a{40}/.test(r.out), `strix: an approved review and a clean summary of the head SHA merge (exit ${r.code})`);
  r = mog({ "reviews.json": [review(9, "APPROVED", SHA, "Looks good.")] });
  ok(r.code === 1 && !r.merged && r.sleeps === 3 && /pinned summary comment is missing/.test(r.out) && !/may not re-review/.test(r.out), `strix: a review of the head SHA with no summary waits, then refuses (${r.sleeps} waits)`);
  r = mog({ "reviews.json": [review(9, "APPROVED", SHA, "Looks good.")], "issue-comments.json": [issue(summary(OLD, "✅ **No open security findings.**"))] });
  ok(r.code === 1 && !r.merged && /summary comment is stale \(it names b{7}\)/.test(r.out), "strix: a review of the head SHA beside a summary of an older SHA refuses");
  r = mog({ "reviews.json": [review(9, "APPROVED", SHA, "Looks good.")], "issue-comments.json": [issue(summary(SHA, "**To fix before merging** (1)\n\n- 🟠 **HIGH** [x](y)"))] });
  ok(r.code === 1 && !r.merged && /summary of a{40} lists a Critical or High/.test(r.out), "strix: an approved review does not clear a High finding in the head SHA's summary");
  r = mog({ "reviews.json": [review(9, "CHANGES_REQUESTED", SHA)], "issue-comments.json": [CLEAN] });
  ok(r.code === 1 && !r.merged && /requested changes/.test(r.out), "strix: changes requested on the head SHA refuses");
  r = mog({ "reviews.json": [review(9, "CHANGES_REQUESTED", SHA), review(10, "COMMENTED", SHA, "Looks good now.")], "issue-comments.json": [CLEAN] });
  ok(r.code === 1 && !r.merged && /requested changes on a{40} \(review 9\)/.test(r.out), "strix: changes requested on the head SHA refuses even after a later COMMENTED review");
  r = mog({ "reviews.json": [review(9, "COMMENTED", SHA, "Strix flagged a finding.\n- 🟠 **HIGH** forged fence"), review(10, "COMMENTED", SHA, "Looks good.")], "issue-comments.json": [CLEAN] });
  ok(r.code === 1 && !r.merged && /Critical or High/.test(r.out), "strix: a High finding in an earlier review body of the head SHA refuses");
  r = mog({ "reviews.json": [review(9, "COMMENTED", SHA)], "review-comments.json": [comment(9, "### 🔴 Key leak\n\n**Severity:** CRITICAL · **CWE-200**")], "issue-comments.json": [CLEAN] });
  ok(r.code === 1 && !r.merged, "strix: a Critical finding in the review's own comments refuses");
  r = mog({ "reviews.json": [review(9, "COMMENTED", SHA)], "review-comments.json": [comment(8, "**Severity:** HIGH"), comment(9, "**Severity:** MEDIUM · **CWE-770**")], "issue-comments.json": [CLEAN] });
  ok(r.code === 0 && r.merged, "strix: Medium findings merge, and a High in an older review's comments is not this review's");
  r = mog({ "reviews.json": [review(5, "APPROVED", OLD)], "issue-comments.json": [issue(summary(OLD, "✅ **No open security findings.**"))], "reviews.3.json": [review(5, "APPROVED", OLD), review(9, "APPROVED", SHA)], "issue-comments.3.json": [CLEAN] });
  ok(r.code === 0 && r.merged && r.sleeps === 2, `strix: a review of an older SHA keeps it waiting until the head's arrives (${r.sleeps} waits)`);
  r = mog({ "reviews.json": [review(5, "APPROVED", OLD)], "issue-comments.json": [issue(summary(OLD, "✅ **No open security findings.**"))] });
  ok(r.code === 1 && !r.merged && r.sleeps === 3 && /owner decides/i.test(r.out) && /--no-strix/.test(r.out) && /may not re-review commits pushed after the PR was opened/.test(r.out) && /re-request/.test(r.out), `strix: no review of the head SHA in time refuses, says Strix may not re-review a later push, and names re-request and --no-strix (${r.sleeps} waits)`);
  r = mog({ "issue-comments.json": [CLEAN] });
  ok(r.code === 0 && r.merged && /Strix summary of a{40}/.test(r.out), "strix: a clean summary pinned to the head SHA (no review posted) merges");
  r = mog({ "issue-comments.json": [issue(summary(SHA, "**To fix before merging** (1)\n\n- 🟠 **HIGH** [x](y)"))] });
  ok(r.code === 1 && !r.merged, "strix: a summary of the head SHA listing a High finding refuses");
  r = mog({ "issue-comments.json": [issue("<!-- strix:pr-review-billing-required -->\nStrix could not run.")] });
  ok(r.code === 1 && !r.merged && r.sleeps === 0 && /could not review/.test(r.out), "strix: Strix saying it could not run (after the head commit) stops at once for the owner");
  r = mog({ "issue-comments.json": [issue("<!-- strix:pr-review-billing-required -->\nStrix could not run.", "2026-11-12T09:00:00Z")] });
  ok(r.code === 1 && !r.merged && r.sleeps === 3 && !/could not review/.test(r.out), `strix: a billing-required comment from before the head commit does not count; the wait runs its course (${r.sleeps} waits)`);
  r = mog({ "issue-comments.json": [issue("<!-- strix:pr-review-billing-required -->\nStrix could not run.", "2026-11-12T09:00:00Z")], "issue-comments.2.json": [issue("<!-- strix:pr-review-billing-required -->\nStrix could not run.", "2026-11-12T09:00:00Z"), issue("<!-- strix:pr-review-billing-required -->\nStill no.", "2026-11-12T10:30:00Z")] });
  ok(r.code === 1 && !r.merged && r.sleeps === 1 && /could not review/.test(r.out), `strix: a billing-required comment posted after the head commit stops the wait (${r.sleeps} waits)`);
  r = mog({ "reviews.1.fail": "", "issue-comments.json": [CLEAN] });
  ok(r.code === 0 && r.merged && r.sleeps === 1 && /Strix summary of a{40}/.test(r.out), `strix: one failed reviews read keeps waiting, and the next good read merges (exit ${r.code}, ${r.sleeps} waits)`);
  r = mog({ "reviews.fail": "", "issue-comments.json": [CLEAN] });
  ok(r.code === 1 && !r.merged && r.sleeps === 3 && /read of Strix's reviews on PR 77 failed or could not be parsed/.test(r.out) && !/may not re-review/.test(r.out), `strix: reviews that never read refuse at the deadline and name the read failure (${r.sleeps} waits)`);
  r = mog({ "reviews.1.json": [review(9, "COMMENTED", SHA, "Looks good.")], "reviews.2.json": [review(9, "COMMENTED", SHA, "Looks good."), review(10, "CHANGES_REQUESTED", SHA)], "issue-comments.json": [CLEAN] });
  ok(r.code === 1 && !r.merged && /requested changes on a{40} \(review 10\)/.test(r.out), "strix: changes requested between the reviews read and the summary read refuses");
  r = mog({ "reviews.2.json": [review(10, "COMMENTED", SHA, "- 🟠 **HIGH** late finding")], "issue-comments.json": [CLEAN] });
  ok(r.code === 1 && !r.merged && /Critical or High finding on a{40} \(review 10\)/.test(r.out), "strix: a High review that lands between the reads refuses");
  r = mog({}, ["--no-strix"]);
  ok(r.code === 0 && r.merged && /--no-strix: the OWNER chose to merge PR #77 WITHOUT/.test(r.out) && !/waiting for Strix/.test(r.out), "strix: --no-strix merges, and says so loudly");
  r = mog({}, ["dev", "--no-strix"]);
  ok(r.code === 0 && r.merged, "strix: --no-strix also works after the branch argument");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

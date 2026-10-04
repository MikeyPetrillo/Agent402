// scripts/sync-dev-branch.sh moves the dev branch to main only when nothing on
// it would be lost. Offline: every case builds a throwaway bare "origin" and a
// clone in the OS temp dir and runs the real script against it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("./sync-dev-branch.sh", import.meta.url).pathname;
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// The GitHub release for package.json's version (scripts/github-release.js,
// run by deploy.yml's github-release job after a deploy from main):
//   - the changelog parsing, the notes and the plan, offline;
//   - the script end to end against a stub gh: tag and release present does
//     nothing, a tag with no release is released on that tag, no tag is tagged
//     at the deployed commit, an unreadable state stops the run;
//   - the tree: CHANGELOG.md's top version is package.json's (so the job has
//     notes to publish), version headings are unique and descending;
//   - the job: after a successful deploy, on a push to main only, contents:
//     write in that job alone, a pinned checkout that keeps no credentials, no
//     package install.
//
//   node scripts/test-github-release.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changelogSection, topChangelogVersion, releaseNotes, plan, NOTES_MAX } from "./github-release.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- parsing and plan ---
const SAMPLE = [
  "# Changelog", "", "## Unreleased", "", "## v2.14.0 - 2026-11-23", "", "### 2026-11-23 (a)", "Tools:", "- one",
  "", "## v2.13.0 - 2026-11-22", "### 2026-11-22 (b)", "- two", "", "## v2.1.0 - 2026-08-17", "- old", "",
].join("\n");
ok(topChangelogVersion(SAMPLE) === "2.14.0", "top version skips Unreleased and reads the first version heading");
const s = changelogSection(SAMPLE, "2.14.0");
ok(s && s.heading === "v2.14.0 - 2026-11-23", "section heading is the heading text");
ok(s && s.body.includes("- one") && !s.body.includes("- two"), "section body stops at the next version heading");
ok(changelogSection(SAMPLE, "2.1.0")?.body === "- old", "last section runs to the end");
ok(changelogSection(SAMPLE, "2.1") === null, "a prefix of a version is not that version");
ok(changelogSection(SAMPLE, "2.9.9") === null, "absent version has no section");
ok(plan({ tagExists: true, releaseExists: true }) === "none", "tag and release present: nothing");
ok(plan({ tagExists: true, releaseExists: false }) === "release-existing-tag", "tag without release: release that tag");
ok(plan({ tagExists: false, releaseExists: false }) === "tag-and-release", "no tag: tag and release");
const notes = releaseNotes(s, "o/r");
ok(notes.startsWith("### 2026-11-23 (a)") && notes.includes("https://github.com/o/r/blob/main/CHANGELOG.md"), "notes carry the section and the changelog link");
const big = releaseNotes({ heading: "x", body: `### a\n${"x".repeat(NOTES_MAX)}\n### b\n- y` }, "o/r");
ok(big.length < 125_000 && big.includes("The rest of this version's entries are in the changelog."), "notes over the limit are cut at a group with a pointer");

// --- end to end against a stub gh ---
const dir = mkdtempSync(join(tmpdir(), "gh-release-test-"));
const log = join(dir, "calls.jsonl");
const stub = join(dir, "gh");
writeFileSync(join(dir, "stub.mjs"), `
import { appendFileSync } from "node:fs";
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
const st = process.env.STUB_STATE;
if (a[0] === "api") {
  if (st === "broken") { console.error("HTTP 502"); process.exit(1); }
  if (st === "none") { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
  console.log("{}"); process.exit(0);
}
if (a[0] === "release" && a[1] === "view") {
  if (st === "both") { console.log("{}"); process.exit(0); }
  console.error("release not found"); process.exit(1);
}
if (a[0] === "release" && a[1] === "create") process.exit(0);
process.exit(2);
`);
writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "stub.mjs")}" "$@"\n`);
chmodSync(stub, 0o755);
const SHA = "a".repeat(40);
function run(state, extra = {}) {
  writeFileSync(log, "");
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/github-release.js")], {
    encoding: "utf8",
    env: { ...process.env, GH_CMD: stub, STUB_STATE: state, GH_REPO: "o/r", TARGET_SHA: SHA, ...extra },
  });
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls, create: calls.find((c) => c[1] === "create") };
}
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
let r = run("both");
ok(r.code === 0 && !r.create, "tag and release present: exits 0, creates nothing");
r = run("tag");
ok(r.code === 0 && r.create && r.create.includes("--verify-tag") && !r.create.includes("--target"), "tag without release: released on the existing tag");
ok(r.create && r.create[2] === `v${version}` && r.create.includes("--notes-file"), "release is named for package.json's version, notes from a file");
r = run("none");
ok(r.code === 0 && r.create && r.create[r.create.indexOf("--target") + 1] === SHA, "no tag: tagged at the deployed commit");
r = run("none", { TARGET_SHA: "main; rm -rf /" });
ok(r.code !== 0 && !r.create, "no tag and a target that is not a commit id: refused");
r = run("broken");
ok(r.code !== 0 && !r.create, "an unreadable tag state stops the run before any write");
r = run("none", { GH_REPO: "o/r --x" });
ok(r.code !== 0 && !r.create, "a repo that is not owner/repo is refused");
r = spawnSync(process.execPath, [join(ROOT, "scripts/github-release.js"), "--plan"], { encoding: "utf8", env: { ...process.env, GH_CMD: stub, STUB_STATE: "none", GH_REPO: "o/r", TARGET_SHA: SHA } });
ok(r.status === 0 && !readFileSync(log, "utf8").includes("create"), "--plan writes nothing");

// --- the tree ---
const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
ok(topChangelogVersion(changelog) === version, `CHANGELOG.md's top version is package.json's (${version}), so the release job has notes`);
ok(changelogSection(changelog, version)?.body.length > 0, "the current version's section has entries");
const heads = [...changelog.matchAll(/^## v(\d+)\.(\d+)\.(\d+)\b/gm)].map((m) => m.slice(1).map(Number));
const key = (v) => v[0] * 1e6 + v[1] * 1e3 + v[2];
ok(new Set(heads.map(key)).size === heads.length, "no version heading appears twice");
ok(heads.every((v, i) => i === 0 || key(heads[i - 1]) > key(v)), "version headings run newest first");
ok(/^## v2\.8\.2 - /m.test(changelog), "v2.8.2 (tagged) has its own heading");
// Every tag the repo already carries has a heading, when tags are in this clone.
const tags = spawnSync("git", ["tag", "-l", "v*"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n").filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
const missing = tags.filter((t) => !new RegExp(`^## ${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "m").test(changelog));
ok(missing.length === 0, `every version tag in this clone has a changelog heading (${tags.length} read${missing.length ? `; missing ${missing.join(", ")}` : ""})`);

// --- the job ---
const raw = readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8");
const m = /\n  github-release:\n([\s\S]*?)(?=\n  [a-z][\w-]*:\n|$)/.exec(raw);
ok(!!m, "deploy.yml has a github-release job");
const job = m ? m[1] : "";
ok(/needs: \[deploy\]/.test(job) && /needs\.deploy\.result == 'success'/.test(job), "runs only after a successful deploy");
ok(/github\.ref == 'refs\/heads\/main'/.test(job) && /github\.event_name == 'push'/.test(job), "runs only on a push to main");
ok(/permissions:\n\s+contents: write\n/.test(job) && !/(issues|pull-requests|actions|packages|id-token): write/.test(job), "contents: write and nothing else");
ok(/timeout-minutes: \d+/.test(job), "the job has a timeout");
ok(/actions\/checkout@[0-9a-f]{40}/.test(job) && /persist-credentials: false/.test(job), "checkout pinned by sha, keeps no credentials");
ok(!/npm (ci|install)|setup-node/.test(job), "installs no packages");
ok(/run: node scripts\/github-release\.js\s*$/m.test(job) && /GH_TOKEN: \$\{\{ github\.token \}\}/.test(job), "runs the script with the job's own token");
const top = /^permissions:\n([\s\S]*?)\n\S/m.exec(raw);
ok(top && !/contents: write/.test(top[1]), "the workflow's default permissions do not grant contents: write");
ok(existsSync(join(ROOT, "scripts/github-release.js")) && !/from "(?!node:)[^"]+"/.test(readFileSync(join(ROOT, "scripts/github-release.js"), "utf8")), "the script imports node: modules only");

console.log(`\ntest-github-release: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

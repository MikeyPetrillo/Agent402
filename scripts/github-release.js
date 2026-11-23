// Create the GitHub release for package.json's version, from its CHANGELOG.md
// section, when no release of that version exists. Run by the github-release
// job of deploy.yml after a deploy from main succeeds; GH_TOKEN carries
// contents: write for that job only.
//
//   tag and release exist    -> nothing to do
//   tag exists, no release   -> release on the existing tag (--verify-tag)
//   no tag                   -> tag TARGET_SHA and release it
//   no changelog section     -> fail (the version has nothing to say)
//
// Imports nothing outside node: the job installs no packages. The gh CLI is
// called with an argument list, never through a shell.
//
//   GH_REPO=owner/repo TARGET_SHA=<sha> node scripts/github-release.js
//   node scripts/github-release.js --plan   (prints the plan, writes nothing)
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
// GitHub refuses a release body over 125,000 characters.
export const NOTES_MAX = 120_000;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The "## vX.Y.Z - date" heading's text and the lines up to the next "## v".
export function changelogSection(text, version) {
  const lines = String(text).split("\n");
  const head = new RegExp(`^## v${esc(version)}(\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## v\d/.test(l));
  if (end < 0) end = lines.length;
  return { heading: lines[start].slice(3).trim(), body: lines.slice(start + 1, end).join("\n").trim() };
}

// The top "## vX.Y.Z" heading's version.
export function topChangelogVersion(text) {
  const m = /^## v(\d+\.\d+\.\d+)\b/m.exec(String(text));
  return m ? m[1] : null;
}

export function releaseNotes(section, repo) {
  const link = `Full entries: [CHANGELOG.md](https://github.com/${repo}/blob/main/CHANGELOG.md) and [agent402.tools/changelog](https://agent402.tools/changelog).`;
  let body = section.body;
  if (body.length > NOTES_MAX) {
    const cut = body.lastIndexOf("\n### ", NOTES_MAX);
    body = `${body.slice(0, cut > 0 ? cut : NOTES_MAX).trimEnd()}\n\nThe rest of this version's entries are in the changelog.`;
  }
  return `${body}\n\n${link}\n`;
}

export function plan({ tagExists, releaseExists }) {
  if (releaseExists) return "none";
  return tagExists ? "release-existing-tag" : "tag-and-release";
}

function gh(args) {
  const r = spawnSync(process.env.GH_CMD || "gh", args, { encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}

// 0 = present, 1 = absent; anything else stops the run (never create on an unreadable state).
function exists(args) {
  const r = gh(args);
  if (r.code === 0) return true;
  if (/HTTP 404|not found|release not found/i.test(r.out)) return false;
  throw new Error(`gh ${args[0]} could not be read (exit ${r.code})`);
}

async function main() {
  const repo = process.env.GH_REPO;
  const sha = process.env.TARGET_SHA;
  const dry = process.argv.includes("--plan");
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const section = changelogSection(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), version);
  if (!section) { console.error(`CHANGELOG.md has no "## v${version}" section: no release notes to publish.`); process.exit(1); }
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) { console.error("GH_REPO is not owner/repo."); process.exit(1); }
  const tag = `v${version}`;
  const tagExists = exists(["api", `repos/${repo}/git/ref/tags/${tag}`]);
  const releaseExists = exists(["release", "view", tag, "--repo", repo, "--json", "tagName"]);
  const step = plan({ tagExists, releaseExists });
  console.log(`${tag}: tag ${tagExists ? "present" : "absent"}, release ${releaseExists ? "present" : "absent"} -> ${step}`);
  if (step === "none" || dry) return;
  if (step === "tag-and-release" && !/^[0-9a-f]{40}$/.test(sha || "")) { console.error("TARGET_SHA is not a commit id."); process.exit(1); }
  const file = join(mkdtempSync(join(tmpdir(), "release-")), "notes.md");
  writeFileSync(file, releaseNotes(section, repo));
  const args = ["release", "create", tag, "--repo", repo, "--title", section.heading, "--notes-file", file];
  if (step === "tag-and-release") args.push("--target", sha); else args.push("--verify-tag");
  const r = gh(args);
  if (r.code !== 0) { console.error(`gh release create failed (exit ${r.code}): ${r.out.slice(0, 500)}`); process.exit(1); }
  console.log(`Released ${tag}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

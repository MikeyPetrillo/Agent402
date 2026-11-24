#!/usr/bin/env node
// Prints, one per line, the commit subjects the markers job of deploy.yml reads
// for one revision range: every commit in it except the ones an outside
// contributor wrote.
//
// A marker in a subject starts a job that spends or publishes ([publish],
// [drain], [paytest], [probe], [purl], the bazaar passes). An outside pull
// request's commits reach main inside its merge, and their subjects are the
// contributor's own text, so reading every subject in a merged range let an
// outside commit start one of those jobs. Left out:
//   - every commit a merge commit brings in from another account's fork: a
//     merge whose subject is GitHub's "Merge pull request #N from <owner>/..."
//     with an owner other than this repository's (GITHUB_REPOSITORY), the
//     merge itself and every commit reachable from its second parent and not
//     from its first;
//   - a commit on the range's first-parent line that is not a merge and whose
//     subject ends "(#N)": GitHub's squash merge, whose subject is the pull
//     request's title.
// A pull request from a branch of this repository is merged with a merge
// commit (scripts/merge-on-green.sh), and its commits are read as before.
// Each left-out commit is named on stderr. Exits non-zero when git cannot read
// the range (the caller then falls back as it did before).
//
//   node scripts/marker-subjects.js <rev-range>
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MERGE_FROM = /^Merge pull request #\d+ from ([A-Za-z0-9-]+)\//;
const SQUASH = /\(#\d+\)\s*$/;

/** The owner a "Merge pull request #N from <owner>/<branch>" subject names, or null. */
export function mergedFrom(subject) {
  const m = MERGE_FROM.exec(String(subject || ""));
  return m ? m[1] : null;
}

/**
 * Pure part: given the range's commits ({ sha, parents, subject }, newest
 * first), the first-parent line's shas and a reader of a merge's brought-in
 * commits, the subjects to read and the commits left out.
 */
export function selectSubjects({ commits, firstParent, broughtIn, owner }) {
  const own = String(owner || "").toLowerCase();
  const left = new Map(); // sha -> why
  for (const c of commits) {
    const from = mergedFrom(c.subject);
    if (c.parents.length >= 2 && from && from.toLowerCase() !== own) {
      left.set(c.sha, `merge of ${from}'s pull request`);
      for (const sha of broughtIn(c)) if (!left.has(sha)) left.set(sha, `brought in by ${from}'s pull request`);
    }
  }
  const fp = new Set(firstParent);
  for (const c of commits) {
    if (c.parents.length < 2 && fp.has(c.sha) && SQUASH.test(c.subject) && !left.has(c.sha)) left.set(c.sha, "squash-merged pull request title");
  }
  return { subjects: commits.filter((c) => !left.has(c.sha)).map((c) => c.subject), left };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  const range = process.argv[2];
  if (!range || range.startsWith("-")) { console.error("usage: marker-subjects.js <rev-range>"); process.exit(2); }
  const owner = String(process.env.GITHUB_REPOSITORY || "").split("/")[0];
  const commits = git(["log", "--format=%H%x00%P%x00%s", range, "--"]).split("\n").filter(Boolean).map((l) => {
    const [sha, parents, subject] = l.split("\0");
    return { sha, parents: parents ? parents.split(" ").filter(Boolean) : [], subject: subject ?? "" };
  });
  const firstParent = git(["rev-list", "--first-parent", range, "--"]).split("\n").filter(Boolean);
  const broughtIn = (c) => git(["rev-list", `${c.parents[1]}`, `^${c.parents[0]}`, "--"]).split("\n").filter(Boolean);
  const { subjects, left } = selectSubjects({ commits, firstParent, broughtIn, owner });
  for (const [sha, why] of left) console.error(`not read for markers: ${sha.slice(0, 12)} (${why})`);
  if (subjects.length) process.stdout.write(subjects.join("\n") + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

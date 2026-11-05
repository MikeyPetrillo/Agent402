---
name: batch
description: Run an Agent402 batch end to end - one worktree per independent piece, briefed agents, one merge onto the dev branch, the reviewer gate (money-security, copy-rules, perf-ops, batch-reviewer), the full suite mirroring every CI lane, a draft PR merged only by merge-on-green, production verification, and a findings log. Use when the user says /batch, "start a batch", "batch these", or asks to fan work out across agents and ship it as one PR.
argument-hint: "<batch name> <work items>"
---

# Batch: $ARGUMENTS

The batch named above is built with the steps below. Each step ends in an observable result;
do not start the next step until the result is in hand. `CLAUDE.md` ("Dev / CI / deploy
workflow", "Splitting work across agents", "Testing") and the matching `.claude/rules/*.md`
files are the rules; this skill is the order.

## 1. Worktrees, one per independent piece
Pieces are independent only when neither reads the other's output and they write no common
file, store or wallet. For each piece, under the session scratchpad:

```sh
git worktree add -b <batch-branch>-<piece> <scratchpad>/<piece> <dev head>
```

`node_modules`: for read-only runs, link the main checkout's `node_modules` into the worktree.
An agent that must install first removes the link (`rm node_modules`, the link only), then runs
`npm ci --ignore-scripts && npm rebuild better-sqlite3`. Never run `npm ci` through the link: it
empties the main checkout's `node_modules`.

Result: `git worktree list` shows one worktree per piece, each on its own branch from the dev head.

## 2. Brief each agent
One brief per piece, built from this template. The brief is the agent's whole context.

- **Goal**: one sentence, the observable outcome.
- **Facts already verified**: what you checked and how (file:line, a command and its output),
  and what is ruled out, so the agent does not re-derive or contradict it.
- **Read first**: `CLAUDE.md`, the matching `.claude/rules/*.md`, the named source files.
- **Build**: the change, scoped narrowly; what not to touch.
- **Tests that must fail without the fix**: name the scenario; the agent proves the test fails
  on the unfixed code.
- **Mutation checks on copies, never `git stash`**: revert each fix in a scratch copy and
  confirm a test fails; never stash, reset or check out over working files.
- **Suites to run, with exit codes**: list them; every exit code goes in the report.
- **Report shape and length**: what changed (files, one line each), tests added, every run
  with its exit code, commit SHA; a line budget (for example under 30 lines).
- **Commit rules**: subject starts `[test] `, under 72 characters (checked by
  `scripts/test-commit-message-framing.js`), mechanism only, no em dashes, US spelling; the
  session's attribution trailers; stage explicit paths, never `git add -A`; no `CHANGELOG.md`
  or `src/changelog.js` edits by piece agents (the merge step writes them); no push.

Result: every piece has a running agent with a brief that names its tests and report shape.

## 3. Environment facts for every agent
Put these in every brief that runs code:
- Node 22 on `PATH` (the repo's engines; older Node fails suites in ways that look real).
- A local Postgres URL needs `?sslmode=disable`.
- Redis: a local `redis-server` on a port below 32768, one per suite run that needs it.
- Suites that need the private cost table read `UPSTREAM_COSTS_FILE`; the table is never
  printed, logged or quoted.
- A child process's JSON result is read with `scripts/lib/child-json.js` (`childJson`), never
  from the last line of stdout.
- A suite that seeds more tools per seller than the cap imports `scripts/lib/uncapped-sellers.js`
  before any `src/` module.
- An offline suite imports `scripts/lib/offline-stores.js` first.
- A booted server spreads `ownStoreEnv(label)` after `process.env` and listens on port 0.

Result: no agent report names an environment failure that one of these facts would have prevented.

## 4. Merge in one place
On the dev branch (or a fresh batch branch from main when the dev branch carries a bad commit),
merge every piece branch, one at a time:
- Resolve each conflict by reading both sides; never take one side whole.
- Regenerate generated files instead of merging them (page dates, published slugs, pack
  prices, counts).
- `node --check src/server.js && node --check src/x402-index.js`.
- Write the `CHANGELOG.md` and `src/changelog.js` entries for the batch, then
  `node scripts/gen-page-dates.js --write`.

Result: one branch holds every piece; `git log --oneline main..HEAD` lists each piece's commits;
both `node --check` runs exit 0; `scripts/test-page-dates.js` exits 0.

## 5. The gate
On the merged diff (`git diff main...HEAD`), in parallel, each in its own fresh context:
- `money-security-reviewer` (money paths, security, 8/10-confidence findings),
- `copy-rules-reviewer` (claims against code, repo rules),
- `perf-ops-reviewer` (hot paths against main, alarms, rollback),
- `batch-reviewer` (merge integrity, whole-diff correctness).

Alongside them:
- The full suite mirroring every `deploy.yml` lane, in a fresh clone with its own `npm ci`,
  each test given its CI step's environment (real Postgres and Redis where the lane has them).
- Mutation re-checks of every fix in the batch, on copies.
- Docker image build and smoke: `docker build` then boot the image as
  `.github/workflows/docker-build-check.yml` does and wait for `/health` 200.

Fix every finding with a test that fails without the fix, then re-run the reviewer and suites
the fix touches. Result: every reviewer verdict is SHIP, every suite and the image smoke exit 0,
and every mutation makes a test fail.

## 6. Push and merge
Push only on the owner's word. Open a draft PR from the batch branch. Watch the push-event run
(`gh run list --event push`), never the PR-event run, which skips tests and ends green. Before
marking the PR ready, read its code-scanning alerts
(`gh api "repos/{owner}/{repo}/code-scanning/alerts?ref=refs/pull/<pr>/merge&state=open"`) and fix
every alert the batch introduced, test scripts included, with the same test-first rule as step 5.
Merge only with `scripts/merge-on-green.sh <pr>`.

Result: the PR has no open code-scanning alert from the batch and is merged by the helper,
pinned to the tested SHA, every required check green.

## 7. Production verification
- `GET /health`: `meta.build` equals the merge commit.
- `GET /api/gateway-status`: read every word; any word that is not its healthy value is
  explained or fixed.
- The deploy job's "Bazaar listing validation on the new build" step is green.
- For a `[publish]` commit: `npm view <pkg> version` equals the package's `package.json`.

Result: each of the four reads recorded with its value.

## 8. Findings log
After each gate, append the gate's findings to the per-batch findings log kept in the private
memory folder, outside the repository, using the columns in `findings.md` beside this file. Name
the class of each finding, not only the instance. When a class appears a second time, add a
guard test or a step to this skill in the same batch, and record which in the log.

Result: the log has one row per finding with its fixing commit and, for a repeated class, the
guard or skill step added.

## Common misses
- A commit subject over 72 characters.
- A child's JSON read from its last line instead of `childJson`.
- A test seeding past the per-seller cap without importing `uncapped-sellers.js`.
- A Postgres URL without `sslmode=disable`.
- `npm ci` run through a `node_modules` link.
- A CodeQL-shaped substring check on URLs in a test (compare by equality).
- Values interpolated into a generated script's source (pass them as argv).
- A workflow edited on one branch and deleted on another.
- An `apt-get install` in a workflow: CI installs apt packages only through
  `bash scripts/ci-apt-install.sh <package>...` (bounded attempts, mirror failover).

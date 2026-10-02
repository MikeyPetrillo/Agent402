#!/usr/bin/env bash
# Merge a PR from the dev branch only after the PUSH-event run of its head SHA
# has every test lane green, then report what main deployed.
#
# Why this exists: with a PR open, every push spawns TWO deploy.yml runs (push
# and pull_request). "The first run matching the SHA" is usually the PR run,
# which finishes earlier and never deploys. Merging on it (2026-08-25) meant
# the tree-gate on main - which only trusts push-event runs - had no green run
# to match and re-ran the whole suite; on 2026-08-22 the same mistake cancelled
# a deploy outright. The push run is the only one that counts, so this script
# refuses to consider any other.
#
# Three things the 2026-08-25 review added, each a way "green" could have been
# hollow: the merge is pinned to the SHA that was tested (a push between the
# check and the merge would otherwise land untested, and --admin bypasses branch
# protection); "green" means every test* LANE concluded success, not the run -
# a marker-less commit skips every lane and the run still concludes success;
# and every SHA is shape-checked before it is used, so an API hiccup cannot
# turn into a merge of "null".
#
#   scripts/merge-on-green.sh <pr-number> [branch]
#
# Needs gh (authenticated). Exits non-zero, merging nothing, on any doubt.
set -euo pipefail
PR="${1:?pr number}"
BRANCH="${2:-claude/sweet-brown-i99jl3}"
WORKFLOW="${GATE_WORKFLOW:-Deploy to Railway}"
is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }

SHA=$(gh pr view "$PR" --json headRefOid -q .headRefOid || true)
is_sha "$SHA" || { echo "could not read a head SHA for PR #$PR (got '${SHA}')"; exit 1; }

# FORK PRs (2026-09-13). A contributor's head lives in their own repo, so two
# assumptions below break: the local-HEAD catch-up can never converge (measured
# on #1338 - "PR head never caught up with local HEAD", refusing a PR whose 21
# required checks were all green), and there IS no push-event run in this repo
# to gate on. Per the CI note in CLAUDE.md the events are exactly inverted: our
# own dev branch runs its lanes on the PUSH run and skips them on pull_request,
# while forks keep full pull_request lanes. So detect once and honour it in both
# places rather than hand-verifying every outside contribution, which is the
# thing this script exists to stop anyone doing by eye.
# An unreadable answer here is "" and therefore NOT "true", which takes the
# push path: for a fork that finds no push run and exits 1. Fail-closed by
# construction - the failure mode is refusing to merge, never merging unchecked.
IS_FORK=$(gh pr view "$PR" --json isCrossRepository -q '.isCrossRepository' 2>/dev/null || echo "")
HEAD_REF=$(gh pr view "$PR" --json headRefName -q '.headRefName' 2>/dev/null || echo "")
# The same inversion applies to ANY head that is not our dev branch, not only a
# fork: a Dependabot branch lives in this repo, so isCrossRepository is false,
# but deploy.yml runs its lanes on the pull_request event there and never on a
# push. Gating such a PR on a push run refuses it however green it is (measured
# on #1392, 21 of 21 required contexts passing, no push run in existence). So
# the rule is the BRANCH, not the ownership: our dev branch gates on its push
# run, everything else on its pull_request run. An unreadable HEAD_REF is "",
# which is not the dev branch, so it takes the pull_request path and finds no
# run for a dev-branch SHA - still fail-closed, still refusing rather than
# merging something unchecked.
if [ "$IS_FORK" = "true" ] || [ "$HEAD_REF" != "$BRANCH" ]; then
  GATE_EVENT="pull_request"; GATE_BRANCH="$HEAD_REF"
  echo "PR #$PR head $HEAD_REF is not the dev branch ($BRANCH)${IS_FORK:+, fork=$IS_FORK} - gating on its pull_request run"
else
  GATE_EVENT="push"; GATE_BRANCH="$BRANCH"
fi

# The PR's head lags the push by a few seconds. Run right after `git push`
# (2026-08-25) this read the PREVIOUS head, judged its run, and refused - the
# fix was pushed and never merged. When the local checkout is on the PR branch
# and already pushed, insist the PR head has caught up with it first.
# It only applies when the local checkout IS the PR's head branch: merging a
# Dependabot PR from our own dev checkout compared two unrelated heads and
# refused forever (#1392). Same shape as the gate-event bug above, so the
# condition names the PR's head ref rather than assuming it.
if [ "$IS_FORK" != "true" ] && [ "$HEAD_REF" = "$BRANCH" ] && [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)" = "$BRANCH" ]; then
  LOCAL=$(git rev-parse HEAD)
  if is_sha "$LOCAL" && [ "$LOCAL" != "$SHA" ]; then
    if [ "$(git rev-parse "origin/$BRANCH" 2>/dev/null || true)" = "$LOCAL" ]; then
      echo "PR head $SHA lags the pushed local head $LOCAL - waiting for GitHub to catch up"
      for _ in $(seq 1 18); do
        sleep 5
        SHA=$(gh pr view "$PR" --json headRefOid -q .headRefOid || true)
        [ "$SHA" = "$LOCAL" ] && break
      done
      [ "$SHA" = "$LOCAL" ] || { echo "PR head ($SHA) never caught up with local HEAD ($LOCAL) - not merging"; exit 1; }
    else
      echo "local HEAD $LOCAL is not pushed (origin/$BRANCH differs) - push first, or merge from a clean checkout"; exit 1
    fi
  fi
fi
echo "PR #$PR head $SHA on $GATE_BRANCH"

# The push run can take a few seconds to appear after a push.
RUN=""
for _ in $(seq 1 30); do
  RUN=$(gh run list --workflow "$WORKFLOW" --branch "$GATE_BRANCH" --event "$GATE_EVENT" --commit "$SHA" --limit 5 \
        --json databaseId -q '.[0].databaseId // empty' 2>/dev/null || true)
  [ -n "$RUN" ] && break
  sleep 10
done
[[ "$RUN" =~ ^[0-9]+$ ]] || { echo "no $GATE_EVENT-event run found for $SHA"; exit 1; }
echo "$GATE_EVENT run: $RUN (waiting)"

gh run watch "$RUN" --interval 30 >/dev/null 2>&1 || true
# Every test lane must have run AND passed. A skipped lane is not a passed lane.
LANES=$(gh run view "$RUN" --json jobs -q '.jobs[] | select(.name | test("^test(-|$)")) | "\(.name)=\(.conclusion)"' || true)
[ -n "$LANES" ] || { echo "$GATE_EVENT run $RUN has no test lanes - not merging"; exit 1; }
echo "$LANES" | sed 's/^/  /'
if echo "$LANES" | grep -vq '=success$'; then
  echo "$GATE_EVENT run $RUN is NOT green on every test lane - not merging"
  exit 1
fi

# --admin is unavoidable (the ruleset requires a code-owner review and there is
# one owner), so it also bypasses the ruleset's REQUIRED STATUS CHECKS - which
# is how #949 merged with CodeQL red (2026-08-26). Enforce them here: read the
# required contexts from the ruleset and refuse unless each has a SUCCESS
# check run on the PR head and none is FAILURE/ERROR. Waits for pending ones.
REQUIRED=$(gh api "repos/{owner}/{repo}/rules/branches/main" -q '.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context' 2>/dev/null || true)
[ -n "$REQUIRED" ] || { echo "could not read the ruleset's required checks - not merging"; exit 1; }
for i in $(seq 1 60); do
  ROLLUP=$(gh pr view "$PR" --json statusCheckRollup -q '.statusCheckRollup[] | "\(.name // .context)=\(.conclusion // .state)"' 2>/dev/null || true)
  MISSING=""; BAD=""
  while IFS= read -r ctx; do
    [ -n "$ctx" ] || continue
    # `|| true` is load-bearing: a required context ABSENT from the rollup
    # (CodeQL posts its named check a couple of minutes after the lanes) makes
    # this pipeline exit 1, and under set -e a failing assignment-substitution
    # kills the whole script SILENTLY - measured 2026-09-01, three runs in a
    # row died here with no message and "worked on retry" once CodeQL had
    # posted. Absent must mean MISSING-and-wait, which is this loop's whole job.
    line=$(echo "$ROLLUP" | grep -F "$ctx=" | tail -1 || true)
    case "$line" in
      *=SUCCESS|*=success) ;;
      *=FAILURE*|*=failure*|*=ERROR*|*=error*|*=CANCELLED*|*=cancelled*|*=TIMED_OUT*) BAD="$BAD $ctx" ;;
      *) MISSING="$MISSING $ctx" ;;
    esac
  done <<< "$REQUIRED"
  if [ -n "$BAD" ]; then echo "required check(s) FAILED on PR $PR:$BAD - not merging"; exit 1; fi
  [ -z "$MISSING" ] && break
  echo "waiting for required check(s):$MISSING"; sleep 30
done
[ -z "$MISSING" ] || { echo "required check(s) never completed:$MISSING - not merging"; exit 1; }
echo "every ruleset-required check is green on PR $PR"

# The markers job on MAIN rescans every subject in the push range, and a merge
# whose range carries a subject it rejects leaves deploy and publish SKIPPED on
# a run that is otherwise green - the change is merged and not shipped, which is
# the class of bug an unconditional deploy on main exists to prevent. The PR
# lanes never look at the branch's own subjects, so the first reading is the one
# after the merge. Read them here, where the merge can still be stopped.
# Measured 2026-09-22: PR #1454 merged green and its main run failed markers on a
# 76-character subject, so neither prod nor npm received it.
if [ -f scripts/test-commit-message-framing.js ]; then
  if ! COMMIT_RANGE="origin/main..$SHA" node scripts/test-commit-message-framing.js; then
    echo "commit subjects on PR $PR would fail the markers job on main - reword them before merging"
    exit 1
  fi
fi

gh pr ready "$PR" >/dev/null 2>&1 || true
# Pinned to the tested SHA: if the branch moved since, gh refuses and we stop.
gh pr merge "$PR" --merge --admin --match-head-commit "$SHA"
MERGE=$(gh pr view "$PR" --json mergeCommit -q '.mergeCommit.oid // empty' || true)
is_sha "$MERGE" || { echo "merged, but could not read the merge commit (got '${MERGE}'); check gh pr view $PR"; exit 1; }
echo "merged: ${MERGE:0:8}"

# Main deploys unconditionally. Report the run and, separately, what prod says:
# the job can be red for a Railway race while prod is correct, and the reverse
# has happened too, so the build hash on /health is the only proof.
MAIN=""
for _ in $(seq 1 30); do
  MAIN=$(gh run list --workflow "$WORKFLOW" --branch main --event push --commit "$MERGE" --limit 5 \
         --json databaseId -q '.[0].databaseId // empty' 2>/dev/null || true)
  [ -n "$MAIN" ] && break
  sleep 10
done
[[ "$MAIN" =~ ^[0-9]+$ ]] || { echo "no main run found for ${MERGE:0:8} yet; check gh run list"; exit 0; }
echo "main run: $MAIN (waiting)"
gh run watch "$MAIN" --exit-status --interval 30 >/dev/null 2>&1 && echo "main run green" || echo "main run NOT green (may be a Railway race - trust /health below)"
H=""
for _ in $(seq 1 60); do
  H=$(curl -s --max-time 8 "${TARGET_URL:-https://agent402.tools}/health" || true)
  if printf '%s' "$H" | grep -q "\"build\":\"${MERGE:0:7}\""; then echo "PROD: $H"; exit 0; fi
  sleep 10
done
echo "prod did not report ${MERGE:0:7} within 10 min; last: $H"
exit 1

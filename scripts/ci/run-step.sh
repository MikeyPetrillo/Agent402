#!/usr/bin/env bash
# Runs one test step of .github/workflows/deploy.yml from its committed list.
#
#   bash scripts/ci/run-step.sh <lane> <step>
#
# The step's script list lives in scripts/ci/lanes/<lane>.sh under "# @step <step>",
# with the comment that says why each script runs beside its line; the workflow
# step keeps its env, services and `if:`. Keeping the lists here keeps deploy.yml
# under GitHub's 500 KB workflow limit.
#
# ONE STEP, MANY SCRIPTS (2026-08-25): GitHub spends ~0.7 s of runner setup per
# step, so a lane runs many scripts in one step. Each script still runs in its own
# process, in list order; `t` groups its log and names it with its elapsed time,
# and a failure prints the failing script as an error.
#
# In a sharded lane (CI_SHARDS set at job level, scripts/lib/ci-shards.js) `t`
# counts its calls across the whole job in $RUNNER_TEMP/ci-shard-calls and shard k
# runs call i when (i - 1) % CI_SHARDS + 1 == k. scripts/lib/ci-workflow.js reads
# the two `t` lines below to expand each step for the workflow guards, and
# scripts/test-ci-shards.js runs this file for every shard of every sharded lane.
set -euo pipefail
lane="${1:?lane}"; step="${2:?step}"
file="$(dirname "$0")/lanes/${lane}.sh"
[ -f "$file" ] || { echo "::error::no test list for lane ${lane} (${file})"; exit 1; }
# Exactly one section may carry the id; none or two fails the step.
body="$(awk -v id="$step" '/^# @step /{ s = $3; sub(/:$/, "", s); on = (s == id); found += on; next } on { print } END { if (found != 1) exit 3 }' "$file")" \
  || { echo "::error::${file} has no single section \"# @step ${step}\""; exit 1; }
if [ -n "${CI_SHARDS:-}" ]; then
  t() { local k; k=$(( $(cat "$RUNNER_TEMP/ci-shard-calls" 2>/dev/null || echo 0) + 1 )); echo "$k" > "$RUNNER_TEMP/ci-shard-calls"; if [ $(( (k - 1) % CI_SHARDS + 1 )) -ne "$CI_SHARD" ]; then echo "--  $* (shard $(( (k - 1) % CI_SHARDS + 1 ))/$CI_SHARDS)"; return 0; fi; local s=$SECONDS; echo "::group::$*"; "$@" || { echo "::endgroup::"; echo "::error::failed: $*"; exit 1; }; echo "::endgroup::"; echo "ok  $* ($((SECONDS - s))s)"; }
else
  t() { local s=$SECONDS; echo "::group::$*"; "$@" || { echo "::endgroup::"; echo "::error::failed: $*"; exit 1; }; echo "::endgroup::"; echo "ok  $* ($((SECONDS - s))s)"; }
fi
eval "$body"

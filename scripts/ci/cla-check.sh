#!/usr/bin/env bash
# CLA check for an outside pull request (.github/workflows/dco.yml).
# Passes when the PR description, or a comment written by the PR's own author,
# contains the agreement sentence below (letter case and runs of whitespace
# aside). The sentence is the one CLA.md and CONTRIBUTING.md print; the guard
# scripts/test-dco-cla-workflow.js keeps the three identical.
#
# The description and comments are untrusted: they are read from the event file
# and the API into quoted variables and searched as a fixed string, never
# evaluated. Needs GH_TOKEN with pull-requests: read for the comments.
set -euo pipefail

AGREEMENT="I have read the Agent402 Contributor License Agreement in CLA.md and I agree to its terms."

event="${GITHUB_EVENT_PATH:?GITHUB_EVENT_PATH is not set}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
number=$(jq -r '.pull_request.number // empty' "$event")
author=$(jq -r '.pull_request.user.login // empty' "$event")
if ! [[ "$number" =~ ^[0-9]+$ ]] || [ -z "$author" ]; then
  echo "::error::The event file carries no pull request number and author."
  exit 1
fi

normalize() { tr '[:upper:]' '[:lower:]' | tr -s '[:space:]' ' '; }
want=$(printf '%s' "$AGREEMENT" | normalize)

body=$(jq -r '.pull_request.body // ""' "$event" | normalize)
if printf '%s' "$body" | grep -qF -- "$want"; then
  echo "CLA: the pull request description carries the agreement."
  exit 0
fi

if ! raw=$(gh api --paginate "repos/$repo/issues/$number/comments"); then
  echo "::error::Could not read the pull request comments to look for the agreement."
  exit 1
fi
comments=$(printf '%s' "$raw" | jq -r --arg a "$author" '.[] | select(.user.login == $a) | .body')
if printf '%s' "$comments" | normalize | grep -qF -- "$want"; then
  echo "CLA: a comment by the pull request author carries the agreement."
  exit 0
fi

echo "::error::This pull request needs the contributor license agreement. Read CLA.md, then add this sentence to the pull request description (editing the description runs this check again): $AGREEMENT"
exit 1

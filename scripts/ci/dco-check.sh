#!/usr/bin/env bash
# DCO check for an outside pull request (.github/workflows/dco.yml).
# Every non-merge commit of the PR carries a "Signed-off-by: Name <email>" line
# whose email is the commit author's email (compared without regard to case).
# Merge commits are exempt: they add no new authorship.
#
# Runs from the base branch's copy of this script: the workflow checks out the
# base, never the PR's head, and the PR's commits are read through the API
# (repos/<repo>/pulls/<n>/commits) with a read-only token. Works for both the
# pull_request and the issue_comment event.
#
# Commit text is untrusted: it is only ever held in quoted variables and
# compared as a fixed string. Tested by scripts/test-dco-cla-workflow.js.
set -euo pipefail

event="${GITHUB_EVENT_PATH:?GITHUB_EVENT_PATH is not set}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
number=$(jq -r '(.pull_request.number // .issue.number) // empty' "$event")
if ! [[ "$number" =~ ^[0-9]+$ ]]; then
  echo "::error::The event file carries no pull request number."
  exit 1
fi

if ! raw=$(gh api --paginate "repos/$repo/pulls/$number/commits"); then
  echo "::error::Could not read the pull request's commits."
  exit 1
fi
commits=$(printf '%s' "$raw" | jq -s 'add // []')
count=$(printf '%s' "$commits" | jq 'length')
# The API lists at most 250 commits of a pull request.
if [ "$count" -ge 250 ]; then
  echo "::error::This pull request has 250 or more commits, more than the check can read. Split it into smaller pull requests."
  exit 1
fi

safe() { tr -cd 'A-Za-z0-9@._+-'; }

missing=0
checked=0
for ((i = 0; i < count; i++)); do
  c=$(printf '%s' "$commits" | jq -c --argjson i "$i" '.[$i]')
  sha=$(printf '%s' "$c" | jq -r '.sha // ""')
  if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "::error::A commit of this pull request has no SHA."
    missing=1
    continue
  fi
  if [ "$(printf '%s' "$c" | jq '.parents | length')" -gt 1 ]; then continue; fi
  checked=$((checked + 1))
  author_email=$(printf '%s' "$c" | jq -r '.commit.author.email // ""' | tr '[:upper:]' '[:lower:]')
  signoffs=$(printf '%s' "$c" | jq -r '.commit.message // ""' \
    | sed -n 's/^[Ss]igned-[Oo]ff-[Bb]y:[[:space:]]*.*<\([^<>]*\)>[[:space:]]*$/\1/p' \
    | tr '[:upper:]' '[:lower:]')
  if [ -z "$signoffs" ]; then
    echo "::error::Commit $sha has no Signed-off-by line. Sign off with: git commit -s (see CONTRIBUTING.md, Developer Certificate of Origin)."
    missing=1
  elif [ -z "$author_email" ] || ! printf '%s\n' "$signoffs" | grep -qxF -- "$author_email"; then
    echo "::error::Commit $sha is signed off, but no Signed-off-by line carries its author's email ($(printf '%s' "$author_email" | safe)). Set git config user.name and user.email to the identity you sign with, then amend: git commit --amend --reset-author -s"
    missing=1
  fi
done

if [ "$missing" = "0" ]; then
  echo "DCO: $checked commit(s) signed off by their authors."
fi
exit "$missing"

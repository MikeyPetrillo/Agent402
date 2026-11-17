#!/usr/bin/env bash
# DCO check for an outside pull request (.github/workflows/dco.yml).
# Every non-merge commit between the PR's base and head carries a
# "Signed-off-by: Name <email>" line whose email is the commit author's email
# (compared without regard to case). Merge commits are exempt: they add no new
# authorship.
#
# Reads the base and head SHAs from the event file ($GITHUB_EVENT_PATH). Commit
# text is untrusted: it is only ever held in quoted variables and compared as a
# fixed string. Tested by scripts/test-dco-cla-workflow.js.
set -euo pipefail

event="${GITHUB_EVENT_PATH:?GITHUB_EVENT_PATH is not set}"
base=$(jq -r '.pull_request.base.sha // empty' "$event")
head=$(jq -r '.pull_request.head.sha // empty' "$event")
if ! [[ "$base" =~ ^[0-9a-f]{40}$ && "$head" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::The event file carries no pull request base and head SHA."
  exit 1
fi

missing=0
checked=0
while read -r sha; do
  [ -n "$sha" ] || continue
  if [ "$(git rev-list --no-walk --count --merges "$sha")" = "1" ]; then continue; fi
  checked=$((checked + 1))
  author_email=$(git log -1 --format=%ae "$sha" | tr '[:upper:]' '[:lower:]')
  signoffs=$(git log -1 --format=%B "$sha" \
    | sed -n 's/^[Ss]igned-[Oo]ff-[Bb]y:[[:space:]]*.*<\([^<>]*\)>[[:space:]]*$/\1/p' \
    | tr '[:upper:]' '[:lower:]')
  if [ -z "$signoffs" ]; then
    echo "::error::Commit $sha has no Signed-off-by line. Sign off with: git commit -s (see CONTRIBUTING.md, Developer Certificate of Origin)."
    missing=1
  elif ! printf '%s\n' "$signoffs" | grep -qxF -- "$author_email"; then
    echo "::error::Commit $sha is signed off, but no Signed-off-by line carries its author's email ($author_email). Set git config user.name and user.email to the identity you sign with, then amend: git commit --amend --reset-author -s"
    missing=1
  fi
done < <(git rev-list "$base".."$head")

if [ "$missing" = "0" ]; then
  echo "DCO: $checked commit(s) signed off by their authors."
fi
exit "$missing"

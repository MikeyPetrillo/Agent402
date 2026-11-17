#!/usr/bin/env bash
# CLA check for an outside pull request (.github/workflows/dco.yml).
# Every person whose work is in the pull request agrees to the contributor
# license agreement in CLA.md by its agreement sentence below (letter case and
# runs of whitespace aside):
#   - the PR author: in the PR description or in a comment of their own;
#   - every other commit author with a GitHub account: in a comment of their
#     own, or in the PR description as "@login: <sentence>";
# The repository owner and bots are exempt. A commit whose author email is not
# linked to a GitHub account fails: its agreement cannot be matched to anyone.
# The sentence names the agreement's version; CLA.md and CONTRIBUTING.md print
# the same sentence and CLA.md the same version (scripts/test-dco-cla-workflow.js).
#
# Runs from the base branch's copy of this script, for the pull_request and the
# issue_comment event alike; the PR, its commits and its comments are read
# through the API with a read-only token. Their text is untrusted: held in
# quoted variables and searched as a fixed string, never evaluated.
set -euo pipefail

AGREEMENT="I have read the Agent402 Contributor License Agreement (CLA v1.0, 2026-11-17) in CLA.md and I agree to its terms."
OWNER="mikeypetrillo"

event="${GITHUB_EVENT_PATH:?GITHUB_EVENT_PATH is not set}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
number=$(jq -r '(.pull_request.number // .issue.number) // empty' "$event")
if ! [[ "$number" =~ ^[0-9]+$ ]]; then
  echo "::error::The event file carries no pull request number."
  exit 1
fi

api() { gh api --paginate "$1" | jq -s 'if length == 1 and (.[0] | type) == "object" then .[0] else add // [] end'; }
if ! pr=$(api "repos/$repo/pulls/$number") \
  || ! commits=$(api "repos/$repo/pulls/$number/commits") \
  || ! comments=$(api "repos/$repo/issues/$number/comments"); then
  echo "::error::Could not read the pull request, its commits or its comments."
  exit 1
fi

normalize() { tr '[:upper:]' '[:lower:]' | tr -s '[:space:]' ' '; }
want=$(printf '%s' "$AGREEMENT" | normalize)
body=$(printf '%s' "$pr" | jq -r '.body // ""' | normalize)
author=$(printf '%s' "$pr" | jq -r '.user.login // "" | ascii_downcase')
author_type=$(printf '%s' "$pr" | jq -r '.user.type // ""')
login_ok() { [[ "$1" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; }

failed=0
unlinked=$(printf '%s' "$commits" | jq -r '.[] | select(.author == null and ((.parents | length) < 2)) | .sha' | grep -E '^[0-9a-f]{40}$' || true)
for sha in $unlinked; do
  echo "::error::Commit $sha has an author email that is not linked to a GitHub account, so its author's agreement cannot be matched. Add that email to the author's GitHub account, or re-author the commit with one that is."
  failed=1
done

people=$(printf '%s' "$commits" | jq -r --arg o "$OWNER" '.[] | .author | select(. != null and .type != "Bot") | .login | ascii_downcase | select(. != $o and (endswith("[bot]") | not))')
if [ "$author_type" != "Bot" ] && [ "$author" != "$OWNER" ]; then people=$(printf '%s\n%s' "$author" "$people"); fi
people=$(printf '%s\n' "$people" | sed '/^$/d' | sort -u)

for who in $people; do
  if ! login_ok "$who"; then
    echo "::error::A commit author's GitHub login could not be read."
    failed=1
    continue
  fi
  if [ "$who" = "$author" ] && printf '%s' "$body" | grep -qF -- "$want"; then
    echo "CLA: $who agreed in the pull request description."
    continue
  fi
  if printf '%s' "$body" | grep -qF -e "@$who: $want" -e "@$who $want"; then
    echo "CLA: the pull request description carries the agreement for $who."
    continue
  fi
  if printf '%s' "$comments" | jq -r --arg w "$who" '.[] | select((.user.login // "" | ascii_downcase) == $w) | .body // ""' | normalize | grep -qF -- "$want"; then
    echo "CLA: $who agreed in a comment."
    continue
  fi
  if [ "$who" = "$author" ]; then
    echo "::error::This pull request needs the contributor license agreement from its author ($who). Read CLA.md, then add this sentence to the pull request description or post it as a comment (either runs this check again): $AGREEMENT"
  else
    echo "::error::Commits in this pull request are authored by $who, who has not agreed to the contributor license agreement. $who reads CLA.md and posts this sentence as a comment on the pull request (which runs this check again): $AGREEMENT"
  fi
  failed=1
done

if [ "$failed" = "0" ]; then
  echo "CLA: every contributor to this pull request has agreed."
fi
exit "$failed"

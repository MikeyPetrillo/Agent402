#!/usr/bin/env bash
# Move the dev branch to main's head when everything on it already reached main.
#
# Why (2026-10-04): the dev branch's commits sometimes reach main through
# another branch (a batch PR, a cherry-pick). The originals stay on the dev
# branch, it drifts behind main, and the next PR from it drags those old
# commits into main's history, where the markers job re-reads their subjects.
# That blocked a merge: five old subjects over 72 characters, one carrying
# [publish]. The only fix was rewriting the dev branch, which is otherwise
# never done.
#
# So this is the ONE sanctioned way the dev branch moves other than a normal
# push, and it only moves when nothing would be lost:
#   - no open PR has the dev branch as its head;
#   - merging the dev branch into main would leave main's tree unchanged
#     (`git merge-tree`; this is what decided the 2026-10-04 reset), or, when
#     that merge would conflict, every commit on the dev branch that main lacks
#     is either patch-equivalent
#     to a commit on main (`git cherry` "-"), or touches only files whose net
#     change on the dev branch since the merge base is empty (work that was
#     added and then removed again);
#   - no merge commit on it carries content from neither parent (an evil merge);
#   - the push is --force-with-lease against the exact SHA that was checked,
#     so a commit landing in between makes it refuse.
# Anything else leaves the branch alone and says why. Never touches main.
#
#   scripts/sync-dev-branch.sh [branch] [remote]
#
# DEV_SYNC_OPEN_PRS overrides the open-PR count (tests run without gh).
# DEV_SYNC_DRY_RUN=1 prints the decision and pushes nothing.
set -euo pipefail
BRANCH="${1:-claude/sweet-brown-i99jl3}"
REMOTE="${2:-origin}"
git fetch -q "$REMOTE" main "$BRANCH" || { echo "dev sync: fetch failed; $BRANCH left as is"; exit 0; }
DEV=$(git rev-parse "$REMOTE/$BRANCH")
MAIN=$(git rev-parse "$REMOTE/main")
if [ "$DEV" = "$MAIN" ]; then echo "dev sync: $BRANCH already at main"; exit 0; fi
if git merge-base --is-ancestor "$DEV" "$MAIN"; then
  [ "${DEV_SYNC_DRY_RUN:-}" = "1" ] && { echo "dev sync (dry run): would fast-forward $BRANCH to main ${MAIN:0:8}"; exit 0; }
  git push -q "$REMOTE" "$MAIN:refs/heads/$BRANCH" && echo "dev sync: $BRANCH fast-forwarded to main ${MAIN:0:8}"
  exit 0
fi
OPEN="${DEV_SYNC_OPEN_PRS:-$(gh pr list --head "$BRANCH" --state open --json number -q length 2>/dev/null || echo unknown)}"
if [ "$OPEN" != "0" ]; then echo "dev sync: $BRANCH has an open PR (or the check failed: $OPEN); left as is"; exit 0; fi
# The direct test: would main's content change if it merged the dev branch?
# It sees through every way the same work can reach main (a batch PR, a
# cherry-pick, a merge of main back into dev that makes git cherry blind).
if MERGED=$(git merge-tree --write-tree "$MAIN" "$DEV" 2>/dev/null | head -1) && [ "$MERGED" = "$(git rev-parse "$MAIN^{tree}")" ]; then
  [ "${DEV_SYNC_DRY_RUN:-}" = "1" ] && { echo "dev sync (dry run): would move $BRANCH from ${DEV:0:8} to main ${MAIN:0:8} (merging it would change nothing)"; exit 0; }
  git push -q --force-with-lease="$BRANCH:$DEV" "$REMOTE" "$MAIN:refs/heads/$BRANCH"
  echo "dev sync: $BRANCH moved from ${DEV:0:8} to main ${MAIN:0:8} (merging it would change nothing on main)"
  exit 0
fi
BASE=$(git merge-base "$MAIN" "$DEV")
# git cherry skips merge commits, so a merge on the dev branch that resolved a
# conflict with content from NEITHER parent would be lost unseen. --cc lists
# exactly those files; any at all and the branch stays.
for m in $(git rev-list --merges "$MAIN..$DEV"); do
  if [ -n "$(git diff-tree --cc -r --name-only --no-commit-id "$m")" ]; then
    echo "dev sync: merge ${m:0:8} on $BRANCH carries content of its own (neither parent has it); left as is"; exit 0
  fi
done
UNIQUE=$(git cherry "$MAIN" "$DEV" | awk '$1=="+"{print $2}')
if [ -n "$UNIQUE" ]; then
  FILES=$(for c in $UNIQUE; do git diff-tree --no-commit-id --name-only -r "$c"; done | sort -u)
  NET=$(printf '%s\n' "$FILES" | xargs git diff --name-only "$BASE" "$DEV" -- 2>/dev/null || true)
  if [ -n "$NET" ]; then
    echo "dev sync: $BRANCH carries work main lacks ($(echo "$UNIQUE" | wc -l | tr -d ' ') commit(s), e.g. $(echo "$NET" | head -3 | tr '\n' ' ')); left as is"
    exit 0
  fi
fi
[ "${DEV_SYNC_DRY_RUN:-}" = "1" ] && { echo "dev sync (dry run): would move $BRANCH from ${DEV:0:8} to main ${MAIN:0:8}"; exit 0; }
git push -q --force-with-lease="$BRANCH:$DEV" "$REMOTE" "$MAIN:refs/heads/$BRANCH"
echo "dev sync: $BRANCH moved from ${DEV:0:8} to main ${MAIN:0:8} (every commit on it had already reached main)"

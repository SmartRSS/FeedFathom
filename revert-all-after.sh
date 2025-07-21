#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <commit-hash>"
  exit 1
fi3b9ab19

TARGET_COMMIT="$1"
BRANCH_NAME="revert-to-$TARGET_COMMIT-$(date +%s)"

# Create a new branch from current HEAD
echo "[INFO] Creating new branch: $BRANCH_NAME"
git checkout -b "$BRANCH_NAME"

# Revert all non-merge commits after the target commit
NON_MERGE_COMMITS=$(git log --no-merges --reverse --format="%H" "$TARGET_COMMIT"..HEAD)
for sha in $NON_MERGE_COMMITS; do
  echo "[INFO] Reverting non-merge commit $sha"
  if ! git revert --no-edit -X ours "$sha"; then
    echo "[ERROR] Conflict while reverting $sha. Aborting."
    git revert --abort || true
    exit 2
  fi
done

# Revert all merge commits after the target commit
MERGE_COMMITS=$(git log --merges --reverse --format="%H" "$TARGET_COMMIT"..HEAD)
for sha in $MERGE_COMMITS; do
  echo "[INFO] Reverting merge commit $sha (mainline 1)"
  if ! git revert -m 1 --no-edit -X ours "$sha"; then
    echo "[ERROR] Conflict while reverting merge $sha. Aborting."
    git revert --abort || true
    exit 3
  fi
done

echo "[INFO] Pushing branch $BRANCH_NAME to origin"
git push origin "$BRANCH_NAME"
echo "[SUCCESS] All commits after $TARGET_COMMIT reverted and branch pushed: $BRANCH_NAME" 
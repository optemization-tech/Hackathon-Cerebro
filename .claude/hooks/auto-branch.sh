#!/bin/bash
# SessionStart hook: if on main with a clean tree, auto-create a feature branch.
# Prevents accidental work directly on main when multiple people use Claude Code.

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

branch=$(git branch --show-current 2>/dev/null || echo "")
[ "$branch" = "main" ] || exit 0

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[auto-branch] Skipping: working tree dirty on main. Commit, stash, or branch manually." >&2
  exit 0
fi

slug="session-$(date +%Y%m%d-%H%M%S)"
git checkout -b "feature/$slug" >&2
echo "[auto-branch] Switched main -> feature/$slug. Run /ship when the feature is done." >&2
exit 0

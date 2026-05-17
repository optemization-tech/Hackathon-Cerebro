#!/bin/bash
# PreToolUse Bash hook: block `git commit` and `git push` when current branch is main.
# Forces the branch-per-feature workflow.

input=$(cat)

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

branch=$(git branch --show-current 2>/dev/null || echo "")
[ "$branch" = "main" ] || exit 0

cmd=$(echo "$input" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const i=JSON.parse(d);process.stdout.write(i.tool_input?.command||'')}catch(e){}})" 2>/dev/null)

if echo "$cmd" | grep -qE '(^|[^A-Za-z])git[[:space:]]+(commit|push)\b'; then
  echo "[block-main] BLOCKED: you are on main. Create a feature branch first:" >&2
  echo "  git checkout -b feature/<short-name>" >&2
  echo "Then re-run your command. When the feature is done, use /ship to land it." >&2
  exit 2
fi

exit 0

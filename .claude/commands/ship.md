---
description: Land the current feature — commit, rebase against main, resolve conflicts inline, push, open PR with auto-merge.
---

You are shipping the current feature. Execute these steps in order. If any step fails in a way you cannot recover from, stop and report.

## 1. Sanity checks

- Run `git branch --show-current`. If the result is `main`, abort and tell the user to create a feature branch first.
- Run `git status`. If there are no changes AND no unpushed commits, abort with "nothing to ship".

## 2. Stage and commit

- `git add -A`
- `git diff --cached --stat` to see what's staged
- Generate a conventional commit message based on the actual changes: `<type>: <description>` where type is one of feat, fix, refactor, docs, test, chore, perf, ci.
- `git commit -m "<message>"`

## 3. Sync with main and resolve conflicts inline

- `git fetch origin main`
- `git rebase origin/main`
- If rebase reports conflicts:
  1. Run `git status` to list conflicted files
  2. For each conflicted file:
     - Read the file
     - Inspect the `<<<<<<<`, `=======`, `>>>>>>>` markers
     - Resolve based on intent — favor keeping both behaviors when both sides made legitimate changes
     - Edit the file to remove markers and produce the correct merged content
     - `git add <file>`
  3. `git rebase --continue`
  4. If new conflicts appear, repeat
  5. If a conflict is semantically ambiguous (e.g., two different implementations of the same function), run `git rebase --abort` and ask the user how to proceed — do not guess

## 4. Push

- `git push -u origin <current-branch>`

## 5. Open PR with auto-merge

- `gh pr create --base main --fill`
- `gh pr merge --auto --squash`
- Report the PR URL

## 6. Final report

Print a short summary:
- Branch shipped
- Commit message(s)
- PR URL
- Auto-merge status (enabled / merged immediately)

Do not force-push, skip steps, or use `--no-verify`. If something fails, stop and tell the user.

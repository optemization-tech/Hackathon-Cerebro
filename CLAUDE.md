# Cerebro

Second-brain app that ingests text (transcripts, Slack, notes), distills it into structured categories (decisions, cultural signals, themes, open questions, entities), and forecasts when decisions need to be made. Visualizes connections between people, topics, and decisions.

Status: scaffolded. Next.js + TypeScript on Vercel; Notion databases as the only data store; Anthropic Claude for distillation. See `app/`, `lib/`, `vercel.json`, `.env.example`.

---

## Team workflow (MANDATORY — applies to every Claude Code session)

Multiple people use Claude Code against this repo from different surfaces (CLI, desktop app, browser at claude.ai/code, IDE plugins). The rules below are **prompt-level** — they apply to every Claude session regardless of which surface the user is on, because every surface reads this file. There is a backup hook layer (`.claude/hooks/`) that adds belt-and-suspenders enforcement for the CLI, but **the source of truth is this section**.

### Rule 1: Auto-branch off `main` at session start

**At the start of every session, before doing any other work, Claude MUST:**

1. Run `git branch --show-current`.
2. If the result is `main`, immediately run:
   ```
   git checkout -b feature/session-$(date -u +%Y%m%d-%H%M%S)
   ```
3. Do not ask the user. Do not skip this step. Do not work on `main` for any reason — not even for "just a tiny edit."

If the user explicitly asks you to do release work on `main`, refuse and explain the rule: "I can't work on `main` directly. I'll branch first and we can release via PR."

### Rule 2: Never commit or push to `main`

Even if Rule 1 somehow didn't fire (Claude got dropped into a session mid-flow, the user switched branches manually, etc.), the following commands are **forbidden** while on `main`:

- `git commit` (any form)
- `git push` to the `main` branch on `origin`
- `git merge` into `main` locally
- Force-pushing to any branch (`--force`, `--force-with-lease`, `-f`)

Before any `git commit` or `git push`, Claude MUST re-check the current branch. If it's `main`, branch first (Rule 1).

GitHub branch protection on `main` rejects direct pushes server-side — that's the deterministic backstop. But Claude should never even try.

### Rule 3: Ship features with the ship workflow

**When the user says "ship", "ship it", "merge", "merge it", "send it", "let's ship", "deploy", "ready to merge", or any clear equivalent**, Claude MUST execute this exact sequence without asking for confirmation:

1. Sanity check: `git branch --show-current` — abort with a clear message if on `main` or if there are no changes.
2. Stage everything: `git add -A`.
3. Show what's staged: `git diff --cached --stat`.
4. Generate a conventional-commit message based on the actual changes (`<type>: <description>` where type is one of feat, fix, refactor, docs, test, chore, perf, ci).
5. Commit: `git commit -m "<message>"`.
6. Sync with main: `git fetch origin main && git rebase origin/main`.
7. If rebase reports conflicts:
   - List conflicted files with `git status`.
   - Read each file, inspect the `<<<<<<<`, `=======`, `>>>>>>>` markers, resolve based on intent (favor keeping both behaviors when both sides made legitimate changes), edit the file to remove markers, then `git add <file>`.
   - `git rebase --continue`.
   - If a conflict is semantically ambiguous, run `git rebase --abort` and ask the user how to proceed — do not guess.
8. Push: `git push -u origin <current-branch>`.
9. Open PR: `gh pr create --base main --fill`.
10. Enable auto-merge: `gh pr merge --auto --squash` (use the PR number from step 9 if needed).
11. Report the PR URL and confirm auto-merge status.

Do not force-push, do not skip steps, do not use `--no-verify`. If something fails, stop and tell the user.

The same workflow is available as a `/ship` slash command in the CLI/desktop; the slash command and these instructions are kept in sync.

### Rule 4: PRs auto-merge

Auto-merge is enabled on every PR opened by the ship workflow. The PR will merge into `main` automatically once required checks pass (currently none required, so PRs merge within ~seconds of opening).

---

## What this means for users on different surfaces

| Surface | Auto-branch | `/ship` command | Ship by saying "ship" | Branch protection |
|---|---|---|---|---|
| Claude Code CLI | ✅ hook + prompt | ✅ slash command | ✅ prompt | ✅ GitHub |
| Claude Code desktop | ✅ hook + prompt | ✅ slash command | ✅ prompt | ✅ GitHub |
| Claude Code browser (claude.ai/code) | ✅ prompt only | ❌ (use words instead) | ✅ prompt | ✅ GitHub |
| Plain `git push` from terminal | n/a | n/a | n/a | ✅ GitHub (rejects direct `main` push) |

**Bottom line for users:** open a session, work normally, say "ship it" when done. The session does the rest. No manual git, no manual PR, no manual merge — on any surface.

### Setup (one-time per developer)

- `brew install gh && gh auth login` (CLI/desktop users — the browser sandbox has `gh` pre-configured).
- Clone this repo. The `.claude/` config is committed — no other setup needed.

### Power-user escape hatches

- To intentionally work on `main` (e.g., release work): you can't. Open a PR.
- To skip the ship workflow and PR manually: push your feature branch with `git push -u origin <branch>` and open the PR in the GitHub UI. Branch protection still requires a PR.

---

## Repo conventions

- Commit messages: conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`). The ship workflow generates these automatically.
- File organization: by feature, not by type.
- Tests: 80% coverage target once code exists.

---

## Files in `.claude/`

These are CLI/desktop-only redundancy for the rules above. The prompt rules in this file are the source of truth.

| File | Purpose |
|---|---|
| `settings.json` | Wires the hooks below |
| `hooks/auto-branch.sh` | `SessionStart`: hard-enforces Rule 1 in the CLI |
| `hooks/block-main.sh` | `PreToolUse` on `Bash`: hard-enforces Rule 2 in the CLI |
| `commands/ship.md` | `/ship` slash command for CLI/desktop users — same sequence as Rule 3 |

---

## Architecture (high-level)

- **Frontend + API**: Next.js (App Router) on Vercel
- **Data store**: Notion databases (no separate DB). Five output DBs: Decisions, Themes, Entities, Open Questions, Cultural Signals.
- **Ingestion**: Vercel Cron hits `/api/ingest` every 30 min → reads recent meeting pages from a Notion source DB → distills via Claude → writes structured records to the five output DBs.
- **UI**: feed reads from the same Notion DBs.
- **`slack/`**: separate Notion-Workers scaffold owned by the Slack ingestion teammate. Untouched by the main app.

Env vars: see `.env.example`. Notion DB IDs must be filled in by the operator after creating the five output databases in Notion.

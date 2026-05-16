# Cerebro

Second-brain app that ingests text (transcripts, Slack, notes), distills it into structured categories (decisions, cultural signals, themes, open questions, entities), and forecasts when decisions need to be made. Visualizes connections between people, topics, and decisions.

Status: scaffolding. The product itself is not built yet — the workflow infrastructure is.

---

## Team workflow (MANDATORY for Claude Code sessions)

Multiple people use Claude Code against this repo. To avoid lost work, conflicting commits, and broken `main`, **every Claude Code session follows the branch-and-ship workflow below**. The rules are enforced by hooks in `.claude/`.

### The rules

1. **Never work directly on `main`.** When you open a session on `main`, the `SessionStart` hook automatically moves you to a fresh `feature/session-<timestamp>` branch. Don't fight it.
2. **`git commit` and `git push` are blocked on `main`.** A `PreToolUse` hook blocks both. If you somehow end up on `main`, the hook tells you to branch first.
3. **Ship features with `/ship`.** When a feature is complete, type `/ship`. Claude will commit, rebase against the latest `main`, resolve any conflicts inline, push the branch, open a PR, and enable auto-merge. The PR auto-merges into `main` once checks pass.
4. **Conflicts are resolved by Claude inside `/ship`.** When the rebase hits a conflict, Claude reads the file, understands both sides, and edits the merged result. If a conflict is semantically ambiguous (two different implementations of the same logic), Claude will stop and ask — never guesses.
5. **`main` is protected on GitHub.** Direct pushes are blocked at the remote. PRs are required. Auto-merge is enabled.

### What this means for you

- Open a Claude Code session → you're automatically on a feature branch.
- Work normally.
- When done, type `/ship`.
- Done. No manual git, no manual PR, no manual conflict resolution.

### Setup (one-time per developer)

- `brew install gh && gh auth login`
- Clone this repo. The `.claude/` config is committed — no other setup needed.

### Power-user escape hatches

- To intentionally work on `main` (e.g., release work): start the session, then `git checkout main`. The block-main hook will still prevent commits/pushes — disable hooks in your session settings if you really need to.
- To skip `/ship` and PR manually: push your feature branch with `git push -u origin <branch>` and open the PR in the GitHub UI.

---

## Repo conventions

- Commit messages: conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`). `/ship` generates these automatically.
- File organization: by feature, not by type.
- Tests: 80% coverage target once code exists.

---

## Files in `.claude/`

| File | Purpose |
|---|---|
| `settings.json` | Wires the hooks below |
| `hooks/auto-branch.sh` | `SessionStart`: moves you off `main` to a feature branch |
| `hooks/block-main.sh` | `PreToolUse` on `Bash`: blocks `git commit`/`push` when on `main` |
| `commands/ship.md` | `/ship` slash command: commit → rebase → resolve conflicts → push → PR with auto-merge |

---

## Product direction (TBD)

The Cerebro app itself hasn't been scaffolded yet. Open questions to settle before writing app code:

- **Stack**: Next.js+TS vs Python/FastAPI+React vs Streamlit
- **First data source**: pasted text vs Slack export vs both
- **Storage**: Supabase (Postgres+pgvector) vs local Postgres vs SQLite+sqlite-vec
- **MVP scope**: ingest+feed vs +graph viz vs +decision radar/forecasting

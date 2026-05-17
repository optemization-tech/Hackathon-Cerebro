---
author: optemism
date: 2026-05-17
topic: slack-brief-generators
---

# Slack A/B brief generators

Built `slack/src/lib/briefs.ts` with two exported generators (`generateBriefFormatA`, `generateBriefFormatB`) for the daily briefs A/B experiment. Format A produces Hindsight-typed sections (Decisions/Insights/Frameworks/Strategies/Signals/Projects/Tasks/People/Companies/Glossary Candidates/Open Threads). Format B produces a 3-5 paragraph day-in-the-life narrative (~600 words). Both wired to `claude-sonnet-4-6` via `@anthropic-ai/sdk` with exponential backoff retry, 500-message input cap, and 4096 output token cap. PR #93 opened with auto-merge enabled.

## Files changed
- slack/src/lib/briefs.ts (new — 200 lines)
- slack/package.json (added @anthropic-ai/sdk)
- slack/package-lock.json
- slack/.env.example (added ANTHROPIC_API_KEY)

## Next steps
- Session 1.4 (A/B runner) will call these generators over the test window
- Prompt iteration may happen after seeing real output on sample channel-days

Part of orchestrate run: https://www.notion.so/363a48662b2581f7a4c9f43a959594ec (Wave 1, Session 3).

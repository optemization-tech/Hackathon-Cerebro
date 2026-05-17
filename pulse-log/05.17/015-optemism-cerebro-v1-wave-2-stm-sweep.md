---
author: optemism
date: 2026-05-17
topic: cerebro-v1-wave-2-stm-sweep
---

# Wave 2 STM sweep: glossary normalization + Person Source backfill

Ran the full STM sweep across all 425 transcript rows (Circleback, Notion Meetings, Granola Meeting). Two passes: first with the initial 60-entry glossary (365 body updates, 17 Person Source sets), second after glossary was updated with Optemization-specific vocabulary (31 additional body updates, 17 more Person Source sets). All non-archived rows now have glossary-normalized bodies and Person Source attribution.

Root cause confirmed: Circleback anonymizes speakers as "Participant N" so person-name aliases never fire in transcript text — not a code bug. Glossary substitutions correctly apply to meeting titles, attendee names, and summary text. Patched the Circleback webhook handler to auto-populate Person Source on new events going forward.

Also: backlogged LLM backstop for glossary normalization uncertainty (clean() false positive/miss thresholds), and hotfixed CLAUDE.md with known Notion data source IDs + user UUIDs for faster DB discovery across sessions.

## Files changed
- circleback/scripts/sweep-stm.ts
- circleback/src/processing.ts
- circleback/src/index.ts
- circleback/src/processing.test.ts
- lib/cleaning/clean.test.ts
- BACKLOG.md
- CLAUDE.md

## Next steps
- Run `migrate-ids.ts --apply` for 22 Circleback rows with legacy IDs
- Verify DROP COLUMN "Entities" status on STM schema
- Grade session 2.4 via `/orchestrate-advance` in PM session

Part of orchestrate run: https://www.notion.so/362a48662b25816dad83d73444171f76 (Circleback Worker, Session 2.4 sweep).

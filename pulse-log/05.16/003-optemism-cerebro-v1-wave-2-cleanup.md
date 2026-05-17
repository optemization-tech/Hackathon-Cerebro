---
author: optemism
date: 2026-05-16
topic: cerebro-v1-wave-2-cleanup
---

# Wave 2 cleanup: drop Entities, simplify cleaning, align Circleback ID to uuidv5

Session 2.3 of the cerebro-v1-build orchestrate run. Shipped PR #46 — an atomic cleanup
across 19 files that collapses two architectural decisions made during Wave 2. Entity
extraction is now fully delegated to Hindsight; lib/cleaning returns a plain string and
carries no entity logic. All 4 copies (canonical + 3 vendored) are in sync. Circleback's
ID generation now matches Slack's uuidv5 pattern using a shared CEREBRO_NAMESPACE_UUID;
processMeeting() handles the transition window by checking both new and legacy ID formats.
Migration script at circleback/scripts/migrate-ids.ts is ready to run (22 rows, dry-run by
default). DROP COLUMN "Entities" deferred to post-migration step 5.

Part of orchestrate run: https://www.notion.so/362a48662b25816dad83d73444171f76 (Circleback Worker, Session 2.3 cleanup).

## Files changed
- circleback/scripts/backfill.ts
- circleback/scripts/migrate-ids.ts (new)
- circleback/src/cleaning/clean.ts, index.ts, types.ts
- circleback/src/processing.ts
- docs/specs/cerebro.md
- google/src/cleaning/clean.ts, index.ts, types.ts
- google/src/index.ts
- lib/cleaning/clean.test.ts, clean.ts, index.ts, types.ts
- slack/src/cleaning/clean.ts, index.ts, types.ts
- slack/src/index.ts

## Next steps
- Run circleback/scripts/migrate-ids.ts --dry-run (verify 22 rows)
- Run with --apply to migrate IDs
- DROP COLUMN "Entities" via notion-update-data-source MCP

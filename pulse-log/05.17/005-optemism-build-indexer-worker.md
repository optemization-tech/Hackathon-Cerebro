---
author: optemism
date: 2026-05-17
topic: build-indexer-worker
---

# Build Hindsight Indexer Worker (Phase-1 Minimum)

Built the production Indexer Worker at `indexer/` — a Notion Workers SDK project that bridges Short-Term Memory to Hindsight Cloud. The `indexerDelta` sync runs every 5 minutes, querying STM for `Status=pending` rows, calling Hindsight `retain()` in sync mode (`async: false`), and flipping Status to `indexed` or `failed`. The `reindexStmRow` tool provides manual single-row reprocessing with STM parent validation. Adapted the prototype-indexer logic with review fixes: Source via `getSelect()`, AbortController fetch timeout (30s), pacer rate limiting (10 req/s), and max 50 rows per cycle. No retry sync or STM schema migration (deferred to V1.1).

Part of `stm-hindsight-pipeline` Wave 2, Session 2.5 (U6). PR #63 merged.

## Files changed

- indexer/src/index.ts (new — worker definition, ~418 LOC)
- indexer/package.json (new)
- indexer/tsconfig.json (new)
- indexer/.env.example (new)
- indexer/README.md (new)
- CLAUDE.md (updated worker registry + repo layout)
- STATUS.md (marked Indexer Worker as built)

## Next steps

- Deploy: `cd indexer && ntn workers deploy && ntn workers env push`
- Seed `PERSON_SOURCE_SLUGS` with team Notion user IDs for cleaner person-source tags
- Wave 3 (Session 3.1) validates end-to-end extraction across all data types

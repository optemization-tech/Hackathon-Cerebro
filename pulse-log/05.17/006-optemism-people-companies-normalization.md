---
author: optemism
date: 2026-05-17
topic: people-companies-normalization
---

# People + Companies normalization across all source workers

Extended the cleaning pipeline to load People DB and Companies DB alongside the Glossary DB, so `clean()` normalizes person names and company names — not just glossary terms. Merged entries with Glossary-wins dedup (human-curated aliases take precedence). Added the cleaning pipeline to the meetings-ingest worker, which was previously writing raw transcript text to STM without any normalization.

Deployed Slack worker with all three data source IDs. Fresh-deployed meetings-ingest worker with cleaning + all three data source IDs. Google worker is code-ready but blocked on GCP domain-wide delegation (backlogged).

## Files changed
- lib/cleaning/glossary.ts (loadPeople, loadCompanies, loadAllEntries)
- lib/cleaning/index.ts (updated exports)
- lib/cleaning/clean.test.ts (6 new tests for multi-source normalization)
- slack/src/cleaning/glossary.ts (vendored mirror)
- slack/src/cleaning/index.ts (vendored mirror)
- slack/src/index.ts (loadEntriesOnce with People + Companies env vars)
- google/src/cleaning/glossary.ts (vendored mirror)
- google/src/cleaning/index.ts (vendored mirror)
- google/src/index.ts (loadEntriesOnce with People + Companies env vars)
- workers/meetings-ingest/src/cleaning/ (vendored cleaning library, new)
- workers/meetings-ingest/src/index.ts (clean() on transcript + title)
- workers/meetings-ingest/.env.example (new env vars documented)
- BACKLOG.md (Google worker deploy recipe)

## Next steps
- Deploy Google worker when GCP service account is created (see BACKLOG.md)

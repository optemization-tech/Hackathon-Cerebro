---
author: optemism
date: 2026-05-17
topic: clean-meetings-stm
---

# Clean all "Notion Meetings" STM pages + send to Hindsight

Ran a glossary-normalization sweep across all 190 "Notion Meetings" Short-Term Memory pages and flipped them to `pending` so the deployed Hindsight Indexer Worker re-indexes them. Built `scripts/clean-meetings-stm.ts` — a one-off script that loads glossary entries from a local cache (`scripts/glossary-cache.json`, 65 entries from the Glossary DB), reads each STM page's block content, applies the `clean()` regex normalization, writes the cleaned body back via `pages.updateMarkdown()`, and flips Status to "pending". Also upgraded root `@notionhq/client` to v5.21.0 for `ntn_` token support.

Results: 44 bodies cleaned, 146 unchanged, 189 statuses flipped (1 transient timeout). Indexer picks up pending rows on its 5-min cron (50/cycle → ~20 min).

## Files changed
- package.json
- package-lock.json
- scripts/clean-meetings-stm.ts
- scripts/glossary-cache.json

## Next steps
- Re-run script for the 1 timed-out page
- Consider adding People + Companies DB entries to the glossary cache for deeper normalization

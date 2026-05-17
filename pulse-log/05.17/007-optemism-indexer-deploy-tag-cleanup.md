---
author: optemism
date: 2026-05-17
topic: indexer-deploy-tag-cleanup
---

# Indexer deploy + Hindsight tag cleanup

Aligned meetings-ingest Hindsight tags: Data Type changed from "Notion Meetings" to "meeting transcript", added explicit Source: "Notion" property (PR #87). Removed redundant `stm:` tag from indexer since `document_id` already carries the STM row ID (PR #87). Removed `team:optemization` static tag — the Hindsight bank is already scoped to optemization-cerebro (PR #89). Deployed the indexer worker to Notion for the first time and triggered re-indexing of 50 pending STM rows. Saved the new Notion PAT ("STM Indexer") to 1Password.

## Files changed
- workers/meetings-ingest/src/index.ts
- indexer/src/index.ts
- indexer/workers.json (new — deploy config)
- indexer/.env (new — not committed, secrets)

## Next steps
- Monitor indexer 5m schedule picking up remaining pending rows
- Verify updated tags in Hindsight after re-index completes

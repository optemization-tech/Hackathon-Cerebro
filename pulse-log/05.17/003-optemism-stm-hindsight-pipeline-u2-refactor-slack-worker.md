---
author: optemism
date: 2026-05-17
topic: stm-hindsight-pipeline-u2-refactor-slack-worker
---

# Refactor Slack worker: narrative-only STM body

Refactored `slack/src/index.ts` so the STM page body contains only cleaned narrative message text — no `## Message` / `## Metadata` headings, no bullet list of IDs/permalinks/channels. All metadata (slackUserId, channelId, channelName, teamId, workspaceName, threadTs, messageTs, permalink, senderEmail, senderName, senderRealName) moved to a `Metadata` rich_text property as a JSON blob. Added the `Metadata` property to the STM database schema via Notion API. Existing properties (ID, Name, Data Type, Status, Person Source, Event Date) unchanged.

This is Session 2.1 of the STM-Hindsight pipeline orchestrate run (Wave 2). The refactor ensures the Hindsight Indexer feeds narrative content only into `retain()`, improving extraction quality.

## Files changed
- slack/src/index.ts

## Next steps
- Deploy the slack worker (`ntn workers deploy` in `slack/`) to start ingesting with the new format
- Other Wave 2 workers (google, meetings-ingest) should adopt the same Metadata JSON pattern

Part of orchestrate run: https://www.notion.so/363a48662b258151b0a3c3157bbb52cd (Wave 2, Session 1).

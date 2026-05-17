---
author: optemism
date: 2026-05-17
topic: slack-brief-write-pipeline
---

# Slack brief write pipeline

Built `slack/src/lib/write-pipeline.ts` exporting `writeBrief(notion, hindsight, input)` — the STM upsert + optional Hindsight retain function for daily channel briefs. Idempotent via `slack-brief_{channelId}_{date}[_{format}]` ID key with dedup query. Sets all required STM properties (Name, ID, Data Type = "Slack daily brief", Source = Slack, Status = pending, Event Date, Metadata JSON). Optional direct Hindsight retain for A/B experiment mode with full tag set. PR #94 merged via auto-merge.

## Files changed
- slack/src/lib/write-pipeline.ts (new)

## Next steps
- Sessions 1.1–1.3 complete their Wave 1 work
- Wave 2 sessions consume `writeBrief` for experiment + backfill

Part of orchestrate run: https://www.notion.so/363a48662b2581f7a4c9f43a959594ec (Wave 1, Session 4).

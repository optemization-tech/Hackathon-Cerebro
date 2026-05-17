---
author: optemism
date: 2026-05-17
topic: refactor-meetings-ingest
---

# Refactor meetings-ingest worker for STM pipeline

Refactored `workers/meetings-ingest/src/index.ts` so the Hindsight Indexer can extract useful memory units from meeting rows. Body is now narrative-only (brief, tldr, summary, transcript) with no metadata preamble. Meeting metadata (calendarPageId, type, source, gcalUrl, recordingUrl, attendees) moved to a `Metadata` JSON rich_text property. Added `Status: pending` so the Indexer's delta query picks up new rows.

Note: the brief specified `Status: cleaned` but the actual post-Session-1.1 convention is `pending` (Slack worker already uses `pending`, Indexer queries `Status = pending`). Used `pending` to match the deployed convention.

## Files changed
- workers/meetings-ingest/src/index.ts

## Next steps
- Deploy worker: `cd workers/meetings-ingest && ntn workers deploy`
- Trigger delta sync to verify: `ntn workers sync trigger meetingsDelta`
- Close out orchestrate session row 363a48662b25810a888decc9bbb7fb1a

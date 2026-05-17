# Cerebro Indexer Worker

Bridges Short-Term Memory rows to the Hindsight Cloud memory bank. Runs on a 5-minute schedule, picking up `Status: pending` rows, calling Hindsight `retain()` in sync mode, and flipping Status to `indexed` (or `failed`).

## Setup

```bash
cd indexer
npm install
cp .env.example .env
# Fill in NOTION_API_TOKEN and HINDSIGHT_API_KEY
```

## Capabilities

| Capability | Type | Schedule | What it does |
|---|---|---|---|
| `indexerDelta` | sync | 5m | Queries STM for Status=pending, retains each to Hindsight, flips to indexed/failed |
| `reindexStmRow` | tool | manual | Reprocesses a single STM row (resets to pending, then retains) |

## Development

```bash
npm run check                                          # type-check
ntn workers exec indexerDelta --local                  # run delta sync locally
ntn workers exec reindexStmRow --local -d '{"stmPageId":"<page-id>"}'  # reindex one row
```

## Deployment

```bash
ntn workers deploy
ntn workers env push                                   # push NOTION_API_TOKEN + HINDSIGHT_*
ntn workers sync status                                # verify HEALTHY
```

## Architecture

- **Status lifecycle:** source workers write `pending` → Indexer flips to `indexed` (success) or `failed` (error).
- **Retain mode:** `async: false` (sync). ~3s per row. Honest Status semantics — `indexed` means Hindsight actually extracted.
- **Idempotent:** `document_id` is the STM `ID` property (deterministic hash from source workers). Re-retaining the same document_id upserts in Hindsight.
- **Rate limiting:** pacer at 10 req/s shared across sync and tool.
- **Fetch timeout:** 30s via AbortController on each Hindsight API call.

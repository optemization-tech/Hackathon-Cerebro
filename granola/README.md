# Granola Source Worker — Cerebro

Ingests Granola.so meeting notes into Short-Term Memory (STM) in Notion. The Hindsight Indexer Worker (5-min cron) handles `retain()` from STM — this worker never calls Hindsight directly.

Each page in STM gets the Granola summary (structured markdown from Granola's AI), the full transcript (formatted with timestamps and speaker labels), and metadata (Granola ID, title, dates, source URL, attendees). `Person Source` is populated from the Granola note `owner.email` matched to a Notion workspace user.

## Architecture

```
Granola API → pullGranola (newest-first, year-scoped, folder-filtered)
    → notion.pages.create (with summary + transcript + Person Source)
    → STM (Data Type: "Granola Meeting") → [Indexer Worker picks up]
```

Backfill paginates the full 2026 dataset; cursor is persisted in sync state so multi-run drains chain automatically when the platform's ~5-min execution budget is exhausted.

## Capabilities

### Syncs

| Key | Schedule | Description |
|-----|----------|-------------|
| `granolaMeetingsBackfill` | Manual | Paginates all 2026 Granola notes from newest to oldest. Saves cursor to state and returns `hasMore: true` when the 4-min budget elapses, so the platform auto-chains continuations. |
| `granolaMeetingsDelta` | Every 5m | Fetches notes with `updated_after = lastSyncTime` (or last hour on first run). Same filters and write path as backfill. |

### Tools (agent-callable)

| Key | Description |
|-----|-------------|
| `ingestGranolaMeetings` | On-demand ingest, callable from Notion AI / Custom Agent. Runs the same `pullGranola` loop with the same 4-min budget; returns a summary string with the option to call again if `hasMore` is set. |

## Filters

The worker writes a Granola note to STM only if it passes ALL of:

1. **2026-only** — `created_at` year must be 2026. Pre-2026 stubs short-circuit pagination (newest-first ordering).
2. **Folder blocklist** — skips notes whose `folder_membership` includes `Personal`, `BeTema`, or `Default` (case-insensitive match on folder name).
3. **Deduplication** — UUID v5 derived from `granola://<noteId>` against the `ID` rich-text property in STM. Already-ingested notes are skipped.

Unfiled notes (empty `folder_membership`) are accepted by default. Personal voice memos that leak through can be cleaned up by moving them to the `Personal` folder in Granola and running `scripts/cleanup_leaked_personal.py`.

## Environment variables

Set via `ntn workers env set KEY=value`.

| Variable | Required | Description |
|----------|----------|-------------|
| `NOTION_API_TOKEN` | Yes (for syncs) | Notion internal integration token (`ntn_...`). Needed for syncs; tools are pre-authenticated when invoked via a Notion Custom Agent. Create at https://www.notion.so/profile/integrations/internal and grant access to the STM database. |
| `GRANOLA_API_KEY` | Yes | Granola.so API key (`grn_...`). Retrieve from Granola desktop: Settings → Connectors → API keys. |

## Commands

```shell
# Deploy
ntn workers deploy

# Trigger a full backfill (resets cursor first)
ntn workers sync state reset granolaMeetingsBackfill && ntn workers sync trigger granolaMeetingsBackfill

# Check sync health
ntn workers sync status

# View latest run summary
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}

# On-demand ingest (run the tool)
ntn workers exec ingestGranolaMeetings -d '{}'
```

## Source modules

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker entry: types, helpers (uuid5, formatTranscript, buildMarkdown, loadEmailToUserId), `pullGranola` loop, sync + tool registrations |

## Ops scripts

Python utilities for one-off cleanup / migration tasks. Run from a terminal; they read credentials from the repo's `.env` (path is hardcoded — adjust if running from a different machine).

| Script | Purpose |
|--------|---------|
| `scripts/cleanup_leaked_personal.py` | Audit active Granola Meeting pages in STM; archive any whose underlying Granola note is currently in `Personal`/`BeTema`/`Default`. Run after bulk-filing personal notes in Granola. |
| `scripts/cleanup_hybrid.py` | Historical: applies an unfiled-and-solo heuristic. Retained for reference; the current filter is just the folder blocklist. |
| `scripts/restore_archived.py` | Historical: unarchives Granola Meeting pages via Notion search. Largely obsolete now that the worker auto-recreates pages when filters change. |

## Notes on Granola API quirks

- **Pagination is newest-first by `created_at`**, with opaque cursors. Cursor decodes to `{ created_at, last_doc_id }`.
- **Rate limit: 5 req/s sustained.** The worker's `granolaApi` pacer is configured to this.
- **`updated_after` IS honored** by `GET /v1/notes` — confirmed by passing a future date and getting 0 results.
- **`folders` endpoint is paginated** even when there are only ~40 folders; iterate via `hasMore`/`cursor`.
- **Transcript shape**: `Array<{ text, start_time, end_time, speaker: { source } }>` — `speaker.source` is `"me"`, `"speaker"`, or `"microphone"`. The worker labels them as `Me` / `Other` / raw source value respectively, and groups consecutive same-speaker segments into a single paragraph with a leading `[mm:ss]` offset.
- **Solo recordings without calendar invite** list only the owner in `attendees`. The worker keeps these because impromptu work calls share the same shape; the user files true personal voice memos to `Personal` in Granola when noticed.

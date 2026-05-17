# Meetings Ingest Worker

Reads the Notion Calendar DB for meeting entries, extracts transcripts from page content, cleans them through the Glossary normalization library, and writes cleaned text to Short-Term Memory.

## Setup

```bash
cd workers/meetings-ingest
npm install
```

Set `GLOSSARY_DATA_SOURCE_ID` in your environment. The STM data source ID is hardcoded to the shared workspace DB.

## Capabilities

| Capability | Type | What it does |
|---|---|---|
| `ingestMeetings` | sync | Queries Calendar DB, extracts transcripts, cleans via Glossary, writes to STM |

## Architecture

- **Source**: Notion Calendar DB (meeting pages with transcripts in page body)
- **Cleaning**: Uses `lib/cleaning/` — the shared Glossary normalization library. Loads entries from the Glossary DB and normalizes entity names before writing.
- **ID determinism**: Document IDs are SHA-256 hashes for idempotent upserts.
- **Output**: Cleaned rows in Short-Term Memory with `Status: pending` for the Indexer to pick up.

## Development

```bash
ntn workers exec ingestMeetings --local
```

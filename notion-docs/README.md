# Notion-Docs source worker

> **Status: PARKED.** Reconstructed on `parked/wave-2-u8-u10-notion-docs-indexer` branch from the original Wave 2 worker session before scope narrowed. Typechecks but never deployed or verified end-to-end. Pick this up in a follow-up session — see "How to resume" below.

Watches one or more Notion databases (Optemization Docs, Granola mirror) and writes new + edited rows into Short-Term Memory.

## What it watches

Configurable via env. Each configured data source becomes a watched DB:

| Source slug | Data Type | Env var |
|---|---|---|
| Notion | Note | `OPTEMIZATION_DOCS_DATA_SOURCE_ID` |
| Granola | Notion Meetings | `GRANOLA_DATA_SOURCE_ID` (optional) |

The Optemization Docs DB is `7770dd47209b49098dad46ec0d4dcb3b` — resolve its data source ID with `ntn datasources resolve 7770dd47209b49098dad46ec0d4dcb3b` and put the result in `OPTEMIZATION_DOCS_DATA_SOURCE_ID`.

Granola is optional — only enable if Tem's Granola↔Notion mirror is configured and the mirror destination is a Notion DB this worker's integration can read.

## What it does (per source page)

1. `worker.sync("notionDocsDelta", { schedule: "30m" })` queries non-archived rows where `last_edited_time > cursor[dataSourceId]`.
2. Flattens the page body to plain text via `notion.blocks.children.list` (skips child databases and embeds; depth-capped at 6).
3. Extracts the title from whichever property has `type: "title"`.
4. Applies `clean()` (Glossary normalization) to title + body. Recognized entities get JSON-stringified into the STM row's `Entities` property.
5. Writes a `Status: pending` row into Short-Term Memory.
6. Dedup ID: `notion-doc:<page-id>:<last-edited-time>`.

## Re-edit behavior

The dedup ID encodes `last_edited_time`. If a page gets re-edited upstream, the next sync produces a **new STM row** (the previous row remains in place, reflecting the older snapshot). The Indexer's `document_id` is the STM page ID, so each STM row is its own Hindsight memory.

**Why not in-place update?** Hindsight retain's idempotency is per `document_id`. Producing a new STM row per edit preserves the history of versions — useful when the audit trail matters. If you want only the latest version visible in `recall`, run the Indexer once over the new row (overwrites the latest fact) and add a cleanup script that archives the older STM row.

## How to resume

```sh
git checkout parked/wave-2-u8-u10-notion-docs-indexer
cd notion-docs
npm install
npm run check
```

Then verify against current STM schema (a `Source` property may have been added after this work was parked — adjust the writes if so), deploy:

```sh
ntn login
ntn workers deploy
ntn workers env push    # NOTION_API_TOKEN, OPTEMIZATION_DOCS_DATA_SOURCE_ID, GLOSSARY_DATA_SOURCE_ID
ntn workers sync trigger notionDocsBackfill   # one-time backfill
```

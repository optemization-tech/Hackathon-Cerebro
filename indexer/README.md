# Hindsight Indexer worker

> **Status: PARKED.** Reconstructed on `parked/wave-2-u8-u10-notion-docs-indexer` branch from the original Wave 2 worker session before scope narrowed. Typechecks but never verified end-to-end against real STM data (a verified dry run flipped 50 STM rows to `failed` and was reverted; see "Verified during build" below). Pick this up in a follow-up session — see "How to resume" below.

Polls Short-Term Memory every 5 minutes for `Status: pending` rows and pushes them into the `Cerebro` Hindsight Cloud bank via the retain endpoint. The only Cerebro worker that calls Hindsight.

## What it does

1. Queries STM (`362a4866-2b25-801c-9ce5-000b30156f9b`) for rows where `Status = pending`. Caps batch at 50/run.
2. Loads all Notion `person` users into a Map (used to slug `Person Source` for `person-source:<slug>` tags). Falls back gracefully when the integration token can't list users.
3. For each row:
   - Reads `Data Type`, `Person Source`, `Entities` (JSON), `created_time`.
   - Flattens the row's page body to plain text.
   - Builds tags: `team:optemization`, `source:<slug>`, `data-type:<kebab>`, `stm:<page-id>`, optional `person-source:<slug>`, `verified:true` (Notion source only).
   - POSTs to `https://api.hindsight.vectorize.io/v1/default/banks/Cerebro/memories` with `{ items: [{content, context, timestamp, document_id, tags, entities}], async: true }`.
   - On 200 → flips Status to `indexed`. On 4xx/5xx → `failed`. On 429 → 5s backoff × 3 retries before failing.

### Retain endpoint

The correct retain endpoint (per Hindsight Cloud OpenAPI v0.5.6) is:

```
POST /v1/{namespace}/banks/{bank_id}/memories
```

(NOT `/memories/retain` — that returns 405 — and NOT `/memory/retain` — that returns 404. Both common guesses based on the SDK docs.)

### Source derivation (no STM `Source` property)

STM doesn't have a `Source` property yet (Wave 1 only added Entities + Status options). The Indexer derives source slug + verified flag from Data Type:

| Data Type | source slug | verified |
|---|---|---|
| Slack message | slack | false |
| Email | gmail | false |
| Calendar Event | gcal | false |
| Circleback transcript | circleback | false |
| Notion Meetings | notion-meetings | false |
| Note | notion | **true** |
| Documents | notion | **true** |

When STM gets a `Source` property, simplify by reading it directly.

## Verified during build (parked session)

- TypeScript clean (`tsc --noEmit`).
- Bank existence verified: `GET /v1/default/banks` returns `bank_id: "Cerebro"`.
- Retain endpoint shape verified against the live OpenAPI spec.
- **Dry-run side-effect**: one test cycle ran against 50 real pending STM rows with the wrong URL path. All 50 flipped to `Status: failed`. They were reverted to `pending` in the same session before the work was parked, so no data was lost.

## How to resume

```sh
git checkout parked/wave-2-u8-u10-notion-docs-indexer
cd indexer
npm install
npm run check
```

If the STM schema has since grown a `Source` property, swap the `deriveSourceFromDataType` fallback for a direct property read. Then:

```sh
ntn login
ntn workers deploy
ntn workers env push    # NOTION_API_TOKEN, HINDSIGHT_API_KEY
ntn workers sync trigger hindsightIndexer   # run once to verify
ntn workers runs list --plain | grep hindsightIndexer | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

After a successful run, confirm the result in Hindsight's UI:
- Open https://ui.hindsight.vectorize.io/banks/Cerebro
- Check **Memories** — new entries should appear with the STM tags applied.

## Failure modes

- **Empty body** — the integration is likely missing access to the row's page content. The worker flips the row to `Status: failed` and logs the page ID. Share the page with the integration and flip the row back to `pending`.
- **`HINDSIGHT_API_KEY` missing** — the sync errors at startup. Push the key via `ntn workers env push`.
- **Bank not found** — verify `HINDSIGHT_BANK_ID=Cerebro` matches the live bank URL slug (not the display name).
- **PAT scope** — Notion Personal Access Tokens can't list or retrieve users. Indexer logs a warning and continues without `person-source:<slug>` tags. Use an internal integration token for full functionality.

# Source:notion trace — origin investigation

Investigation date: 2026-05-17
Session: stm-hindsight-pipeline 1.2 (trace-source-notion)

## Summary

The Cerebro Hindsight bank (`optemization-cerebro`, bank_id `Cerebro`) contains 11 documents tagged `source:notion` producing 105 memory units. These were all retained in a ~26-second burst on 2026-05-17 between 02:11:06 and 02:11:32 UTC. This report traces their origin and recommends how to handle them going forward.

## Findings

### What exists

| Metric | Value |
|---|---|
| Total bank documents | 17 |
| Total bank memory units (nodes) | 254 |
| `source:notion` documents | 11 |
| `source:notion` memory units | 105 |
| `source:gcal` documents | 4 |
| `source:cerebro-bootstrap` documents | 1 |
| Untagged (idempotency test) | 1 |

### Origin: the parked Wave 2 indexer

The `source:notion` documents were produced by the **parked indexer** from commit `a814a83` (`parked/wave-2-u8-u10-notion-docs-indexer`), run during the Wave 2 session (2.1) on 2026-05-16 evening PDT.

**Evidence chain:**

1. **Context string match.** The retain_params.context values on the Hindsight documents are `"Documents from notion"` and `"Documents from notion by tem"`. This exact pattern is constructed by the parked indexer's context builder at `indexer/src/index.ts`:
   ```ts
   if (dataType) contextParts.push(dataType);           // → "Documents"
   if (derived) contextParts.push(`from ${derived.source}`);  // → "from notion"
   if (personSlug) contextParts.push(`by ${personSlug}`);     // → "by tem"
   ```
   No other code in the repo produces this pattern.

2. **Tag signature match.** Each document carries `source:notion`, `data-type:documents`, `verified:true`, `stm:<page-id>`, `team:optemization`, optionally `person-source:tem`. This exact combination is produced by the parked indexer's `deriveSourceFromDataType()` function, which maps `Data Type = "Documents"` to `{ source: "notion", verified: true }` and then builds tags via `buildTags()`. The main-branch `hindsight-indexer` (`workers/hindsight-indexer/src/index.ts`) has **no mapping for "Documents"** in its `DATA_TYPE_TAGS` and does **not** emit `verified:true` at all.

3. **Timeline.** The parked commit is timestamped 2026-05-16T19:31:37-07:00 (= 2026-05-17T02:31:37 UTC). The retains happened at 02:11 UTC — 20 minutes before the commit, during the same session. The session likely ran the indexer code locally before parking the branch.

4. **Document IDs are STM page IDs.** All 11 document IDs follow the `363a4866-2b25-*` Notion page ID format, matching Short-Term Memory pages. The indexer uses `documentId: page.id` when calling `retainContent()`.

5. **Pulse log contradiction.** The Wave 2 pulse log (`002-optemism-cerebro-v1-wave-2-circleback-cleaner.md`) states "No memories were written to Hindsight by this session — bank stats showed 12 pre-existing documents, all dated before the session started." This is incorrect — the 11 `source:notion` documents exist. The discrepancy likely arose because: (a) the retain calls used `async: true`, so they returned immediately but hadn't been processed when the session checked bank stats, or (b) the session's self-assessment was written before the indexer test run completed.

### Source content: Optemization Docs Database

The 11 documents contain content from the **Optemization Docs Database** — Notion pages covering internal docs like hiring posts, workspace architecture guides, engagement portal standards, and operational frameworks. The `preamble.ts` wrapper in `workers/documents-ingest/` prepends structured metadata (title, type, scope, status, created/last-edited dates, docs page ID) before the page body.

The `documents-ingest` worker (`workers/documents-ingest/src/index.ts`, added in commit `8ce885b` by Chris) wrote these pages to STM with `Data Type: "Documents"` and `Status: "pending"`. The parked indexer then read them from STM and retained them to Hindsight.

### STM page IDs (for cross-reference)

| STM Page ID | Memory Units | Text Length | Person Source |
|---|---|---|---|
| 363a4866-2b25-8133-a7d2-c62c81a11619 | 8 | 8,020 | tem |
| 363a4866-2b25-8195-9c8f-c7169d5f97e2 | 10 | 3,227 | tem |
| 363a4866-2b25-813c-bbff-d57c8c9d4eb7 | 7 | 3,710 | — |
| 363a4866-2b25-814c-aa2a-ed53f16f58ea | 10 | 5,730 | — |
| 363a4866-2b25-81d9-a4d8-f659131f1c79 | 11 | 5,113 | — |
| 363a4866-2b25-817f-864d-c9aab2e86b49 | 25 | 13,226 | — |
| 363a4866-2b25-813f-adbb-e2d3cb75fa87 | 4 | 1,912 | — |
| 363a4866-2b25-81c6-a6fa-f788b8e13dd4 | 9 | 6,175 | — |
| 363a4866-2b25-81cf-8060-c08a0660e9c7 | 12 | 5,848 | — |
| 363a4866-2b25-8142-a8ea-c4333c78a9cb | 5 | 2,725 | tem |
| 363a4866-2b25-817f-88ad-eeb16b260212 | 4 | 2,887 | tem |

## Tag quality issues

The existing tags use **two overlapping tags** to identify content origin: `source:notion` + `data-type:documents`. The STM database already has a single `Data Type` select property that encodes both the source system and content type (e.g., "Documents", "Slack message", "Calendar Event", "Notion Meetings"). The Hindsight tag scheme should mirror this: one `data-type:` tag per document, no separate `source:` tag.

This affects **all** documents in the bank, not just the `source:notion` ones — the gcal docs also carry redundant `source:gcal` alongside `data-type:calendar-event`.

The correct canonical tag set per document should be:
- `data-type:<kebab-STM-Data-Type>` (e.g., `documents`, `slack-message`, `calendar-event`, `circleback-transcript`, `notion-meetings`, `note`, `granola-meeting`)
- `verified:true` (only for `documents` and `note` — human-edited Notion content)
- `team:optemization`
- `stm:<page-id>`
- `person-source:<slug>` (when available)

No `source:` tag. The data type IS the source identifier.

**Status: backlogged.** Tag cleanup deferred to the production indexer build. Existing content is preserved as-is — the extracted memory units are usable even with the redundant tags. See `BACKLOG.md` for the cleanup item.

## Recommendation: Preserve (tag cleanup backlogged)

**Preserve** the 105 existing memory units. The content is real, high-quality, and correctly extracted. The tags have a redundant `source:` dimension that should be dropped, but this is a bank-wide convention change that applies to all documents (not just these 11) and should be done once when the production indexer ships.

The STM rows are the durable store. When the production indexer re-retains these pages with corrected tags, Hindsight will update the existing documents (dedup by `document_id` = STM page ID). No deletion needed — just re-retain with the right tags.

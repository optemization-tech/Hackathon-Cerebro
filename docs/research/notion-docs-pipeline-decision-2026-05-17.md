# Notion Docs pipeline decision

Investigation date: 2026-05-17
Session: stm-hindsight-pipeline 2.9 (redesign-notion-docs-worker)

## Question

Should the Notion Docs worker (Optemization Docs DB `7770dd47209b49098dad46ec0d4dcb3b`) flow through Short-Term Memory like all other source workers, or write directly to Hindsight since Docs are already persistent in Notion?

## Context

- The existing `workers/documents-ingest/` worker (built by Chris) already writes Docs DB pages to STM with `Data Type: "Documents"`, `Status: "pending"`. It has three syncs: `docsBackfill`, `docsDelta`, `docsVerified`.
- The Hindsight Indexer at `indexer/src/index.ts` picks up `Status = pending` rows and calls `retain()`. It infers `source: notion` from `Data Type = "document"`.
- 105 `source:notion` memory units already exist in the Cerebro bank from a parked indexer test run (Session 2.1). These use STM page IDs as `document_id` and carry `stm:<page-id>` tags.
- The `cerebro.md` spec explicitly states: "Source workers never call Hindsight directly. The Indexer Worker is the sole Hindsight writer."
- Unlike Slack messages, emails, and calendar events, Docs are **already persistent and curated in Notion**. They're human-authored, edited over time, and represent verified organizational knowledge.

## Approaches evaluated

### Path 1: via-STM (current documents-ingest approach)

**Flow:** Docs DB page -> documents-ingest worker -> STM row (Status: pending) -> Indexer -> Hindsight retain

**Pros:**
- Consistent with all other source workers (Slack, Google, Meetings)
- Single Indexer remains sole Hindsight writer (clean separation)
- STM provides unified audit trail across all sources
- Worker already exists and has run successfully (produced the 105 units)
- `Captured From` citation path works for the downstream Sync Worker

**Cons:**
- **Edit handling is broken.** The UUIDv5 dedup key (`notion-docs://<docs-page-id>`) means once a doc is ingested, subsequent edits are silently skipped. The STM snapshot becomes stale immediately. The `docsDelta` sync detects `last_edited_time` changes but then finds the existing STM row via dedup and returns `created: false`.
- **Data duplication.** Copying persistent, curated documents into STM is redundant. STM was designed for ephemeral external inputs (Slack messages, emails) that don't otherwise live in Notion.
- **Extra latency.** Docs change -> STM write -> 5-min Indexer cron -> Hindsight. For content already inside Notion.
- **STM bloat.** Long-form docs (some 13K+ chars) inflate STM, which was designed for shorter ingestion units.

### Path 2: direct-to-Hindsight (bypass STM entirely)

**Flow:** Docs DB page -> new "notion-docs" worker -> Hindsight retain() directly

**Pros:**
- No data duplication. Docs DB is the canonical store; Hindsight indexes it directly.
- Edit handling is natural: delta sync detects `last_edited_time` changes, re-retains with same `document_id`, Hindsight upserts in place.
- Lower latency: one hop instead of two.
- Conceptually clean for persistent, already-in-Notion content.

**Cons:**
- **Breaks the core architecture.** cerebro.md says "The Indexer Worker is the sole Hindsight writer." This creates a second writer.
- **Split credentials and rate limiting.** Two workers now manage Hindsight API keys, retries, and rate budgets independently.
- **No STM audit trail.** Docs content doesn't appear in the STM feed. Loses "everything in one place" uniformity.
- **No `Captured From` for Long-Term Memory.** The Sync Worker uses `stm:<page-id>` tags for citations. Without an STM row, there's no citation primitive.
- **Tag divergence.** The 105 existing units use STM page IDs; new units would use Docs page IDs — two conventions in the same bank.

### Path 3: via-STM with edit-aware upsert (hybrid)

**Flow:** Docs DB page -> documents-ingest worker -> STM row (create or UPDATE + reset Status) -> Indexer -> Hindsight retain

**How it differs from Path 1:** When `docsDelta` detects an edited doc whose STM row already exists, it **updates** the STM page's body content and resets `Status` to `pending`. The Indexer then picks it up and re-retains to Hindsight with the same `document_id` (upsert).

**Pros:**
- Preserves the architecture (single Indexer writer)
- STM audit trail maintained
- Edit handling works correctly — edits propagate through the full pipeline
- Consistent with all other sources
- Existing 105 units don't need cleanup (same `document_id` convention)
- `Captured From` citations still work for the Sync Worker

**Cons:**
- Requires the documents-ingest worker to UPDATE existing STM pages, not just create them. This is ~30 lines of new logic in `upsertDoc()`.
- Still has data duplication, though synchronized on delta cycles.
- Still has 5-min extra latency vs direct — acceptable for curated docs that change infrequently.

## Recommendation: Path 3 (via-STM with edit-aware upsert)

**Rationale:**

1. **Architecture integrity outweighs latency savings.** The "Indexer is the sole Hindsight writer" principle exists for operational reasons (single credential manager, unified rate limiting, easy engine migration). Breaking it for one source type creates maintenance debt.

2. **Edit handling is the critical gap.** The current `documents-ingest` worker can't handle edits. That's the real problem Session 2.7 hit. Path 3 solves it with a small code change.

3. **The existing worker is 90% complete.** Chris's `workers/documents-ingest/` already handles Docs DB reading, preamble building, content extraction, filtering, and dedup. Adding edit-aware upsert is incremental.

4. **Consistent `document_id` with the 105 existing units.** They use STM page IDs. Path 3 preserves this. Path 2 would create divergent IDs requiring a bank cleanup.

5. **Docs edit infrequently.** The extra latency of STM intermediate (5-10 min) is irrelevant for documents that change days or weeks apart.

## Implementation plan

### Files to modify

| File | Change |
|---|---|
| `workers/documents-ingest/src/index.ts` | Add edit-aware upsert to `upsertDoc()`: when dedup finds existing STM row, compare source doc's `last_edited_time` against STM row's `created_time`. If source is newer, UPDATE the STM page body + properties and reset Status to `pending`. |
| `workers/documents-ingest/src/index.ts` | Refine `docsDelta` to pass through `last_edited_time` for comparison. |
| `workers/documents-ingest/src/index.ts` | Add `Source: { select: { name: "Notion" } }` property write (Indexer currently infers source from data type, but explicit is better). |
| `indexer/src/index.ts` | Add `"documents"` to `inferSourceFromDataType` for explicit mapping (already handles "document" lowercase — verify it works with "Documents" as written by the worker). |

### Implementation details

**Edit detection logic in `upsertDoc()`:**

```typescript
// If STM row exists, check if source doc was edited after STM ingestion
if (cached) {
  const sourceLastEdited = docsPage.last_edited_time;
  // Fetch the cached STM row's last edit time for comparison
  const stmPage = await notion.pages.retrieve({ page_id: cached.pageId });
  const stmLastEdited = (stmPage as any).last_edited_time;
  
  if (sourceLastEdited && stmLastEdited && sourceLastEdited > stmLastEdited) {
    // Source doc was edited after STM snapshot — update STM
    const content = await fetchPageContent(notion, docsPage.id);
    if (content.trim().length < 50) return { ... };
    
    const preamble = buildPreamble(row);
    const markdown = [preamble, "## Content\n", content].join("\n\n");
    
    // Update the page body + reset Status to pending
    await replacePageBody(notion, cached.pageId, markdown);
    await notion.pages.update({
      page_id: cached.pageId,
      properties: { Status: { select: { name: "pending" } } }
    });
    
    return { id, pageId: cached.pageId, pageUrl: ..., created: false, updated: true };
  }
  
  return { id, pageId: cached.pageId, pageUrl: ..., created: false, updated: false };
}
```

**Body replacement** uses the Notion API's `notion.blocks.children.list()` to get existing blocks, `notion.blocks.delete()` to clear them, then `notion.blocks.children.append()` with new markdown content. Alternatively, use the page-level markdown write via `notion.pages.update()` if the Workers SDK supports it.

### Deployment

```shell
cd workers/documents-ingest/
npm install
npm run check
ntn workers deploy
ntn workers env push  # DOCS_DATA_SOURCE_ID=7da0cbf5-c760-44a9-a0a4-2fe239efa796
ntn workers sync trigger docsBackfill  # full initial ingest
```

### Verification

1. Trigger `docsBackfill` — all non-archived, non-draft docs should appear in STM with `Status: pending`.
2. Wait for Indexer cycle — STM rows should flip to `indexed`.
3. Edit a doc in the Docs DB — next `docsDelta` cycle should UPDATE the STM row and reset Status to `pending`.
4. Wait for Indexer — the updated row re-indexes, Hindsight upserts the memory in place.
5. Check Hindsight bank: new `source:notion` documents should appear with `data-type:documents` and `verified:true` tags.

## Decision log

| Date | Decision | Decided by |
|---|---|---|
| 2026-05-17 | Recommended Path 3 (via-STM with edit-aware upsert) | Session 2.9 |
| 2026-05-17 | **Tem chose Path 2 (direct-to-Hindsight)** + delete old 105 units and re-ingest fresh | Tem |

### Rationale for overriding the recommendation

Tem challenged the premise: STM was designed for ephemeral external data (Slack, email, calendar). Notion Docs are already persistent, curated, internal. Putting them in STM duplicates data that already has a canonical home. The "sole Indexer writer" principle was designed for external sources — it doesn't need to apply to internal Notion content.

### Chosen implementation

- New worker at `notion-docs/` (repo root, consistent with `slack/`, `google/`)
- Reads Docs DB → calls Hindsight `retain()` directly, bypassing STM
- `document_id` = Docs page ID (UUID, no wrapping)
- Tags: `team:optemization`, `source:notion`, `data-type:documents`, `verified:true`, `docs:<docs-page-id>`, `person-source:<slug>`
- Delta sync via `last_edited_time` — re-retains edited docs (Hindsight upserts by `document_id`)
- Cleanup script deletes the 11 old STM-routed documents from the bank before re-ingesting

# Session: Meetings-Ingest Worker (Worker A)

**Date:** 2026-05-16 → 2026-05-17
**Branch:** `feature/session-20260516-211828`
**Worker ID (latest):** `019e3342-eb20-71fd-82d9-8ed102fb4e01` (deleted; zombie backfill still running with correct code)

---

## What was built

**Worker A (`workers/meetings-ingest/`)** — a Notion Worker that pulls meeting data from the Calendar DB and writes structured records into the Short-Term Memory DB.

### Source & Target

| | DB Name | DB ID | Data Source ID |
|---|---|---|---|
| **Source** | Calendar Database | `f69027a8577d4db3b20be1a1c00881e0` | `ca95a9c4-f6af-49a6-b2b8-a61e276e5cf5` |
| **Target** | Short-Term Memory | `362a48662b2580bfb16dd60e57679d9d` | `362a4866-2b25-801c-9ce5-000b30156f9b` |

### Properties set on each Short-Term Memory record

| Property | Type | Value |
|---|---|---|
| `Name` | title | Meeting title from Calendar |
| `ID` | rich_text | UUIDv5 of `calendar://<calendarPageId>` with namespace `8a7c1d3e-2b4f-4a6d-9e8f-1c3b5d7e9f0a` |
| `Data Type` | select | `Notion Meetings` |
| `Person Source` | people | Calendar `Lead` person (if present) |

### Page body structure

```
## Context
- Title, Date, Type, Attendees, GCal link, Recording link, Calendar page ID
- Brief (if present)
- TL;DR (if present)
---

## Summary
[Structured notes from inside the transcription block — headings, bullets, action items]

## Raw Transcript
[Actual spoken dialog — plain paragraphs from after the last structured element]
```

### Filters & guards

1. **Date filter (in-code):** Skips any page with `Date < 2026-01-01`. The `dataSources.query` API silently ignores property-based date filters, so this is enforced in code after fetching.
2. **Transcript minimum:** Skips pages where the raw transcript portion is under 100 characters.
3. **Template filter:** Strips boilerplate lines matching `Agenda Item \d+` or `Follow-up \d+`.
4. **Dedup:** UUIDv5 keyed on `calendar://<pageId>`. Queries Short-Term Memory for existing `ID` before writing. Skips if already present (does NOT update).

### Sync capabilities

| Sync | Schedule | Mode | Notes |
|---|---|---|---|
| `meetingsBackfill` | manual | incremental | Paginates all Calendar pages (2026+), writes to STM. Currently has no `limit` param. |
| `meetingsDelta` | 5m | incremental | Queries Calendar for pages edited since last run. Uses `last_edited_time` cursor in state. |

Both syncs use a shim managed DB (`meetingsSyncShim`) as the scheduler hook. Actual writes go to Short-Term Memory via `context.notion.pages.create`.

---

## Files

| Path | Purpose |
|---|---|
| `workers/meetings-ingest/package.json` | Deps: `@notionhq/workers`. Mirrors `slack/package.json`. |
| `workers/meetings-ingest/tsconfig.json` | Strict TS, ES2020, nodenext. Mirrors `slack/tsconfig.json`. |
| `workers/meetings-ingest/.env.example` | `NOTION_API_TOKEN` (local only), `CALENDAR_DATA_SOURCE_ID` |
| `workers/meetings-ingest/.env` | Gitignored. Has the live token + data source ID. |
| `workers/meetings-ingest/src/index.ts` | Worker entry. UUIDv5 dedup, property readers, upsert, pullCalendar, two syncs. |
| `workers/meetings-ingest/src/markdown.ts` | `fetchPageContent()` — recursive block walker. Splits output into `agenda`, `summary`, `transcript`. Handles `transcription` block type (Granola/Circleback content). |
| `workers/meetings-ingest/src/preamble.ts` | `buildPreamble()` — generates the Context section from Calendar row properties. |

---

## Architecture decisions

1. **No Worker B / no interpretation.** Worker A ingests raw content only. No Claude calls, no distillation, no glossary annotations. The raw transcript + summary is the end product.
2. **Short-Term Memory is a unified DB.** Slack worker and meetings-ingest worker both write here, distinguished by `Data Type` (`Slack message` vs `Notion Meetings`).
3. **`NOTION_` env prefix is reserved.** Can't push `NOTION_API_TOKEN` or `NOTION_CALENDAR_DATA_SOURCE_ID` via `ntn workers env push`. Renamed calendar var to `CALENDAR_DATA_SOURCE_ID`. The platform provides `context.notion` for writes (platform-level auth), so `NOTION_API_TOKEN` only needed for local testing.
4. **`dataSources.query` filter limitations.** Property-based filters (like date) are silently ignored by the API. Enforce in code instead.
5. **Transcription block structure.** Calendar pages have a `transcription` block (Granola/Circleback) containing both structured summary (headings + bullets) and raw spoken dialog (paragraphs). These are split: structured → `## Summary`, dialog → `## Raw Transcript`. The split point is the last heading/bullet/to-do — everything after is raw transcript.

---

## Operational notes

- **ntn CLI:** Installed at `~/.local/bin/ntn` (v0.14.0). `~/.zshrc` has PATH entry.
- **ntn login:** Uses verification-code flow, not auto-browser. Run `ntn login`, open the printed URL, confirm code, then `ntn login poll`.
- **Pause vs kill:** `ntn workers sync pause <key>` prevents new runs but does NOT cancel in-flight runs. No `runs cancel` command exists. Deleting the worker also doesn't kill in-flight runs (they use platform auth). Only way to stop a zombie run is to remove the integration connection from the target DB in Notion UI.
- **Rate limits:** The Notion API rate limit is per-integration. Heavy session usage can exhaust it. Creating a new integration gives a fresh budget.
- **Integration name:** "Hackathon" — must be connected to both Calendar DB and Short-Term Memory DB.

---

## Resume instructions

The worker code is on disk at `workers/meetings-ingest/`. The worker was deleted from Notion (to kill a zombie run). To redeploy:

```sh
cd workers/meetings-ingest
rm -f workers.json
ntn workers deploy --name meetings-ingest
ntn workers env push --yes
ntn workers sync pause meetingsDelta   # pause until ready
ntn workers sync trigger meetingsBackfill
```

If the backfill zombie from this session is still running, wait for it to finish or remove "Hackathon" from Short-Term Memory DB connections, wait for writes to stop, re-add the connection, then deploy fresh.

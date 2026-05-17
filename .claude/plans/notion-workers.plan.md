# Plan: Cerebro Notion Workers (Option B — full migration)

**Status:** Approved architecture; pending implementation kickoff.
**Date:** 2026-05-16
**Complexity:** Medium (estimated 7–10h)

Migrate Cerebro from the Vercel-cron distillation path (`/api/ingest`) to a fully Notion-Workers architecture: two workers + one shared skill replace the cron. The Calendar DB becomes the source of truth, the existing five output databases remain user-owned and human-editable, and the glossary lives as a reusable skill any worker can import.

---

## Locked decisions

| # | Decision | Notes |
|---|---|---|
| 1 | Two workers under `workers/` + one shared skill under `skills/` | `slack/` stays untouched |
| 2 | Worker A (`workers/meetings-ingest`) owns a managed `meetings` DB; schema mirrors the Calendar DB's properties | Calendar DB schema introspected at impl-time via `ntn datasources resolve` + `query` |
| 3 | Meeting page body = `[Context Preamble]` + `[Raw Transcript Markdown]` | Preamble explains provenance (Notion meeting, calendar, date) + how to read |
| 4 | **Glossary = shared skill at `skills/glossary/`** that any Notion worker can import | Mirrors the `slack/.agents/skills/` precedent. Skill exposes `getGlossary(platform): Term[]` plus a `SKILL.md` reference doc. No separate Worker C. |
| 5 | Platform detection = heuristic on attendees/title/content (optional small Claude call) | Performed inside Worker B before glossary lookup |
| 6 | Worker B (`workers/interpreter`) appends `## Glossary Annotations` section to the meeting page body | Same page Worker A wrote |
| 7 | The five distilled DBs (Decisions / Themes / Entities / Open Questions / Cultural Signals) **stay user-created** | Worker B writes via `context.notion.pages.create`, same property names as `lib/notion.ts` |
| 8 | `/api/ingest` is retired | Delete `app/api/ingest/`, the cron entry in `vercel.json`, `CRON_SECRET`, `lib/distill.ts`, `lib/ingest.ts` |
| 9 | Next.js `app/` keeps the **feed UI** only | `app/api/feed/route.ts`, `app/page.tsx` remain |

## Architecture

```
Notion Calendar DB
        │
        │  Worker A — workers/meetings-ingest
        │   • meetingsBackfill (replace, manual)
        │   • meetingsDelta    (incremental, 5m)
        │   • pacer: notionApi (3 req/s)
        ▼
   Meetings DB (managed by Worker A)
   ├─ properties mirrored from Calendar DB
   └─ page body: [Context Preamble] + [Raw Transcript MD]
        │
        │  Worker B — workers/interpreter
        │   • interpretDelta (incremental, 5m)
        │   • platform-detect (heuristic / Claude)
        │   • imports skills/glossary → getGlossary(platform)
        │   • appends ## Glossary Annotations to page body
        │   • distills via Claude, writes records to:
        ▼
 5 user-created DBs (existing):
 Decisions / Themes / Entities / Open Questions / Cultural Signals

   ┌─ Shared skill — skills/glossary ─────────────┐
   │  • SKILL.md         (reference for agents)   │
   │  • getGlossary(platform): Term[]             │
   │  • code-defined terms per platform           │
   │  • importable by any Notion worker           │
   └──────────────────────────────────────────────┘
```

## Patterns to mirror

| Category | Source | Pattern |
|---|---|---|
| Worker scaffold | `slack/src/index.ts`, `slack/CLAUDE.md` | `@notionhq/workers` SDK; `Worker` + `worker.sync` / `worker.tool` / `worker.pacer`; deploy via `ntn workers deploy` |
| Shared skill layout | `slack/.agents/skills/` | Skill = directory with `SKILL.md` + supporting files |
| Sync strategy | `slack/CLAUDE.md` "Backfill + delta pair" | Manual replace-mode backfill + incremental delta on `"5m"` |
| Notion read fallback | `lib/notion.ts:49-59` (`readPageText`) | Block-walker fallback if Notion markdown endpoint unavailable |
| Distillation | `lib/distill.ts:34-61` | Claude call with strict JSON schema validated by Zod |
| Schema validation | `lib/types.ts` | Zod schemas at the boundary |
| Env loading | `lib/env.ts:19-28` | `zod` schema parse, cached singleton |

## Files

### CREATE

| Path | Purpose |
|---|---|
| `skills/glossary/SKILL.md` | Reference doc for coding agents — what the skill does, how to import it |
| `skills/glossary/package.json` | Workspace-style package so workers can import via `file:` dep or relative path |
| `skills/glossary/tsconfig.json` | Strict TS, tabs |
| `skills/glossary/src/index.ts` | Exports `getGlossary(platform): Term[]` + `Platform` / `Term` types |
| `skills/glossary/src/terms/notion.ts` | Glossary for `notion` platform |
| `skills/glossary/src/terms/slack.ts` | Glossary for `slack` platform |
| `skills/glossary/src/terms/index.ts` | Platform → terms registry |
| `workers/meetings-ingest/package.json` | Mirror `slack/package.json` |
| `workers/meetings-ingest/tsconfig.json` | |
| `workers/meetings-ingest/src/index.ts` | Worker entry: managed Meetings DB + backfill + delta syncs |
| `workers/meetings-ingest/src/markdown.ts` | `fetchPageMarkdown(notion, pageId)` w/ block-walker fallback |
| `workers/meetings-ingest/src/preamble.ts` | `buildPreamble(calendarRow): string` |
| `workers/meetings-ingest/.env.example` | `NOTION_API_TOKEN`, `NOTION_CALENDAR_DB_ID` |
| `workers/interpreter/package.json` | Includes `skills/glossary` as a local dependency |
| `workers/interpreter/tsconfig.json` | |
| `workers/interpreter/src/index.ts` | Worker entry: `interpretDelta` sync |
| `workers/interpreter/src/platform.ts` | `inferPlatform(meeting): Platform` |
| `workers/interpreter/src/annotate.ts` | `annotate(markdown, glossary): string` — pure, unit-testable |
| `workers/interpreter/src/distill.ts` | Port of `lib/distill.ts` |
| `workers/interpreter/src/writers.ts` | Port of `lib/notion.ts` writers via `context.notion.pages.create` |
| `workers/interpreter/.env.example` | `NOTION_API_TOKEN`, `ANTHROPIC_API_KEY`, 5 output DB IDs |

### DELETE

| Path | Why |
|---|---|
| `app/api/ingest/route.ts` | Replaced by Worker B's delta sync |
| `vercel.json` cron entry | No more cron |
| `lib/distill.ts` | Moves into `workers/interpreter/src/distill.ts` |
| `lib/ingest.ts` | Orchestrator no longer needed |

### UPDATE

| Path | Why |
|---|---|
| `lib/notion.ts` | Strip writers; keep `notion()` + `listRecentRecords()` for feed UI |
| `lib/types.ts` | Distillation types move into the interpreter worker |
| `lib/env.ts` | Drop `CRON_SECRET` and `NOTION_MEETINGS_DB_ID` |
| `.env.example` | Match `lib/env.ts` changes |
| `CLAUDE.md` | Add Workers + Skills sections; remove `/api/ingest` references |
| `app/api/feed/route.ts` | Verify it reads only from the 5 output DBs |

## Tasks (implementation order)

### Phase 1 — Shared glossary skill — foundational, no deps
- 1.1 Create `skills/glossary/` directory layout
- 1.2 Write `SKILL.md`: purpose, API surface, how a worker imports it, example usage
- 1.3 Seed `terms/notion.ts` and `terms/slack.ts` with ~20 terms each
- 1.4 Implement `getGlossary(platform): Term[]` with a Zod-validated `Platform` enum
- 1.5 Validate: `npm run check` inside `skills/glossary/`

### Phase 2 — Worker A (meetings-ingest)
- 2.1 Scaffold `workers/meetings-ingest/` mirroring `slack/`
- 2.2 Introspect Calendar DB schema (`ntn datasources resolve <id>` + `query`) → mirror into managed `meetings` DB
- 2.3 Implement `fetchPageMarkdown` (markdown endpoint + block fallback)
- 2.4 Implement `buildPreamble(calendarRow)`
- 2.5 `meetingsBackfill` (replace, manual)
- 2.6 `meetingsDelta` (incremental, 5m)
- 2.7 After each upsert, append `[preamble] + [markdown]` as page body via `context.notion.blocks.children.append` (chunk if needed)
- 2.8 Validate: `ntn workers sync trigger meetingsBackfill --preview`

### Phase 3 — Worker B (interpreter)
- 3.1 Scaffold `workers/interpreter/` mirroring `slack/`
- 3.2 Declare `skills/glossary` as a local dependency in `package.json` (e.g., `"@cerebro/glossary": "file:../../skills/glossary"`)
- 3.3 Port `distill.ts` and writers from `lib/`
- 3.4 Implement `inferPlatform(meeting)` heuristic
- 3.5 Implement `annotate(markdown, glossary)` (pure, unit-testable)
- 3.6 `interpretDelta` sync: read Meetings → infer platform → call `getGlossary` → annotate → distill → write records
- 3.7 Append `## Glossary Annotations` section via `blocks.children.append`
- 3.8 Idempotency: track processed meeting IDs in sync state; dedupe writes by `hash(meetingId + record.title)`
- 3.9 Validate: `ntn workers sync trigger interpretDelta --preview`

### Phase 4 — Retire `/api/ingest`
- 4.1 Delete files listed under DELETE
- 4.2 Strip `CRON_SECRET` and `NOTION_MEETINGS_DB_ID` from `lib/env.ts` + `.env.example`
- 4.3 Update `CLAUDE.md`
- 4.4 `npm run build` clean at repo root

### Phase 5 — Wire up
- 5.1 `ntn workers deploy` in each of the two worker dirs
- 5.2 One-time backfill: `ntn workers sync trigger meetingsBackfill`
- 5.3 Watch: `ntn workers sync status`
- 5.4 Verify the 5 output DBs get rows per meeting

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `ntn workers deploy` doesn't bundle `file:` local deps (the glossary skill) | Medium | Verify early; fallback options: (a) `npm pack` the skill and install the tarball, (b) symlink built `dist/` into each worker, (c) inline the glossary inside Worker B if bundling fails |
| Notion markdown endpoint shape differs from assumption | Medium | Block-walker fallback (proven in `lib/notion.ts`) |
| Long transcripts hit per-call block-append limits | Low | Chunk via batched `blocks.children.append` calls |
| Duplicate distilled records on re-processing | High without mitigation | Track processed meetings in sync state; dedupe by `hash(meetingId + record.title)` |
| Heuristic platform detection misfires | Medium | Log inferred platform; allow override via property on the meeting page |
| Calendar DB schema unknown | Medium | Phase 2 starts with an introspection step |

## Acceptance

- [ ] Both workers deploy clean; `ntn workers sync status` shows HEALTHY for all
- [ ] Glossary skill imports successfully from Worker B (no missing-module errors at deploy)
- [ ] One backfill run populates Meetings DB with the most recent calendar entries
- [ ] Each meeting page body shows: Context Preamble → Raw Transcript → `## Glossary Annotations`
- [ ] Decisions / Themes / Entities / Open Questions / Cultural Signals get new rows per meeting
- [ ] Second delta cycle for an unchanged meeting produces zero duplicates
- [ ] `npm run build` succeeds at repo root (Next.js feed UI)
- [ ] `/api/ingest` is gone; cron entry removed from `vercel.json`
- [ ] `CLAUDE.md` updated to document the workers + the shared skill

## Open items (resolve at start of Phase 2 — not blocking plan approval)

- Calendar DB ID + schema (paste property names + types, or share the DB ID for introspection).
- Confirm Notion Workers bundling behavior for local file deps so the glossary skill ships with Worker B.

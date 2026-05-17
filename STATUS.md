# Cerebro Build Status

Last updated: 2026-05-17 (hackathon day 2, demo Sunday evening)

## What works right now

- [x] Slack worker (`slack/`) — deployed, ingesting messages into Short-Term Memory
- [x] Google worker (`google/`) — built (GMail + GCal via domain-wide delegation), needs deploy + env push
- [x] Meetings-ingest worker (`workers/meetings-ingest/`) — deployed, ingesting calendar meeting transcripts into STM
- [x] Hindsight Cloud bank bootstrapped (`optemization-cerebro`, PR #17)
- [x] Frontend feed + swipe deck wired to 12 Long-Term Memory DBs (PR #18, #19)
- [x] Root `.env.example` matches `lib/env.ts` (12 LTM DBs + STM + Hindsight)
- [x] Branch protection + ship workflow + auto-merge working
- [x] Notion swipe deck live at `/api/deck` (PR #19)

## What's not built yet (hackathon must-ship)

- [ ] Shared cleaning library (`clean(content, glossary)`) — spec calls this MUST-ship
- [ ] Glossary DB seeded with ~15 entries in Notion
- [x] Hindsight Indexer Worker (`indexer/`) — polls STM Status=pending, calls `retain()` (sync), flips to indexed/failed. Needs deploy.
- [ ] Cerebro Sync Worker — receives Hindsight webhooks, classifies facts, writes to LTM DBs
- [ ] Ask Cerebro Custom Agent + `askCerebro` tool
- [ ] Q&A API (`/api/ask`) — calls Hindsight `reflect()`
- [ ] Tavus avatar page (`/avatar`)
- [ ] ElevenLabs voice surface
- [ ] Graph viz page (`/graph`)

## What's stretch

- [ ] Granola or Circleback source worker
- [x] Notion-Docs source worker (`notion-docs/`) — built, retains directly to Hindsight (bypasses STM). Needs deploy.
- [ ] Companies, Strategies, Patterns LTM DBs populated
- [ ] Force-directed graph with live data

## Known issues

- `workers/meetings-ingest/` lives under `workers/` while other workers live at root — not worth moving mid-hackathon, documented in CLAUDE.md worker registry
- `google/` worker needs env push before deploy (`GOOGLE_SERVICE_ACCOUNT_KEY_BASE64`, `GOOGLE_ADMIN_EMAIL`, `GOOGLE_WORKSPACE_DOMAIN`)
- `.claude/plans/notion-workers.plan.md` describes superseded architecture (Worker A + B + glossary skill) — only Worker A was built
- Hindsight Cloud `retain.completed` webhook not yet emitted by their API — Sync Worker should poll instead

# Cerebro — Hackathon Submission

**Notion Developer Platform Hackathon | May 16-17, 2026 | San Francisco**

**[Live Demo](https://hackathon-cerebro.vercel.app/)** | [GitHub](https://github.com/optemization/Hackathon-Cerebro)

---

## Thesis

The "second brain" framework has existed for almost a decade. Tools like Notion, Obsidian, and Roam gave people a place to store knowledge — but every one of them is predicated on human entry, human editing, and human verification. That's fundamentally flawed. Humans don't capture consistently. They forget to update. They don't cross-reference. The second brain rots.

Cerebro proposes a nearly fully autonomous second brain. No manual entry. No human-in-the-loop structuring. Every meeting transcript, Slack message, email, calendar event, and doc flows in automatically, gets cleaned against a team glossary, gets distilled by a memory engine that extracts facts, resolves entities, and consolidates observations — and surfaces as structured, queryable knowledge that both humans and AI agents can use.

The value chain: **automatic capture** -> **custom cleaning** -> **distillation** -> **sense-making** -> **interactive UI** -> **agent SDK**.

## What we built in 2 days

### Data pipeline (Notion Workers SDK)

Six source workers pulling from every team surface:

| Worker | Source | Status |
|---|---|---|
| Slack | Slack messages + threads | Deployed |
| Google | Gmail + Google Calendar (domain-wide delegation) | Built |
| Meetings Ingest | Notion Calendar DB meeting transcripts | Deployed |
| Granola | Granola.so meeting recordings | Built |
| Notion Docs | Org's existing Notion Docs DB | Built |
| Circleback | Circleback meeting transcriptions | In progress |

Each worker cleans its input through a shared **Glossary normalization library** (`lib/cleaning/`) before writing to Short-Term Memory. The Glossary DB holds alias-to-canonical mappings (e.g., "Tem" = "Temirlan Nugmanov", "RC" = "Rick Chen") so entities resolve consistently across sources.

### Memory engine (Hindsight Cloud)

A **Hindsight Indexer Worker** polls Short-Term Memory for new rows and calls `retain()` — Hindsight's memory primitive that extracts facts, resolves entities, and builds an observation graph. The `retain` / `recall` / `reflect` contract is our internal API surface — the engine behind it is pluggable.

### Notion Custom Agent

A **Decisions Interpreter** built as a Notion Custom Agent with four tools:

- `searchDecisions` — find decisions by person, status, time period, scope
- `getDecisionDetail` — read full page body with connections and source context
- `getDecisionImpact` — analyze what a decision affects, its consequences, related knowledge
- `analyzeDecisionTrends` — aggregate patterns, velocity, bottlenecks, status distributions

The agent understands the team's decision history, spots patterns, assesses impact, and identifies risks — all from structured Notion data enriched by the knowledge graph.

### Q&A surfaces

- **Chat** — Anthropic Claude API (Sonnet 4.6) for reasoning over the Decisions DB
- **Force-directed graph** — interactive knowledge graph visualization from Hindsight
- **Swipe deck** — Tinder-style card feed for browsing Long-Term Memory
- **HeyGen LiveAvatar** — video avatar Q&A interface
- **ElevenLabs** — voice chat interface

### Frontend

Next.js App Router on Vercel. API routes for chat (`/api/chat`), graph data (`/api/graph`), feed (`/api/feed`), swipe deck (`/api/deck`), and avatar sessions (`/api/liveavatar/session-token`).

## Novel platform usage

- **Notion Workers SDK** — 6+ source workers using the new Workers runtime for data ingestion with backfill + delta sync
- **Notion Custom Agents** — Decisions Interpreter agent with tool-based architecture, deployed as a Worker
- **Workspace-level databases** — Notion as the canonical data store for both Short-Term and Long-Term Memory (no external DB)
- **Glossary DB** — entity normalization powered by a Notion database, queried by every worker at ingest time

## Dogfooding

Built on real Optemization team data from day one. Real Slack messages, real meeting transcripts, real emails, real calendar events. Not synthetic data — the system is ingesting and distilling our actual team's knowledge as we build it.

## What's next

- Full Long-Term Memory population across all 13 DBs
- Cerebro Sync Worker (Hindsight webhooks -> classified LTM writes)
- Self-serve onboarding for consulting clients (AIVC, PicnicHealth, Bellesa)
- Single-player mode (personal Cerebro for individual users)

## Team

- **Tem** (Temirlan Nugmanov) — Architecture, workers, Hindsight integration
- **Kamau** — Frontend, graph viz, swipe deck
- **Mike** — Workers, data pipeline

[Optemization](https://optemization.com) — a Notion consultancy for mid-market and enterprise companies.

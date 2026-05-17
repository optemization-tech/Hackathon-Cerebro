# Cerebro — spec

> **Status:** in-progress spec, captured 2026-05-16.
> **Authors:** Tem, with Kamau and Mike on the build.
>
> **How to read this doc.** The single source of truth for what Cerebro is and where it's going. Two big sections:
>
> 1. **[Hackathon scope (V1)](#hackathon-scope-v1--what-ships-by-sunday-demo)** — what ships by the Notion Developer Platform Hackathon demo (May 16–17, San Francisco). Read this if you're contributing this weekend. Every choice in here builds in the same direction as the product scope — no functional shortcuts that would have to be unwound later.
> 2. **[Product scope (V1.1 → V3)](#product-scope-v11--v3--long-arc)** — the long-arc vision. How Cerebro evolves post-hackathon: Hindsight Cloud → self-host → fork triggers, full data model populated, forecasting, single-player mode, productization roadmap. Read for context on direction.

## TL;DR

Cerebro is Optemization's team second brain. **Six source Notion Workers** (Slack, Granola, Circleback, GMail, GCal, Notion-Docs) pull data, clean it via a shared Glossary-normalization library, and write cleaned text into the workspace-level **Short-Term Memory** Notion DB ([already created](https://www.notion.so/optemization/362a48662b2580bfb16dd60e57679d9d)). The Notion-Docs worker watches the org's existing Docs database(s) — for Optemization, [this one](https://www.notion.so/optemization/7770dd47209b49098dad46ec0d4dcb3b?v=115e42e1e0cc42a1ba4ffdee205cbba7). A **Glossary DB** holds aliases ↔ canonical mappings.

A **Hindsight Indexer Worker** polls Short-Term Memory on a 5-minute cron and feeds new/edited rows into a [Hindsight Cloud](https://hindsight.vectorize.io) memory bank named `Cerebro`. Hindsight does the heavy memory work — fact extraction, entity resolution, observation consolidation, multi-strategy retrieval. A **Cerebro Sync Worker** subscribes to Hindsight's `retain.completed` and `consolidation.completed` webhooks and writes structured records into **Long-Term Memory** — thirteen Notion DBs grouped as dossiers (People, Companies, Agents), actions (Projects, Tasks, Decisions), intelligence (Insights, Frameworks, Strategies, Patterns, Signals), and measurement (Objectives, Metrics).

An **Ask Cerebro** Notion Custom Agent answers questions via Hindsight `reflect()`, surfaced through three voice/video Q&A surfaces (Tavus avatar, ElevenLabs voice chat, the Notion agent UI directly) plus a force-directed graph viz on a Next.js page.

Dogfooded on real Optemization data. Internal team is the first user. Post-hackathon target: consulting clients like AIVC.

**Architectural principles:** Notion is the canonical raw store. Source workers clean before writing. Hindsight is an index/query engine on top, fed by the Indexer Worker. Source workers never call Hindsight directly. The `retain` / `recall` / `reflect` contract is our internal interface — the engine behind it is pluggable.

## What Cerebro is

Cerebro is the team second brain that makes an organization legible to AI. Every meeting transcript, Slack message, email, calendar event, and verified Notion doc flows in. Cerebro extracts structured records (decisions, signals, patterns, frameworks, etc.) into a normalized graph that humans browse in Notion and agents query via a Custom Agent. Built on Hindsight's memory primitives, surfaced through Notion's relational graph + Custom Agents + Workers, with voice and video Q&A surfaces on top.

The thesis: **legibilize the org**. RC at AIVC's framing — *"if I can know what was said in this meeting by which person, that resolves stakeholder management"* — generalized into a system. Cerebro turns the team's daily work into a queryable, structured, agent-readable graph without making humans do the structuring.

## Audience evolution

| Phase | Users | Notes |
|---|---|---|
| Hackathon (this weekend) | Optemization team | Dogfood on our own meetings/Slack/Notion/email/calendar. |
| Months 1–3 post-hackathon | Optemization team + RC (AIVC) as design partner | RC has explicitly asked for the team-multiplayer version of his single-player Obsidian "Knowledge OS." |
| Months 3–12 | Consulting clients across Optemization's portfolio (PicnicHealth, Bellesa, Leslie Institute, Temporal) | Productize the V1 → V2 transition. Each client gets a dedicated instance. |
| Year 2+ | Any team that wants their org legibilized | Self-serve or assisted onboarding. Pricing/packaging defined later. |

---

# Hackathon scope (V1) — what ships by Sunday demo

Everything in this section is in scope for the Notion Developer Platform Hackathon demo on May 17, 2026. Each subsection scopes "must-ship" vs "stretch" where relevant. Items marked "Deferred" exist in this section's data model for forward-compatibility but get populated/built in the [product scope](#product-scope-v11--v3--long-arc).

## For agents reading the repo

If you're a coding agent opening this repo cold and contributing this weekend:

- **This is the hackathon scope.** It scopes what ships by Sunday. The product scope below is post-hackathon direction.
- **The scaffold in `lib/` is V0** — it talks to Anthropic directly from Vercel cron and writes to 5 flat output DBs (Decisions, Themes, Entities, Open Questions, Cultural Signals). The hackathon scope is V1: ingestion via six Notion Workers (Slack/Granola/Circleback/GMail/GCal/Notion-Docs), cleaning at ingest, Hindsight Cloud as the memory engine fed by a dedicated Indexer Worker, distillation into Long-Term Memory via a webhook-driven Sync Worker, Q&A surfaces hitting Hindsight `reflect()`. Default to evolving V0 toward V1, not building parallel.
- **Code in `slack/` is the canonical Notion Worker template.** `ingestSlackMessage` is the pattern. New source workers (Granola, Circleback, GMail, GCal, Notion-Docs) follow that shape and call the shared cleaning library before writing to Short-Term Memory.
- **Notion is the canonical raw store.** Source workers clean their inputs (via the shared Glossary-normalization library) and write cleaned text to Short-Term Memory. The Indexer Worker is the only thing in the system that calls Hindsight `retain()`. Source workers stay thin. Don't reach for a third datastore (no Postgres, Redis, vector DB) — Hindsight already covers that need.
- **The team-workflow rules in `CLAUDE.md` are not optional.** Branch off `main` immediately, never commit to `main`, run the ship sequence when the user says "ship."
- **Don't add features beyond the must-ship list below without asking.** This doc is the scope.

## Architecture

Three-stage worker pipeline. Notion is the canonical raw store. Hindsight is the memory engine. Long-Term Memory is the human-readable distilled graph.

```
                Source Workers (6)
                ┌─────────────────────────────────────────────────────┐
External APIs ─►│ Slack │ Granola │ Circleback │ GMail │ GCal │ Notion│
                │   each pulls, applies source-specific parsing,      │
                │   then calls clean(content, glossary) from a        │
                │   shared library (Glossary normalization)           │
                └────────────────┬────────────────────────────────────┘
                                 │  reads
                                 ▼
                          ┌──────────────┐
                          │ Glossary DB  │
                          │ (Notion)     │
                          │ aliases ↔    │
                          │ canonical    │
                          └──────────────┘
                                 │
                                 ▼
                ┌──────────────────────────────────────────┐
                │ Short-Term Memory DB (Notion)            │
                │ workspace-level · cleaned text in page   │
                │ content · Status: cleaned                │
                └──────────────────────────────────────────┘
                                 │
                                 │  Hindsight Indexer Worker
                                 │  - 5-min cron
                                 │  - query Status: cleaned
                                 │  - call Hindsight retain()
                                 │  - mark Status: indexed
                                 ▼
                ┌──────────────────────────────────────────┐
                │ Hindsight Cloud                          │
                │ Bank: Cerebro               │
                │ fact extraction · entity resolution ·    │
                │ observation consolidation ·              │
                │ TEMPR retrieval · mental models          │
                └──────────────────────────────────────────┘
                                 │
                                 │  webhooks:
                                 │  - retain.completed
                                 │  - consolidation.completed
                                 ▼
                ┌──────────────────────────────────────────┐
                │ Cerebro Sync Worker (Notion webhook)     │
                │ on retain.completed:                     │
                │   recall(stm:<id>) → classify facts →    │
                │   upsert into Long-Term Memory →         │
                │   mark Status: distilled                 │
                │ on consolidation.completed:              │
                │   write Patterns + refresh dashboards    │
                └──────────────────────────────────────────┘
                                 │
                                 ▼
                ┌──────────────────────────────────────────┐
                │ Long-Term Memory (Notion, 13 DBs)        │
                │ MVP (8):  People · Decisions · Insights  │
                │           · Signals · Projects · Tasks   │
                │           · Objectives · Metrics         │
                │ Stretch:  Companies · Strategies         │
                │ Deferred: Agents · Frameworks · Patterns │
                │ Every row → `Captured From` →            │
                │ Short-Term Memory (citation primitive)   │
                └──────────────────────────────────────────┘
                                 │
                                 ▼
                ┌──────────────────────────────────────────┐
                │ Q&A surfaces (all hit Hindsight reflect) │
                │ - Ask Cerebro Notion Custom Agent        │
                │ - Tavus avatar (Next.js → /api/ask)      │
                │ - ElevenLabs voice (hosted → /api/ask)   │
                │ - Graph viz (Next.js, reads Notion)      │
                └──────────────────────────────────────────┘
```

## Runtime split

| Component | Runs on | Status |
|---|---|---|
| 6 source workers (Slack, Granola, Circleback, GMail, GCal, Notion-Docs) | Notion Workers | Slack in flight; 5 not started |
| Shared cleaning library (`clean(content, glossary)`) | TypeScript module imported by each worker | To build |
| Short-Term Memory DB | Notion | [Already created](https://www.notion.so/optemization/362a48662b2580bfb16dd60e57679d9d) |
| Glossary DB | Notion | To create (seed ~15 entries) |
| Hindsight Indexer Worker | Notion Worker (5-min cron) | To build |
| Hindsight bank `Cerebro` | Hindsight Cloud | To create |
| Cerebro Sync Worker (webhook-driven) | Notion Worker (webhook capability) | To build |
| Long-Term Memory DBs (8 for MVP) | Notion | To create |
| Ask Cerebro Custom Agent | Notion Custom Agent | To configure with `askCerebro` Worker tool |
| Q&A API (`/api/ask`) | Next.js on Vercel | To build |
| Tavus avatar page (`/avatar`) | Next.js on Vercel | To build |
| Graph viz page (`/graph`) | Next.js on Vercel | To build |
| ElevenLabs hosted chat | ElevenLabs | To configure (tool POSTs to `/api/ask`) |

**Eight workers total:** 6 source + 1 indexer + 1 sync. Plus the shared cleaning library used by all six source workers, and two Custom Agents (Ask Cerebro + optional Cerebro Distiller).

Why this split:

- Source workers stay focused on their *one* job: pull from external, parse, clean, write to Notion. They never touch Hindsight directly.
- The shared cleaning library means one place to maintain Glossary integration — updates flow to all six source workers automatically.
- The Indexer is the single Hindsight-aware bridge — centralized auth, retry, idempotency. Easy to swap Hindsight later by rewriting one worker.
- The Sync Worker handles only the inbound webhook path. Cleanly separated from ingestion.
- Vercel hosts the visual surfaces (Tavus avatar, graph viz, `/api/ask`).

## Data model

Fifteen databases total: two ingest-layer (Short-Term Memory + Glossary) + thirteen Long-Term Memory DBs. The thirteen LTM DBs split into four groups by **what each row represents**:

- **Dossier DBs** — *who*. One row per **entity**: a person, a company, or an AI agent. Each row is a single, persistent file folder that Cerebro keeps adding to over time. The "RC Willenbrock" dossier gets new entries every time RC shows up in a Granola transcript, a Slack thread, or an email — all merged into one record with citations back to the source. Same shape for companies (the "AIVC" dossier accumulates every mention of AIVC across all our work) and agents (the "Granola" dossier accumulates everything we know about how Granola behaves as a tool — its capabilities, its quirks, what we use it for, what's broken about it).
- **Action DBs** — *what the team does*. Time-bounded events with owners: projects start and finish, tasks get assigned and completed, decisions get made and sometimes reversed. Actions reference entities from the Dossier layer ("Tem committed to delivering X for AIVC by Friday").
- **Intelligence DBs** — *what the team knows and what Cerebro notices*. Five DBs split across descriptive lenses (Insights, Frameworks, Patterns), prescriptive bets (Strategies), and the attentional event log (Signals).
- **Measurement DBs** — *what the team commits to and how we measure progress*. Bounded targets (Objectives) and the durable measurement entities they track (Metrics).

Why "dossier" and not "profile" or "record"? A dossier is something a third party assembles about a subject by accumulating evidence from many sources — that's exactly what Cerebro does. A profile is something the subject writes about themselves; Cerebro doesn't have that.

Schemas are defined once here in their forward-compatible form; the **Status** column indicates when each DB ships.

### Ingest-layer DBs

#### Short-Term Memory

[Already created](https://www.notion.so/optemization/362a48662b2580bfb16dd60e57679d9d). Workspace-level. One row per ingested unit. Contains *cleaned* text in page body — what humans read and what Hindsight indexes are identical.

| Property | Type | Notes |
|---|---|---|
| Name | title | Source-type-appropriate. Cleaned (e.g. "Aar See" in title → "RC Willenbrock"). |
| ID | text (`userDefined:ID`) | The source system's stable UUID. Used for dedup. |
| Data Type | select | `Meeting transcript` / `Slack message` / `Email` / `Calendar event` / `Note`. |
| Source | select | `Slack` / `Granola` / `Circleback` / `GMail` / `GCal` / `Notion`. |
| Person Source | person (limit 1) | The Optemization team member whose account this came from. |
| Status | select | `cleaned` (source wrote it) / `indexed` (Indexer pushed to Hindsight) / `distilled` (Sync Worker wrote it to Long-Term Memory) / `failed`. |
| Created time / Created by | system | Auto. |

**Raw body (cleaned)** is stored as the row's page content (not as a property).

**Future additions (product scope):**
- `Engagement` relation (→ engagement/project) — auto-populated by the Distiller once it knows.
- `Sensitivity` select (`public` / `internal` / `confidential` / `legal-hold`) — drives recall filtering for clients with compliance needs.
- `Raw Source URL` — link back to the original Slack thread / Granola recording / Gmail thread / calendar event.

#### Glossary

**Status: MUST-ship for hackathon.** Disambiguation table. Read by the shared cleaning library.

| Property | Type | Notes |
|---|---|---|
| Term | title | Canonical written form. "RC Willenbrock", "Optemization", "AIVC". |
| Aliases | multi_select | Misspellings, abbreviations, speech-to-text mangles. "Aar See", "AarSee", "RC", "Optimization", "I-V-C". |
| Type | select | `PERSON` / `ORG` / `AGENT` / `CONCEPT`. Used when passing to Hindsight's `entities` param. |
| Canonical (relation) | relation → People/Companies/Agents | Optional — links the term to a Long-Term Memory row if it exists. |
| Definition | rich_text | Plain-English meaning (used by humans + Hindsight context). |
| Context | rich_text | When this entry applies (e.g. "Optemization internal" vs "AIVC engagement"). |

**Seed entries (~15, hand-curated for MVP):**

| Term | Aliases | Type |
|---|---|---|
| Tem | Tim, Temir, Temirlan | PERSON |
| Kamau | Kamau Muata | PERSON |
| Mike | Mike Scharf | PERSON |
| RC Willenbrock | RC, Aar See, AarSee | PERSON |
| Optemization | Optimization, Op-tem-ization | ORG |
| AIVC | I-V-C, AIVC.ai, AI VC | ORG |
| PicnicHealth | PicNick Health, Picnic Health | ORG |
| Bellesa | Bellesa.co | ORG |
| Leslie Institute | NYUEI, Leslie Inst | ORG |
| Temporal | Temporal.io | ORG |
| Roofstock | Roof Stock | ORG |
| Granola | Granola.ai, Granola App | AGENT |
| Circleback | Circle back, Circleback.ai | AGENT |
| Hindsight | Hindsight.io, Vectorize Hindsight | AGENT |
| Cerebro | Cerebros, Cerebro app | CONCEPT |

Post-hackathon, Glossary grows via manual additions and (Phase 1.5+) an LLM-assisted "Glossary candidate" pass over Short-Term Memory raw bodies looking for unknown proper nouns and proposing entries for human review.

### Long-Term Memory — Dossier DBs

| DB | Status | Purpose / schema |
|---|---|---|
| **People** | Must (V1) | Every human Cerebro has seen. Deduped via Glossary + Hindsight entity resolution. Includes Optemization team members + every external person. Fields: Name, Aliases, Companies (→), Role, First/Last Seen, Interaction History (rollup, V1.1+), Communication Style (LLM-derived, V1.5+), `Captured From` (→ Short-Term Memory), back-refs from Decisions/Insights/Patterns/etc. |
| **Companies** | Stretch (V1) / Must (V1.1) | Every organization. Name, Aliases, Domain, People (→ back), Status (`prospect`/`active client`/`partner`/`vendor`/`peer`), Notes, back-refs, `Captured From`. |
| **Agents** | Deferred (V1.1+) | Non-human actors. AI agents, services, automations that *do* things and increasingly have identities (emails, Stripe accounts, calendars). Examples: Granola, Cerebro Distiller, Circleback bot, future Claude/Devin instances. Name, Type (`model`/`service`/`automation`), Operated By (→ Company), Capabilities, back-refs, `Captured From`. |

### Long-Term Memory — Action DBs

| DB | Status | Purpose / schema |
|---|---|---|
| **Projects** | Must (V1) | Time-bounded work streams. RC's distinction: projects have deadlines; doctrines/frameworks don't (those live in the Intel layer). Fields: Name, Status, Lead (→ Person), Companies (→), Tasks (→ back), Engagement (→ engagement), `Captured From`. |
| **Tasks** | Must (V1) | Actions + scheduled follow-ups. Title, Status, Assignee (→ Person), Due, `Captured From`, Project (→). Cerebro-owned for V1; integration with existing Optemization Tasks DBs is V1.5 (see [Tasks integration](#tasks-integration)). |
| **Decisions** | Must (V1) | What was decided + why + scope. Title, Status (`proposed`/`committed`/`reversed`/`blocked`), Decided At, Rationale, Scope, Decision Makers (→ People), Affected Projects (→), `Captured From`. |

### Long-Term Memory — Intelligence DBs

Five DBs that capture what the team knows and what Cerebro notices. The split:

- **Insights, Frameworks, Patterns** are **descriptive** — they describe how things are. Humans articulate Insights in the moment; Frameworks are Insights or Patterns that have been named and deliberately adopted as reusable lenses; Patterns are repetitions Cerebro infers from many facts.
- **Strategies** are **prescriptive** — deliberate bets the team makes about what to do, often as applications of a Framework.
- **Signals** are **attentional** — the event log of everything worth noticing, including both raw observations and meta-events Cerebro emits when its own structured-knowledge graph transitions.

#### The four axes

| | Author | Shape | Lifetime | The test |
|---|---|---|---|---|
| **Insight** | Human, in the moment | A statement of realization | Ephemeral — could be wrong | "I just realized that X" |
| **Framework** | Human, articulated + deliberately adopted | A *named* lens (has a title) | Durable — persists across projects | The team uses the name to describe new situations |
| **Strategy** | Human, deliberately proposed | A hypothesis + applied approach | Bounded — has a verdict | "Let's try X to achieve Y, because Framework Z says…" |
| **Signal** | Cerebro, observed or emitted | One atomic event | Pointlike — snapshot at a moment | Visible in a single source, or fired by a Cerebro transition |
| **Pattern** | Cerebro, inferred | Aggregate across many facts | Durable — strengthens with evidence | Requires multiple data points to make the claim |

#### Signal sub-types

Signals are the team's attention feed. Two sub-types, distinguished by a `Kind` controlled-vocabulary property:

**Source signals** — observations extracted directly from raw data.
- `source_observation` — qualitative observation. *"AIVC's response time slowed 30% after the missed milestone."*
- `metric_reading` — a quantitative datapoint that updates a Metric. *"AIVC NPS measured at 7.2 on 2026-05-15."* References the parent Metric row.

**Meta signals** — fired by Cerebro's own structured-knowledge transitions.
- `pattern_emerged` — a new Pattern just crystallized after enough supporting facts.
- `framework_candidate` — Cerebro suggests an Insight or Pattern is durable enough to be named as a Framework. Human accepts → Framework row created. Decline → Signal stays as record.
- `framework_applied` — a Strategy was created that applies an existing Framework.
- `framework_pattern_contradiction` — a Pattern contradicts an in-flight Framework. High severity.
- `strategy_verdict` — a Strategy got its verdict (`proven` / `disproven`).
- `pattern_recognized_by_human` — a human articulated an Insight that recognizes a Pattern Cerebro had already inferred. The "Cerebro told me about myself" moment.
- `objective_at_risk` — a metric reading crossed an Objective threshold in the wrong direction.

The `Kind` enum is a **closed controlled vocabulary**, seeded with the values above and customized per workspace at onboarding. New kinds get added deliberately, not invented by the LLM at extraction time.

#### The promotion ladder

Cerebro suggests; humans decide. Cerebro never auto-creates a Framework or Strategy.

```
Insight  ──┐
           ├─→ (Cerebro emits `framework_candidate` Signal after threshold) ─→ human accepts ─→ Framework row
Pattern  ──┘                                                                 ─→ human declines ─→ Signal stays as record

Framework + a specific situation ─→ human proposes ─→ Strategy
Strategy + bounded target        ─→ Objective(s)
Metric updates (Signals of kind `metric_reading`) ─→ Objective verdict ─→ Signal of kind `strategy_verdict`
```

#### Multi-typing

`unit_type` is `multi-values` in the Hindsight bank — one fact can carry `[insight, signal]` (a realization that's also a noticing event) or `[framework, strategy]` (an articulated lens deliberately operationalized). On the Notion projection side, the Sync Worker upserts one row in each matching LTM DB, cross-linked via relations. The Hindsight knowledge graph stays a single entity; Notion is the human-readable projection.

#### Canonical worked example: "scope delivery as trust recovery"

Take RC's actual phrase: *"Scope delivery is a trust recovery mechanism."* The chain across LTM:

| # | DB | Author | Captures |
|---|---|---|---|
| 1 | **Insight** | RC, in a 2025 AIVC meeting | "Just realized the way out of a trust deficit isn't promises — it's over-delivered scope." `Realized By: RC` |
| 2 | **Signal** (`framework_candidate`) | Cerebro, after RC has articulated this 4× | Suggests promotion of Insight #1 to a Framework. Tem accepts. |
| 3 | **Framework** | RC + Tem (originator + adopter) | "Scope delivery as trust recovery — when trust is damaged, over-deliver on scope, never over-promise." `Originator: RC`, `Promoted From: Insight #1` |
| 4 | **Strategy** | Tem, proposed for AIVC | "Ship the Tavus avatar before the voice surface — it's the visible scope marker." `Applies Framework: #3`, `Applies To: AIVC engagement`, `Status: in_flight` |
| 5 | **Objective** | Tem, set for AIVC | "AIVC contract renewal at 1.5× ARR by Sept 30." `Strategy: #4`, `Measures: AIVC ARR Metric` |
| 6 | **Metric** | Tem, created at engagement start | "AIVC ARR" — durable measurement entity. `Cadence: monthly`, `Measures Objective: #5` |
| 7 | **Signal** (`metric_reading`) | Cerebro, monthly | "AIVC ARR = $X on date Y." References Metric #6. |
| 8 | **Signal** (`strategy_verdict`) | Cerebro, when #4 resolves | "Strategy #4 outcome: proven — avatar shipped, AIVC engagement renewed." |
| 9 | **Pattern** | Cerebro, inferred across 3+ engagements | "Optemization slips on demo-critical milestones the week before delivery." `Subjects: Optemization team` |

Same root reality. Nine artifacts, each with its own role in the graph.

#### Blur cases — disambiguation rules

1. **Insight has been said five times — Framework yet?** Not automatically. Cerebro emits a `framework_candidate` Signal. Human deliberately accepts → Framework row created. Decline → Signal stays as record. Framework promotion is always a human decision.
2. **Cerebro inferred a Pattern; the human then articulates the same realization.** Both rows: the Pattern stays; a new Insight captures the human's statement. A `pattern_recognized_by_human` Signal links them. This is the high-value moment — surface in the attention feed.
3. **Strategy without verdict yet.** Still a Strategy. Status `proposed` or `in_flight`. Verdict (`proven`/`disproven`) is a status transition, not a different DB. `Applies Framework` is optional — ad-hoc strategies don't need one.
4. **Pattern → Framework promotion.** Same as #1. Cerebro emits `framework_candidate`; human decides.
5. **Framework in flight + contradicting Pattern.** A `framework_pattern_contradiction` Signal fires, references both. High severity. Both rows stay; the Signal surfaces the tension.
6. **Signal recurs — does it become a Pattern?** No. Signals stay individual. A Pattern is a separate aggregate row that references the constituent Signals via an `Evidence Signals` relation. Patterns are second-order; Signals are first-order.

#### Schemas

| DB | Status | Schema |
|---|---|---|
| **Insights** | Must (V1) | Statement, Realized By (→ Person), Realized At, Recognizes Pattern (→ Pattern, optional), `Captured From`. |
| **Signals** | Must (V1) | Statement, Kind (closed enum, see above), Valence (`positive`/`negative`/`neutral`), Severity (`low`/`medium`/`high`), Topic, References (→ Framework/Pattern/Strategy/Objective/Metric, optional), `Captured From`. |
| **Strategies** | Stretch (V1) / Must (V1.1) | Title, Hypothesis, Applies Framework (→ Framework, optional), Applies To (→ Projects/Companies), Status (`proposed`/`in_flight`/`proven`/`disproven`), Outcome, Verdict Date, `Captured From`. |
| **Frameworks** | Deferred (V1.1+) | Name, Statement, Originator (→ Person), Promoted From (→ Insight/Pattern), Cited By (`Captured From` rollup). |
| **Patterns** | Deferred (V1.1+) | Name, Description, Subjects (→ People/Companies), Evidence Signals (→ Signal rollup), Evidence Count, First/Last Observed, `Captured From`. |

### Long-Term Memory — Measurement DBs

Two DBs that quantify the team's bets. Separated from Intelligence because they're not lenses or observations — they're *commitments and the rulers that measure them*.

| DB | Status | Authored by | Schema |
|---|---|---|---|
| **Objectives** | Must (V1) | Human (committed to) | Title, Kind (`objective`/`key_result`), Parent Objective (→ Objective, for KRs), Target Value, Target Date, Measured Outcome, Verdict (`hit`/`missed`/`in_flight`/`abandoned`), Applies To (→ Strategy/Framework/Project/Company), Measures (→ Metric), `Captured From`. |
| **Metrics** | Must (V1) | Human (defined) | Name, Definition, Unit, Cadence (`daily`/`weekly`/`monthly`/`quarterly`/`ad_hoc`), Current Value, Last Updated, Source (`Mercury`/`Slack`/`Notion-Docs`/`manual`/etc.), Measures Objective (→ Objective), Measures Framework (→ Framework, optional), Trend Pattern (→ Pattern, when one emerges), `Captured From`. |

Key relations across Intelligence ↔ Measurement:

- **Objective → Metric**: the metric this Objective is measured against. "AIVC NPS ≥ 8 by Sept 30" measures the "AIVC NPS" Metric.
- **Metric → Pattern**: when readings accumulate into a clear trend (rising / falling / volatile), Cerebro creates a Pattern row and links the Metric to it.
- **Metric readings**: each measurement is a Signal of `Kind: metric_reading` that references the parent Metric row.

Cadence: Metrics with steady cadence are KPIs by another name. `ad_hoc` cadence is for one-off measurements taken to verdict a specific Objective.

### Cross-cutting

- Every Long-Term Memory DB has a `Captured From` relation back to Short-Term Memory. Clickable citations.
- People/Companies/Agents have `Aliases` synced from Glossary.
- The graph viz reads from People + Decisions + Signals + Insights + Patterns + Short-Term Memory at minimum. Other DBs are filters/overlays.

## Source workers (6)

Each source worker is a thin source adapter: pull from external API → parse source-specific format → call shared `clean()` → write to Short-Term Memory with `Status: cleaned`. They do NOT call Hindsight. They do NOT write to Long-Term Memory.

| Worker | Status | OAuth | Notes |
|---|---|---|---|
| **Slack** | In flight ([PR #4](https://github.com/optemization-tech/Hackathon-Cerebro/pull/4) merged) | Single workspace bot | Already writes to Notion via `ingestSlackMessage`. Add cleaning + entity extraction; rename to write to Short-Term Memory. |
| **Granola** | Not started | TBD per-user via Granola API/MCP | Primary meeting source. |
| **Circleback** | Not started | TBD per-user | Alternate meeting source. |
| **GMail** | Not started | **Google Workspace domain-wide delegation** — single service account, no per-user OAuth flow. | Same OAuth model works for GCal. |
| **GCal** | Not started | Same as GMail | Pulls calendar events. |
| **Notion-Docs** | Not started | Notion integration (already authorized) | Watches the org's **existing Docs database(s)**. For Optemization, [this one](https://www.notion.so/optemization/7770dd47209b49098dad46ec0d4dcb3b?v=115e42e1e0cc42a1ba4ffdee205cbba7). Filters out archived rows. Each non-archived row → Short-Term Memory entry tagged `verified:true` (passed through to Hindsight). Re-syncs on `last_edited_time` change. Configurable list of Docs DB IDs — multi-DB orgs supported in product scope. |

**Canonical pattern:** see `slack/src/index.ts`. Each worker is a Notion Worker with a sync capability writing into Short-Term Memory. Dedup via the source system's stable UUID written to the `ID` property. Schedule: every 30 minutes for the demo. Pacer respects upstream API limits.

**Cleaning step (every worker):** after parsing the source-specific payload but before writing to Short-Term Memory, call `clean(content, glossary)` from the shared library. Store the cleaned text in the row's page body. The library performs alias → canonical term substitution only — entity extraction is Hindsight's job during `retain()`.

**Architectural rule:** source workers write only to Short-Term Memory. They do NOT call Hindsight. They do NOT write to Long-Term Memory. The Indexer Worker is the sole Hindsight writer; the Sync Worker is the sole Long-Term Memory writer.

## The shared cleaning library

A small TypeScript module imported by all six source workers. Lives somewhere like `slack/src/lib/cleaning.ts` initially (since `slack/` is the worker repo); will move to a shared workers/lib path as more workers come online.

### API

```ts
import { clean } from "./cleaning";
import { loadGlossary } from "./glossary";

const glossary = await loadGlossary(notionClient);
const cleanedText = clean(rawText, glossary);
```

### Behavior

1. Loads Glossary entries (cached per Worker run).
2. For each Glossary entry, finds aliases in the raw text and replaces with the canonical term.
   - Case-insensitive match.
   - Word-boundary aware (so "Tim" doesn't match inside "Timothy").
   - Longest-alias-first (so "I-V-C" doesn't get partially matched by a single-letter alias).
3. Returns the normalized string directly. **No entity extraction** — that is Hindsight's job during `retain()`. Keeping cleaning to text normalization only makes the library simpler and avoids double-work between the source workers and Hindsight.

Hindsight's LLM extracts entities from the cleaned body during `retain()`, producing a clean entity graph without any pre-seeding from the ingestion pipeline.

### Why a library, not a Worker

- Cleaning rides on top of source-specific parsing (Slack JSON vs Granola transcript vs Notion page content) — source workers naturally already have the parsed text in hand.
- A separate Cleaner Worker would add an extra Notion I/O hop (write raw → read raw → write cleaned → read cleaned) and another `Status` stage for no real benefit.
- Each source worker does very little Glossary work — one `clean()` call. The shared module captures the DRY benefit without adding a Worker.

## Hindsight Indexer Worker

A single Notion Worker that bridges Short-Term Memory → Hindsight Cloud. The only thing in the system that calls `retain()`.

### Execution model

- **Schedule:** 5-minute cron (or `continuous` if we want lower latency for the demo).
- **Query:** Short-Term Memory rows where `Status = cleaned`. Paginate; cap batch at ~50 per run.
- **For each row:**
  1. Read row properties: cleaned page body, `ID`, `Data Type`, `Source`, `Person Source`, `Created time`, `verified:true` if tagged.
  2. Build the tag set from row properties (see "Tagging strategy" below).
  3. Call Hindsight `retain(bank_id="Cerebro", content=<cleaned body>, document_id=<row id>, tags=<tag set>, context=<Data Type>, timestamp=<Created time>)` with `async: false` (sync mode) so Status is flipped to `indexed` only after Hindsight has actually extracted. Entity extraction is delegated to Hindsight's LLM.
  4. On success, flip the row's `Status` to `indexed`.
  5. On failure, flip to `failed` and record the error — retry `failed` rows on a slower schedule.
- **Idempotency:** `document_id` is the STM `ID` property value (deterministic per source worker). Re-running the Indexer over an already-indexed row is a no-op upsert on Hindsight's side; the Indexer's query filter (`Status = cleaned`) skips `indexed` and `failed` rows by default.

### Tagging strategy (every `retain` call)

| Tag | Example |
|---|---|
| `team:optemization` | always |
| `person-source:<slug>` | `person-source:tem`, `person-source:kamau` — who captured this |
| `source:<tool>` | `source:slack`, `source:granola`, `source:circleback`, `source:gmail`, `source:gcal`, `source:notion-docs` |
| `data-type:<type>` | `data-type:meeting-transcript`, `data-type:slack-message`, `data-type:email`, `data-type:calendar-event`, `data-type:note` |
| `engagement:<slug>` | `engagement:aivc`, `engagement:internal` — when detectable |
| `stm:<page-id>` | `stm:362a4866-…` — the Short-Term Memory page ID (citation primitive) |
| `verified:true` | only for rows from the Notion-Docs source (human-authored, edited, verified content) |

Recall is scoped naturally: `tags=["engagement:aivc"]` → only AIVC. `tags=["verified:true"]` → only org-edited Docs content. `tags=["stm:<page-id>"]` → every memory derived from one Short-Term Memory row.

### Why a single Worker (not per-source)

- One place to manage Hindsight credentials, rate limits, and the `retain()` integration shape.
- Source workers don't need to know about Hindsight — testable in isolation against a Notion mock.
- Backfill is trivial: reset a range of Short-Term Memory rows to `Status: cleaned` and the Indexer re-processes them.
- Migrating off Hindsight later means rewriting one Worker, not six.

## The Hindsight bank: `Cerebro` (bank ID: `Cerebro`, namespace: `default`)

One bank for V1. Tags handle scoping. Multi-bank options live in the [product scope](#bank-architecture-options).

### Bank config

```json
{
  "version": "1",
  "bank": {
    "mission": "I am Cerebro, the Optemization team's second brain. I track decisions, signals, patterns, and people across the team's meetings, Slack, email, calendar, and verified Notion docs so anyone — human or agent — can ask 'what's going on?' and get a sourced answer. I prioritize accuracy, attribution, and citation over speculation. Memories tagged verified:true come from human-edited Notion documents and should be weighted higher than raw transcript-derived facts when they conflict.",
    "retain_mission": "Extract structured records that legibilize Optemization, an AI consultancy team. Capture: (1) People — every human mentioned, their role, their company, their current concerns; (2) Companies — every organization in scope, especially clients; (3) Decisions — what the team committed to, who decided, why, when, and the status (proposed/committed/reversed/blocked); (4) Insights — moments of conscious realization articulated by a team member, tied to the source moment; (5) Signals — stress markers, friction points, deadlines, blockers, leading indicators across functions, with valence; (6) Projects — time-bounded work streams; (7) Tasks — concrete follow-ups with owners and due dates. Be precise about attribution: who said what, in what context, when.",
    "enable_observations": true,
    "observations_mission": "Track behavioral patterns the team may not have consciously noticed: recurring concerns that surface across many sources, decisions that keep getting deferred, people whose stress signals are rising, frameworks the team reaches for repeatedly, strategies that keep failing or succeeding. These observations become Cerebro's Patterns — what Cerebro tells the team about themselves.",
    "disposition": { "skepticism": 4, "literalism": 4, "empathy": 3 }
  },
  "mental_models": [
    {
      "id": "team-state",
      "name": "Team State Right Now",
      "source_query": "What is the Optemization team currently working on, who is leading what, and what are the most active engagements? Who is dealing with what kind of pressure or friction right now?",
      "max_tokens": 2048,
      "trigger": { "refresh_after_consolidation": true }
    },
    {
      "id": "open-decisions",
      "name": "Open Decisions",
      "source_query": "What decisions are currently proposed, blocked, or pending? Who needs to make each one, and what's blocking them?",
      "max_tokens": 2048,
      "trigger": { "refresh_after_consolidation": true }
    },
    {
      "id": "client-engagements",
      "name": "Active Client Engagements",
      "source_query": "What's the state of each active client engagement — AIVC, PicnicHealth, Bellesa, Leslie Institute, Temporal? Active workstreams, latest signals, what the team is committed to delivering, who's leading.",
      "max_tokens": 4096,
      "trigger": { "refresh_after_consolidation": true }
    },
    {
      "id": "rising-signals",
      "name": "Rising Signals",
      "source_query": "What signals have been mounting across recent meetings, Slack threads, and emails — stress points, friction signals, pending deadlines, anything that suggests the team should pay attention?",
      "max_tokens": 2048,
      "trigger": { "refresh_after_consolidation": true }
    }
  ]
}
```

### document_id

The Indexer passes `document_id = <Short-Term Memory page ID>` on every `retain` call. This makes retain idempotent — re-indexing the same row updates the Hindsight memory in place rather than accumulating duplicates. Re-running the Indexer over any range of Short-Term Memory rows is therefore safe.

## Cerebro Sync Worker (webhook-driven)

A Notion Worker with a webhook capability. Subscribed to Hindsight Cloud webhooks for the `Cerebro` bank.

> **Cloud webhook caveat (2026-05-16).** Hindsight Cloud's `CreateWebhookRequest.event_types` only accepts `consolidation.completed` today — `retain.completed` is documented but not yet emitted by the Cloud API. Until that lands, the `retain.completed` handler below runs on a 5-minute cron in the Sync Worker, polling Short-Term Memory for rows with `Status: indexed` and treating each one as if a webhook had fired. Same handler logic, just pull-driven. When Cloud ships `retain.completed`, register the webhook and delete the poller — no other change needed.

### `retain.completed` handler (poll-driven on Cloud; webhook-driven once Cloud supports it)

1. Receive event with `document_id` (the Short-Term Memory page ID) — or, in poll mode, pick up a Short-Term Memory row with `Status: indexed`.
2. Call Hindsight `recall(query="all facts from this document", tags=["stm:<doc-id>"], types=["world"])` — pull the structured facts Hindsight extracted.
3. For each fact, classify into a Long-Term Memory DB (People / Decisions / Insights / Signals / Projects / Tasks) — the classification logic uses the fact's entities, context, and metadata, falling back to an LLM call if needed.
4. Upsert into the right DB with `Captured From` pointing back to the Short-Term Memory row.
5. Mark the Short-Term Memory row's `Status` as `distilled`.

### `consolidation.completed` handler

1. Receive event with `observations_created` / `observations_updated`.
2. Call Hindsight `recall(types=["observation"], since=<last-sync-timestamp>)`.
3. Each observation becomes a Pattern row (Pattern DB is deferred for V1 — defer to V1.1).
4. For mental models, just refresh the cached display in the graph viz.

### Cerebro Distiller Custom Agent (optional refinement)

A Notion Custom Agent kept lightweight. Used for human-in-the-loop refinement when the auto-sync produces something off — Tem invokes "Cerebro Distiller, fix this Decision row" and the agent uses Worker tools to read related Short-Term Memory + edit the row. Not on the critical path for the demo.

## Q&A surfaces

Four surfaces, one backend.

### Ask Cerebro (Notion Custom Agent)

Available in the Notion UI for free. Single Worker tool:

| Tool | Purpose |
|---|---|
| `askCerebro(question, scope?)` | Calls Hindsight `reflect()` against the `Cerebro` bank. Returns `{ answer, based_on: [fact_ids] }`. Citations are looked up via `relatedMemories` and presented as clickable Short-Term Memory links. |

The agent prompt biases toward citation. The bank's `mission` + `disposition` already shape voice — Ask Cerebro inherits this.

### Tavus video avatar

`/avatar` page on the Next.js app hosts the Tavus CVI widget. Widget configured with a tool that POSTs the user's spoken question to `/api/ask`. Side panel updates with citations.

### ElevenLabs voice chat

ElevenLabs hosted UI. Their conversational agent has a tool registered: HTTP POST to `/api/ask`. We don't host the UI ourselves.

### Graph viz

`/graph` page. Force-directed graph (react-force-graph or vis-network) reading People + Decisions + Signals + Insights + Short-Term Memory via `/api/feed`. Click a node → side panel with clickable Short-Term Memory citations.

### The Q&A API

`POST /api/ask`. Body: `{ question: string, scope?: { engagement?: string } }`. Response: `{ answer: string, citations: [{ memoryId, title, url }] }`.

Internals:

1. Receive question.
2. Call Hindsight `reflect(bank_id="Cerebro", query=question, include_facts=true, budget="mid", tags=<scope tags>)`.
3. Stream the answer tokens back (Tavus/ElevenLabs both want streaming).
4. From the response's `based_on.memories`, look up the source Short-Term Memory pages via the `stm:<page-id>` tags and return them as citations.

**Fallback if Hindsight Cloud is unavailable:** the Q&A API calls Anthropic Claude directly with `relatedMemories` / `searchMemories` Worker tools as function-call schemas. Same external surface. Time-box the Hindsight integration to Saturday afternoon — fall back if it's not working.

## Demo flow (3 minutes)

1. **Setup (~20s):** "We legibilized Optemization. Six source Workers writing into Notion's Short-Term Memory after cleaning each input against the org's Glossary. One Indexer Worker pushing that into Hindsight Cloud. One Sync Worker reading Hindsight's insights back into Long-Term Memory. Two Custom Agents. Six Long-Term Memory DBs. All on Notion's Developer Platform with Hindsight as the memory engine." Show Short-Term Memory ticking forward (a Slack message just landed, Status flipping from `cleaned` → `indexed` → `distilled`), Long-Term Memory populated.
2. **The avatar (~60s):** Open the Tavus avatar page. Ask "What did RC commit to with us last week?" Avatar speaks back; citations populate the side panel; click a citation to jump into the Short-Term Memory entry in Notion.
3. **Voice (~30s):** Switch to ElevenLabs hosted chat. Ask "What's the team feeling about Asana vs Linear right now?" — Hindsight pulls Signals + Insights, reflects, speaks back. Same backend, different surface.
4. **Graph (~40s):** Open the graph viz. Force-directed layout of people ↔ decisions ↔ signals/insights. Click RC's node — side panel shows his interaction history, recent decisions, signals around him.
5. **The platform kicker (~30s):** Quick view of the Notion agent UI with Ask Cerebro running natively. "And by the way, all of this works inside Notion too because Ask Cerebro is a Custom Agent calling a Worker tool that calls Hindsight reflect." Cut to the worker dashboard showing all eight Workers live. End on Short-Term Memory ticking forward as another Slack thread comes in — and the Glossary normalizing "Aar See" → "RC Willenbrock" right in front of the audience.

## MVP cut

### Must ship (demo-critical)

- Short-Term Memory DB (already created) — extend Source + Data Type options, confirm `Status` select works (`cleaned` / `indexed` / `distilled` / `failed`).
- **Glossary DB** with ~15 seed entries (team members, AIVC, RC, key clients, common acronyms).
- **Shared cleaning library** (`clean(content, glossary)`) — TypeScript module imported by source workers.
- Hindsight Cloud bank `Cerebro` configured with the JSON above. Mental models populated and refreshing.
- **3 source workers running for real on Optemization's data:** Slack (already in flight) + Granola or Circleback (one meeting source) + Notion-Docs (watching [the Optemization Docs DB](https://www.notion.so/optemization/7770dd47209b49098dad46ec0d4dcb3b?v=115e42e1e0cc42a1ba4ffdee205cbba7)). Each calls the cleaning library and writes to Short-Term Memory only.
- **Hindsight Indexer Worker** running on a 5-min cron, polling Short-Term Memory `Status: cleaned`, calling Hindsight `retain()` with sync mode, marking `Status: indexed` only after extraction completes.
- **Cerebro Sync Worker** subscribed to Hindsight webhooks, writing into 8 Long-Term Memory DBs (the 6 original MVP + Objectives + Metrics).
- Ask Cerebro Custom Agent with `askCerebro` Worker tool.
- **Both Tavus and ElevenLabs surfaces working**, hitting the same `/api/ask`.
- **Graph viz page** rendering People ↔ Decisions ↔ Signals/Insights with clickable Short-Term Memory citations.

### Stretch (demo nice-to-have)

- 4th source worker (GMail or GCal).
- Companies + Strategies Long-Term Memory DBs populated.
- Patterns DB populated from Hindsight observations (this is *technically* MVP-able if `consolidation.completed` fires reliably).
- Mental model display panel on the graph viz page (live-updating dashboards).
- Indexer running on `continuous` schedule instead of 5-min cron for near-real-time demo feel.
- LLM-assisted Glossary candidate proposer (scan Short-Term Memory for unknown proper nouns, propose entries).

### Deferred to product scope

Everything in the [product scope section](#product-scope-v11--v3--long-arc) below.

## Open questions (hackathon-blocking)

1. **Hindsight Cloud signup latency.** Need an API key by Saturday morning. If approval delays, fall back to vanilla Anthropic for the demo and use Hindsight Cloud in V1.1. Sign up at [ui.hindsight.vectorize.io/signup](https://ui.hindsight.vectorize.io/signup) Friday night.
2. **Webhook delivery from Hindsight to Notion Workers.** Notion Workers support webhooks ([slack/CLAUDE.md docs them](../../slack/CLAUDE.md#webhooks)). Verify the URL format works with Hindsight's webhook subscription model — Hindsight expects a POST endpoint; Notion Workers expose those natively. Should "just work" but verify Saturday morning. ⚠️ **Resolved 2026-05-16:** Hindsight Cloud's `CreateWebhookRequest` only accepts `consolidation.completed` today (verified via the OpenAPI spec at `https://api.hindsight.vectorize.io/openapi.json`). The `retain.completed` path is poll-driven in V1 (Sync Worker scans Short-Term Memory for `Status: indexed`); flip to webhook once Cloud emits the event. See [Cerebro Sync Worker](#cerebro-sync-worker-webhook-driven).
3. **`retain.completed` → Long-Term Memory classification.** Hindsight returns generic "world facts." We need to classify each fact into Person / Decision / Insight / Signal / etc. before writing to Notion. Approach: light LLM classifier in the Sync Worker, with heuristics (entity types, context tags) as fast-path. Manageable but real work.
4. **Granola vs Circleback for V1.** Pick one as the second source worker (besides Slack and Notion-Docs). Decision criterion: cleaner read API + per-user OAuth story. Both have MCP integrations per the available skills list.
5. **Notion-Docs filtering rules.** Which rows in the Docs DB do we actually want to ingest? Default: all non-archived. Open question whether to also filter on `External Facing` (skip external-facing client docs?), `Status` (skip drafts?), or specific Types (skip Scratchpad/Drafts). Decide during build by looking at the actual Docs DB content.
6. **Indexer schedule for demo.** 5-minute cron is the safe default. If we want the demo to feel near-real-time ("watch the Slack message land in Hindsight in seconds"), switch to `continuous`. Verify Hindsight Cloud rate limits before flipping.
7. **Cleaning library API shape.** Per-source variants vs one uniform `clean()` call. MVP: uniform. Each source calls `clean(content, glossary)` after its source-specific parsing. Source-specific cleaning (signature stripping, transcript artifact removal) lives inside each source worker before calling `clean()`.

---

# Product scope (V1.1 → V3) — long arc

Everything beyond the hackathon demo. The hackathon scope above is the V1 milestone toward what's below. The data model from the hackathon scope is unchanged; this section adds the memory architecture phases, bank options, source ingestion roadmap, Q&A surfaces roadmap, deferred features (Forecasting, single-player, Tasks integration), pricing/packaging deferrals, and the milestone roadmap.

## Memory architecture: three phases

### Phase 1: Hindsight Cloud (hackathon → first months)

- One bank: `Cerebro` (namespace: `default`)
- [Hindsight Cloud](https://hindsight.vectorize.io) hosted (zero infra ops)
- Six source workers write to Notion Short-Term Memory after cleaning via shared library; the Indexer Worker bridges Notion → Hindsight `retain()` on a 5-minute cron
- Cerebro Sync Worker subscribed to Hindsight webhooks; writes into Long-Term Memory
- Ask Cerebro Custom Agent calls Hindsight `reflect()`
- Defined in detail in the hackathon scope above.

### Phase 2: Self-hosted vanilla Hindsight (months 1–6 post-hackathon)

**Triggers to migrate:**
- **Cost.** Cloud per-call pricing becomes meaningful at full team scale (especially with 6+ sources hitting `retain` every 30 minutes).
- **Data residency.** Clients like AIVC won't accept third-party vendors in the decision path. Hosting Hindsight on infra we control is the answer.
- **Latency / tuning.** We may want to colocate Hindsight with our Postgres for tighter feedback loops.

**How:**
- Helm chart on our infra (Vercel + Neon Postgres + pgvector, or Render, or Fly).
- Pull upstream Hindsight as a dependency, not modified source.
- Bank config (mission, observations_mission, mental models, dispositions) handles ~90% of customization.
- Tags, webhooks, the indexer-worker pattern, and the Notion-as-canonical-raw-store discipline stay identical. The Indexer Worker swaps its Hindsight endpoint from Cloud to self-hosted; everything else is unchanged.

**What stays the same:**
- The Cerebro layer (six source workers, shared cleaning library, Indexer Worker, Cerebro Sync Worker, Cerebro Distiller, Q&A API, graph viz, avatar/voice pages).
- The bank config — just deployed to our infra instead of Cloud.
- All product workflows.

### Phase 3: Fork triggers (only when justified)

Specific triggers — not before:

1. **Extraction-prompt customization.** When we want Hindsight's LLM to emit Cerebro's 13 categories natively (Decision/Insight/Pattern/Signal/Objective/Metric/...) instead of generic facts we post-classify. Saves real LLM tokens at scale.
2. **Write-back primitive.** When humans editing a Person row in Notion needs to propagate back into Hindsight's entity graph cleanly, and we can't get that via the public API.
3. **Custom retrieval strategy.** When TEMPR (semantic + BM25 + graph + temporal) isn't enough and we want a 5th — e.g. an `engagement` strategy that traverses Notion's relational graph alongside Hindsight's.
4. **On-prem for a specific client.** When AIVC (or similar) wants Cerebro inside their VPC with no outbound network. Vanilla Helm gets us 95% there; the last 5% might need code changes.

Until one of these fires, vanilla self-hosted is the right answer. Cerebro's defensibility lives in the Notion integration + demo surfaces + workflows + bank config + prompt engineering — NOT in the memory primitives themselves. Hindsight is plumbing; we own the value layer above it.

## Bank architecture options

| Option | When |
|---|---|
| **Single workspace bank** (`Cerebro`, namespace `default`) | Default. Tags handle scoping. Hackathon through ~6 months. |
| **Per-engagement bank** | When extraction quality suffers from over-broad mission, or when we sell to clients (each client gets a bank tuned for their org). Bank per AIVC/PicnicHealth/Bellesa/etc. |
| **Per-person bank** | Single-player mode. Each Optemization team member has their own bank scoped to their own data. Useful for privacy-conscious users and as a B2C-lite offering. |
| **Hybrid** | Workspace bank + per-engagement banks. A routing layer (Notion Worker or Cerebro Distiller) decides where each retain lands. Probably the long-term answer at scale. |

Trade-offs:
- **Single bank**: rich entity graph (Hindsight's strength). Cross-engagement recall works. Simpler ops.
- **Multi-bank**: tuned extraction per scope. Disposition can differ per use case. But the entity graph fragments — RC's interactions in the AIVC bank don't graph-traverse to his Optemization mentions in the team bank.

For V2+, expect to run a hybrid: a `team-wide` bank that captures everything (broad mission, no special disposition), plus per-engagement banks for active clients (tuned mission, scoped recall for client-facing Q&A).

## Source ingestion roadmap

Beyond the 6 hackathon workers (Slack, Granola, Circleback, GMail, GCal, Notion-Docs):

| Source | Phase | Notes |
|---|---|---|
| Additional Docs DBs (per-engagement or per-team) | V1.1 | Multi-DB orgs supported — the Notion-Docs worker accepts a list of Docs DB IDs. |
| Pulse logs (per-engagement, per-day) | V1.5 | Selective ingestion of daily notes from engagement folders. |
| GitHub (PRs, issues, commit messages) | V1.5 | For the engineering team. PR descriptions contain decisions. |
| Linear or Asana (tasks, project state) | V1.5 | Pull task DB to keep Cerebro's Tasks DB in sync. |
| Voice memos / standalone recordings | V2 | Granola handles many; standalone audio uploads for ad-hoc. |
| Browser history (selective) | V2 | Per-user opt-in. Captures what someone was researching. |
| Stripe / Mercury / financial events | V2 | Surface revenue/cost signals into the Signals DB. |
| Phone calls | V2 | If we can transcribe (Twilio + Whisper or equivalent). |
| Notion comments + page edits | V2 | When the team starts editing Long-Term Memory rows, those edits should feed back as `experience` facts. |
| LinkedIn + X saves | V2 | Mirror of RC's clippings pattern — saved posts become Insights or Signals candidates. |

Pattern: every Notion Worker is a thin source adapter. Add as engagements grow. The bank can absorb breadth — Hindsight's tag system handles scoping.

## Q&A surfaces roadmap

| Surface | V1 (hackathon) | V1.1 | V2+ |
|---|---|---|---|
| Ask Cerebro Custom Agent | ✓ | Refined prompts + dispositions | Per-engagement disposition tuning |
| Tavus video avatar | ✓ | Branded characters per use case | "Cerebro the assistant" with persistent identity |
| ElevenLabs voice chat | ✓ | – | On-the-go via phone call (Twilio) |
| Cerebro graph viz | ✓ basic | Time-scrubber + sub-graph zoom + filtering | Diff view: what changed in the last day/week |
| Slack bot | – | `/ask cerebro <question>` in any channel | Reply in-thread with citations |
| Email digest | – | Daily/weekly digest of what changed in Long-Term Memory | Personalized per recipient |
| Mobile native app | – | – | Maybe — depends on usage patterns. Voice + light dashboard. |
| Notion in-line | – | Backlink hover preview shows related Long-Term Memory rows | First-class Notion sidebar |

## Forecasting (deferred from hackathon)

Cerebro should not just answer "what happened?" — it should answer "what's about to happen?"

Use cases:
- An open Decision has been pending N days; the team lead isn't meeting the relevant stakeholder for another M days; **flag it**.
- A Signal pattern is escalating (more stress signals in the last 7 days than the previous 30); **alert**.
- A Project's Tasks are accumulating beyond capacity; **predict overrun**.

Implementation: Hindsight observations + Patterns DB + a scheduled Worker running forecasting queries against the bank + writes into a new `Forecasts` DB. The reflect prompt for these can use higher `budget` and explicit "predict" framing.

Phase V1.5–V2 feature.

## Single-player vs workspace

**Workspace mode (default).** One bank per team. All members share Long-Term Memory and Short-Term Memory. Tag-scoped recall by `person-source:<slug>` lets queries narrow to one person's perspective without splitting the data.

**Single-player mode.** One bank per Person. They see only the meetings/Slack/email they participated in. Useful for:
- New hires onboarding (their bank grows as they engage).
- Privacy-conscious team members who don't want their personal email surfacing in team queries.
- Selling Cerebro to individual contributors (B2C-lite).

Implementation: bank-per-user with `Person Source` already-existing as the natural scope. Same Long-Term Memory DBs, filtered views per Person.

Phase V1.5–V2 feature.

## Tasks integration

The hackathon ships a Cerebro-owned Tasks DB to keep scope contained. The product question: do we maintain our own, or integrate with the existing Optemization Tasks DBs ([Tasks 1](https://www.notion.so/2123fb33a7fd4048a249fddb4269aa9e), [Tasks 2](https://www.notion.so/a4d5202b1a304dda8d8c58927063a32a))?

**Option A: maintain Cerebro Tasks.** Pro: clean schema control. Con: duplicate of source-of-truth task systems.

**Option B: write into existing DBs.** A Cerebro Sync Worker that watches Hindsight for task-shaped facts and upserts into the existing Optemization Tasks DBs. Pro: single source of truth. Con: schema mapping at every Tasks DB the customer uses.

**Option C: read-only Cerebro Tasks view.** Cerebro Tasks is a view over the customer's existing Tasks DB(s) plus task-shaped facts from Hindsight that haven't yet been materialized. Best of both — but the most build effort.

Pick post-hackathon based on dogfood feedback. Default plan: Option C for V1.5.

## Pricing and packaging (deferred)

Not designing pricing yet. When we do:
- **Per-workspace tier** vs **per-user tier** vs **per-Person-bank tier** are all viable.
- **Self-hosted option** for clients with compliance needs (data residency, on-prem).
- **Managed option** via Optemization (we host, client pays a margin).
- **OSS option** for the Cerebro layer (the Notion workers + Distiller + Q&A API are MIT/Apache, monetize the service + agentic operations).

Defer until V1.5 traction is clear.

## Roadmap

| Milestone | Target date | Scope |
|---|---|---|
| **V1 (hackathon)** | 2026-05-17 | 3 sources running, 8 Long-Term Memory DBs (the 6 original MVP + Objectives + Metrics), both voice/video surfaces, graph viz, Hindsight Cloud bank. See [hackathon scope](#hackathon-scope-v1--what-ships-by-sunday-demo) above. |
| **V1.1** | end of May 2026 | All 6 sources running (Slack + Granola + Circleback + GMail + GCal + Notion-Docs). All 13 Long-Term Memory DBs populated. Mental model dashboards visible in the graph viz. Multi-Docs-DB support. |
| **V1.5** | June–July 2026 | RC (AIVC) onboarded as design partner. Per-engagement bank prototype. Forecasting in alpha. Single-player mode v0. Slack bot for Q&A. |
| **V2** | Q3 2026 | Self-hosted vanilla Hindsight. First on-prem client demo. Forecasting GA. Tasks integration Option C. Two design-partner customers live. |
| **V2.5** | Q4 2026 | First fork commits, if any trigger has fired. Single-player mode GA. Pricing model finalized. |
| **V3** | 2027 | Self-serve onboarding. OSS layer published. Marketplace presence (Notion app gallery, Cerebral Valley, etc.). |

## Open questions (strategic)

1. **Custom Agent vs SDK-driven agent.** Long-term, do we keep Ask Cerebro as a Notion Custom Agent (limited to Notion's surface) or build our own agent runtime on Vercel that uses Hindsight directly (more control, less Notion-native)? Trade-off: Notion-native = better integration with Notion users + Workers; custom = more freedom for the avatar/voice/multi-channel surfaces.
2. **Multi-tenancy at scale.** When we onboard 10+ client teams, what's the operational model? One Hindsight deployment per team? Multi-tenant single deployment with bank-level isolation? Hosted vs client-self-hosted?
3. **Disposition customization per client.** RC (AIVC) wants high skepticism (he's a VC). PicnicHealth might want high empathy (healthcare). Are dispositions configured per bank, or per Q&A surface, or both?
4. **Notion lock-in.** Cerebro's "human-readable" surface is Notion. What if a client doesn't use Notion? Possible answers: (a) we don't sell to them; (b) we build a Cerebro-native UI on top of Hindsight that mirrors Notion's relational view; (c) we offer Cerebro as a Notion-installer that bootstraps their workspace.
5. **The "Memory layer" question.** Hindsight is the right answer today. In 2 years, will it be? If a competitor (Anthropic's memory primitives? OpenAI's? Notion's own?) ships something better, can we swap? The `retain/recall/reflect` contract is small and well-defined — keep it as our internal interface, treat the underlying engine as pluggable.
6. **Forecasting accuracy.** Forecasting is the most exciting feature but the hardest. Is it valuable enough to be worth building well, or do we cap it at "suggestion-level" forecasts that humans verify?
7. **Cerebro for non-team contexts.** Is there a meaningful product for individuals (single-player Cerebro as a personal knowledge OS)? RC built his on Obsidian; could Cerebro replace that? Or is the team-multiplayer angle the only viable wedge?

---

# Reference

## Glossary (for agents reading this doc)

| Term | Meaning |
|---|---|
| Cerebro | The team second brain — this product. |
| Short-Term Memory | The raw-but-cleaned-text Notion database every source worker writes to. Workspace-level. [Already created](https://www.notion.so/optemization/362a48662b2580bfb16dd60e57679d9d). The canonical raw store. |
| Long-Term Memory | The distilled output DBs as a group. 13 DBs total; 8 of those ship in V1 (the 6 original MVP + Objectives + Metrics). |
| Glossary DB | The Notion DB of aliases ↔ canonical terms ↔ entity types. Read by the shared cleaning library. MUST-ship for V1 with ~15 seed entries. |
| Cleaning library | Shared TypeScript module imported by every source worker. Exposes `clean(content, glossary)` returning a normalized `string` (alias → canonical term substitution only; no entity extraction). Lives in the workers codebase. |
| Hindsight | [hindsight.vectorize.io](https://hindsight.vectorize.io) — the biomimetic memory system we use as the memory engine. Open-source on [GitHub](https://github.com/vectorize-io/hindsight); V1 uses Hindsight Cloud (managed). |
| Bank | A Hindsight memory bank. V1 uses one: bank ID `Cerebro`, namespace `default`. |
| Source Worker | One of the six Notion Workers (Slack, Granola, Circleback, GMail, GCal, Notion-Docs) that pulls from an external API, parses it, cleans via the shared library, and writes to Short-Term Memory. Doesn't talk to Hindsight. |
| Notion-Docs source worker | The 6th source worker. Watches the org's existing Docs database(s) — for Optemization, [the main Docs DB](https://www.notion.so/optemization/7770dd47209b49098dad46ec0d4dcb3b?v=115e42e1e0cc42a1ba4ffdee205cbba7). Ingests human-authored, verified content. Tagged `verified:true` so Hindsight can weight it higher. |
| Hindsight Indexer Worker | The single Notion Worker that polls Short-Term Memory for `Status: cleaned` rows and calls Hindsight `retain()`. The only thing in the system that talks to Hindsight on ingest. |
| Cerebro Sync Worker | The Notion Worker (webhook capability) that receives Hindsight events (`retain.completed`, `consolidation.completed`) and writes to Long-Term Memory. The only thing that writes to Long-Term Memory. |
| Cerebro Distiller | The Notion Custom Agent for human-in-the-loop refinement of Long-Term Memory rows. Optional for V1. |
| Ask Cerebro | The Notion Custom Agent that answers user questions via Hindsight `reflect()`. |
| Worker | A Notion Worker — see [`slack/CLAUDE.md`](../../slack/CLAUDE.md). |
| Q&A API | The Next.js API route at `/api/ask` that bridges voice/video surfaces to Hindsight `reflect()`. |
| `Captured From` | The relation on every Long-Term Memory row pointing back to Short-Term Memory entries. Citation primitive. |
| `stm:<page-id>` | Hindsight tag pattern for joining a memory back to its Short-Term Memory row. |
| `verified:true` | Hindsight tag applied to memories sourced from the org's Docs DB. Indicates human-authored, edited content; can be used to weight recall. |
| Mental Model | A standing Hindsight query whose answer auto-refreshes after each consolidation. Powers the "always-fresh dashboards" on the demo surface. |
| Domain-wide delegation | Google Workspace's admin-level OAuth scheme — single service account for the whole optemization.com domain. |
| TEMPR | Hindsight's 4-strategy retrieval: semantic + BM25 + graph + temporal, fused with RRF + cross-encoder reranking. |
| Legibilize | Make the org's work readable by AI agents. RC at AIVC's phrase. The point of Cerebro. |

## References

- [**Repo top-level CLAUDE.md**](../../CLAUDE.md) — team workflow rules. Read first.
- [**`slack/CLAUDE.md`**](../../slack/CLAUDE.md) — Notion Worker API + canonical worker patterns.
- [**Short-Term Memory DB**](https://www.notion.so/optemization/362a48662b2580bfb16dd60e57679d9d) — the workspace-level raw-capture DB.
- [**Optemization Docs DB**](https://www.notion.so/optemization/7770dd47209b49098dad46ec0d4dcb3b?v=115e42e1e0cc42a1ba4ffdee205cbba7) — the source for the Notion-Docs worker.
- [**Hindsight Cloud signup**](https://ui.hindsight.vectorize.io/signup) — sign up before Saturday morning.
- [**Hindsight docs**](https://hindsight.vectorize.io) — biomimetic memory system docs.
- [**Hindsight GitHub**](https://github.com/vectorize-io/hindsight) — Apache-licensed source we can fork if/when triggered.
- [**Notion Workers docs**](https://developers.notion.com/workers/get-started/overview).
- [**Notion Agents SDK**](https://github.com/makenotion/notion-agents-sdk-js).
- [**Hackathon Prep Notion page**](https://www.notion.so/optemization/Hackathon-Prep-361a48662b2580f5a26ad73a9f8fbd2a) — original brainstorm + judging criteria.
- [**Tavus CVI**](https://www.tavus.io/cvi) — video avatar platform.
- [**ElevenLabs Conversational AI**](https://elevenlabs.io/conversational-ai) — voice surface.
- [**Optemization's Notion workspace**](https://www.notion.so/optemization) — the human-readable side of Cerebro.

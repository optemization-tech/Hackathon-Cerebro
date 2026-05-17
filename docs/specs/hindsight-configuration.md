# Hindsight Configuration Guide for Cerebro

Reference doc covering how Hindsight works, how Cerebro should use it, and specific configuration recommendations. Based on Hindsight's official docs, best practices, and the Cerebro product spec.

Source: https://hindsight.vectorize.io

---

## How Hindsight works (the 60-second version)

Hindsight is a memory system for AI agents. Three operations:

- **`retain(content)`** -- ingests raw text (transcripts, Slack, emails). An LLM extracts structured facts, identifies entities, builds a knowledge graph, and anchors everything temporally. The raw text is not stored verbatim; only the extracted facts are.
- **`recall(query)`** -- searches the extracted facts using four strategies in parallel: semantic (vector), keyword (BM25), graph (entity relationships), temporal (date/time). Returns ranked facts.
- **`reflect(query)`** -- autonomous reasoning loop. Searches memory, synthesizes an answer, and returns it directly. Uses mental models and observations hierarchically.

After `retain()` completes, Hindsight asynchronously consolidates related facts into **observations** -- deduplicated, evidence-grounded beliefs with proof counts and freshness trends.

A **memory bank** is an isolated container for all of this. Banks don't share data. One bank = one brain.

### Memory type hierarchy

| Type | What it stores | Example |
|---|---|---|
| Mental Model | User-curated summaries for common queries | "Team State Right Now" |
| Observation | Auto-consolidated knowledge from facts | "Tem consistently prefers async communication" |
| World Fact | Objective facts received | "AIVC's contract runs through Q3" |
| Experience Fact | The bank's own actions and interactions | "I recommended Python to Bob" |

During `reflect`, the agent checks in priority order: Mental Models > Observations > Raw Facts.

### Multi-Strategy Retrieval (TEMPR)

| Strategy | Best for |
|---|---|
| Semantic | Conceptual similarity, paraphrasing |
| Keyword (BM25) | Names, technical terms, exact matches |
| Graph | Related entities, indirect connections |
| Temporal | "last spring", "in June", time ranges |

---

## Bank architecture decision: one bank

One bank (`optemization-cerebro`) for V1. Tags handle scoping.

Why not 11 banks (one per LTM category)? Banks are fully isolated -- no cross-bank knowledge graph. If "Alice" appears in a decision and a task and a project, those connections must live in one graph. Multi-bank fragments the entity graph, which is Hindsight's primary value-add.

When to reconsider: per-engagement banks when extraction quality suffers from over-broad mission, or when selling to clients who need data isolation. Expect hybrid (workspace bank + per-engagement banks) at V2+.

---

## Bank configuration recommendations

### Retain

| Setting | Current | Recommended | Why |
|---|---|---|---|
| Chunk Size | 1500 | 3000 | Default. Meeting transcripts have multi-turn context (decisions, causal chains) that fragment at 1500 chars. 3000 preserves the narrative. Try 4000-5000 if extraction still misses cross-turn context. |
| Mission | Good as-is | Keep | Specific, lists 7 categories, emphasizes attribution. |
| Extraction Mode | concise | verbose | Concise drops subtle facts. Cerebro needs signals (stress markers, friction), patterns (behavioral repetition), and causal chains -- all things concise is more likely to drop. Verbose captures more detail per fact. Tradeoff: more tokens, slower. Acceptable for batch ingestion. |

**On `custom` extraction mode:** The built-in extraction prompts are not published. `custom` replaces them entirely via `retain_custom_instructions`. The product spec identifies this as a Phase 3 fork trigger: "When we want Hindsight's LLM to emit Cerebro's 11 categories natively instead of generic facts we post-classify." For now, `verbose` + `retain_mission` + entity labels gets 80-90% there without the risk.

### Entity labels (currently empty -- highest-priority gap)

Entity labels classify each extracted fact at retain time and store classifications as entities in the knowledge graph. With `tag: true`, they also enable hard filtering at recall time (`recall(tags=["unit_type:decision"])`).

Without entity labels, the Sync Worker has to post-classify every fact with a separate LLM call. With them, Hindsight does classification during extraction -- one LLM call, not two.

```json
{
  "entity_labels": [
    {
      "key": "unit_type",
      "type": "multi-values",
      "description": "The type(s) of knowledge unit this fact represents",
      "tag": true,
      "values": [
        {"value": "glossary",   "description": "Term, acronym, or nickname with definition"},
        {"value": "people",     "description": "Persistent record about a human — name, role, organization, interactions, current concerns"},
        {"value": "company",    "description": "Persistent record about an organization — domain, status, people, interactions with the team"},
        {"value": "agent",      "description": "Persistent record about a non-human actor (AI agent, service, automation) — what it does, who operates it, how the team uses it"},
        {"value": "task",       "description": "Action item or scheduled follow-up with owner and due date"},
        {"value": "project",    "description": "Time-bounded work stream grouping actions"},
        {"value": "decision",   "description": "What was decided, why, scope, who decided"},
        {"value": "framework",  "description": "Reusable mental model articulated by a person"},
        {"value": "strategy",   "description": "Applied approach with lifecycle state"},
        {"value": "insight",    "description": "Conscious in-the-moment realization articulated by a human, tied to the source moment"},
        {"value": "pattern",    "description": "Behavioral repetition Cerebro infers across many facts; subjects may not be aware"},
        {"value": "signal",     "description": "Atomic event worth noticing — raw observation, metric reading, or Cerebro-emitted meta-event"},
        {"value": "objective",  "description": "Bounded target the team commits to: an OKR objective or key result with a verdict"},
        {"value": "metric",     "description": "Durable named measurement tracked over time (e.g. AIVC NPS, weekly active engagements)"}
      ]
    },
    {
      "key": "status",
      "type": "value",
      "description": "Lifecycle state of decisions, strategies, tasks, projects, objectives",
      "optional": true,
      "tag": true,
      "values": [
        {"value": "open",       "description": "Active or unresolved"},
        {"value": "closed",     "description": "Resolved or completed"},
        {"value": "proposed",   "description": "Under consideration"},
        {"value": "in_flight",  "description": "Currently being executed"},
        {"value": "proven",     "description": "Validated by outcomes"},
        {"value": "disproven",  "description": "Invalidated by outcomes"},
        {"value": "committed",  "description": "Team has committed to this"},
        {"value": "reversed",   "description": "Previously committed, now reversed"},
        {"value": "blocked",    "description": "Cannot proceed, waiting on something"},
        {"value": "hit",        "description": "Objective met its target"},
        {"value": "missed",     "description": "Objective did not meet its target by the deadline"},
        {"value": "abandoned",  "description": "Objective deliberately walked away from before verdict"}
      ]
    },
    {
      "key": "valence",
      "type": "value",
      "description": "Emotional or directional charge of signals and insights",
      "optional": true,
      "tag": true,
      "values": [
        {"value": "positive",   "description": "Favorable indicator"},
        {"value": "negative",   "description": "Unfavorable indicator or warning"},
        {"value": "neutral",    "description": "Informational, no directional charge"}
      ]
    },
    {
      "key": "signal_kind",
      "type": "value",
      "description": "When unit_type includes 'signal', the specific kind of attention event. Closed vocabulary — seeded here, customized per workspace at onboarding, then stable.",
      "optional": true,
      "tag": true,
      "values": [
        {"value": "source_observation",            "description": "Qualitative observation extracted directly from raw source data"},
        {"value": "metric_reading",                "description": "A quantitative datapoint that updates a Metric — references the parent Metric row"},
        {"value": "pattern_emerged",               "description": "A new Pattern just crystallized after enough supporting facts"},
        {"value": "framework_candidate",           "description": "Cerebro suggests an Insight or Pattern is durable enough to be named as a Framework; human accepts or declines"},
        {"value": "framework_applied",             "description": "A Strategy was created that applies an existing Framework"},
        {"value": "framework_pattern_contradiction","description": "A Pattern contradicts an in-flight Framework — high severity, surfaces the tension"},
        {"value": "strategy_verdict",              "description": "A Strategy got its verdict (proven or disproven)"},
        {"value": "pattern_recognized_by_human",   "description": "A human articulated an Insight that recognizes a Pattern Cerebro had already inferred"},
        {"value": "objective_at_risk",             "description": "A metric reading crossed an Objective threshold in the wrong direction"}
      ]
    }
  ]
}
```

### Observations

| Setting | Current | Notes |
|---|---|---|
| Enable Observations | On | Correct. |
| Mission | Good as-is | Specific: recurring concerns, deferred decisions, rising stress signals, team frameworks, failing/succeeding strategies. Maps well to Cerebro's Patterns concept. |

### Reflect

| Setting | Current | Notes |
|---|---|---|
| Mission | Good as-is | Clear identity, accuracy over speculation, `verified:true` weighting rule. |
| Skepticism | 4/5 | Right for a factual, attribution-heavy brain. |
| Literalism | 4/5 | Right for precise technical recall. |
| Empathy | 3/5 | Balanced. Could lower to 2 if emotional interpretation is unwanted. |

---

## Per-call parameters (set by the Indexer Worker, not in bank config)

These are the parameters the Indexer Worker must set on every `retain()` call. They are not visible in the bank configuration UI because they're per-item, not per-bank.

### `context` (required, high-impact)

A short label describing the source/situation. Injected into the LLM prompt, actively shapes extraction quality.

```typescript
// Build from Short-Term Memory row properties
const context = [
  row.dataType,           // "Meeting transcript"
  `from ${row.source}`,   // "from Granola"
  `by ${row.personSource}` // "by Tem"
].join(" ");
// => "Meeting transcript from Granola by Tem"
```

Best practices from the docs: "Providing context consistently is one of the highest-leverage things you can do to improve memory quality."

### `timestamp` (required for temporal retrieval)

When the event actually occurred. Three forms:

| Value | When to use |
|---|---|
| ISO 8601 string (`"2026-05-14T10:00:00Z"`) | Meetings, Slack messages, emails -- use the source timestamp, not ingestion time |
| Omitted/null | Defaults to current time (usually wrong for batch ingestion) |
| `"unset"` | Timeless reference material (Notion-Docs with `verified:true`) |

Without a real timestamp, "what happened last week?" doesn't rank correctly because TEMPR's temporal strategy has no anchor.

### `document_id` (required for idempotency)

The Short-Term Memory page ID. Makes retain idempotent -- re-running over an already-indexed row is a safe upsert.

### `tags` (required for scoping and filtering)

| Tag | Example | Purpose |
|---|---|---|
| `team:optemization` | always | Workspace scope |
| `person-source:<slug>` | `person-source:tem` | Who this content came from |
| `source:<tool>` | `source:slack` | Which source worker |
| `data-type:<type>` | `data-type:meeting-transcript` | Content type |
| `engagement:<slug>` | `engagement:aivc` | Client engagement scope |
| `stm:<page-id>` | `stm:abc123` | Citation primitive (links back to Short-Term Memory) |
| `verified:true` | Notion-Docs source only | Higher weight in reflect |

### `observation_scopes` (set to `per_tag`)

Controls which tag combinations get their own observation pass. Default (`combined`) creates one observation for the full tag set, which means `person-source:tem` alone never gets its own observations.

Set to `"per_tag"` so "What patterns does Tem show?" and "What's happening in the AIVC engagement?" each have isolated observations.

```typescript
observation_scopes: "per_tag"
```

### `entities` (from the Glossary DB)

Pre-identified entities from the cleaning library. Guarantees Hindsight recognizes them even if the LLM would miss or inconsistently name them.

```typescript
entities: [
  { text: "RC Willenbrock", type: "PERSON" },
  { text: "Optemization", type: "ORG" },
  { text: "AIVC", type: "ORG" }
]
```

### Complete Indexer Worker retain call

```typescript
await client.retain({
  bank_id: "optemization-cerebro",
  content: cleanedBody,
  context: `${row.dataType} from ${row.source} by ${row.personSource}`,
  timestamp: sourceTimestamp,        // from the source system, not ingestion time
  document_id: stmPageId,
  tags: [
    "team:optemization",
    `person-source:${row.personSourceSlug}`,
    `source:${row.source.toLowerCase()}`,
    `data-type:${row.dataType.toLowerCase().replace(/ /g, "-")}`,
    `stm:${stmPageId}`,
    ...(row.engagement ? [`engagement:${row.engagement}`] : []),
    ...(row.source === "Notion" ? ["verified:true"] : []),
  ],
  entities: glossaryEntities,
  observation_scopes: "per_tag",
});
```

---

## Mental models

Mental models are pre-computed `reflect` answers for common queries. They return instantly and refresh automatically after each consolidation cycle.

Entity labels and mental models serve different purposes:
- **Entity labels** classify facts at write time. "This fact is a `decision`." Enables structured recall.
- **Mental models** pre-compute answers at read time. "What are the open decisions right now?" Enables instant Q&A.

You need both.

### Defined mental models (from product spec)

```json
[
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
    "source_query": "What's the state of each active client engagement -- AIVC, PicnicHealth, Bellesa, Leslie Institute, Temporal? Active workstreams, latest signals, what the team is committed to delivering, who's leading.",
    "max_tokens": 4096,
    "trigger": { "refresh_after_consolidation": true }
  },
  {
    "id": "rising-signals",
    "name": "Rising Signals",
    "source_query": "What signals have been mounting across recent meetings, Slack threads, and emails -- stress points, friction signals, pending deadlines?",
    "max_tokens": 2048,
    "trigger": { "refresh_after_consolidation": true }
  }
]
```

### Recommended additions (one per knowledge dimension)

| ID | Name | Source query |
|---|---|---|
| `people-directory` | People Directory | "Who are the key people Cerebro has seen? For each: name, role, organization, last seen, notable context." |
| `project-status` | Project Status | "What projects is the team working on? Who leads each, what's the latest status, what's blocked?" |
| `active-tasks` | Active Tasks | "What tasks and follow-ups are outstanding? Who owns each, what's the due date, what's overdue?" |

Best practices from the docs:
- One model per knowledge dimension. Never "everything about the org."
- Tag mental models to scope which memories they read. A per-engagement model should tag `["engagement:aivc"]` so it only reads AIVC-scoped memories.
- Use `refresh_after_consolidation: true` for models that should stay current as new data flows in.

---

## Anti-patterns to avoid

From Hindsight's official best practices:

| Anti-pattern | Problem | Fix |
|---|---|---|
| Pre-summarizing before retain | Loses entity relationships, temporal markers, structural context | Retain raw content; Hindsight extracts facts |
| Random UUIDs as `document_id` | Creates duplicate documents on every retain | Use stable session/page/ticket IDs |
| Omitting the `context` field | Reduces extraction quality significantly | Always describe what kind of data this is |
| Using `metadata` for filtering | Metadata is not filterable | Use tags for anything you'll filter on |
| Vague or generic missions | Generic extraction = noisy, low-value memories | Be specific about domain, data type, what to ignore |
| `tags_match="any"` for scoped data | Leaks memories across scopes | Use `any_strict` or `all_strict` for partitioned data |
| Retaining and recalling in same request | Retained memories not yet indexed | Retain end-of-turn; recall at start of next turn |
| One mental model for everything | Low accuracy, slow refresh, hard to scope | One model per knowledge dimension |
| `high` budget for every recall | Expensive, slow, usually unnecessary | Use `low` for simple lookups, `mid` as default |
| Missing timestamp on retain | Disables temporal retrieval entirely | Always set from actual content timestamps |

---

## Hindsight concepts vs Cerebro concepts

| Hindsight concept | Cerebro equivalent | Notes |
|---|---|---|
| Memory bank | The brain (`optemization-cerebro`) | One bank for V1 |
| World fact | People, Companies, Decisions, Projects, Tasks, Insights, Signals | Classified via entity labels |
| Experience fact | Ask Cerebro's own interactions | What the agent did/recommended |
| Observation | Patterns | Auto-consolidated from facts |
| Mental model | Standing dashboards (Team State, Open Decisions, etc.) | Pre-computed reflect answers |
| Entity | Glossary entries + auto-extracted people/orgs/concepts | Glossary pre-seeds; Hindsight extends |
| Tag | Source/type/engagement scoping | Set per retain call |
| Document | Short-Term Memory row | `document_id` = STM page ID |
| Directive | Hard rules for reflect | "Never speculate about financials" |
| Disposition | Cerebro's personality tuning | Skepticism/literalism/empathy |

---

## Architecture: where Hindsight sits

```
Source Workers (Slack, Granola, Circleback, GMail, GCal, Notion-Docs)
    |
    v
Short-Term Memory (Notion DB, cleaned text)
    |
    v
Indexer Worker -- retain() --> Hindsight bank (optemization-cerebro)
                                  |-- facts extracted (entity-labeled)
                                  |-- entities linked (knowledge graph)
                                  |-- observations consolidated (async)
                                  |-- temporal anchoring
                                  |
                                  v
Sync Worker <-- webhooks ---- retain.completed / consolidation.completed
    |
    v
Long-Term Memory (11 Notion DBs) -- display layer for humans
    |
    v
Q&A Surfaces -- reflect() --> Hindsight answers with citations
```

Hindsight is the brain. Notion is the display layer. Source workers never call Hindsight. The Indexer Worker is the sole Hindsight writer. The Sync Worker is the sole Long-Term Memory writer.

---

## References

- [Hindsight docs](https://hindsight.vectorize.io)
- [Best practices](https://hindsight.vectorize.io/best-practices)
- [Retain API](https://hindsight.vectorize.io/developer/api/retain)
- [Memory Banks API](https://hindsight.vectorize.io/developer/api/memory-banks)
- [Documents API](https://hindsight.vectorize.io/developer/api/documents)
- [Bank Templates](https://hindsight.vectorize.io/templates)
- [FAQ](https://hindsight.vectorize.io/faq)
- [Cerebro Product Spec](https://www.notion.so/optemization/Product-Spec-362a48662b2581dc98cee224c2f58a67)

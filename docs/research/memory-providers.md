# Memory engine providers — research synthesis

> **Status:** research synthesis, captured 2026-05-16.
> **Author:** Tem.
> **Companion doc:** [`docs/specs/cerebro.md`](../specs/cerebro.md). This doc validates the memory-engine choice; that doc defines the product.
>
> **How to read.** Eight providers compared at landscape level; three (Hindsight, Mem0, Honcho) deep-read against their actual docs; the three evaluated against Cerebro's spec line-by-line. Skip to [TL;DR](#tldr) for the verdict, [the landscape](#the-landscape) for who's who, the [deep dive](#deep-dive-hindsight--mem0--honcho) for code-level differences, [evaluation against the spec](#evaluation-against-the-cerebro-spec) for the Cerebro-specific argument.

---

## TL;DR

**Hindsight** is the right memory engine for Cerebro V1. Not because the spec already mentions it — because Cerebro's product shape (document-anchored fact extraction, tag-based scoping, citation-preserving Q&A, Observations→Patterns flow, disposition-shaped reflection, per-bank semantic missions) maps to Hindsight's API surface with unusual fidelity, and doesn't map cleanly to any of the seven alternatives surveyed.

**Three-line summary of the field:**

- **Hindsight** (Vectorize, MIT, Dec 2025) — 4-way hybrid retrieval (semantic + BM25 + graph + temporal), explicit Observations + Mental Models tiers, Mission/Disposition knobs. API contract matches Cerebro's needs 1:1. Pre-1.0 churn risk.
- **Mem0** (YC S24, Apache 2.0, $24M raised) — most mature, broadest backends, but the API model is messages-and-extracted-facts; the graph layer was just removed from OSS; no document-anchored citation primitive; no Observations equivalent.
- **Honcho** (Plastic Labs, AGPL-3.0, $5.4M raised) — uniquely strong at modeling who a user *is* over time via Neuromancer XR. Wrong product shape for Cerebro (peer-and-session model, not document-and-tag), and AGPL-3.0 blocks self-host-for-clients.

**The other five** (OpenViking, Holographic, RetainDB, Byterover, Supermemory) are either too early, the wrong shape, or not actually standalone products. Detailed below.

**Risk-adjusted recommendation:** Build on Hindsight Cloud for V1. Keep a thin `retain/recall/reflect` adapter so the engine stays swappable. Verify webhooks Friday night. Don't bet the demo on Mental Models — treat them as a flourish. Phase 2 (self-host vanilla Hindsight on Helm + Postgres + pgvector) when AIVC says yes.

---

## Why this research exists

The Cerebro spec is anchored to Hindsight. This research treats the choice as if it weren't — surveys eight providers in the AI-memory-for-agents category, reads docs deeply for the three serious candidates, then evaluates each against the spec's actual requirements.

**Honest framing.** The spec's API contract (`retain` / `recall` / `reflect`), bank config syntax (`mission` / `retain_mission` / `observations_mission` / `disposition`), and architectural concepts (Observations, Mental Models, tag-based scoping, `document_id` idempotency) are Hindsight-specific. The exercise of evaluating "ignore that it's anchored" therefore needs to ask two questions: (1) **does the spec's design stand independently of the vendor?** and (2) **if it does, which vendor delivers it best?** Answer to both is yes-and-Hindsight, for reasons sourced from the docs and traced through the spec below.

**Method.** Eight parallel web-research passes for landscape facts; three parallel deep-doc reads for the serious candidates (Hindsight, Mem0, Honcho); a final pass evaluating each against the spec. All claims trace to URLs in [References](#references).

---

## The landscape

Eight providers, in order of relevance to Cerebro:

### 1. Hindsight (Vectorize)

- **URL:** [hindsight.vectorize.io](https://hindsight.vectorize.io/)
- **Stage:** $3.6M seed (True Ventures, Oct 2024). Hindsight product launched Dec 2025. 13.5k GitHub stars. ~7-person team.
- **License:** MIT, with zero feature-gating in the OSS version.
- **Architecture:** PostgreSQL + pgvector. Four-way retrieval ("TEMPR") — semantic + BM25 + graph + temporal, fused via reciprocal rank fusion. Three-tier memory: Facts → Observations → Mental Models.
- **API:** `retain(content, document_id, tags, entities, context, timestamp)` / `recall(query, tags, types, budget)` / `reflect(query, budget)` / `create_mental_model()`. Python + TS + Go SDKs with 1:1 parity. Native MCP server. 20+ framework integrations (LangChain, LlamaIndex, LangGraph, CrewAI, etc.).
- **Pricing:** Self-hosted free; cloud usage-billed at $15/M retain, $3/M reflect, $0.75/M recall.
- **Founder credibility:** Chris Latimer ran the vector DB business at DataStax. Most domain-credible founder in the field.
- **Verdict:** Most architecturally complete memory engine of the eight. Pre-1.0 churn is real (55+ releases in 5 months; v0.5.5 silently lost data; v0.6.0 silently renamed params). Best fit for Cerebro.

### 2. Mem0

- **URL:** [mem0.ai](https://mem0.ai/)
- **Stage:** $23.9M total ($20M Series A from Basis Set, Oct 2025). YC S24. 55.9k GitHub stars — the most-starred dedicated memory repo. Founders ex-Tesla Autopilot AI + ex-Embedchain.
- **License:** Apache 2.0.
- **Architecture:** Vector store (24+ backends in Python) plus formerly a Neo4j graph layer. **The graph store was removed from OSS** in the current release, replaced by "built-in entity linking" in the vector collection. Cloud Pro tier still gates graph as a paid feature.
- **API:** `add(messages, user_id, agent_id, run_id)` / `search(query, filters)` / `update(id)` / `delete(id)`. Two LLM calls per `add()` for extraction + conflict resolution. Cloud `add()` is async (returns PENDING + event_id); OSS is sync.
- **Pricing:** Hobby free / Starter $19 / Growth $79 / Pro $249 / Enterprise. Graph memory is Pro-only — a 13× jump that's the most-cited community friction. LLM passthrough is your cost on top.
- **Reputation:** Self-published LOCOMO benchmark numbers were rebutted in detail by Zep ([blog.getzep.com](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)) with methodology-level critique; Mem0 hasn't published corrected numbers. HN thread [#46891715](https://news.ycombinator.com/item?id=46891715) documents that Mem0 stores stated facts but doesn't learn implicit user behavioral patterns.
- **Compliance posture:** SOC 2 Type 1 + HIPAA. Best procurement story of the three serious candidates.
- **Verdict:** Safest procurement choice and most ecosystem reach (AWS Strands SDK exclusive, OpenAI Agents SDK integration). Wrong API shape for Cerebro — see [evaluation against the spec](#evaluation-against-the-cerebro-spec).

### 3. Honcho (Plastic Labs)

- **URL:** [honcho.dev](https://honcho.dev/)
- **Stage:** $5.35M pre-seed (Variant + White Star, April 2025). 3.6k GitHub stars. Founded 2023.
- **License:** AGPL-3.0 — network copyleft applies.
- **Architecture:** PostgreSQL + pgvector + Redis + LLM + embedding model. Most operationally complex of the three. **Peers** (humans + AI agents, same data model) within **Sessions** within **Workspaces**. The differentiator is Neuromancer XR, a fine-tuned Qwen3-8B that runs continuously in the background ("dreaming") to build a representation of each peer — cloud-only.
- **API:** Two query modes — `session.get_context()` for cheap retrieval (free, ~200ms) and `peer.chat()` for billed dialectic reasoning ($0.001–$0.50/query depending on `reasoning_level`). Plus `session.search()` for raw message retrieval. Best Vercel AI SDK integration of the three (dedicated `@honcho-ai/vercel-ai-sdk` package).
- **Pricing:** $2/M messages ingestion. `context()` unlimited. `chat()` tiered $0.001–$0.50/query. Cheapest of the three at small/medium scale.
- **Differentiator:** Models implicit user patterns and inferences ("would this user prefer cold brew?") — fact-storage providers can only answer what was explicitly said.
- **Risks:** AGPL with no public commercial license. Neuromancer XR is closed cloud-only — self-host gets you the architecture but not the reasoning quality (base Qwen3-8B is 17 points below Neuromancer XR on LoCoMo).
- **Verdict:** Best-in-class at modeling who a user is over time. Wrong product shape for Cerebro's document-and-tag world.

### 4. OpenViking

- **URL:** [openviking.ai](https://openviking.ai/)
- **Stage:** ByteDance / Volcengine corporate OSS — not a startup. Launched January 2026. 24k GitHub stars.
- **License:** AGPLv3 core + Apache 2.0 CLI.
- **Architecture:** Virtual filesystem metaphor (`viking://` URIs). Hierarchical drill-down rather than semantic similarity. L0/L1/L2 tiered content loading (1-sentence abstract → core info → full content).
- **Distinctive:** Retrieval trajectories are stored and inspectable — debuggable in a way pure-vector systems aren't. Self-evolving "dreamer" worker writes insights back to memory.
- **Risks:** AGPLv3 + no commercial-license path for proprietary embed. Early security CVEs (broken access control, path traversal — both patched). MCP package documented as Cloudwise-internal hardcoded ([#606](https://github.com/volcengine/OpenViking/issues/606)). No hosted tier. Python-only SDK.
- **Verdict:** Compelling architecture for hierarchical knowledge bases. Wrong shape for Cerebro and the AGPL is a blocker for selling to clients.

### 5. Honcho's peer "Holographic" — not actually a vendor

- **What it is:** Not a standalone product. The "Holographic memory" plugin is bundled inside [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent). Single SQLite file + FTS5 + Holographic Reduced Representations (Plate 1995 academic technique). Zero external dependencies. The privacy/air-gap choice by construction.
- **Verdict:** Only relevant if you're already on Hermes Agent. Not applicable to Cerebro.

### 6. RetainDB

- **URL:** [retaindb.com](https://www.retaindb.com/)
- **Stage:** Meenlabs Inc, San Francisco. ~Q1 2026 launch. 14 GitHub stars. Bootstrapped / no public funding.
- **Architecture:** PostgreSQL + pgvector. Seven typed memory categories (Factual, Preference, Event, Relationship, Opinion, Goal, Instruction). Marketed as hybrid retrieval; benchmark analysis reveals actual mechanism is **chronological dump** of full memory into model context — won't scale past medium histories.
- **License:** Apache-2.0 (source-available, very low engagement).
- **Distinctive:** "Memory Router" — URL swap in front of OpenAI/Anthropic calls, zero code change. Useful for prototyping.
- **Risks:** Cloud-only (no real self-host), single-founder bootstrapped, 14 stars, claims-only benchmarks, extraction locked to Claude Sonnet server-side.
- **Verdict:** Too early to bet a roadmap on. Watch.

### 7. Byterover

- **URL:** [byterover.dev](https://www.byterover.dev/)
- **Stage:** Bootstrapped (Campfirein). arXiv paper April 2026. 4.8k GitHub stars. 1 publicly listed GitHub org member. Lead author Andy Nguyen.
- **License:** Elastic License 2.0 — source-available, **not OSI-approved open source**. Commercial use requires a license.
- **Architecture:** **Local markdown files** in a hierarchical Context Tree (Domain→Topic→Subtopic→Entry). No vector DB, no embedding service. 5-tier retrieval: cache → fuzzy text → LLM only on novel multi-hop. Adaptive Knowledge Lifecycle (importance + maturity + recency decay).
- **Target:** Coding agents specifically. MCP-native: Cursor, Claude Code, Cline, Windsurf, Zed.
- **Verdict:** Best-in-class for "shared memory across coding agents." Wrong domain for Cerebro (no REST API, no embeddable SDK, MCP-only).

### 8. Supermemory

- **URL:** [supermemory.ai](https://supermemory.ai/)
- **Stage:** $2.6M seed (Susa, Browder, SF1, Oct 2025). Angels include Jeff Dean (Google), Dane Knecht (Cloudflare CTO). 22.6k GitHub stars. Founder Dhravya Shah, 19, ex-Cloudflare intern.
- **License:** MIT.
- **Architecture:** Cloudflare Workers + Postgres + pgvector + Cloudflare KV. Knowledge graph with typed edges (Updates / Extends / Derives) + dual-timestamp temporal grounding.
- **Pivot history:** Started as a consumer "second brain for bookmarks"; pivoted to developer infra. Notable customer win: Scira publicly switched off Mem0.
- **Distinctive:** Cleanest DX of the field. One `npx` command for MCP setup. Memory router proxies LLM calls (auto-injects context).
- **Risks:** Air-gapped self-host is Enterprise-only. Router proxy adds latency and obscures what gets injected. Sub-5-person team, first-time founder. OSS repo is the personal app, not a containerized self-host API.
- **Verdict:** Strong second choice if Hindsight's pre-1.0 risk feels too high. But the API model is documents-and-chunks RAG, not document-anchored fact extraction; Cerebro's Observations→Patterns flow has no equivalent.

---

## Architectural forks

The eight providers cluster into four conceptual camps. Picking the right engine starts with picking the right camp:

| Camp | Stores | Returns | Providers | Best for |
|---|---|---|---|---|
| **Fact extraction** | LLM-extracted atomic facts | Matched facts as evidence | Mem0, RetainDB | "What did user X say about Y?" |
| **Hierarchical synthesis** | Facts + auto-consolidated Observations + curated Mental Models | Typed facts OR synthesized prose with citations | Hindsight | "What patterns are emerging? What did the team decide and why?" |
| **User modeling / theory of mind** | Messages + asynchronously-derived peer representations | Inferences *about* the user (not necessarily things they said) | Honcho | "Would this user prefer X? What's their style?" |
| **Hierarchical filesystem** | Markdown / structured docs in a tree | Drilled-down content with inspectable trajectories | Byterover, OpenViking, Holographic | "Coding agents need shared, human-auditable context" |

Cerebro's spec is unambiguously **hierarchical synthesis** territory:

- "Decisions" + "Insights" + "Signals" — typed structured records, not free-text RAG chunks ([spec lines 232–250](../specs/cerebro.md))
- "Patterns" → "Maps directly from Hindsight observations — every consolidated observation becomes (or updates) a Pattern row" ([spec line 249](../specs/cerebro.md))
- Mental Models with `refresh_after_consolidation: true` driving live dashboards ([spec lines 362–391](../specs/cerebro.md))
- `reflect()` for Q&A with `based_on.memories` citations ([spec line 432](../specs/cerebro.md))

This camp has one viable provider: Hindsight.

---

## Deep dive: Hindsight × Mem0 × Honcho

The three serious candidates, read doc-by-doc and put side by side. Every claim cites the relevant doc URL.

### Hello world, side by side

**Hindsight** ([docs](https://hindsight.vectorize.io/developer/api/quickstart))
```python
from hindsight_client import Hindsight
client = Hindsight(base_url="http://localhost:8888")

client.retain(bank_id="my-bank",
              content="Alice works at Google as a software engineer")

client.recall(bank_id="my-bank",
              query="What does Alice do?")        # → list of typed fact objects
```

**Mem0** ([docs](https://docs.mem0.ai/platform/quickstart))
```python
from mem0 import MemoryClient
client = MemoryClient(api_key="...")

messages = [
    {"role": "user", "content": "I'm Alex. I love basketball."},
    {"role": "assistant", "content": "Noted, Alex!"}
]
client.add(messages, user_id="alex")               # → {status: "PENDING", event_id: "..."}

client.search("What are Alex's interests?",
              filters={"user_id": "alex"})         # → [{memory, score, metadata, ...}]
```

**Honcho** ([docs](https://docs.honcho.to/))
```python
from honcho import Honcho
honcho = Honcho(workspace_id="my-app", api_key="...")

user = honcho.peer("user-abc")
assistant = honcho.peer("assistant")
session = honcho.session("session-001")
session.add_peers([user, assistant])
session.add_messages([
    user.message("I prefer dark mode and hate meetings before 10am."),
    assistant.message("Got it.")
])

ctx = session.get_context(tokens=2000, peer_target="user-abc")
insight = user.chat("What does this user dislike about their calendar?",
                    reasoning_level="low")
```

Three observations from the code:

1. **Mem0 has no notion of "session"** — messages are bucketed by `user_id` / `agent_id` / `run_id` / `app_id`.
2. **Hindsight has no notion of "user"** as a first-class entity — there's a bank, you scope further with tags.
3. **Honcho is the only one where "peer" is the trunk of the API** — and peers cover humans and AI agents identically.

### Data model — what actually gets stored

| | Mem0 | Hindsight | Honcho |
|---|---|---|---|
| **Stored unit** | LLM-extracted atomic fact | Structured facts at three tiers (Facts → Observations → Mental Models) | Messages + derived conclusions (explicit + deductive) + peer representations |
| **Source preserved?** | No — raw messages not retrievable | No — "the content itself is never stored verbatim" ([retain API docs](https://hindsight.vectorize.io/developer/api/retain)) | Yes — Messages are first-class |
| **Idempotent re-ingest?** | No `document_id` primitive | Yes — `document_id` + "replace"/"append" modes | Per-message; no document-anchored idempotency |
| **Citation primitive** | Memory ID per extracted fact | `document_id` + `based_on.memories` from `reflect()` | Message ID; conclusions tied to source messages |
| **Scoping** | `user_id` / `agent_id` / `run_id` / `app_id` | Bank + `tags[]` with `tag_groups` boolean composition | Workspace / Session / Peer (no tag system) |
| **Entity hints on write** | No — Mem0's LLM extracts entities itself | Yes — `entities=[{text, type}]` passed to `retain()` | No |
| **Observations / patterns layer** | Removed from OSS; gated to Pro on cloud | First-class with proof count + freshness trend (stable / strengthening / weakening) | "Conclusions" exist but are peer-scoped, not document-scoped |

### Write semantics — what fires, what blocks, what costs

| | Mem0 | Hindsight | Honcho |
|---|---|---|---|
| **Default sync behavior** | Cloud: async (returns PENDING + event_id). OSS: sync | `retain()` blocks; opt-in `async: true` | `add_messages()` returns immediately; reasoning is background |
| **LLM calls per write** | 2 (extraction + conflict resolve) | 1 (extraction) | 1 deriver pass per ~1000 tokens of ingested messages |
| **Conflict resolution** | LLM marks old memory obsolete; ADD / UPDATE / DELETE / NOOP | `document_id` + `update_mode` ("replace" / "append"); no version chain | Deduction specialist resolves contradictions during dreaming |
| **Deletion API** | `DELETE /v1/memories/{id}` per memory | `delete_document()` per document | `observations.delete(id)` per observation; **no bulk wipe API** ([issue #598](https://github.com/plastic-labs/honcho/issues/598)) |
| **TTL/forget** | None documented | None documented | None documented |

**The async-by-default behavior is sneaky on Mem0 cloud.** If your code does `client.add(messages, user_id=...)` and then immediately `client.search(...)`, the new memory isn't there yet (community-reported ~6s lag). You must poll `GET /v1/event/{event_id}/` or eat the inconsistency.

### Read semantics — three different shapes

**Mem0** returns facts:
```
POST /v3/memories/search/
  query, filters (≥1 ID required), top_k, threshold, rerank, reference_date
→ [{id, memory, score, metadata, categories, created_at, updated_at}]
```
Hybrid retrieval (semantic + BM25 + entity matching) is **implicit and not tunable**. The `rerank` boolean is the only retrieval knob. You inject results into your own prompt.

**Hindsight** has two reads — `recall()` for facts, `reflect()` for synthesis:
```python
recall(bank_id, query,
       types=["world" | "experience" | "observation"],
       budget="low" | "mid" | "high",
       max_tokens=4096,
       query_timestamp, tags, tag_groups,
       include_chunks, include_source_facts, trace)
→ list of fact objects, RRF-fused, ranked

reflect(bank_id, question, ...)
→ {text (markdown), structured_output, based_on (sources), usage, trace}
```
`reflect()` is the agentic synthesis path: checks Mental Models → Observations → raw Facts, produces a grounded, disposition-aware answer. **You cannot toggle TEMPR strategy weights.** Budget is the only knob — controls depth, not strategy mix.

**Honcho** has three reads, with a unique two-tier pricing model:
```python
session.get_context(tokens=N, summary?, peer_target?, ...)
→ SessionContext (message window + working rep + peer card); free, ~200ms

peer.chat(query, reasoning_level="minimal" | "low" | "medium" | "high" | "max")
→ synthesized natural-language answer about the peer

session.search(query, limit, filters?)
→ raw matching Message records
```

| `reasoning_level` | Price/query |
|---|---|
| `minimal` | $0.001 |
| `low` | $0.01 |
| `medium` | $0.05 |
| `high` | $0.10 |
| `max` | $0.50 |

This is unique. Cheap retrieval (`context()`) is free; only `chat()` is billed, and you tune cost with a dial. For 90% of calls you use the free path.

### Cost at scale — worked math

Three workloads, normalized to a common scenario. **Different providers charge in different units; this is best-effort, not apples-to-apples.**

**Scenario A: small SaaS app** (10k users × 20 sessions × 30 messages = 6M messages)

| | Mem0 | Hindsight | Honcho |
|---|---|---|---|
| Storage tier | Pro $249 (if extraction yields ~1 memory per 10 messages) | Token-based; ~6M msgs × ~100 tokens × $15/M = ~$9,000 one-time | Ingestion 6M × $2/M = **$12 one-time** |
| Retrieval (50k searches/mo) | Pro tier covers it | $0.75/M × ~25M query tokens ≈ **~$19/mo** | `context()` free; 5k `chat()` at mixed low/medium ≈ **~$50–90/mo** |
| **Realistic monthly** | **~$249 + LLM passthrough** | **~$1,000–$2,000/mo** dominated by ingestion | **~$60–$100/mo** |

**Scenario B: full-team product** (1k users × 200 sessions × 100 msgs = 20M msgs, 200k queries)

| | Mem0 | Hindsight | Honcho |
|---|---|---|---|
| Storage | Enterprise (Pro caps at 500k mems / 50k queries) | Token-billed, ~$30k+/mo on retain | Ingestion ~$40/mo |
| Retrieval | Enterprise pricing | ~$75/mo on recall; more if reflect-heavy | 200k `chat()` at `low` ≈ **~$2,000/mo**; or keep most as free `context()` |

**Honcho's pricing scales most gracefully at low/mid scale. Mem0's flat tiers are predictable up to a ceiling. Hindsight is most expensive per unit but most flexible.**

### Self-host comparison

| | Mem0 OSS | Hindsight self-host | Honcho self-host |
|---|---|---|---|
| **License** | Apache 2.0 — clean | MIT — clean | AGPL-3.0 — network copyleft |
| **Min infra** | pip-only library mode (Qdrant embedded); Docker Compose for server | Single Docker (9 GB full / 500 MB slim) + Postgres + pgvector | Postgres + pgvector + Redis + LLM + embedding + separate deriver worker |
| **LLM provider flexibility** | Any provider; **but** Ollama + Qdrant has a documented silent-failure bug ([#3441](https://github.com/mem0ai/mem0/issues/3441)) | Any OpenAI-compatible (OpenAI / Groq / DeepSeek). **No Ollama support, no offline mode** | Any OpenAI-compatible — Ollama and vLLM explicitly supported |
| **What's lost vs cloud** | Nothing material | Cloud-only: dashboard analytics, SLA, team UI | **Neuromancer XR is cloud-only.** Self-host gets the architecture but not the differentiating reasoning quality |

### License comparison — actually matters for selling to clients

- **Mem0** (Apache 2.0) — Embed freely in closed-source. Fully procurement-safe.
- **Hindsight** (MIT) — Embed freely. Even more permissive than Apache (no patent grant or attribution requirements). Procurement-safe.
- **Honcho** (AGPL-3.0) — Network copyleft. If you embed and run as a service, you must release your source. No commercial license is publicly documented. Many enterprises (Google's the famous one) ban AGPL outright.

For Cerebro selling to AIVC, PicnicHealth, Bellesa, Leslie Institute, Temporal: **Honcho's AGPL is a hard blocker unless you stay on their cloud.** Mem0 and Hindsight are both clean.

### Pre-1.0 risk

All three are early.

- **Mem0** — most mature in absolute terms; actively churning. The graph store was just removed from OSS. OpenMemory MCP is being sunset. Documented dimension-mismatch silent failures ([#2302](https://github.com/mem0ai/mem0/issues/2302), [#4614](https://github.com/mem0ai/mem0/issues/4614)). Zep methodology rebuttal stands unrebutted.
- **Hindsight** — youngest of the three (Dec 2025 launch). **v0.5.5 silently extracted zero facts for a release**, reverted in v0.5.6. **v0.6.0 silently renamed `max_results` to `max_tokens`**. The `hindsight-openclaw` plugin v0.6.5 silently failed all `retain()` calls ([#1120](https://github.com/vectorize-io/hindsight/issues/1120)), closed as "not planned." 55+ releases in 5 months. **Pin versions; treat every minor as breaking.**
- **Honcho** — deriver worker startup trap in manual installs ([#494](https://github.com/plastic-labs/honcho/issues/494)). No memory-wipe API. Self-host loses the differentiator. AGPL with no public commercial license.

---

## Evaluation against the Cerebro spec

The spec's [hackathon scope](../specs/cerebro.md#hackathon-scope-v1--what-ships-by-sunday-demo) defines what V1 needs from a memory engine. Capability matrix:

| Spec requirement | Hindsight | Mem0 | Honcho |
|---|---|---|---|
| `retain(content, document_id, tags=[...], entities=[...], context, timestamp)` | ✅ Exact signature | ❌ Wants role-tagged messages; no `document_id`; no `tags`; no entity hints | ❌ Requires peer attribution; no `document_id`; no `tags` |
| `document_id` as idempotent upsert + citation key (spec line 396) | ✅ "replace" / "append" modes; re-running Indexer is a no-op | ❌ Memory IDs are per extracted fact; no source-document concept | ❌ Messages keyed by message ID; no document primitive |
| Tag-based scoping (`engagement:aivc`, `verified:true`, `stm:<page-id>`, `source:slack`, `person-source:tem`) | ✅ Native + `tag_groups` boolean composition | ⚠️ Encode in `metadata`, custom filter per call; no boolean composition | ❌ Workspace/session/peer is the scoping primitive |
| `recall(tags=["stm:<doc-id>"], types=["world"])` — Sync Worker pattern (spec line 406) | ✅ Direct call shape | ⚠️ `search(filters={...})` possible but awkward | ❌ `search()` returns Messages, not extracted facts |
| Glossary entity hints `[{text, type}]` passed into `retain()` (spec line 299) | ✅ Confirmed `entities` parameter | ❌ Mem0's LLM extracts entities itself | ❌ No equivalent |
| Observations layer → Patterns DB (spec line 249) | ✅ Core concept | ❌ Graph store removed from OSS | ⚠️ "Conclusions" exist but peer-scoped |
| Mission / Retain Mission / Observations Mission / Disposition (spec lines 354–392) | ✅ Bank config in spec is literally Hindsight JSON | ❌ Model config only | ⚠️ Operational dials only; no semantic shaping |
| Mental Models with `refresh_after_consolidation: true` | ✅ Native feature | ❌ Doesn't exist | ❌ Peer Card / Working Rep are per-peer, not per-bank |
| Webhooks: `retain.completed`, `consolidation.completed` → Sync Worker | ✅ Documented (verify Saturday morning) | ❌ Not documented | ❌ Reasoning is background but no external event hooks |
| Self-host with permissive license + Helm + Postgres + pgvector | ✅ MIT + clean Phase 2 path | ✅ Apache 2.0; pip / Docker | ❌ AGPL-3.0 network copyleft |
| `reflect(query, budget, tags=<scope>)` returning `{answer, based_on: [fact_ids]}` for Q&A | ✅ Exact shape | ❌ No synthesis endpoint; assemble yourself | ⚠️ `peer.chat()` exists but answers are about a peer, not document-anchored |

**Almost every load-bearing primitive in the spec maps 1:1 to a Hindsight API surface and has no clean equivalent in the other two.**

### The "ignore that it's anchored" question, honestly

Stripping the spec of every Hindsight reference and asking which engine fits a **tag-based, document-anchored, fact-extracting, citation-preserving, mental-models-equipped, webhook-driven, MIT-licensable system built on Postgres + pgvector** — Hindsight is still the answer. Because what makes Cerebro Cerebro (the document-anchored citation primitive, the Glossary-aware entity extraction, the Observations→Patterns flow, the disposition-shaped reflection, the per-bank semantic missions) doesn't exist in the other two.

It's not that the spec was written around Hindsight. It's that **Cerebro's product shape matches Hindsight's product shape with unusual fidelity.** The convergence is probably not coincidence — these docs have been read while designing. But the test is whether the design choices stand independent of the vendor. They do.

---

## Recommendation

**Build on Hindsight Cloud for V1.**

### Pros

1. **API contract is 1:1 with the spec.** Zero impedance. The bank config in [spec lines 354–392](../specs/cerebro.md) is already valid Hindsight JSON.
2. **Tag system carries Cerebro's whole scoping model.** The seven tag families in [spec lines 326–337](../specs/cerebro.md) plus `tag_groups` boolean composition supports every multi-axis recall pattern the Q&A API needs.
3. **Observations layer is the V1.1 Patterns DB**, as the spec itself names.
4. **MIT license** is procurement-clean for the AIVC / PicnicHealth / Bellesa / Leslie Institute / Temporal arc.
5. **Phase 2 self-host is one Worker rewrite.** [Spec line 535](../specs/cerebro.md): *"The Indexer Worker swaps its Hindsight endpoint from Cloud to self-hosted; everything else is unchanged."*
6. **Mental Models give Cerebro a unique product feature** — auto-refreshing dashboards that no competitor offers.
7. **Founder credibility** is the strongest in the field for memory infra. Chris Latimer ran the vector DB business at DataStax.

### Cons (real risks)

1. **Pre-1.0 churn.** Hindsight has shipped 55+ releases in 5 months; v0.5.5 silently lost data; v0.6.0 renamed params without deprecation. Mitigation: pin versions, wrap behind a thin adapter, treat upgrades as breaking.
2. **Webhook delivery to Notion Workers is unverified.** Mitigation: spec already calls for Saturday verification; fallback is polling — Sync Worker reads `Status: indexed` rows directly. 5-min lag, same outcome.
3. **Cost at full-team scale.** Order-of-magnitude $150/day retain at Cloud rates if all six sources fire continuously. Mitigation: spec line 527 identifies cost as a Phase 2 self-host trigger.
4. **`verified:true` weighting is a filter, not a weight.** Mitigation: in the Q&A API, do two recalls (`tags=["verified:true"]` first, broad second), interleave with verified first, dedupe.
5. **No documented TTL / forget.** Mitigation: doable via `delete_document()` looped over Short-Term Memory rows matching a deletion criterion.
6. **Ollama / fully-offline mode not supported.** Mitigation: Hindsight uses LiteLLM; point at a self-hosted OpenAI-compatible endpoint (Groq self-hosted, vLLM, AIVC's own gateway). Test before promising AIVC.
7. **Mental Models is a Hindsight-proprietary concept.** Mitigation: don't make it the spine of the demo flow — spec already marks it as Stretch ([line 489](../specs/cerebro.md)).

### Mitigations the spec already has built in

- **Q&A API fallback to Anthropic Claude** if Hindsight integration breaks ([spec line 459](../specs/cerebro.md)).
- **3 sources is must-ship**, not all 6 ([spec line 477](../specs/cerebro.md)).
- **Patterns DB is Stretch**, not Must ([spec line 488](../specs/cerebro.md)).
- **`retain/recall/reflect` contract as internal interface** with pluggable engine ([spec line 21](../specs/cerebro.md) + [line 665](../specs/cerebro.md)).

### What to do

1. **Build on Hindsight Cloud for V1.** Spec is clean; ship the demo.
2. **Keep the adapter thin.** `lib/memory.ts` exposes `retain` / `recall` / `reflect` with Hindsight-shaped signatures. The Indexer Worker imports it. Don't sprinkle Hindsight client calls across multiple files.
3. **Verify webhooks Friday night, not Saturday morning.** Single biggest demo-risk item.
4. **Don't bet the demo on Mental Models.** Treat them as the dashboard cherry, not the spine.
5. **Stay version-pinned and watch the changelog.** Subscribe to `vectorize-io/hindsight` releases on GitHub.
6. **Phase 2 trigger is when AIVC says yes.** That's when self-host pays for itself.

If a different team built this on Mem0 instead, they'd be writing a glue layer to fake-format Notion docs as `{role: "user"}` messages, encoding all their tags as `metadata` JSON, losing the Observations layer, having no `consolidation.completed` event to drive the Sync Worker, and reinventing Mental Models as a cron job. That's a real cost paid every day in V1, in exchange for a slightly more mature SDK.

**Hindsight, with full eyes on the pre-1.0 risk.**

---

## Glossary

### Dialectic API

Honcho's signature endpoint. Standard memory APIs work like this:

```
memory.search("user preferences about coffee")
  → returns matching facts/chunks
  → you stuff them into your prompt
  → your LLM synthesizes a response
```

The dialectic endpoint inverts the contract:

```
honcho.chat("would this user like cold brew?")
  → returns a natural-language answer about the user
  → you inject that answer into your prompt
```

You aren't retrieving data from the memory system — you're having a conversation *with* the memory system about the user. Hence "dialectic" — dialectical / Socratic dialogue. Honcho's own model (Neuromancer XR, a fine-tuned Qwen3-8B) does the reasoning over the user representation built up in the background.

**Why it matters.** A fact-retrieval API can only return what was stored. The dialectic API can infer: *"What's this user's attitude toward risk?"* *"Do they prefer terse or detailed replies?"* — none of which the user ever said in those words. The reasoning happens off the hot path (Honcho runs a "dreamer" worker continuously, re-reasoning over new interactions as they arrive). The cost: you trust Honcho's inferences. Fact-retrieval is auditable ("here are the stored sentences I matched on"); dialectic is a black box.

For Cerebro, this is the wrong shape — Cerebro needs document-anchored, citable evidence, not inferred conclusions.

### AGPL (GNU Affero General Public License v3)

The strongest commonly-used copyleft license. Regular GPL says: if you *distribute* software containing GPL code, your software must also be released under GPL. AGPL adds: if you let anyone use it *over a network* (SaaS, API, web service), you must release your source under AGPL — even if you never "distribute" a binary. This closes the "SaaS loophole" of GPL.

**Why it matters for memory providers** (Honcho, OpenViking):
- Embed AGPL code into a closed-source SaaS → legally obligated to open-source your whole product.
- Workaround: a paid commercial license that releases you from the obligation (Honcho's isn't publicly documented).
- Many companies (Google) ban AGPL outright from their codebases.

For Cerebro selling to AIVC, PicnicHealth, Bellesa, Leslie Institute, Temporal: AGPL is a hard blocker unless you stay on the vendor's cloud (no self-host). Hindsight (MIT) and Mem0 (Apache 2.0) are both clean.

### Other terms

- **TEMPR.** Hindsight's 4-strategy retrieval: semantic + BM25 + graph + temporal, fused via reciprocal rank fusion + cross-encoder reranking. Strategy weights are not user-tunable; the `budget` parameter controls depth.
- **Reciprocal Rank Fusion (RRF).** Result-fusion algorithm that combines rankings from multiple retrieval strategies by summing `1/(rank + k)` across strategies. Resilient to strategies with different score scales.
- **HRR (Holographic Reduced Representations).** Plate 1995 academic technique for encoding structured information as superposed complex-valued vectors. Used by the Hermes Agent "Holographic" plugin. Retrieval is algebraic (binding / unbinding) rather than nearest-neighbor.
- **LOCOMO / LongMemEval.** Long-term memory benchmarks for LLM agents. Every vendor publishes flattering numbers on these; methodologies differ enough that head-to-head comparison from vendor-published numbers is unreliable. The only public methodology rebuttal is Zep's of Mem0.
- **MCP (Model Context Protocol).** Anthropic's open protocol for connecting LLM apps to external tools and data. Most memory providers expose MCP servers so Claude / Cursor / etc. can access memory natively.

---

## References

### Hindsight
- [hindsight.vectorize.io — product homepage](https://hindsight.vectorize.io/)
- [Developer docs: Quick Start](https://hindsight.vectorize.io/developer/api/quickstart)
- [Developer docs: Retain API](https://hindsight.vectorize.io/developer/api/retain)
- [Developer docs: Recall API](https://hindsight.vectorize.io/developer/api/recall)
- [Developer docs: Reflect API](https://hindsight.vectorize.io/developer/api/reflect)
- [Developer docs: Mental Models API](https://hindsight.vectorize.io/developer/api/mental-models)
- [Developer docs: Configuration (Mission / Directives / Disposition)](https://hindsight.vectorize.io/developer/configuration)
- [Developer docs: Installation](https://hindsight.vectorize.io/developer/installation)
- [Developer docs: MCP Server](https://hindsight.vectorize.io/developer/mcp-server)
- [Vectorize pricing](https://vectorize.io/pricing)
- [Changelog](https://hindsight.vectorize.io/changelog)
- [GitHub: vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)
- [GitHub issue #1120 — openclaw silent retention failure](https://github.com/vectorize-io/hindsight/issues/1120)
- [GlobeNewswire — Vectorize $3.6M Seed (Oct 2024)](https://www.globenewswire.com/news-release/2024/10/08/2959671/0/en/Vectorize-Raises-3-6-Million-to-Transform-AI-Powered-Data-Retrieval.html)

### Mem0
- [mem0.ai homepage](https://mem0.ai/)
- [Platform Quickstart](https://docs.mem0.ai/platform/quickstart)
- [Open Source Quickstart](https://docs.mem0.ai/open-source/python-quickstart)
- [REST API — Add Memories](https://docs.mem0.ai/api-reference/memory/add-memories)
- [REST API — Search Memories](https://docs.mem0.ai/api-reference/memory/search-memories)
- [Vector DB Components](https://docs.mem0.ai/components/vectordbs/overview)
- [LangChain Integration](https://docs.mem0.ai/integrations/langchain)
- [Pricing](https://mem0.ai/pricing)
- [GitHub: mem0ai/mem0](https://github.com/mem0ai/mem0)
- [arXiv:2504.19413 — Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413)
- [Zep rebuttal — "Lies, Damn Lies, and Statistics"](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)
- [TechCrunch — Mem0 raises $24M (Oct 2025)](https://techcrunch.com/2025/10/28/mem0-raises-24m-from-yc-peak-xv-and-basis-set-to-build-the-memory-layer-for-ai-apps/)
- [HN #46891715 — Mem0 doesn't learn user patterns](https://news.ycombinator.com/item?id=46891715)
- [GitHub issue #3441 — Ollama + Qdrant silent failure](https://github.com/mem0ai/mem0/issues/3441)
- [GitHub issue #2302 — Embedding dimension not settable](https://github.com/mem0ai/mem0/issues/2302)

### Honcho
- [honcho.dev homepage](https://honcho.dev/)
- [Honcho v3 Overview](https://honcho.dev/docs/v3/documentation/introduction/overview.md)
- [Honcho v3 Quickstart](https://honcho.dev/docs/v3/documentation/introduction/quickstart.md)
- [Architecture: Peers, Sessions, Workspaces, Messages](https://honcho.dev/docs/v3/documentation/core-concepts/architecture.md)
- [chat() feature docs](https://honcho.dev/docs/v3/documentation/features/chat.md)
- [get-context() feature docs](https://honcho.dev/docs/v3/documentation/features/get-context.md)
- [Dreaming docs](https://honcho.dev/docs/v3/documentation/features/advanced/dreaming.md)
- [Self-Hosting Guide](https://honcho.dev/docs/v3/contributing/self-hosting.md)
- [License (AGPL-3.0)](https://honcho.dev/docs/v3/contributing/license.md)
- [Vercel AI SDK Integration](https://honcho.dev/docs/v3/guides/integrations/vercel-ai-sdk.md)
- [GitHub: plastic-labs/honcho](https://github.com/plastic-labs/honcho)
- [Plastic Labs — Introducing Neuromancer XR](https://plasticlabs.ai/blog/research/Introducing-Neuromancer-XR)
- [Variant — investment thesis](https://variant.fund/articles/investing-in-plastic-labs/)
- [GitHub issue #494 — self-hosted deriver worker](https://github.com/plastic-labs/honcho/issues/494)
- [GitHub issue #598 — no memory-wipe API](https://github.com/plastic-labs/honcho/issues/598)

### OpenViking
- [GitHub: volcengine/OpenViking](https://github.com/volcengine/OpenViking)
- [openviking.ai homepage](https://openviking.ai/)
- [MarkTechPost launch writeup](https://www.marktechpost.com/2026/03/15/meet-openviking-an-open-source-context-database-that-brings-filesystem-based-memory-and-retrieval-to-ai-agent-systems-like-openclaw/)
- [Red Hat Developer — Deploy OpenViking on OpenShift AI](https://developers.redhat.com/articles/2026/04/23/deploy-openviking-openshift-ai-improve-ai-agent-memory)
- [GitHub issue #606 — MCP package Cloudwise hardcoding](https://github.com/volcengine/OpenViking/issues/606)

### Holographic (Hermes Agent plugin)
- [GitHub: NousResearch/hermes-agent](https://github.com/nousresearch/hermes-agent)
- [Hermes Agent Memory Providers docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)
- [Holographic Memory plugin README](https://github.com/NousResearch/hermes-agent/blob/main/plugins/memory/holographic/README.md)

### RetainDB
- [retaindb.com homepage](https://www.retaindb.com/)
- [Pricing](https://www.retaindb.com/pricing)
- [Features](https://www.retaindb.com/features)
- [Benchmark page](https://www.retaindb.com/benchmark)
- [GitHub: RetainDB](https://github.com/RetainDB)
- [LangMem vs RetainDB — Gamgee](https://gamgee.ai/vs/langmem-vs-retaindb/)

### Byterover
- [byterover.dev homepage](https://www.byterover.dev/)
- [Pricing](https://www.byterover.dev/pricing)
- [LoCoMo benchmark blog](https://www.byterover.dev/blog/benchmark-ai-agent-memory)
- [arXiv:2604.01599 — ByteRover paper](https://arxiv.org/abs/2604.01599)
- [GitHub: campfirein/byterover-cli](https://github.com/campfirein/byterover-cli)

### Supermemory
- [supermemory.ai homepage](https://supermemory.ai/)
- [Pricing](https://supermemory.ai/pricing)
- [How it works docs](https://supermemory.ai/docs/concepts/how-it-works)
- [Memory engine blog](https://supermemory.ai/blog/memory-engine/)
- [Research / benchmarks](https://supermemory.ai/research/)
- [GitHub: supermemoryai/supermemory](https://github.com/supermemoryai/supermemory)
- [TechCrunch — Supermemory $2.6M raise (Oct 2025)](https://techcrunch.com/2025/10/06/a-19-year-old-nabs-backing-from-google-execs-for-his-ai-memory-startup-supermemory/)
- [LogRocket — Mem0 vs Supermemory comparison](https://blog.logrocket.com/building-ai-apps-mem0-supermemory/)

### Cross-cutting
- [Agent Memory Providers Compared — glukhov.org](https://www.glukhov.org/ai-systems/memory/agent-memory-providers/)
- [LongMemEval benchmark](https://xiaowu0162.github.io/long-mem-eval/)
- [LongMemEval paper (ICLR 2025)](https://arxiv.org/abs/2410.10813)

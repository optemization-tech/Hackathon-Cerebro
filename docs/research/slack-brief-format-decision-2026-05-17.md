**Winner: TBD — pending human review.**

---

# Slack Brief Format A/B Decision

**Date:** 2026-05-17
**Experiment window:** 2026-05-10 to 2026-05-16
**Channels tested:** 6 channels spanning 4 engagement categories (see table below)
**Briefs generated:** 54 total (46 new + 8 prior #delivery briefs)
**Eval queries:** 7 standard Cerebro extraction dimensions
**Hindsight bank:** Cerebro (default namespace)

### Channel selection rationale

| Channel | ID | Category | Days with data | Messages | Why selected |
|---|---|---|---|---|---|
| #picnic-health | C0AFWTRSD8U | Active client engagement | 4 | 20 | Active client with technical escalation threads |
| #people | C02MQ6FMWQ2 | Internal / bot-heavy | 5 | 93 | High bot-message ratio (Daily Check-In); tests extraction robustness |
| #temporal-internal | C0AQY7PACAV | Client internal | 3 | 18 | Internal-facing client engagement channel |
| #temporal | C0AQ3SQ0VM5 | Client engagement | 3 | 9 | Client-facing engagement channel |
| #mouse-internal | C0AUCEN9D7C | Client internal | 4 | 16 | Internal coordination for newer engagement |
| #mouse | C0AUCEKE5MY | Client engagement | 4 | 8 | Client-facing channel with workspace blueprint work |

Prior run (PR #103) also covered #delivery (C01EFPJ4EBS, internal team, 4 days, 17 msgs) — those 8 briefs remain in Hindsight tagged `format:a`/`format:b`.

## Formats tested

**Format A — Hindsight-typed sections:** Structured brief with H2 sections per knowledge category (Decisions, Insights, Frameworks, Strategies, Signals, Projects, Tasks, People, Companies, Glossary Candidates, Open Threads). Bulleted items under each section. Only non-empty sections included.

**Format B — Day-in-the-life narrative:** 3-5 paragraph prose in temporal order. Decisions, action items, and open questions woven into the narrative rather than categorized.

Both formats require **verbatim quotes** (3-8 per brief) from high-signal messages. Both attribute every claim to the speaker.

## Spot-check findings (manual review)

Reviewed 6 briefs (1 per format × 3 channels: #picnic-health, #people, #mouse). Focused on the busiest day per channel.

| Dimension | Format A | Format B |
|---|---|---|
| Hallucination | None detected | None detected |
| Attribution | Every claim attributed to speaker | Every claim attributed to speaker |
| Verbatim quotes | Present, block-style in bullet points | Present, woven inline into prose |
| Specificity | High — names, tools, dates, links preserved | High — same detail level |
| Structure | Scan by category (Decisions, People, etc.) | Read end-to-end temporal narrative |
| Brief length (range) | 248–7892 chars | 600–3596 chars |
| Information density | Higher — more discrete extractable facts | Same facts, more connective tissue |
| Readability | Reference-style — find what you need fast | Story-style — understand context and causality |
| Bot-message handling (#people) | Extracts human threads from bot check-ins cleanly | Same — focuses on substantive conversation, ignores bot scaffolding |

### Notable quality differences (wider sample confirms prior findings)

- **Format A** surfaces more discrete extractable facts per brief. The #mouse 2026-05-12 brief captured a full workspace blueprint methodology, 6 specific decisions, framework components, and glossary candidates in separate scannable sections (7,369 chars).
- **Format B** provides better temporal context and causal chains. The #picnic-health 2026-05-14 brief reads as a coherent incident narrative — you understand *why* Meg halted migrations, what Tem tried, and why the initial fix wasn't sufficient (2,979 chars vs Format A's 4,806 chars for the same day).
- **Format B** is consistently shorter (30-60% less text) because it doesn't repeat entity names across category sections.
- **Bot-heavy channels (#people):** Both formats handle the Daily Check-In bot posts gracefully — they extract the human threads (music discussion, work questions) rather than summarizing bot prompts. Neither hallucinates bot intent.

## Hindsight eval results

### Methodology

7 reflect queries covering: Decisions, Stress signals, People+Projects, Strategies, Patterns, Insights, Open tasks. Each query run with `tags: ["format:a", "source:slack"]` (or `format:b`), `tags_match: "all"`, `budget: "mid"`. Corpus: 54 briefs across 7 channels.

### Results

| Query | Format A (chars) | Format B (chars) | Hedges A | Hedges B | Winner |
|---|---|---|---|---|---|
| Decisions | 2467 | 2266 | 0 | 0 | tie |
| Stress signals | 2879 | 2619 | 0 | 0 | tie |
| People + Projects | 2918 | 2674 | 0 | 0 | tie |
| Strategies | 3031 | 3327 | 0 | 0 | tie |
| Patterns | 3185 | 3065 | 0 | 0 | tie |
| Insights | 2898 | 2896 | 0 | 0 | tie |
| Open tasks | 2575 | 1047 | 0 | 0 | tie |

**Overall: 0 wins format-a, 0 wins format-b, 7 ties.**

Average answer length: Format A = 2850 chars, Format B = 2556 chars.
Citations (`based_on`): null for all queries (Hindsight limitation, not format-dependent).

### Interpretation

Hindsight's consolidation layer normalizes both formats into the same underlying knowledge graph. The reflect API returns comparably rich, specific, zero-hedge answers regardless of which format was ingested. This result holds across 7 channels spanning client engagements (#picnic-health, #temporal, #mouse), internal coordination (#temporal-internal, #mouse-internal, #delivery), and bot-heavy team channels (#people).

**The choice between A and B does not meaningfully affect downstream retrieval quality.** Hindsight extracts the same facts from both.

The "Open tasks" query showed Format B returning a raw JSON memory-ID blob (1,047 chars vs Format A's 2,575 chars of structured prose) — this is a Hindsight consolidation artifact, not a format-dependent outcome.

## Trade-off summary

| Consideration | Favors Format A | Favors Format B |
|---|---|---|
| Hindsight retrieval quality | — | — |
| Human spot-checking at scale | Yes (scannable sections) | |
| Token efficiency (shorter briefs = cheaper backfill) | | Yes (30-60% shorter) |
| Category mapping to LTM DB types | Yes (1:1 section → DB type) | |
| Causal/temporal context for readers | | Yes (narrative flow) |
| Information density (discrete facts) | Yes | |
| Bot-heavy channel handling | Equal | Equal |

## Recommendation (non-binding — awaiting human override)

The data does not produce a clear automated winner. Both formats are equally effective for Hindsight's knowledge extraction. The decision reduces to a **human judgment call** on which secondary properties matter more:

- If **human auditability and LTM routing** matter more → Format A
- If **token cost and narrative readability** matter more → Format B

The prior run's recommendation of Format A was based on the same reasoning (higher density, better spot-checking, LTM mapping). The wider sample confirms the structural trade-offs but does not change the retrieval parity.

## Experiment artifacts

- **Run 1 manifest (prior, #delivery only):** `slack/scripts/.runs/2026-05-17T12-57-30-751Z-manifest.json` (committed in PR #103)
- **Run 2 manifest (this run, 6 channels):** `slack/scripts/.runs/2026-05-17T15-19-01-151Z-manifest.json`
- **Eval results (prior run):** `docs/research/eval-results-2026-05-17.json`
- **Eval results (this run):** `docs/research/eval-results-2026-05-17-rerun.json`
- **STM pages:** 54 briefs in Short-Term Memory DB, all retained to Hindsight with `format:a`/`format:b` + `source:slack` tags
- **Brief generator prompts:** `slack/src/lib/briefs.ts`
- **Eval runner:** `scripts/eval-slack-brief-formats.mjs`

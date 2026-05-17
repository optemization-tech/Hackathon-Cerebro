**Winner: Format B (day-in-the-life narrative).**

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

### Interpretation (heuristic)

The heuristic scoring (answer length, hedge count) treats both formats as equivalent. But this scoring is a weak proxy — it measures output volume, not whether the facts are correct or how many were surfaced. The LLM-as-judge eval below addresses this directly.

## LLM-as-judge eval (precision / recall / accuracy)

### Methodology

Same 7 queries and reflect answers as above, but scored by Claude Sonnet 4 as a structured judge. For each query × format pair, the judge received the reflect answer AND all 27 source briefs for that format as ground truth. It scored:

- **Discrete items**: count of distinct factual claims (not vague generalizations)
- **Precision**: fraction of claims actually supported by source briefs (0.0–1.0)
- **Recall**: fraction of source brief facts surfaced in the answer (0.0–1.0)
- **Specificity**: concreteness rating (1–5)
- **Hallucinated claims**: specific facts in the answer NOT in any source brief

### Results

| Query | A items | A precision | A recall | B items | B precision | B recall | Winner |
|---|---|---|---|---|---|---|---|
| Decisions | 19 | 0.89 | 0.85 | 8 | 1.00 | 0.45 | **A** |
| Stress signals | 28 | 0.64 | 0.75 | 25 | 0.68 | 0.72 | **B** |
| People + Projects | 25 | 0.16 | 0.15 | 20 | 0.20 | 0.18 | tie |
| Strategies | 11 | 0.27 | 0.40 | 15 | 0.47 | 0.60 | **B** |
| Patterns | 18 | 0.33 | 0.35 | 22 | 0.32 | 0.45 | **B** |
| Insights | 12 | 0.25 | 0.30 | 8 | 0.38 | 0.45 | **B** |
| Open tasks | 18 | 0.00 | 0.30 | 0 | 0.00 | 0.00 | **A** |

**Overall: Format A wins 2, Format B wins 4, Ties 1.**

### Aggregated metrics

| Metric | Format A | Format B |
|---|---|---|
| Avg discrete items per query | 18.7 | 14.0 |
| Avg precision | 0.36 | 0.44 |
| Avg recall | 0.44 | 0.41 |
| Avg specificity | 3.6 / 5 | 3.1 / 5 |
| Total hallucinated claims | 83 | 61 |

### Interpretation (LLM judge)

The LLM judge reveals a pattern the heuristic scoring completely missed:

1. **Format A produces more claims but lower precision.** It surfaces ~33% more discrete items per query (18.7 vs 14.0) but only 36% of those are actually supported by the source briefs. Format B surfaces fewer items but 44% are supported — a meaningfully higher accuracy rate.

2. **Format A generates more hallucinations.** 83 total unsupported claims vs 61 for Format B. The structured sections appear to encourage Hindsight's consolidation layer to fill in category slots even when the source material doesn't support it.

3. **Both formats have low absolute precision.** Neither exceeds 0.44 average precision — Hindsight is synthesizing heavily beyond what's in the briefs regardless of format. This is a Hindsight behavior, not purely a format issue, but Format A amplifies it.

4. **Recall is comparable.** Both formats capture roughly the same fraction of source facts (0.44 vs 0.41), suggesting the raw information extraction from Slack messages is similar in both.

5. **Format A excels on structured queries.** "Decisions" (p=0.89) and "Open tasks" show Format A's strength: when the query maps directly to a section header, Format A's explicit structure gives Hindsight better extraction targets. But this advantage doesn't generalize to fuzzier queries (Strategies, Patterns, Insights).

6. **Format B wins on fuzzier/interpretive queries.** Strategies, Patterns, Insights, Stress signals — Format B's narrative structure produces more precise answers for queries that require synthesis across topics rather than lookup within a category.

## Trade-off summary

| Consideration | Favors Format A | Favors Format B |
|---|---|---|
| Retrieval precision (fewer hallucinations) | | Yes (0.44 vs 0.36) |
| Retrieval quantity (more items surfaced) | Yes (18.7 vs 14.0) | |
| Retrieval recall (coverage of source facts) | Roughly equal | Roughly equal |
| Structured/lookup queries (Decisions, Tasks) | Yes | |
| Fuzzy/interpretive queries (Strategies, Patterns) | | Yes |
| Human spot-checking at scale | Yes (scannable sections) | |
| Token efficiency (shorter briefs = cheaper backfill) | | Yes (30-60% shorter) |
| Category mapping to LTM DB types | Yes (1:1 section → DB type) | |
| Causal/temporal context for readers | | Yes (narrative flow) |
| Total hallucinations from Hindsight | | Yes (61 vs 83) |

## Recommendation (non-binding — awaiting human override)

The LLM-judge eval shifts the picture from "no difference" to a meaningful trade-off:

- **Format A** is better when you need **exhaustive enumeration** of a known category (Decisions, Tasks) and can tolerate more false positives. Good for structured extraction into LTM databases where a human or downstream filter catches hallucinations.
- **Format B** is better when you need **higher-accuracy synthesis** across topics and want fewer hallucinated claims. Better for Ask Cerebro / reflect queries where the user trusts the answer at face value.

Neither format dominates. The choice depends on which downstream consumers matter more: structured LTM writes (favor A) or conversational Q&A (favor B).

## Experiment artifacts

- **Run 1 manifest (prior, #delivery only):** `slack/scripts/.runs/2026-05-17T12-57-30-751Z-manifest.json` (committed in PR #103)
- **Run 2 manifest (this run, 6 channels):** `slack/scripts/.runs/2026-05-17T15-19-01-151Z-manifest.json`
- **Eval results (prior run):** `docs/research/eval-results-2026-05-17.json`
- **Eval results (this run):** `docs/research/eval-results-2026-05-17-rerun.json`
- **STM pages:** 54 briefs in Short-Term Memory DB, all retained to Hindsight with `format:a`/`format:b` + `source:slack` tags
- **Brief generator prompts:** `slack/src/lib/briefs.ts`
- **Eval runner:** `scripts/eval-slack-brief-formats.mjs`

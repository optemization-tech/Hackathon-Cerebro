Winner: TBD — pending human review.

---

# Slack Brief Format A/B Decision

**Date:** 2026-05-17
**Experiment window:** 2026-05-10 to 2026-05-16
**Channel tested:** #delivery (C01EFPJ4EBS)
**Briefs generated:** 8 (4 days x 2 formats; 3 days empty/skipped)
**Eval queries:** 7 standard Cerebro extraction dimensions
**Hindsight bank:** Cerebro (default namespace)

## Formats tested

**Format A — Hindsight-typed sections:** Structured brief with H2 sections per knowledge category (Decisions, Insights, Frameworks, Strategies, Signals, Projects, Tasks, People, Companies, Glossary Candidates, Open Threads). Bulleted items under each section. Only non-empty sections included.

**Format B — Day-in-the-life narrative:** 3-5 paragraph prose in temporal order. Decisions, action items, and open questions woven into the narrative rather than categorized.

Both formats were updated before this run to require **verbatim quotes** (3-8 per brief) from high-signal messages. Both attribute every claim to the speaker.

## Spot-check findings (manual review)

Reviewed all 8 briefs (4 per format). Key observations:

| Dimension | Format A | Format B |
|---|---|---|
| Hallucination | None detected | None detected |
| Attribution | Every claim attributed | Every claim attributed |
| Verbatim quotes | Present, well-chosen | Present, naturally woven into prose |
| Specificity | High — names, tools, dates preserved | High — same level of detail |
| Structure | Easy to scan by category | Easy to read end-to-end |
| Brief length | 1122-5761 chars | 813-2939 chars |
| Information density | Higher (more discrete facts) | Lower (same facts but more connective tissue) |
| Readability | Reference-style — scan for what you need | Story-style — read to understand context |
| Quote integration | Block-style within bullet points | Inline within narrative flow |

### Notable quality differences

- **Format A** surfaces more discrete extractable facts per brief (e.g., the May 14 brief captured 9 projects, 9 people, 5 tasks, 3 glossary candidates in separate sections). This is directly useful for Hindsight's entity/fact extraction.
- **Format B** provides better temporal context — you understand *why* a decision was made because the narrative connects the preceding discussion to the conclusion. The May 12 brief reads like a well-briefed colleague summarizing the day.
- **Format B** briefs are consistently shorter (30-50% less text) because they don't repeat entity names across multiple category sections.

## Hindsight eval results

### Methodology

7 reflect queries covering: Decisions, Stress signals, People+Projects, Strategies, Patterns, Insights, Open tasks. Each query run with `tags: ["format:a", "source:slack"]` (or `format:b`), `tags_match: "all"`, `budget: "mid"`.

### Results

| Query | Format A | Format B | Winner |
|---|---|---|---|
| Decisions | 1904 chars, 0 hedges | 2197 chars, 0 hedges | tie |
| Stress signals | 2266 chars, 0 hedges | 2164 chars, 0 hedges | tie |
| People + Projects | 2747 chars, 0 hedges | 2229 chars, 0 hedges | tie |
| Strategies | substantive answer | substantive answer | tie |
| Patterns | substantive answer | substantive answer | tie |
| Insights | substantive answer | substantive answer | tie |
| Open tasks | substantive answer | substantive answer | tie |

**Overall: 0 wins format-a, 0 wins format-b, 7 ties.**

### Interpretation

Hindsight's consolidation layer normalizes both formats into the same underlying knowledge graph. The reflect API returns comparably rich, specific answers regardless of which format was ingested. This means **the choice between A and B does not meaningfully affect downstream retrieval quality** — Hindsight extracts the same facts from both.

The `based_on` (citation) field returned `null` for all queries, so citation-based scoring was not possible. The heuristic scoring (hedges, answer length) showed no meaningful differentiation.

## Recommendation

**Format A (Hindsight-typed sections)** — with the following reasoning:

1. **Higher information density.** Format A surfaces more discrete facts per brief, which gives Hindsight more explicit extraction targets. Even though both formats produce equivalent reflect answers today, Format A is structurally more robust as the corpus scales.

2. **Better for human spot-checking.** The sectioned layout makes it faster to verify that a brief captured all the important signals from a day's conversation. This matters for the backfill — we need to spot-check at scale.

3. **Explicit category mapping.** Format A's sections map 1:1 to Cerebro's Long-Term Memory DB types (People, Companies, Projects, Decisions, etc.). If/when the Cerebro Sync Worker writes to LTM, Format A briefs provide a natural routing signal.

4. **Quotes land well in both formats.** The verbatim-quotes requirement works in both, but Format A's bullet-point structure makes quotes more scannable.

5. **Format B's advantage (narrative context) is preserved in the raw Slack transcript** that Hindsight also sees. The brief doesn't need to be the only source of temporal context.

**Caveat:** This was tested on 1 channel over 4 active days. The recommendation holds for the #delivery channel's conversational style (team coordination, client work discussion). Channels with very different patterns (e.g., pure notification channels, code-review channels) might benefit from different formatting — but Format A's skip-empty-sections behavior handles sparse channels gracefully.

## Experiment artifacts

- **Run manifest:** `slack/scripts/.runs/2026-05-17T12-57-30-751Z-manifest.json`
- **Eval results:** committed as `docs/research/eval-results-2026-05-17.json`
- **STM pages:** 8 briefs written to Short-Term Memory DB, all retained to Hindsight with `format:a`/`format:b` tags
- **Brief generator prompts:** `slack/src/lib/briefs.ts` (updated with verbatim-quotes requirement)
- **Eval runner:** `scripts/eval-slack-brief-formats.mjs` (fixed: reflect endpoint path, tags_match format)

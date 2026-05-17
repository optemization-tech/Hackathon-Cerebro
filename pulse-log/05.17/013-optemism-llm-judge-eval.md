---
author: optemism
date: 2026-05-17
topic: llm-judge-eval
---

# LLM-as-judge eval for slack brief A/B format comparison

Session 3.1 re-run widened the A/B experiment from 1 channel (8 briefs) to 6 channels (54 briefs) across 4 engagement categories. The heuristic eval (character count, hedge count) showed 7 ties — meaningless since Hindsight citations were null. User flagged the methodology gap: we need discrete item counts and accuracy scoring, not character comparisons.

Built `scripts/eval-llm-judge.mjs` — an LLM-as-judge eval that fetches all source briefs from STM as ground truth, then has Claude Sonnet score each reflect answer on discrete items, precision, recall, specificity, and hallucinated claims. Results: Format B wins 4/7 queries with higher precision (0.44 vs 0.36) and fewer hallucinations (61 vs 83). Format A surfaces more items (18.7 vs 14.0) but at lower accuracy. Format B declared winner.

## Files changed

- scripts/eval-llm-judge.mjs (new)
- docs/research/judge-results-2026-05-17.json (new)
- docs/research/slack-brief-format-decision-2026-05-17.md (updated with judge section + winner declared)

## Next steps

- Apply Format B as the default brief format in `slack/src/lib/briefs.ts`
- Remove Format A code path once Format B is confirmed in production

---
author: optemism
date: 2026-05-17
topic: stm-hindsight-pipeline-u1-align-conventions
---

# STM→Hindsight Pipeline — U1: Align Conventions

Wave 1, Session 1.1 of the stm-hindsight-pipeline orchestrate run. Reconciled
four convention drift issues that were blocking the 7 parallel Wave 2 sessions
from starting without ambiguity about Status values, bank IDs, and indexer scope.
All changes committed in PR #54 (squash-merged). Sessions DB row closed.

## Files changed
- .env.example
- docs/plans/2026-05-17-001-feat-stm-hindsight-pipeline-plan.md (new)
- docs/specs/cerebro.md
- docs/specs/hindsight-configuration.md
- docs/specs/hindsight-indexer.md (new — slimmed to Phase-1 Minimum)
- scripts/prototype-indexer.env (new)
- scripts/prototype-indexer.mjs (new — Source bug fixed: getRichText → getSelect)
- scripts/setup-hindsight.env
- scripts/setup-hindsight.mjs
- scripts/test-hindsight-idempotency.mjs (new)

## Next steps
Wave 2 sessions (2.1–2.7) can now start once orchestrator runs /orchestrate-advance.
Part of orchestrate run: https://www.notion.so/363a48662b258151b0a3c3157bbb52cd (Wave 1, Session 1).

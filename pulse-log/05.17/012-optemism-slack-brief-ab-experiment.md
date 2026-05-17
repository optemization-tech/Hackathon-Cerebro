---
author: optemism
date: 2026-05-17
topic: slack-brief-ab-experiment
---

# Slack brief A/B experiment execution

Ran the end-to-end A/B experiment comparing Format A (Hindsight-typed sections) vs Format B (narrative prose) on #delivery channel for the past week. Updated both generators to require 3-8 verbatim quotes per brief (preserving voice and evidence, not just gist). Fixed STM write pipeline property names (`Nam` not `Name`, removed nonexistent `Source`), fixed eval runner Hindsight API contract (correct reflect URL, `tags_match` string enum, no `include` param). Eval results: 7/7 ties — Hindsight's consolidation normalizes both formats identically. Decision doc recommends Format A for upstream structure and human readability. PR #103 merged.

Part of orchestrate run: https://www.notion.so/363a48662b2581f7a4c9f43a959594ec (Wave 3, Session 1).

## Files changed
- slack/src/lib/briefs.ts
- slack/src/lib/write-pipeline.ts
- scripts/eval-slack-brief-formats.mjs
- docs/research/slack-brief-format-decision-2026-05-17.md (new)
- docs/research/eval-results-2026-05-17.json (new)

## Next steps
- Human review of Format A vs Format B briefs for final sign-off
- Deploy brief generators with winning format
- Scale beyond #delivery to all active channels

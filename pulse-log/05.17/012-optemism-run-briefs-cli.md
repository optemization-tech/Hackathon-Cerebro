---
author: optemism
date: 2026-05-17
topic: run-briefs-cli
---

# Run-briefs CLI for daily Slack brief generation

Built `slack/scripts/run-briefs.ts` — the CLI orchestrator for the Slack daily brief pipeline. Wires together the four libraries from Sessions 1.1–1.4 (channels, messages, briefs, write-pipeline) into a single invocation. Supports date ranges, A/B format experiments, channel filtering, bounded concurrency, dry-run mode, skip-existing dedup, and optional direct Hindsight retain. Emits per-run manifest JSON to `slack/scripts/.runs/` for audit.

## Files changed
- slack/scripts/run-briefs.ts (new, 432 lines)
- slack/scripts/.runs/.gitkeep (new)
- .gitignore (added manifest exclusion)

## Next steps
- Session 3.1 will use this CLI to run the A/B experiment (--formats a,b over May 10–16)
- Backfill session will use it for Jan 1 → May 9 with the winning format

Part of orchestrate run: https://www.notion.so/363a48662b2581f7a4c9f43a959594ec (Wave 2, Session 1).

---
author: optemism
date: 2026-05-17
topic: eval-runner-tool
---

# Eval runner for Slack brief A/B format comparison

Built `scripts/eval-slack-brief-formats.mjs` — a standalone eval tool that runs N queries x M format scopes against Hindsight `reflect()`, scoped via `tags_match.all`. Captures raw answer text, `based_on` citations, and heuristic scores (citation count, hedge-phrase presence, attribution density). Emits structured JSON with per-query winners and aggregate summary with recommended format. Supports `--manifest`, `--queries`, `--output`, `--budget`, `--concurrency`, and `--dry-run` flags.

## Files changed
- scripts/eval-slack-brief-formats.mjs (new, 337 lines)

## Next steps
- Session 2.1 (brief-generator) retains A/B briefs to Hindsight with format: tags
- Session 3.1 consumes eval output to produce the decision doc

Part of orchestrate run: https://www.notion.so/363a48662b2581f7a4c9f43a959594ec (Wave 2, Session 2).

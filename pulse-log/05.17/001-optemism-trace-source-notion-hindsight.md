---
author: optemism
date: 2026-05-17
topic: trace-source-notion-hindsight
---

# Trace source:notion content in Hindsight bank

Investigated the 11 source:notion documents (105 memory units) in the Cerebro Hindsight bank. Traced origin to the parked Wave 2 indexer (commit a814a83) run during session 2.1 on 2026-05-16 evening — context string pattern and tag signature match exclusively to that code. Content is real Optemization Docs Database pages (hiring posts, workspace architecture, engagement portal standards). During review, established the tag convention: drop `source:` tag entirely, use `data-type:` as single source identifier mirroring STM Data Type 1:1. Recommendation: preserve existing content, backlog tag cleanup to production indexer build.

## Files changed
- docs/research/source-notion-trace.md (new)
- BACKLOG.md

## Next steps
- Production indexer build should implement the canonical tag set (data-type only, no source:)
- Delete test artifacts (idempotency-test, bootstrap smoke test) from Hindsight bank

Part of orchestrate run: https://www.notion.so/363a48662b258151b0a3c3157bbb52cd (Wave 1, Session 2).

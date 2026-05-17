---
author: optemism
date: 2026-05-16
topic: cerebro-v1-wave-2-circleback-cleaner
---

# Cerebro V1 — Wave 2 (narrowed): Circleback worker + cleaner wire-in

Session 2.1 of the cerebro-v1-build orchestrate run. Original wave-2 scope covered 5 units (slack patch, circleback, notion-docs, google patch, indexer); narrowed mid-flight to **circleback + cleaner wire-in**. Shipped U5/U7/U9 to main; parked U8/U10 on a branch for later.

## Shipped — PR #32 (merged)

- **U7 Circleback worker (new)** — `circleback/` worker with `worker.webhook("circlebackEvents", ...)`. HMAC-SHA256 sig verification via `CIRCLEBACK_WEBHOOK_SECRET`. Transcript stitching `[Speaker · hh:mm:ss] text`. Glossary normalization via `clean()`. Dedup ID `circleback:<meeting_id>` (no uuidv5 — first-principles deviation from slack/). Writes STM with Data Type `Circleback transcript` (live STM select option, not the spec's "Meeting transcript").
- **U5 Slack worker patch** — vendored `lib/cleaning/` → `slack/src/cleaning/`. Glossary loads once per sync run. The existing `cleanSlackText()` (Slack-token rewriter for `<@U123>` → `@RealName`) runs FIRST, then `clean(text, glossary)` for Glossary canonical-form normalization on top. Writes `Status: pending` (was `cleaned`) and populates `Entities` JSON. Legacy ~2,418 `cleaned` rows intentionally left alone — documented in `slack/.agents/INSTRUCTIONS.md`.
- **U9 Google worker patch** — same shape as U5. Glossary normalization applied to email subject+body and event summary+description; entities merged + deduped via `mergeEntities()`. `redact()` (cards/SSN/tokens) still runs first, then `clean()`.

Followup: [PR #33](https://github.com/optemization-tech/Hackathon-Cerebro/pull/33) excluded `circleback/` from root tsconfig to unblock the Vercel build.

## Parked — `parked/wave-2-u8-u10-notion-docs-indexer` branch (pushed, not merged)

Reconstructed U8 + U10 from memory after the worktree was deleted mid-session. Both typecheck on the parked branch; neither has been deployed.

- **U8 Notion-Docs multi-DB worker** — 30m sync watching Optemization Docs + optional Granola mirror. Flattens page body via `blocks.children.list`. Glossary normalization on title + body. Dedup ID `notion-doc:<page-id>:<last-edited-time>` — re-edited pages produce new STM rows (history preserved).
- **U10 Hindsight Indexer** — 5m sync polling STM `Status=pending`, cap 50/run. POSTs to the correct retain endpoint `/v1/{ns}/banks/{id}/memories` (the docs-mentioned `/memory/retain` returns 404; `/memories/retain` returns 405 — that was the main field-test learning). Source slug derived from `Data Type` since STM has no `Source` property yet. PAT-tolerant user lookup.

## Notes from the field

- **No `Source` property on STM** — spec calls for it but Wave 1 only added `Entities` + `Status` options. Initial worker writes referenced a Source property that didn't exist; dropped those writes and made the Indexer derive source from `Data Type` instead.
- **Circleback Data Type** — spec says "Meeting transcript" but STM select has "Circleback transcript". Used the live option to avoid a schema migration.
- **Retain URL discovery** — Hindsight's published SDK docs (`hindsight.vectorize.io/developer/api/retain`) imply paths like `/memory/retain` or `/retain`. Live OpenAPI shows the actual endpoint is `POST /v1/{ns}/banks/{id}/memories` (`operationId: retain_memories`). The wrong URL is what caused my test cycle to fail.
- **Side-effect cleaned up** — during indexer test, 50 STM rows got flipped to `Status: failed` from the wrong-URL retain calls. Reverted all 50 back to `pending` before opening PR #32. No memories were written to Hindsight by this session — bank stats showed 12 pre-existing documents, all dated before the session started.

## Files changed (PR #32)

- circleback/ (new worker; 11 files)
- slack/src/cleaning/* (vendored cleaning lib; 4 files)
- slack/src/index.ts (Glossary wire-in + Status pending + Entities)
- slack/.agents/INSTRUCTIONS.md (cleaned-rows decision)
- slack/.env.example (new)
- slack/.gitignore (allow .env.example)
- google/src/cleaning/* (vendored; 4 files)
- google/src/index.ts (Glossary wire-in + Status pending + Entities)
- google/.agents/INSTRUCTIONS.md (cleaned-rows decision)
- google/.env.example (new)
- google/.gitignore (allow .env.example)

## Files added (parked branch)

- notion-docs/ (full new worker; 11 files including vendored cleaning)
- indexer/ (full new worker; 7 files)

## Next steps

- **Wave 2 follow-up session** — pick up `parked/wave-2-u8-u10-notion-docs-indexer`. Verify STM schema hasn't drifted (especially: was `Source` property added?). Deploy notion-docs + indexer. Run indexer once against real STM data to verify the corrected retain URL works end-to-end.
- **Schema migration to consider** — add `Source` select property to STM with options: Slack, GMail, GCal, Circleback, Notion, Granola, Notion Meetings. Once present, the Indexer's `deriveSourceFromDataType` fallback can be retired in favor of reading the property directly.
- **Pre-Wave-3 prep** — the `Captured From` relation (→ Short-Term Memory) is still missing on every LTM DB (flagged in Wave 1 close-out, still pending).

Part of orchestrate run: https://www.notion.so/362a48662b25816dad83d73444171f76 (Wave 2, Session 2.1).

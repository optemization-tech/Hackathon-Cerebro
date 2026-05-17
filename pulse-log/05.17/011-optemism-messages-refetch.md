---
author: optemism
date: 2026-05-17
topic: messages-refetch
---

# Slack message fetch/bundle library for daily briefs

Built `slack/src/lib/messages.ts` — a typed library providing the data-fetching layer for the daily brief pipeline. Four exported functions: `fetchMessagesInRange` (paginated Slack history + thread replies with user-info caching and dual-pass text cleaning via `cleanSlackText` + Glossary `clean()`), `bundleByDay` (groups into PT-day `MessageBundle` maps), `sparseDayFilter` (removes empty-day entries), and `formatMessageForPrompt` (single-message LLM prompt formatting). Also exports `createUserResolver` for shared user-info caching across callers. `MessageBundle` is structurally identical to `BriefContext` from `briefs.ts`, so downstream consumers pass bundles directly.

## Files changed
- slack/src/lib/messages.ts (new, 255 lines)

## Next steps
- Integration test with real Slack workspace via `ntn workers exec`
- Wire into the A/B brief generation pipeline (Session 1.3+ scope)

Part of orchestrate run: https://www.notion.so/363a48662b2581f7a4c9f43a959594ec (Wave 1, Session 2).

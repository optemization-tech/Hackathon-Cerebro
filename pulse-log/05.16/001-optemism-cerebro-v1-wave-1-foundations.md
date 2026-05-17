---
author: optemism
date: 2026-05-16
topic: cerebro-v1-wave-1-foundations
---

# Cerebro V1 — Wave 1 foundations

Wave 1 of the cerebro-v1-build orchestrate run. Landed the foundation every downstream wave (sources, indexer, distillation, surfaces) depends on:

- **`lib/cleaning/`** — shared TypeScript module with `clean(content, glossary)` + `loadGlossary(notion)`. Longest-alias-first ordering (canonical "RC Willenbrock" wins over alias "RC"), word-boundary aware via negative lookarounds (correctly handles internal hyphens like `I-V-C` and spaces like `Aar See`), case-insensitive, deduplicates entities. 15 Node test cases, all green via `npm test`. Tolerant to both spec Glossary schema and the legacy live schema.
- **Short-Term Memory schema patched** — added `Entities` (rich_text) for Hindsight entity hints; expanded `Status` select additively to include `pending` + `indexed` alongside legacy `raw`/`cleaned`/`distilled`/`failed`. Additive approach preserves the 2,418 rows the Slack worker already wrote with `Status: cleaned` (Wave 2 will converge it onto `pending`/`indexed` once the indexer is wired).
- **Glossary seeded** — 15 spec entries (Tem, Kamau, Mike, RC Willenbrock, Optemization, AIVC, PicnicHealth, Bellesa, Leslie Institute, Temporal, Roofstock, Granola, Circleback, Hindsight, Cerebro). Glossary `Type` select extended with PERSON/ORG/AGENT/CONCEPT (kept legacy term/acronym/nickname for backward-compat).
- **Hindsight Cloud bank** — reapplied via `npm run setup:hindsight`: missions, dispositions, 7 mental models, entity_labels reconciled. Scratch `retain()` succeeded (operation `42fd2b32-0f37-452c-85f6-4e6c0c4aac27`). API key already in 1Password.
- **tsconfig** — `allowImportingTsExtensions: true` so the test file's `.ts`-extension imports pass typecheck; `workers/` added to excludes (each worker has its own tsconfig; pre-existing meetings-ingest type errors were leaking into the root typecheck).

Shipped via [PR #24](https://github.com/optemization-tech/Hackathon-Cerebro/pull/24) (merged to main).

## Files changed

- lib/cleaning/clean.test.ts
- lib/cleaning/clean.ts
- lib/cleaning/glossary.ts
- lib/cleaning/index.ts
- lib/cleaning/types.ts
- package.json
- tsconfig.json

## Schema drift flagged for downstream waves

Per the wave-1 scope the 12 non-STM DBs were verified read-only; several have spec drift to converge later:

- `Captured From` (→ Short-Term Memory) is **missing on every LTM DB** — the spec's citation primitive. Wave 3 (distillation) needs to add this or pick an alternative.
- `decisions.Status`: live = Open/Closed/Reversed/Archived; spec = proposed/committed/reversed/blocked.
- `signals`: live has `Type` (Warning/Alert/Deadline/Opportunity) + `Severity` instead of spec's `Valence` (positive/negative/neutral).
- `agents.Type`: live = AI/Bot/Service/System; spec = model/service/automation.
- `tasks.DRI` vs spec `Assignee`; `decisions.Decision Maker` (people property) vs spec `Decision Makers` (relation → People).
- Glossary `Aliases` is rich_text (comma-delimited) not multi_select; `Source` text field carries `spec-seed-v1` provenance on this wave's seeds.

## Next steps

Run `/orchestrate-advance` in the orchestrator PM session (`cerebro-v1-build · PM`) to launch Wave 2 (source workers + cleaning-lib wiring + Hindsight indexer).

Part of orchestrate run: https://www.notion.so/362a48662b25816dad83d73444171f76 (Wave 1, Session 1.1).

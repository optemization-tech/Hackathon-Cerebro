# Backlog

Stuff worth doing but not the active priority. Append at the bottom; move items to a PR title + close them out when shipped.

For current build status see [`STATUS.md`](STATUS.md). For the spec see [`docs/specs/cerebro.md`](docs/specs/cerebro.md).

---

## Audit the time-based Circleback sync fallback

**What:** Find and audit the time-based Circleback sync that some other team member set up as a fallback in case the webhook (handled by `circleback/`) fails. Confirm it doesn't collide with the deployed worker, or harmonize it.

**Why:** PR #42 standardized the STM row layout via `circleback/src/processing.ts::buildMeetingPageContent()`. The deployed `circleback` Notion Worker (id `019e342b-bbdc-71dc-b9da-7c4fd1a3a5fc`, webhook capability `circlebackEvents`) uses that helper. If the time-based sync writes the same STM data source (`362a4866-2b25-801c-9ce5-000b30156f9b`) but uses a different dedup key or a different layout, we'll end up with duplicates and two visual styles in STM.

**Where to look first:**
- 1Password vault `Optemization Automation` has a `Circleback secret` item whose notes reference `val.town cerebro-webhook` — that val (or an adjacent one) is the most likely owner of the timed path.
- Failing that: `ntn workers list` for any other circleback-ish worker (there's a typo'd `circlebackEvents` worker dated 2026-05-17T04:16:41 alongside the live `cricleback` one — could be related), or n8n workflows that mention "circleback".

**Acceptance criteria:**
- Confirm where the fallback writes (STM same data source? a parallel staging DB?).
- Confirm what dedup id it uses. If anything other than `circleback:<numeric_id>`, it'll write duplicates of our backfilled 22 rows whenever it runs.
- If it diverges, either:
  - point it at the same `processMeeting()` path (easiest if it's a val we can edit), or
  - document the divergence and gate it (skip rows the webhook worker already wrote).
- Note: rows currently in STM have `circleback:<id>` IDs created by the backfill in PR #40 (2026-05-17). Any pre-existing rows from the timed sync would have been created BEFORE that and may not be using the same ID scheme — worth diffing.

---

## Hindsight tag cleanup: drop `source:` tag, use `data-type:` as single source identifier

**What:** All documents currently in the Hindsight bank carry both a `source:` and `data-type:` tag. The `source:` tag is redundant — the STM `Data Type` select already encodes both source system and content type. The production indexer should emit only `data-type:<kebab-STM-Data-Type>` (no `source:` tag) and re-retain existing documents to update their tags.

**Why:** Two overlapping tags create ambiguity (e.g., `source:notion` could mean docs OR meetings) and make recall/reflect tag filters unreliable. The STM `Data Type` property is the canonical taxonomy — Hindsight tags should mirror it 1:1.

**Scope:** All documents in the bank (currently 17: 11 source:notion, 4 source:gcal, 1 bootstrap test, 1 idempotency test). The test artifacts (`idempotency-test-*`, `wave-1-smoke-test-*`) should also be deleted.

**Canonical tag set per document:**
- `data-type:<kebab>` — one of: `documents`, `slack-message`, `calendar-event`, `circleback-transcript`, `notion-meetings`, `note`, `granola-meeting`
- `verified:true` — only for `documents` and `note` (human-edited Notion content)
- `team:optemization`
- `stm:<page-id>`
- `person-source:<slug>` (when available)

**Where:** Production indexer build (Session 1.1 / Wave 2). See `docs/research/source-notion-trace.md` for full investigation.

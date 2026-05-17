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

---

## Deploy Google source worker (blocked on GCP auth)

**What:** The Google source worker (`google/`) is code-complete with People + Companies normalization but can't be deployed until a GCP service account with domain-wide delegation is created.

**Why:** Tem needs Gmail + Calendar data flowing into STM. The worker code is ready — just blocked on the credential.

**Steps when unblocked:**
1. Create a GCP service account with domain-wide delegation for `optemization.com`.
2. Base64-encode the JSON key, store in 1Password as "Cerebro Google service account" in the Optemization Automation vault.
3. Deploy: `cd google && ntn workers deploy --name google`
4. Set env vars and push:
   ```
   NOTION_API_TOKEN=<same as other workers>
   GOOGLE_SERVICE_ACCOUNT_KEY_BASE64=<from 1Password>
   GOOGLE_ADMIN_EMAIL=admin@optemization.com
   GOOGLE_WORKSPACE_DOMAIN=optemization.com
   GLOSSARY_DATA_SOURCE_ID=8f93178c-68cb-44da-8f80-0c7192088e0b
   PEOPLE_DATA_SOURCE_ID=c34cc2e0-79f7-4436-b826-220449c55184
   COMPANIES_DATA_SOURCE_ID=b63f79ed-9f3b-4b7b-8b12-263263ba3d5d
   ```
5. `ntn workers env push --yes && ntn workers deploy`

---

## Expand Notion DB Hindsight ingest: Tier 2 databases (deferred)

**What:** Seven additional Notion DBs were identified for direct-to-Hindsight ingest but deferred from the Tier 1 backfill (Session 2.11). They can be added to the `notion-docs` worker's `DATABASE_CONFIGS` registry with per-DB preamble builders.

**Deferred DBs:**
1. **Insights** — extracted insights, learnings, observations
2. **OKRs** — objectives and key results
3. **Changelog** — product/service change log entries
4. **Workflows** — n8n workflow definitions and metadata
5. **Verified Workflows** — production-validated workflow snapshots
6. **Brand Guide** — brand identity, voice, visual guidelines
7. **Deals** — sales pipeline / deal tracking

**Why deferred:** Tier 1 covers the highest-signal DBs (Docs, Discussions, Projects, Engagements, Playbook Core, Tasks). Tier 2 adds breadth but lower urgency. Each DB needs: data source ID resolution, property schema inspection, preamble builder, skip criteria, and a backfill run.

**How to add:**
1. Resolve the database's data source ID via `ntn datasources resolve <database-id>`.
2. Add a new entry to `notion-docs/src/databases.ts` → `DATABASE_CONFIGS` array.
3. Add the corresponding env var (`<DB_NAME>_DATA_SOURCE_ID`) to the deployed worker.
4. Deploy and trigger backfill: `ntn workers sync trigger <key>Backfill`.

---

## Architecturally excluded: Companies + Contacts → Cerebro Sync Worker

**What:** The Companies and Contacts (People) databases are architecturally excluded from direct Hindsight ingest. They are entity rosters — structured records that should be written to Long-Term Memory via the future Cerebro Sync Worker, not fed as raw text to Hindsight.

**Why:**
- Companies and Contacts are **entity masters** — their value is in structured fields (name, role, company, email, relationship status), not in page body text.
- Hindsight's fact extraction works best with narrative/prose content. Feeding it structured roster data would produce low-quality observations ("Alice is at Company X" repeated per row) and waste bank capacity.
- The Cerebro Sync Worker (not yet built) will receive Hindsight webhooks and write structured records to the People and Companies Long-Term Memory DBs. These entity DBs are its natural output, not Hindsight's input.

**When to revisit:** When the Cerebro Sync Worker is built and the LTM write path is operational. At that point, Companies and Contacts flow through: Notion DB → Sync Worker → LTM DBs (People, Companies). Hindsight learns about people and companies indirectly through briefs, docs, and meeting transcripts that mention them.

---

## Tasks DB granularity: per-task vs aggregated briefs

**What:** The Tasks DB is included in Tier 1 as per-task ingest (each task page retained individually to Hindsight). This may be noisy for large task backlogs. Consider per-project aggregation or weekly summary briefs as an alternative.

**Why:** Individual tasks often have minimal body content (just a title and status). Retaining hundreds of sparse task pages may dilute Hindsight's knowledge graph with low-signal entries. The `minContentLength: 20` threshold in the current config filters the emptiest tasks, but dense task backlogs may still produce noise.

**Alternatives to evaluate:**
1. **Per-project aggregation** — group tasks by parent project, generate one brief per project summarizing its active tasks.
2. **Weekly task summaries** — generate one brief per week covering all task status changes.
3. **Status-filtered** — only retain tasks with status changes in the last 30 days (skip stale/completed).

**When to revisit:** After the first backfill run, check Hindsight recall quality for task-related queries. If task recall is noisy, implement one of the alternatives above.

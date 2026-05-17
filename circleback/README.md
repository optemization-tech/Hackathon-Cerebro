# Circleback source worker

Receives Circleback meeting-processed webhooks AND backfills historical meetings
into Short-Term Memory. The per-meeting processing path is shared between both
entry points via [`src/processing.ts`](src/processing.ts).

**Status (2026-05-17, Wave 2):** webhook handler deployed + configured.
Backfill script lives at [`scripts/backfill.ts`](scripts/backfill.ts).

## What the webhook does

1. Circleback POSTs a meeting event to this worker's webhook URL.
2. Worker verifies the HMAC-SHA256 signature against `CIRCLEBACK_WEBHOOK_SECRET`.
3. Extracts meeting metadata (title, start/end, attendees, recording URL) + utterances.
4. Stitches utterances into `[Speaker · hh:mm:ss] text` lines.
5. Applies `clean()` (Glossary normalization) to title + summary + transcript.
6. Writes a `Status: pending` row into Short-Term Memory with `Data Type: Circleback transcript`.
7. Dedup ID: `circleback:<meeting_id>`. Per-invocation query by ID — re-deliveries are no-ops.

## Deploying the worker

```sh
cd circleback
npm install
ntn login                          # one-time
ntn workers deploy                 # deploys worker + creates webhook capability
ntn workers env push               # uploads CIRCLEBACK_WEBHOOK_SECRET, NOTION_API_TOKEN, GLOSSARY_DATA_SOURCE_ID
ntn workers webhook show-url circlebackEvents
```

Paste the URL into the Circleback dashboard → Webhooks. Configure the signature secret to match `CIRCLEBACK_WEBHOOK_SECRET`.

## Backfilling historical meetings

The webhook only catches meetings going forward. To ingest the historical archive:

```sh
# One-time: install + auth the Circleback CLI
npm install -g @circleback/cli
cb login   # browser OAuth flow

# 1. Dump all meetings + transcripts to disk (gitignored)
scripts/fetch-circleback.sh > meetings.json

# 2. Smoke test against the live STM in DRY-RUN mode
NOTION_API_TOKEN=$(op read "op://Optemization Automation/<token-name>/credential") \
  GLOSSARY_DATA_SOURCE_ID=<ds-id> \
  npm run backfill:dry -- --input meetings.json --limit 5

# 3. Confirm the previewed records look right, then go live
NOTION_API_TOKEN=... GLOSSARY_DATA_SOURCE_ID=... \
  npm run backfill -- --input meetings.json

# 4. Re-run to verify idempotency — should be all dedup hits
NOTION_API_TOKEN=... GLOSSARY_DATA_SOURCE_ID=... \
  npm run backfill -- --input meetings.json
```

Flags:

- `--input <path>`: meetings JSON file (or pipe via stdin).
- `--dry-run`: parse + match, but skip Notion writes.
- `--limit N`: process only the first N meetings (useful for smoke tests).
- `--delay-ms N`: sleep between Notion writes (default 250ms).
- `--debug`: log every skip reason.

The script accepts three input shapes:

1. `[{...}, {...}]` — bare meeting array
2. `{ "meetings": [...] }` — wrapped (matches the Circleback CLI list response)
3. `{ ... }` — single meeting object

Each meeting goes through the same `extractMeeting()` → `processMeeting()` path
the webhook uses, so the Glossary normalization, transcript stitching, dedup ID,
and STM property layout are identical.

## Notes

- The Circleback API does not publish a stable webhook payload schema. The parser accepts both `meeting.transcript` and `meeting.utterances` arrays, both CLI-style (`{words, startTimestamp}`) and webhook-style (`{text, start_time}`) utterance fields, and tolerates flattened/nested meeting fields.
- 5 consecutive `WebhookVerificationError` throws short-circuit the worker on the platform side. Redeploy to reset.
- The backfill writes the same `Status: pending` rows the webhook writes, so the future Hindsight Indexer will pick both paths up identically.

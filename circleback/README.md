# Circleback source worker

Receives Circleback meeting-processed webhooks and writes the cleaned transcript into Short-Term Memory.

**Status (2026-05-17, Wave 2):** built, not yet deployed. Webhook URL must be pasted into Circleback's dashboard after `ntn workers deploy`.

## What it does

1. Circleback POSTs a meeting event to this worker's webhook URL.
2. Worker verifies the HMAC-SHA256 signature against `CIRCLEBACK_WEBHOOK_SECRET`.
3. Extracts meeting metadata (title, start/end, attendees, recording URL) + utterances.
4. Stitches utterances into `[Speaker · hh:mm:ss] text` lines.
5. Applies `clean()` (Glossary normalization) to title + summary + transcript.
6. Writes a `Status: pending` row into Short-Term Memory with `Source: Circleback`, `Data Type: Meeting transcript`.
7. Dedup ID: `circleback:<meeting_id>`. Per-invocation query by ID — re-deliveries are no-ops.

## Deploying

```sh
cd circleback
npm install
ntn login                          # one-time
ntn workers deploy                 # deploys worker + creates webhook capability
ntn workers env push               # uploads CIRCLEBACK_WEBHOOK_SECRET, NOTION_API_TOKEN, GLOSSARY_DATA_SOURCE_ID
ntn workers webhook show-url circlebackEvents
```

Paste the URL into the Circleback dashboard → Webhooks. Configure the signature secret to match `CIRCLEBACK_WEBHOOK_SECRET`.

## Notes

- The Circleback API does not publish a stable webhook payload schema. The parser accepts both `meeting.transcript` and `meeting.utterances` arrays and tolerates flattened/nested meeting fields.
- 5 consecutive `WebhookVerificationError` throws short-circuit the worker on the platform side. Redeploy to reset.

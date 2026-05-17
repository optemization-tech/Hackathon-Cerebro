# Slack Source Worker — Cerebro

Generates per-channel-per-day LLM-generated briefs from Slack messages and writes them to Short-Term Memory (STM) in Notion. The Hindsight Indexer Worker (5-min cron) handles `retain()` from STM — this worker never calls Hindsight directly.

**Format B (day-in-the-life narrative)** is the production format, selected after the A/B experiment in Wave 3.

## Architecture

```
Slack API → fetchMessagesInRange → bundleByDay → generateBriefFormatB (Sonnet 4.6)
    → writeBrief → STM (Status: pending) → [Indexer Worker picks up]
```

Per-message ingestion was retired in Wave 4. The worker now produces one brief per channel per day.

## Capabilities

### Syncs

| Key | Schedule | Description |
|-----|----------|-------------|
| `slackDailyBriefs` | Every 24h | Generates yesterday's briefs for all active channels |
| `slackBriefBackfill` | Manual | CLI-triggered backfill; reads `BACKFILL_FROM`/`BACKFILL_TO` env vars |

### Tools (agent-callable)

| Key | Description |
|-----|-------------|
| `backfillRange` | Start a backfill for a date range + channels. Returns `{ runId }` immediately; processing runs async. |
| `regenerateBriefForDay` | Re-generate a single channel-day brief in Format B. Archives the old one first. |
| `getBackfillStatus` | Poll progress of a running backfill by `runId`. Returns `{ total, done, failed, etaSeconds }`. |
| `testAnthropicCall` | Healthcheck — verifies `api.anthropic.com` is reachable from the worker runtime. |

## Environment variables

Set via `ntn workers env set KEY=value`.

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Slack bot token (`xoxb-...`) |
| `NOTION_API_TOKEN` | Yes | Notion internal integration token (`secret_...` or PAT `ntn_...`) |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for brief generation |
| `SLACK_CHANNELS_DATA_SOURCE_ID` | Yes | Data source ID for the Slack Channels DB |
| `GLOSSARY_DATA_SOURCE_ID` | No | Data source ID for Glossary normalization |
| `PEOPLE_DATA_SOURCE_ID` | No | Data source ID for People entity resolution |
| `COMPANIES_DATA_SOURCE_ID` | No | Data source ID for Companies entity resolution |
| `BACKFILL_FROM` | No | Start date for manual backfill sync (default: `2026-01-01`) |
| `BACKFILL_TO` | No | End date for manual backfill sync (default: yesterday PT) |

## Commands

```shell
# Deploy
ntn workers deploy

# Test Anthropic connectivity
ntn workers exec testAnthropicCall -d '{}'

# Generate a single brief
ntn workers exec regenerateBriefForDay -d '{"channelId": "C08LPMGLNQM", "date": "2026-05-16"}'

# Trigger daily briefs manually
ntn workers sync trigger slackDailyBriefs

# Trigger backfill (reads BACKFILL_FROM/BACKFILL_TO env vars)
ntn workers sync trigger slackBriefBackfill

# Check sync health
ntn workers sync status

# View run logs
ntn workers runs list
ntn workers runs logs <runId>
```

## Source modules

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker entry: syncs, tools, orchestration |
| `src/lib/briefs.ts` | LLM prompt templates (Format A + B) and Anthropic client |
| `src/lib/channels.ts` | Reads active channels from the Slack Channels Notion DB |
| `src/lib/messages.ts` | Fetches Slack messages, resolves users, bundles by PT day |
| `src/lib/write-pipeline.ts` | Writes briefs to STM with idempotent dedup |
| `src/cleaning/` | Glossary-based text normalization |

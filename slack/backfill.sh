#!/usr/bin/env bash
# Bounded-range Slack history backfill.
#
# Usage:
#   npm run backfill                              # Full 2026 range (default)
#   npm run backfill -- --since 2026-01-01        # From date to now
#   npm run backfill -- --since 2026-03-01 --until 2026-04-01  # Bounded range
#
# Env vars (alternative to flags):
#   BACKFILL_SINCE=2026-01-01 BACKFILL_UNTIL=2026-05-17 npm run backfill
#
# Requires: ntn CLI authenticated, worker deployed, SLACK_BOT_TOKEN + NOTION_API_TOKEN
# pushed via `ntn workers env push`.

set -euo pipefail

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) export BACKFILL_SINCE="$2"; shift 2 ;;
    --until) export BACKFILL_UNTIL="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -n "${BACKFILL_SINCE:-}" ]] || [[ -n "${BACKFILL_UNTIL:-}" ]]; then
  echo "[backfill] Pushing date-range env vars: BACKFILL_SINCE=${BACKFILL_SINCE:-<unset>} BACKFILL_UNTIL=${BACKFILL_UNTIL:-<unset>}"
  ntn workers env push
fi

echo "[backfill] Triggering slackBackfill sync..."
ntn workers sync trigger slackBackfill

echo "[backfill] Done. Check logs: ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}"

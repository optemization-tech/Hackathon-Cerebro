#!/usr/bin/env bash
# Fetch all of the authenticated Circleback user's meetings (with transcripts +
# metadata) and emit a single JSON array to stdout, ready to pipe into
# backfill.ts. Requires the @circleback/cli tool to be installed and
# authenticated:
#
#   npm install -g @circleback/cli
#   cb login   # browser-based OAuth flow
#
# Usage:
#   scripts/fetch-circleback.sh                  # all meetings
#   scripts/fetch-circleback.sh --from 2024-01-01
#   scripts/fetch-circleback.sh --from 2024-01-01 --to 2026-05-01
#
# Output: a JSON array on stdout. stderr carries progress logs.
#
# Output shape per meeting (matches the Circleback webhook payload as closely
# as the CLI exposes — see support.circleback.ai/en/articles/11014015):
#   { id, linkId, name, createdAt, notes, attendees, transcript: [...] }

set -euo pipefail

if ! command -v cb >/dev/null 2>&1; then
  echo "fetch-circleback.sh: 'cb' (Circleback CLI) not found on PATH" >&2
  echo "Install with: npm install -g @circleback/cli && cb login" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "fetch-circleback.sh: jq is required" >&2
  exit 1
fi

DATE_ARGS=()
HAS_DATE_FILTER=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --from)      DATE_ARGS+=("--from" "$2"); HAS_DATE_FILTER=1; shift 2 ;;
    --to)        DATE_ARGS+=("--to" "$2"); HAS_DATE_FILTER=1; shift 2 ;;
    --last)      DATE_ARGS+=("--last" "$2"); HAS_DATE_FILTER=1; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "fetch-circleback.sh: unknown arg $1" >&2
      exit 1
      ;;
  esac
done

# `cb meetings search` with NO date filter silently returns a small recent
# subset (observed: 9 vs 22 with --from 2010-01-01 on the same account).
# Default to a very old --from so we don't miss historical meetings.
if [[ "$HAS_DATE_FILTER" -eq 0 ]]; then
  DATE_ARGS+=("--from" "2010-01-01")
  echo "fetch-circleback: no date filter passed — defaulting to --from 2010-01-01 (the CLI silently truncates the result set otherwise)" >&2
fi

TMPDIR_FETCH="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_FETCH"' EXIT

echo "fetch-circleback: paginating meeting list..." >&2

PAGE=0
echo "[]" > "$TMPDIR_FETCH/meetings.json"

while :; do
  PAGE_FILE="$TMPDIR_FETCH/page-$PAGE.json"
  if ! cb --json meetings search ${DATE_ARGS[@]+"${DATE_ARGS[@]}"} --page "$PAGE" > "$PAGE_FILE" 2>"$TMPDIR_FETCH/err"; then
    echo "fetch-circleback: cb meetings search failed on page $PAGE:" >&2
    cat "$TMPDIR_FETCH/err" >&2
    exit 1
  fi

  # The CLI emits a bare array (observed shape). Normalize defensively.
  COUNT=$(jq 'if type == "array" then length elif type == "object" then ((.meetings // .results // .items // .data // []) | length) else 0 end' "$PAGE_FILE")
  if [[ "$COUNT" -eq 0 ]]; then
    echo "fetch-circleback: page $PAGE empty — done paginating" >&2
    break
  fi
  echo "fetch-circleback: page $PAGE → $COUNT meeting(s)" >&2

  # Concat into the running list.
  jq -s '
    (.[0] | if type == "array" then . else (.meetings // .results // .items // .data // []) end) +
    (.[1] | if type == "array" then . else (.meetings // .results // .items // .data // []) end)
  ' "$TMPDIR_FETCH/meetings.json" "$PAGE_FILE" > "$TMPDIR_FETCH/meetings.next.json"
  mv "$TMPDIR_FETCH/meetings.next.json" "$TMPDIR_FETCH/meetings.json"

  PAGE=$((PAGE + 1))
  if [[ "$COUNT" -lt 20 ]]; then
    echo "fetch-circleback: partial page (<20) — done paginating" >&2
    break
  fi
done

TOTAL=$(jq 'length' "$TMPDIR_FETCH/meetings.json")
echo "fetch-circleback: collected $TOTAL meeting(s)" >&2

if [[ "$TOTAL" -eq 0 ]]; then
  echo "[]"
  exit 0
fi

echo "fetch-circleback: fetching transcripts in batches of 50..." >&2

# Extract linkIds — that's what 'cb transcripts read' returns as meetingId, so
# matching by linkId makes the downstream merge unambiguous.
jq -r '[ .[] | (.linkId // (.id | tostring)) ] | .[]' "$TMPDIR_FETCH/meetings.json" \
  > "$TMPDIR_FETCH/ids.txt"

echo "[]" > "$TMPDIR_FETCH/transcripts.json"

BATCH=0
split -l 50 "$TMPDIR_FETCH/ids.txt" "$TMPDIR_FETCH/idbatch-"
for f in "$TMPDIR_FETCH"/idbatch-*; do
  BATCH=$((BATCH + 1))
  IDS=()
  while IFS= read -r line; do IDS+=("$line"); done < "$f"
  echo "fetch-circleback: transcript batch $BATCH (${#IDS[@]} ids)" >&2
  if ! cb --json transcripts read "${IDS[@]}" > "$TMPDIR_FETCH/batch.json" 2>"$TMPDIR_FETCH/err"; then
    echo "fetch-circleback: transcripts read failed on batch $BATCH:" >&2
    cat "$TMPDIR_FETCH/err" >&2
    exit 1
  fi
  jq -s '
    (.[0] | if type == "array" then . else (.transcripts // .results // .items // .data // []) end) +
    (.[1] | if type == "array" then . else (.transcripts // .results // .items // .data // []) end)
  ' "$TMPDIR_FETCH/transcripts.json" "$TMPDIR_FETCH/batch.json" > "$TMPDIR_FETCH/transcripts.next.json"
  mv "$TMPDIR_FETCH/transcripts.next.json" "$TMPDIR_FETCH/transcripts.json"
done

T_COUNT=$(jq 'length' "$TMPDIR_FETCH/transcripts.json")
echo "fetch-circleback: collected $T_COUNT transcript record(s)" >&2

# Merge meetings + transcripts. `cb transcripts read` always returns
# `meetingId` set to the linkId (regardless of whether we queried by numeric
# id or linkId), so we key the transcript map by linkId and look up via
# `meeting.linkId`.
jq -s '
  .[0] as $meetings |
  .[1] as $transcripts |
  ($transcripts | map( { (.meetingId | tostring): .transcript } ) | add // {}) as $tx |
  $meetings | map(
    . + {
      transcript: ($tx[ (.linkId // (.id | tostring)) ] // [])
    }
  )
' "$TMPDIR_FETCH/meetings.json" "$TMPDIR_FETCH/transcripts.json"

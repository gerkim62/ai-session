#!/bin/bash
# check-upstream.sh — Compare vendored files against their upstream GitHub sources.
#
# Usage:
#   ./check-upstream.sh              # Check all sources
#   ./check-upstream.sh --diff       # Also download changed files for diff review
#
# Reads upstream-sources.json and queries the GitHub API for current blob SHAs.
# Reports which files have changed upstream since they were extracted.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCES_FILE="$SCRIPT_DIR/upstream-sources.json"
DIFF_DIR="$SCRIPT_DIR/.upstream-diffs"
SHOW_DIFF=false

if [[ "${1:-}" == "--diff" ]]; then
  SHOW_DIFF=true
  mkdir -p "$DIFF_DIR"
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed."
  echo "Install it: sudo apt install jq  OR  brew install jq"
  exit 1
fi

if [[ ! -f "$SOURCES_FILE" ]]; then
  echo "Error: $SOURCES_FILE not found."
  exit 1
fi

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║             Upstream Change Checker                        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

TOTAL=0
CHANGED=0
UNCHANGED=0
SKIPPED=0

COUNT=$(jq '.sources | length' "$SOURCES_FILE")

for i in $(seq 0 $((COUNT - 1))); do
  LOCAL_PATH=$(jq -r ".sources[$i].local_path" "$SOURCES_FILE")
  REPO=$(jq -r ".sources[$i].upstream_repo" "$SOURCES_FILE")
  UPSTREAM_PATH=$(jq -r ".sources[$i].upstream_path" "$SOURCES_FILE")
  COMMIT=$(jq -r ".sources[$i].upstream_commit" "$SOURCES_FILE")
  RECORDED_SHA=$(jq -r ".sources[$i].upstream_blob_sha" "$SOURCES_FILE")

  TOTAL=$((TOTAL + 1))
  printf "  %-35s " "$LOCAL_PATH"

  # Skip entries without a valid blob SHA
  if [[ "$RECORDED_SHA" == "n/a"* ]] || [[ "$RECORDED_SHA" == "null" ]]; then
    echo "⏭  skipped (no blob SHA to compare)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  AUTH_HEADER=()
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    AUTH_HEADER=(-H "Authorization: Bearer $GITHUB_TOKEN")
  elif [[ -n "${GH_TOKEN:-}" ]]; then
    AUTH_HEADER=(-H "Authorization: Bearer $GH_TOKEN")
  fi

  # Query GitHub API for current file info
  API_URL="https://api.github.com/repos/$REPO/contents/$UPSTREAM_PATH"
  HTTP_OUTPUT=$(curl -s -w "\n%{http_code}" "${AUTH_HEADER[@]}" "$API_URL" 2>/dev/null || echo "FETCH_ERROR")
  HTTP_STATUS=$(echo "$HTTP_OUTPUT" | tail -n1)
  RESPONSE=$(echo "$HTTP_OUTPUT" | sed '$d')

  if [[ "$HTTP_STATUS" == "403" ]]; then
    MSG=$(echo "$RESPONSE" | jq -r '.message // empty' 2>/dev/null)
    if [[ "$MSG" == *"rate limit"* ]]; then
      echo "⏳ rate limited by GitHub API (set GITHUB_TOKEN to bypass)"
    else
      echo "⚠  HTTP 403 Forbidden"
    fi
    SKIPPED=$((SKIPPED + 1))
    continue
  elif [[ "$HTTP_STATUS" != "200" ]]; then
    echo "⚠  HTTP $HTTP_STATUS"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  CURRENT_SHA=$(echo "$RESPONSE" | jq -r '.sha // empty' 2>/dev/null)

  if [[ -z "$CURRENT_SHA" ]]; then
    echo "⚠  could not parse SHA from API response"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if [[ "$CURRENT_SHA" == "$RECORDED_SHA" ]]; then
    echo "✅ unchanged"
    UNCHANGED=$((UNCHANGED + 1))
  else
    echo "🔴 CHANGED (was: ${RECORDED_SHA:0:7}  now: ${CURRENT_SHA:0:7})"
    CHANGED=$((CHANGED + 1))

    if [[ "$SHOW_DIFF" == true ]]; then
      DOWNLOAD_URL=$(echo "$RESPONSE" | jq -r '.download_url // empty')
      if [[ -n "$DOWNLOAD_URL" ]]; then
        DIFF_FILE="$DIFF_DIR/$(basename "$UPSTREAM_PATH")"
        curl -sf "$DOWNLOAD_URL" -o "$DIFF_FILE" 2>/dev/null
        echo "           ↳ Downloaded new version to: $DIFF_FILE"
        echo "           ↳ Compare with: diff $LOCAL_PATH $DIFF_FILE"
      fi
    fi
  fi
done

echo ""
echo "─────────────────────────────────────────────────────────────"
echo "  Total: $TOTAL | Unchanged: $UNCHANGED | Changed: $CHANGED | Skipped: $SKIPPED"
echo "─────────────────────────────────────────────────────────────"

if [[ $CHANGED -gt 0 ]]; then
  echo ""
  echo "⚠  $CHANGED file(s) have changed upstream!"
  echo "   Run with --diff to download the new versions for review."
  exit 1
fi

echo ""
echo "✅ All tracked files match their upstream sources."
exit 0

#!/usr/bin/env bash
# Fail only if pyright got WORSE than the committed baseline.
#
# Why a ratchet and not a hard gate: api/ carries pre-existing strict-mode
# errors and zero in any recent module. Gating on zero means CI is red from the
# first commit and everyone learns to ignore it, which is worse than no gate at
# all. Gating on "not worse than today" costs eight lines, catches every new
# error, and lets the number fall naturally as the old ones get cleaned up.
#
# Usage:  bash ops/scripts/pyright-ratchet.sh api
#         bash ops/scripts/pyright-ratchet.sh worker
set -euo pipefail

TREE="${1:?usage: pyright-ratchet.sh <api|worker>}"
cd "$(dirname "$0")/../.."   # repo root

BASELINE_FILE="$TREE/pyright-baseline.txt"
[ -f "$BASELINE_FILE" ] || { echo "::error::missing $BASELINE_FILE"; exit 1; }
BASE="$(tr -d '[:space:]' < "$BASELINE_FILE")"

cd "$TREE"
# `|| true` is load-bearing: pyright exits non-zero whenever it reports an
# error, which under `set -e -o pipefail` would abort this script before it
# could compare anything. A non-zero exit is the NORMAL case for a ratchet.
REPORT="$(uv run pyright --outputjson || true)"
COUNT="$(printf '%s' "$REPORT" | jq '.summary.errorCount')"

if ! [ "$COUNT" -ge 0 ] 2>/dev/null; then
    echo "::error::could not read an error count from pyright in $TREE"
    printf '%s\n' "$REPORT" | tail -20
    exit 1
fi

if [ "$COUNT" -gt "$BASE" ]; then
    echo "::error::pyright errors in $TREE: $COUNT (baseline $BASE). Fix the new ones."
    uv run pyright || true
    exit 1
fi

if [ "$COUNT" -lt "$BASE" ]; then
    echo "::notice::pyright errors in $TREE fell to $COUNT — drop $BASELINE_FILE to $COUNT."
fi

echo "$TREE: $COUNT pyright errors (baseline $BASE) — OK"

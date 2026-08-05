#!/usr/bin/env bash
#
# Inspect and drain a RITHM dead-letter queue.
#
#   ops/scripts/drain-dlq.sh rithm-generation-jobs-dlq            # print only, delete nothing
#   ops/scripts/drain-dlq.sh rithm-generation-jobs-dlq --delete   # print, then delete
#
# READ BEFORE YOU DELETE. A DLQ message is the only surviving record of a failure that
# nothing else logged -- whatever put it there can put another one there on launch day.
# Printing is therefore the default and deleting takes an explicit flag.
#
# The two queues that matter:
#   rithm-generation-jobs-dlq   a job failed 3 SQS receives; the user's track never happened
#   rithm-sns-completions-dlq   a completion never reached the API; the track EXISTS in S3
#                               and the user was never told. The worst of the two.
#
# This deliberately does not use PurgeQueue: purge is all-or-nothing, cannot be undone,
# rate-limits to once a minute, and gives you no chance to look at what you destroyed.

set -euo pipefail

: "${AWS_REGION:=us-east-1}"
: "${AWS_ACCOUNT_ID:=685448855132}"

QUEUE_NAME="${1:-}"
MODE="${2:---print}"

if [[ -z "$QUEUE_NAME" ]]; then
  echo "usage: $0 <queue-name> [--delete]" >&2
  echo "       $0 rithm-generation-jobs-dlq" >&2
  echo "       $0 rithm-sns-completions-dlq --delete" >&2
  exit 1
fi

case "$QUEUE_NAME" in
  *-dlq) ;;
  *) echo "FATAL: '$QUEUE_NAME' is not a DLQ. This script only drains *-dlq queues." >&2
     echo "       Draining a live queue throws away work that has not failed yet." >&2
     exit 1 ;;
esac

DELETE=0
[[ "$MODE" == "--delete" ]] && DELETE=1

for cmd in aws jq; do
  command -v "$cmd" >/dev/null || { echo "FATAL: $cmd not on PATH" >&2; exit 1; }
done

QUEUE_URL="https://sqs.${AWS_REGION}.amazonaws.com/${AWS_ACCOUNT_ID}/${QUEUE_NAME}"

depth() {
  aws sqs get-queue-attributes --region "$AWS_REGION" --queue-url "$QUEUE_URL" \
    --attribute-names ApproximateNumberOfMessages \
    --query 'Attributes.ApproximateNumberOfMessages' --output text
}

before="$(depth)"
echo "queue : $QUEUE_NAME"
echo "depth : $before"
echo "mode  : $([[ $DELETE -eq 1 ]] && echo 'PRINT AND DELETE' || echo 'print only')"
echo

if [[ "$before" == "0" ]]; then
  echo "Nothing to drain."
  exit 0
fi

seen=0
deleted=0
declare -A SEEN_IDS=()

# Long-poll in small batches, deduplicating by MessageId.
#
# Dedup is load-bearing in print mode, not a nicety: a message that is read but not
# deleted becomes visible again when its visibility timeout lapses, so "loop until two
# empty receives" never terminates -- it prints the same three messages forever. Stopping
# on "two rounds that produced no NEW MessageId" is the condition that actually holds for
# both modes. VISIBILITY is set well past the expected run so redelivery does not race the
# loop even on a slow link.
VISIBILITY=120
DEADLINE=$(( SECONDS + 90 ))

stale_rounds=0
while [[ $stale_rounds -lt 2 ]]; do
  if (( SECONDS > DEADLINE )); then
    echo "(stopping: 90s budget reached with $seen message(s) read)" >&2
    break
  fi

  batch="$(aws sqs receive-message --region "$AWS_REGION" --queue-url "$QUEUE_URL" \
    --max-number-of-messages 10 --wait-time-seconds 2 --visibility-timeout "$VISIBILITY" \
    --output json 2>/dev/null || echo '{}')"

  new_in_round=0
  while IFS= read -r msg; do
    [[ -z "$msg" ]] && continue
    mid="$(jq -r '.MessageId' <<<"$msg")"
    [[ -n "${SEEN_IDS[$mid]:-}" ]] && continue
    SEEN_IDS[$mid]=1
    new_in_round=$((new_in_round + 1))

    seen=$((seen + 1))
    body="$(jq -r '.Body' <<<"$msg")"

    echo "--- message $seen ---"
    # SNS-delivered bodies wrap the real payload in a "Message" string field; unwrap it so
    # the failure is readable instead of a JSON string inside a JSON string.
    if jq -e 'has("Message")' >/dev/null 2>&1 <<<"$body"; then
      jq -r '.Message' <<<"$body" | jq '.' 2>/dev/null || jq -r '.Message' <<<"$body"
    else
      jq '.' <<<"$body" 2>/dev/null || echo "$body"
    fi
    echo

    if [[ $DELETE -eq 1 ]]; then
      aws sqs delete-message --region "$AWS_REGION" --queue-url "$QUEUE_URL" \
        --receipt-handle "$(jq -r '.ReceiptHandle' <<<"$msg")"
      deleted=$((deleted + 1))
    fi
  done < <(jq -c '.Messages[]? // empty' <<<"$batch")

  if [[ $new_in_round -eq 0 ]]; then
    stale_rounds=$((stale_rounds + 1))
  else
    stale_rounds=0
  fi
done

echo "read    : $seen"
echo "deleted : $deleted"

if [[ $DELETE -eq 0 ]]; then
  cat <<EOF

Nothing was deleted. Messages return to the queue after their ${VISIBILITY}s visibility
timeout. Re-run with --delete once you have read them.
EOF
else
  sleep 2
  echo "depth now: $(depth)"
fi

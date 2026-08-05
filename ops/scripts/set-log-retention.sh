#!/usr/bin/env bash
#
# Set log retention on every RITHM log group.
#
#   ops/scripts/set-log-retention.sh
#   RETENTION_DAYS=90 ops/scripts/set-log-retention.sh
#
# Why this script exists: every task definition carries "awslogs-create-group": "true",
# and a log group created that way has NO retention policy. It keeps every line forever
# and bills for it forever. Nothing in the deploy path ever sets one, so this is the only
# thing standing between launch and an unbounded CloudWatch Logs line on the invoice.
#
# Idempotent -- put-retention-policy is a straight set, and creating a group that already
# exists is caught and ignored.

set -euo pipefail

: "${AWS_REGION:=us-east-1}"
: "${RETENTION_DAYS:=30}"

LOG_GROUPS=(
  /ecs/rithm-api
  /ecs/rithm-worker
  /ecs/rithm-worker-stub
  /ecs/rithm-api-migrations
)

command -v aws >/dev/null || { echo "FATAL: aws not on PATH" >&2; exit 1; }

# CloudWatch only accepts these values; anything else is an API error that reads like a
# permissions problem.
case "$RETENTION_DAYS" in
  1|3|5|7|14|30|60|90|120|150|180|365|400|545|731|1096|1827|2192|2557|2922|3288|3653) ;;
  *) echo "FATAL: $RETENTION_DAYS is not a valid CloudWatch retention value" >&2; exit 1 ;;
esac

echo "region    : $AWS_REGION"
echo "retention : $RETENTION_DAYS days"
echo

for group in "${LOG_GROUPS[@]}"; do
  printf '  %-30s ' "$group"

  # /ecs/rithm-api-migrations does not exist until the first migration task runs, and the
  # deploy workflow gates the service swap on that task's exit code -- so the group would
  # otherwise be born with no retention on the first real deploy, silently.
  if ! aws logs create-log-group --region "$AWS_REGION" --log-group-name "$group" 2>/dev/null; then
    : # already exists, which is the normal case
  fi

  aws logs put-retention-policy --region "$AWS_REGION" \
    --log-group-name "$group" --retention-in-days "$RETENTION_DAYS"
  echo "ok"
done

echo
aws logs describe-log-groups --region "$AWS_REGION" --log-group-name-prefix /ecs/rithm \
  --query 'logGroups[].{Group:logGroupName,RetentionDays:retentionInDays}' --output table

echo
echo "A null RetentionDays above means 'keep forever'. There should be none."

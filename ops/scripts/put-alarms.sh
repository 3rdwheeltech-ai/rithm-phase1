#!/usr/bin/env bash
#
# Apply ops/cloudwatch/alarms.json to CloudWatch.
#
#   ops/scripts/put-alarms.sh --dry-run    # print every call, touch nothing
#   ops/scripts/put-alarms.sh
#
# Idempotent: put-metric-alarm is upsert-by-name, so re-running changes nothing unless
# alarms.json changed. That is the property that lets this be run from a laptop without
# ceremony, and the reason this is a shell loop rather than a CloudFormation stack --
# eleven resources do not earn a second deployment dialect.
#
# Required (defaults below cover the prod account):
#   ALARM_TOPIC_ARN      SNS topic alarms notify. Create it and CONFIRM the email
#                        subscription first -- an alarm with no subscriber is decoration.
#
# Drain the DLQs BEFORE the first apply. Both currently hold messages from the Day-3/4
# sessions, and alarms that arrive pre-fired teach everyone to ignore them.
#   ops/scripts/drain-dlq.sh rithm-generation-jobs-dlq --print

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ALARMS_FILE="${ALARMS_FILE:-$REPO_ROOT/ops/cloudwatch/alarms.json}"

: "${AWS_REGION:=us-east-1}"
: "${ACESTEP_INSTANCE_ID:=i-0f564ea483fd76435}"
# ALB metric dimensions are the ARN suffix, not the ARN and not the plain name.
: "${TARGET_GROUP_DIM:=targetgroup/rithm-api-tg/f8b10498d2975958}"
: "${LOAD_BALANCER_DIM:=app/rithm-alb/50b47cd3a8c03e28}"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

for cmd in aws jq; do
  command -v "$cmd" >/dev/null || { echo "FATAL: $cmd not on PATH" >&2; exit 1; }
done
[[ -f "$ALARMS_FILE" ]] || { echo "FATAL: no $ALARMS_FILE" >&2; exit 1; }

if [[ -z "${ALARM_TOPIC_ARN:-}" ]]; then
  cat >&2 <<'EOF'
FATAL: ALARM_TOPIC_ARN is unset.

  aws sns create-topic --name rithm-alarms --query TopicArn --output text
  aws sns subscribe --topic-arn <arn> --protocol email --notification-endpoint <you>
  # then CLICK THE CONFIRMATION EMAIL. PendingConfirmation delivers nothing.

  export ALARM_TOPIC_ARN=<arn>
EOF
  exit 1
fi

echo "region        : $AWS_REGION"
echo "alarm topic   : $ALARM_TOPIC_ARN"
echo "acestep box   : $ACESTEP_INSTANCE_ID"
echo "target group  : $TARGET_GROUP_DIM"
echo "load balancer : $LOAD_BALANCER_DIM"
[[ $DRY_RUN -eq 1 ]] && echo "MODE          : DRY RUN"
echo

# Substitute ${VAR} placeholders, then hand each alarm to the CLI as --cli-input-json.
# envsubst is not assumed present (it lives in gettext, absent from slim images), so the
# substitution is done in jq against an explicit allow-list -- which also means a typo'd
# placeholder fails loudly here rather than reaching CloudWatch as a literal "${FOO}".
RENDERED="$(
  jq -c \
    --arg topic "$ALARM_TOPIC_ARN" \
    --arg region "$AWS_REGION" \
    --arg instance "$ACESTEP_INSTANCE_ID" \
    --arg tg "$TARGET_GROUP_DIM" \
    --arg lb "$LOAD_BALANCER_DIM" \
    '
    def subst:
      walk(
        if type == "string" then
          gsub("\\$\\{ALARM_TOPIC_ARN\\}";     $topic)
          | gsub("\\$\\{AWS_REGION\\}";        $region)
          | gsub("\\$\\{ACESTEP_INSTANCE_ID\\}"; $instance)
          | gsub("\\$\\{TARGET_GROUP_DIM\\}";  $tg)
          | gsub("\\$\\{LOAD_BALANCER_DIM\\}"; $lb)
        else . end
      );
    .alarms | subst | .[]
    ' "$ALARMS_FILE"
)"

if grep -q '\${' <<<"$RENDERED"; then
  echo "FATAL: unsubstituted placeholder(s) remain:" >&2
  grep -o '\${[A-Z_]*}' <<<"$RENDERED" | sort -u >&2
  exit 1
fi

applied=0
while IFS= read -r alarm; do
  [[ -z "$alarm" ]] && continue
  name="$(jq -r '.AlarmName' <<<"$alarm")"

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "--- $name"
    jq '.' <<<"$alarm"
    continue
  fi

  printf '  %-34s ' "$name"
  aws cloudwatch put-metric-alarm --region "$AWS_REGION" --cli-input-json "$alarm"
  echo "ok"
  applied=$((applied + 1))
done <<<"$RENDERED"

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "dry run: nothing applied."
  exit 0
fi

echo
echo "$applied alarm(s) applied. Current state:"
aws cloudwatch describe-alarms --region "$AWS_REGION" --alarm-name-prefix rithm- \
  --query 'MetricAlarms[].{Alarm:AlarmName,State:StateValue}' --output table

cat <<'EOF'

INSUFFICIENT_DATA on a DLQ alarm right after apply is normal -- CloudWatch needs one
evaluation period. If it is still INSUFFICIENT_DATA after 10 minutes, the queue has
never published that metric and the dimension name is probably wrong.

Prove one alarm actually reaches a human before calling this done:
  aws cloudwatch set-alarm-state --alarm-name rithm-sns-completions-dlq-depth \
    --state-value ALARM --state-reason "synthetic launch check"
EOF

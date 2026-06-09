#!/usr/bin/env bash
# Runs inside LocalStack container on startup via the init hooks directory.
# Creates all AWS resources needed for local development.
set -euo pipefail

echo "[LocalStack Init] Creating S3 buckets..."
awslocal s3 mb s3://rithm-assets-local
awslocal s3 mb s3://rithm-web-local

echo "[LocalStack Init] Creating SQS queues..."
awslocal sqs create-queue \
  --queue-name rithm-generation-jobs-dlq \
  --attributes MessageRetentionPeriod=1209600

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/rithm-generation-jobs-dlq" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

awslocal sqs create-queue \
  --queue-name rithm-generation-jobs \
  --attributes "{
    \"VisibilityTimeout\": \"300\",
    \"MessageRetentionPeriod\": \"345600\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"
  }"

awslocal sqs create-queue --queue-name rithm-sns-completions-dlq

echo "[LocalStack Init] Creating SNS topics..."
awslocal sns create-topic --name rithm-job-completions
awslocal sns create-topic --name rithm-job-completions-dlq

echo "[LocalStack Init] Done. Resources ready."

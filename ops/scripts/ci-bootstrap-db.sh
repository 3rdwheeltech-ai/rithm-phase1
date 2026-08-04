#!/usr/bin/env bash
# Prepare a throwaway Postgres for the API test suite in CI.
#
# Mirrors the production path exactly: bootstrap SQL creates the schemas, the
# per-module login roles and the shared trigger function; Alembic then creates
# every table. That ordering matters — ops/db/01..05_*.sql contain the SAME DDL
# as the baseline migrations, so running both would collide. On RDS the
# equivalent pair is rds-bootstrap.sql followed by run-migrations.sh.
#
# Usage:  bash ops/scripts/ci-bootstrap-db.sh
# Env:    PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE  (all defaulted below)
set -euo pipefail

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
export PGDATABASE="${PGDATABASE:-rithm-db}"

cd "$(dirname "$0")/../.."   # repo root

echo "=== Waiting for Postgres at $PGHOST:$PGPORT ==="
for _ in $(seq 1 30); do
    if pg_isready -q; then break; fi
    sleep 1
done
pg_isready || { echo "::error::Postgres never became ready"; exit 1; }

echo "=== Schemas, roles and grants (ops/db/00_init.sql) ==="
# ON_ERROR_STOP so a failed CREATE ROLE fails the job instead of leaving a
# half-built database that produces baffling permission errors later.
psql -v ON_ERROR_STOP=1 -q -f ops/db/00_init.sql

echo "=== Migrations (as the superuser, identity first) ==="
# Every module DSN points at the superuser: module roles hold DML privileges
# only and have no CREATE on their own schemas, so a migration run as
# rithm_generation fails with a permission error that reads like a connection
# problem. run-migrations.sh already sequences identity first — do not reorder.
BASE="postgresql+asyncpg://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}"
export DB_IDENTITY_DSN="$BASE"
export DB_CATALOG_DSN="$BASE"
export DB_GENERATION_DSN="$BASE"
export DB_CONVERSATION_DSN="$BASE"
export DB_PERSONALIZATION_DSN="$BASE"
export DB_REQUIRE_SSL=false
export ENVIRONMENT=local
# Settings has no defaults for these three and refuses to construct without
# them; nothing in a migration touches AWS.
export ASSETS_BUCKET="${ASSETS_BUCKET:-rithm-assets-ci}"
export SQS_JOBS_QUEUE_URL="${SQS_JOBS_QUEUE_URL:-http://localhost:4566/000000000000/rithm-generation-jobs}"
export SNS_COMPLETIONS_TOPIC_ARN="${SNS_COMPLETIONS_TOPIC_ARN:-arn:aws:sns:us-east-1:000000000000:rithm-job-completions}"

bash ops/scripts/run-migrations.sh

echo "=== CI database ready ==="

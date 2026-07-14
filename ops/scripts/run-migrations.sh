#!/usr/bin/env bash
# Runs all module Alembic migrations in dependency order.
# Called by:
#   1. GitHub Actions deploy-api.yml (before ECS service update)
#   2. One-off Fargate task in prod for manual migration runs
#   3. Local dev / RDS: `bash ops/scripts/run-migrations.sh`
#
# DSNs come from the environment (source .env.rds.admin for RDS, or rely on
# api/.env locally). Each module keeps its own alembic_version table in its own
# schema, so one master/admin connection applies all five correctly.
set -euo pipefail

MODULES=("identity" "catalog" "generation" "conversation" "personalization")

cd "$(dirname "$0")/../.."    # repo root

echo "=== Running RITHM DB migrations ==="
for module in "${MODULES[@]}"; do
    echo "--- Module: $module ---"
    cd api
    uv run alembic -c "migrations/${module}/alembic.ini" upgrade head
    cd ..
    echo "--- Module $module: OK ---"
done

echo "=== All migrations complete ==="

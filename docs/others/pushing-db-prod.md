# RITHM — RDS Provisioning & DB Deploy Runbook (Phase 0)

**Goal:** stand up a real PostgreSQL 16 database on AWS RDS in `us-east-1`, bootstrap
its schemas/roles, apply all five modules' Alembic migrations, and add a one-flag switch
so you can run the local app against **either** local Docker Postgres (default) **or** RDS
(deliberate), with zero code rewrites.

**Architecture model this enforces**
- **Local Docker Postgres = default dev DB.** Fast loop, safe to wreck.
- **RDS = a deliberately-targeted environment** (your shared dev / future Fargate DB).
  You flip to it with `source .env.rds`, never by accident.
- **One Cognito pool (`rithm-dev`)** is shared by both. Auth users live in Cognito, not
  Postgres. Each Postgres only holds a *mirror* `identity.users` row keyed by `cognito_sub`.
- **Migrations run as the master user; the app runtime uses the restricted module users.**
  (Your restricted roles intentionally lack `CREATE` on their schema — same reason your
  CI overrides the DSNs to `rithm_admin` for the migration step.)

> The DB connection is a direct TCP connection via asyncpg/psycopg2. It does **not** go
> through `AWS_ENDPOINT_URL`. Switching to RDS changes only the 5 DSNs — your boto3
> services (Cognito / SQS / SNS / S3) are completely unaffected.

---

## 0. Prerequisites

- AWS CLI v2 configured for an account/region you control (`aws sts get-caller-identity`).
- `psql` client installed locally (`psql --version`).
- Your repo with the Phase 0 code (`api/app/config.py`, `api/app/shared/db.py`, the five
  `api/migrations/<module>/env.py`, `ops/scripts/run-migrations.sh`, `ops/scripts/init-db-users.sql`).

Set these once in your shell (used by every command below):

```bash
export AWS_REGION=us-east-1
export RDS_ID=rithm-dev
export DB_NAME=rithm
export MASTER_USER=rithm_master
# Generate a strong master password and keep it out of git:
export MASTER_PW="$(openssl rand -base64 24 | tr -d '/+=' )Aa1"
echo "MASTER_PW=$MASTER_PW   # <-- save this somewhere safe NOW"
export MY_IP="$(curl -s https://checkip.amazonaws.com)/32"
echo "Your egress IP: $MY_IP"
```

---

## 1. Networking — VPC, subnet group, security group

RDS needs a DB subnet group spanning **≥2 AZs**. The default VPC has these already.

```bash
# Default VPC + its subnets
export VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[].SubnetId' --output text)

# DB subnet group
aws rds create-db-subnet-group \
  --db-subnet-group-name rithm-dev-subnets \
  --db-subnet-group-description "RITHM dev" \
  --subnet-ids $SUBNETS

# Security group: allow Postgres ONLY from your IP
export SG_ID=$(aws ec2 create-security-group \
  --group-name rithm-rds-dev --description "RITHM RDS dev" \
  --vpc-id $VPC_ID --query GroupId --output text)
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID --protocol tcp --port 5432 --cidr $MY_IP
echo "SG_ID=$SG_ID"
```

> **When your home/office IP changes** (it will), you'll get connection timeouts. Re-run:
> `aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 5432 --cidr "$(curl -s https://checkip.amazonaws.com)/32"`
> (and optionally revoke the stale one).

---

## 2. Create the RDS instance

Pick a valid PG16 minor version (don't hardcode — RDS rejects non-existent minors):

```bash
aws rds describe-db-engine-versions --engine postgres \
  --query "DBEngineVersions[?starts_with(EngineVersion,'16.')].EngineVersion" --output text
# Choose the latest from that list, e.g.:
export PG_VERSION=16.8
```

Create it (Phase-0 sizing: `db.t4g.micro`, 20 GB gp3, single-AZ, encrypted):

```bash
aws rds create-db-instance \
  --db-instance-identifier $RDS_ID \
  --engine postgres --engine-version $PG_VERSION \
  --db-instance-class db.t4g.micro \
  --allocated-storage 20 --storage-type gp3 --storage-encrypted \
  --master-username $MASTER_USER --master-user-password "$MASTER_PW" \
  --db-name $DB_NAME \
  --vpc-security-group-ids $SG_ID \
  --db-subnet-group-name rithm-dev-subnets \
  --publicly-accessible --no-multi-az \
  --backup-retention-period 7 \
  --no-deletion-protection

aws rds wait db-instance-available --db-instance-identifier $RDS_ID

export RDS_HOST=$(aws rds describe-db-instances --db-instance-identifier $RDS_ID \
  --query 'DBInstances[0].Endpoint.Address' --output text)
echo "RDS_HOST=$RDS_HOST"
```

> **Sizing note:** `db.t4g.micro` gives ~110 max connections. Your API uses up to
> `5 modules × (pool_size 5 + overflow 5) = 50` per instance. Fine for dev. Remember
> this ceiling when you size Fargate pools later — don't over-provision.
>
> **Master password handling:** for Phase 0 the env file is acceptable. Before prod,
> recreate with `--manage-master-user-password` (RDS auto-stores it in Secrets Manager)
> and rotate. Don't ever commit `$MASTER_PW`.

---

## 3. One-time DB bootstrap on RDS

Your local Docker auto-runs `init-db-users.sql` from `docker-entrypoint-initdb.d/`.
**RDS has no such hook — you run it once, manually, as the master user.** It must create:
extensions, the `public.touch_updated_at()` trigger fn, the 5 schemas, and the 5 module
roles with **real** (non-dev) passwords.

### 3a. Generate per-module passwords

```bash
for m in identity catalog generation conversation personalization; do
  pw="$(openssl rand -base64 18 | tr -d '/+=')Aa1"
  echo "RITHM_${m^^}_PW=$pw"
done
# Copy these out — you'll paste them into the bootstrap SQL and the .env.rds files.
```

### 3b. Create `ops/scripts/rds-bootstrap.sql`

Copy your existing `init-db-users.sql` to a new file and swap the dev passwords for the
generated ones. It should look like this (passwords filled in):

```sql
-- ops/scripts/rds-bootstrap.sql
-- Run ONCE against RDS as the master user. Mirrors init-db-users.sql but with real PWs.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS generation;
CREATE SCHEMA IF NOT EXISTS conversation;
CREATE SCHEMA IF NOT EXISTS personalization;

DO $$
DECLARE
  modules   TEXT[] := ARRAY['identity','catalog','generation','conversation','personalization'];
  passwords TEXT[] := ARRAY[
    'PASTE_IDENTITY_PW','PASTE_CATALOG_PW','PASTE_GENERATION_PW',
    'PASTE_CONVERSATION_PW','PASTE_PERSONALIZATION_PW'
  ];
  i INT;
BEGIN
  FOR i IN 1..array_length(modules,1) LOOP
    EXECUTE format('CREATE ROLE rithm_%s LOGIN PASSWORD %L', modules[i], passwords[i]);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO rithm_%s', modules[i], modules[i]);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO rithm_%s', modules[i], modules[i]);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO rithm_%s', modules[i], modules[i]);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rithm_%s', modules[i], modules[i]);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO rithm_%s', modules[i], modules[i]);
  END LOOP;
END;
$$;
```

> This is the **same role model as local**: module roles get DML only, **not** `CREATE` on
> the schema. That's deliberate — migrations run as master (Step 6), runtime as these roles.
> `pgcrypto` and `pg_trgm` are both on RDS's supported-extensions list, so `CREATE EXTENSION`
> works. The master user owns the `rithm` DB, so it can create the function in `public`.

### 3c. Run it

```bash
PGPASSWORD="$MASTER_PW" psql \
  "host=$RDS_HOST port=5432 dbname=$DB_NAME user=$MASTER_USER sslmode=require" \
  -v ON_ERROR_STOP=1 -f ops/scripts/rds-bootstrap.sql

# Verify schemas + roles
PGPASSWORD="$MASTER_PW" psql "host=$RDS_HOST dbname=$DB_NAME user=$MASTER_USER sslmode=require" -c "\dn"
PGPASSWORD="$MASTER_PW" psql "host=$RDS_HOST dbname=$DB_NAME user=$MASTER_USER sslmode=require" -c "\du"
```

You should see the 5 schemas and the 5 `rithm_*` roles.

---

## 4. Code changes (3 files + 2 env files)

These are small and additive. They add SSL support keyed off a dedicated flag, so you don't
have to abuse `environment` (which still means `local | prod` for docs/visibility).

### 4a. `api/app/config.py` — add one field

```python
    # Database — one DSN per bounded-context module
    db_identity_dsn: SecretStr
    db_catalog_dsn: SecretStr
    db_generation_dsn: SecretStr
    db_conversation_dsn: SecretStr
    db_personalization_dsn: SecretStr
    db_require_ssl: bool = False          # <-- ADD: true when targeting RDS
```

### 4b. `api/app/shared/db.py` — gate SSL on the new flag

Replace the existing SSL block inside `init_db_engines()`:

```python
        connect_args: dict = {}
        if settings.db_require_ssl:                 # was: settings.environment == "prod"
            connect_args["ssl"] = "require"          # asyncpg: encrypt, no CA verify (fine for dev)
```

> For prod later, swap `"require"` for an `ssl.SSLContext` built from the RDS global CA
> bundle (`verify-full`). For dev, `require` is enough.

### 4c. The five `api/migrations/<module>/env.py` — make Alembic's sync URL SSL-aware

psycopg2 uses `sslmode=` in the URL, **not** asyncpg's `ssl=` connect-arg — so the naive
`DSN.replace("+asyncpg", "")` won't carry SSL. In `run_migrations_online()`, replace the
`engine_from_config(...)` line's URL construction with:

```python
    sync_url = DSN.replace("+asyncpg", "")
    if settings.db_require_ssl and "sslmode=" not in sync_url:
        sync_url += ("&" if "?" in sync_url else "?") + "sslmode=require"

    connectable = engine_from_config(
        {"sqlalchemy.url": sync_url},
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
```

Apply the identical change to all 5 modules (only the surrounding `version_table_schema`
differs per module — leave that as-is).

### 4d. `.env.rds` — app runtime (module users, SSL on)

```bash
# .env.rds  — gitignored. Source this to run the LOCAL app against RDS.
ENVIRONMENT=local
LOG_LEVEL=DEBUG
DB_REQUIRE_SSL=true

DB_IDENTITY_DSN=postgresql+asyncpg://rithm_identity:RITHM_IDENTITY_PW@RDS_HOST:5432/rithm
DB_CATALOG_DSN=postgresql+asyncpg://rithm_catalog:RITHM_CATALOG_PW@RDS_HOST:5432/rithm
DB_GENERATION_DSN=postgresql+asyncpg://rithm_generation:RITHM_GENERATION_PW@RDS_HOST:5432/rithm
DB_CONVERSATION_DSN=postgresql+asyncpg://rithm_conversation:RITHM_CONVERSATION_PW@RDS_HOST:5432/rithm
DB_PERSONALIZATION_DSN=postgresql+asyncpg://rithm_personalization:RITHM_PERSONALIZATION_PW@RDS_HOST:5432/rithm

# Everything else stays as your local values (Cognito real pool, etc.).
# If you keep LocalStack for SQS/SNS/S3, leave AWS_ENDPOINT_URL as-is — RDS is independent.
COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
COGNITO_APP_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
SSE_TOKEN_SECRET=local-dev-secret-not-for-prod
CURRENT_CONSENT_VERSION=tos-2026-05
```

### 4e. `.env.rds.admin` — migrations only (master user)

```bash
# .env.rds.admin  — gitignored. Source this ONLY to run migrations/bootstrap against RDS.
ENVIRONMENT=local
DB_REQUIRE_SSL=true

DB_IDENTITY_DSN=postgresql+asyncpg://rithm_master:MASTER_PW@RDS_HOST:5432/rithm
DB_CATALOG_DSN=postgresql+asyncpg://rithm_master:MASTER_PW@RDS_HOST:5432/rithm
DB_GENERATION_DSN=postgresql+asyncpg://rithm_master:MASTER_PW@RDS_HOST:5432/rithm
DB_CONVERSATION_DSN=postgresql+asyncpg://rithm_master:MASTER_PW@RDS_HOST:5432/rithm
DB_PERSONALIZATION_DSN=postgresql+asyncpg://rithm_master:MASTER_PW@RDS_HOST:5432/rithm
```

Substitute `RDS_HOST`, `MASTER_PW`, and the five module passwords. Then:

```bash
echo ".env.rds"        >> .gitignore
echo ".env.rds.admin"  >> .gitignore
```

> All five DSNs point at `rithm_master` here because migrations are schema-qualified and the
> Alembic version table is per-module (`version_table_schema`), so one master connection
> applies all five correctly. This mirrors what your CI already does with `rithm_admin`.

---

## 5. (Optional) confirm pydantic precedence

`pydantic-settings` resolves **OS env vars above the `.env` file**, so `source`-ing an env
file into your shell cleanly overrides your committed `.env` without editing it:

```bash
set -a; source .env.rds; set +a   # exports all vars; OS env now wins over .env
```

---

## 6. Apply migrations to RDS (as master)

```bash
set -a; source .env.rds.admin; set +a
bash ops/scripts/run-migrations.sh
```

Expected output: each of the 5 modules reports `OK`, ending with `All migrations complete`.

> **If you see `permission denied for schema identity`** — you sourced `.env.rds` (module
> users) instead of `.env.rds.admin` (master). Module users can't `CREATE`. Re-source the
> admin file and rerun.

---

## 7. Run the local app against RDS

Run the API on the host (skip the Docker `postgres` container — you're using RDS now):

```bash
# Fresh terminal recommended (env vars persist in a shell)
set -a; source .env.rds; set +a
cd api && uv run uvicorn app.main:app --reload --port 8080
```

**To go back to local Postgres:** open a new terminal (or `unset` the `DB_*` vars) and use
your normal flow (`docker-compose up` + the api container, or host run with `.env`). Because
`get_settings()` is `lru_cache`'d, switching DBs always means restarting the process — never
expect a live swap.

---

## 8. Verify end-to-end

```bash
# Schemas, tables, and per-module Alembic version tables exist on RDS:
PGPASSWORD="$MASTER_PW" psql "host=$RDS_HOST dbname=$DB_NAME user=$MASTER_USER sslmode=require" <<'SQL'
\dt identity.*
\dt catalog.*
\dt generation.*
\dt conversation.*
\dt personalization.*
SELECT * FROM identity.alembic_version;
SQL

# App healthy against RDS:
curl -s localhost:8080/health   # expect 200

# Auth → mirror-row flow: sign up / log in through your frontend or curl, then:
PGPASSWORD="$MASTER_PW" psql "host=$RDS_HOST dbname=$DB_NAME user=$MASTER_USER sslmode=require" \
  -c "SELECT id, cognito_sub, email, created_at FROM identity.users;"
```

A new `identity.users` row should appear in **RDS** after the first login while pointed at
RDS — even for a user who originally signed up against local Postgres (see §9).

---

## 9. Verify JIT provisioning is idempotent (the shared-Cognito consequence)

Because local and RDS share the `rithm-dev` Cognito pool, a user can authenticate
successfully against Cognito while their mirror row is missing from whichever Postgres you're
pointed at. Your login / `/me` handler must **provision-on-read**, not error. Confirm the
identity handler uses an upsert pattern like:

```sql
INSERT INTO identity.users (id, cognito_sub, email, email_verified)
VALUES (:id, :sub, :email, :verified)
ON CONFLICT (cognito_sub) DO NOTHING;
-- then:
SELECT * FROM identity.users WHERE cognito_sub = :sub;
```

(`id` from `uuid_utils.uuid7()`, never `uuid4`/`gen_random_uuid`.) If instead it 404/500s on
"user not present in DB," fix it to upsert — this is correct behavior regardless of RDS
(covers admin-created users, restored DBs, and DB switches).

**Test it explicitly:** create a brand-new user while pointed at local, confirm the local
row, then restart pointed at RDS and log in as that same user. Login should succeed and a
fresh RDS mirror row should appear.

---

## 10. Hardening / cost / teardown

**Before prod (not now):**
- `publicly-accessible=false` + reach RDS via SSM Session Manager port-forward or Client VPN.
- Custom parameter group with `rds.force_ssl=1` (server-side enforce).
- App SSL → `verify-full` using the RDS global CA bundle.
- Master password via `--manage-master-user-password` (Secrets Manager) + rotation.
- Separate `rithm-prod` Cognito pool and prod RDS; Multi-AZ on.

**Cost (Phase 0):** `db.t4g.micro` ≈ $12–13/mo + 20 GB gp3 ≈ $2/mo. Well inside budget.
Stop it when idle (auto-restarts after 7 days):

```bash
aws rds stop-db-instance  --db-instance-identifier $RDS_ID
aws rds start-db-instance --db-instance-identifier $RDS_ID
```

**Teardown:**

```bash
aws rds delete-db-instance --db-instance-identifier $RDS_ID --skip-final-snapshot
aws rds delete-db-subnet-group --db-subnet-group-name rithm-dev-subnets
aws ec2 delete-security-group --group-id $SG_ID
```

---

## 11. Common pitfalls (fast reference)

| Symptom | Cause | Fix |
|---|---|---|
| `permission denied for schema identity` during migrate | Sourced `.env.rds` (module users) | Source `.env.rds.admin` (master) for migrations |
| Migrations connect but no SSL / `sslmode` ignored | Alembic uses psycopg2 (`sslmode=`), not asyncpg (`ssl=`) | Apply the §4c `sync_url` edit to all 5 `env.py` |
| Connection hangs / times out | Your egress IP changed | Re-`authorize-security-group-ingress` with new `/32` |
| Switched env but app still hits old DB | `get_settings()` is `lru_cache`'d | Restart the process; use a fresh shell |
| "Did switching to RDS break Cognito/SQS?" | It can't — DB is a direct TCP conn | Only the 5 DSNs changed; boto3 paths untouched |
| Login 500s after DB switch | Handler assumes mirror row exists | Make provisioning idempotent (§9) |
| `CREATE EXTENSION` denied | Ran bootstrap as a non-master role | Run `rds-bootstrap.sql` as `rithm_master` |
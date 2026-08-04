"""Alembic env for the 'personalization' module (sync psycopg2; raw-SQL migrations).

Reads this module's DSN from app Settings, converts the async DSN to a sync one
for Alembic, and (when targeting RDS) appends sslmode=require — psycopg2 reads SSL
from the URL, not asyncpg's ssl= connect-arg. target_metadata is None: migrations
are hand-written raw SQL via op.execute(), not ORM autogenerate.
"""

import os
import sys

from alembic import context
from sqlalchemy import engine_from_config, pool

# Make the 'app' package importable (this file lives under api/migrations/).
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from app.config import get_settings  # noqa: E402

config = context.config
settings = get_settings()
DSN = settings.db_personalization_dsn.get_secret_value()


def _sync_url() -> str:
    """asyncpg DSN -> psycopg2 DSN, adding sslmode=require when SSL is on (RDS)."""
    url = DSN.replace("+asyncpg", "")
    if settings.db_require_ssl and "sslmode=" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    return url


def run_migrations_offline() -> None:
    context.configure(
        url=_sync_url(),
        target_metadata=None,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_schemas=True,
        version_table_schema="personalization",
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        {"sqlalchemy.url": _sync_url()},
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=None,
            include_schemas=True,
            version_table_schema="personalization",
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

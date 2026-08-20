"""Alembic environment — async psycopg3, URL from the environment.

Reads KNOWLEDGE_DATABASE_URL (the libpq URL, incl. ?sslmode=disable) directly
from the environment rather than importing Settings, so migrations don't require
the full service config (e.g. OPENROUTER_API_KEY). Only the driver scheme is
swapped to postgresql+psycopg. Migrations are hand-written raw SQL (the pgvector
`vector`/`halfvec` types + the HNSW expression index don't autogenerate cleanly),
so there is no target_metadata.
"""

from __future__ import annotations

import asyncio
import os
from logging.config import fileConfig

from sqlalchemy.ext.asyncio import create_async_engine

from alembic import context

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = None


def _url() -> str:
    url = os.environ.get("KNOWLEDGE_DATABASE_URL", "").strip()
    if not url:
        raise RuntimeError("KNOWLEDGE_DATABASE_URL is not set")
    prefix = "postgresql://"
    if url.startswith(prefix):
        url = "postgresql+psycopg://" + url[len(prefix) :]
    return url


def run_migrations_offline() -> None:
    context.configure(
        url=_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def _do_run(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    engine = create_async_engine(_url())
    async with engine.connect() as connection:
        await connection.run_sync(_do_run)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())

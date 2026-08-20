"""Async SQLAlchemy engine for the pgvector knowledge database.

One engine per process, created in the app lifespan and stored on app.state.db.
psycopg3 is used (not asyncpg) because it accepts the libpq URL — including
``?sslmode=disable`` — unchanged, so ``Settings.knowledge_engine_url`` only swaps
the driver scheme. Embeddings are bound as vector *literals* with an explicit
``::vector`` cast (see app/db/store.py), so no per-connection pgvector adapter
registration is needed and results never carry raw vectors back over the wire.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.config import Settings


def create_knowledge_engine(settings: Settings) -> AsyncEngine:
    """Build the pooled async engine. Caller owns disposal (lifespan)."""
    return create_async_engine(
        settings.knowledge_engine_url,
        pool_size=5,
        max_overflow=5,
        pool_pre_ping=True,   # a container restart shouldn't 500 the next query
        pool_recycle=1800,
    )

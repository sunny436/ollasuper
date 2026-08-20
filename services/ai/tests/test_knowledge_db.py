"""pgvector knowledge store — DB-backed tests.

Gated: these self-skip unless TEST_DATABASE_URL points at a Postgres+pgvector
(>=0.8), so `uv run pytest` stays hermetic/no-network locally. CI runs
`alembic upgrade head` against a pgvector/pgvector:pg16 service, then these.

The load-bearing test is account isolation: a query issued as user A must NEVER
return user B's chunk, even when B's chunk is the globally-nearest vector.
"""

from __future__ import annotations

import os

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.db import store

pytestmark = pytest.mark.db

DIM = 3072


def _vec(hot: int) -> list[float]:
    v = [0.0] * DIM
    v[hot] = 1.0
    return v


@pytest.fixture
async def engine():
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL not set")
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://") :]
    eng = create_async_engine(url)
    try:
        yield eng
    finally:
        async with eng.begin() as conn:
            await conn.execute(text("DELETE FROM files"))  # cascade clears the rest
        await eng.dispose()


async def _seed(eng, file_id: str, user_id: str, hot: int, content: str) -> None:
    await store.persist_ingest(
        eng,
        file_id=file_id,
        user_id=user_id,
        workspace_id="ws",
        filename="f.txt",
        mime_type="text/plain",
        detected_type="text",
        file_size=len(content),
        content_hash=f"{file_id}-hash",
        parser_used="text",
        page_count=None,
        raw_bytes=content.encode(),
        chunks=[
            {
                "chunk_index": 0,
                "content": content,
                "token_count": None,
                "page": None,
                "section": None,
                "source_metadata": {"source": "f.txt"},
                "embedding": _vec(hot),
            }
        ],
        embedding_model="test",
        embedding_dimensions=DIM,
    )


async def test_retrieval_is_account_isolated(engine):
    await _seed(engine, "fileA", "userA", 0, "alpha secret from A")
    await _seed(engine, "fileB", "userB", 1, "bravo secret from B")

    # Query is nearest to B's chunk, but issued as user A.
    rows = await store.retrieve(
        engine,
        user_id="userA",
        query_embedding=_vec(1),
        fetch_k=10,
        embedding_dimensions=DIM,
    )
    assert all(r["file_id"] != "fileB" for r in rows)  # B never leaks to A

    rows_b = await store.retrieve(
        engine,
        user_id="userB",
        query_embedding=_vec(1),
        fetch_k=10,
        embedding_dimensions=DIM,
    )
    assert any(r["file_id"] == "fileB" for r in rows_b)  # B sees their own


async def test_delete_cascades(engine):
    await _seed(engine, "fileC", "userC", 0, "gamma")
    assert await store.delete_by_id(engine, file_id="fileC") is True
    rows = await store.retrieve(
        engine,
        user_id="userC",
        query_embedding=_vec(0),
        fetch_k=10,
        embedding_dimensions=DIM,
    )
    assert rows == []


async def test_reingest_is_idempotent(engine):
    await _seed(engine, "fileD", "userD", 0, "delta v1")
    await _seed(engine, "fileD", "userD", 0, "delta v2")  # same file_id, re-ingest
    rows = await store.retrieve(
        engine,
        user_id="userD",
        query_embedding=_vec(0),
        fetch_k=10,
        embedding_dimensions=DIM,
    )
    mine = [r for r in rows if r["file_id"] == "fileD"]
    assert len(mine) == 1  # delete-then-reinsert, not duplicated
    assert "v2" in mine[0]["content"]

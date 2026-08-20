"""Retrieval SQL/store logic (Tier-1b: real pgvector, deterministic one-hot
vectors — NO network). Extends test_knowledge_db.py to prove tenant filtering,
under-fill resistance, the wrong-model gap, cross-workspace bleed, and stale
re-ingest resurrection. Gated on TEST_DATABASE_URL.
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
            await conn.execute(text("DELETE FROM files"))
        await eng.dispose()


async def _seed(eng, *, file_id, user_id, hot, content, workspace_id="ws",
                model="text-embedding-3-large", content_hash=None):
    await store.persist_ingest(
        eng, file_id=file_id, user_id=user_id, workspace_id=workspace_id,
        filename="f.txt", mime_type="text/plain", detected_type="text",
        file_size=len(content), content_hash=content_hash or f"{file_id}-hash",
        parser_used="text", page_count=None, raw_bytes=content.encode(),
        chunks=[{"chunk_index": 0, "content": content, "token_count": None,
                 "page": None, "section": None,
                 "source_metadata": {"source": "f.txt"}, "embedding": _vec(hot)}],
        embedding_model=model, embedding_dimensions=DIM,
    )


async def test_isolation_holds_with_identical_vectors(engine):
    # Two users, IDENTICAL embedding + identical content-hash. Each must see only
    # their own chunk (tenant filter, not vector distance, decides).
    await _seed(engine, file_id="fA", user_id="uA", hot=0, content="secret-A",
                content_hash="same-hash")
    await _seed(engine, file_id="fB", user_id="uB", hot=0, content="secret-B",
                content_hash="same-hash")
    a = await store.retrieve(engine, user_id="uA", query_embedding=_vec(0),
                             fetch_k=10, embedding_dimensions=DIM)
    assert [r["content"] for r in a] == ["secret-A"]


async def test_no_underfill_among_many_foreign_vectors(engine):
    # One user-A chunk; 60 foreign user-B chunks all NEARER the query. A's query
    # must still return A's chunk (tenant filter + iterative_scan, no under-fill).
    await _seed(engine, file_id="mine", user_id="uA", hot=5, content="MINE")
    for i in range(60):
        await _seed(engine, file_id=f"f{i}", user_id="uB", hot=0,
                    content=f"foreign-{i}", content_hash=f"h{i}")
    rows = await store.retrieve(engine, user_id="uA", query_embedding=_vec(0),
                                fetch_k=10, embedding_dimensions=DIM)
    assert [r["content"] for r in rows] == ["MINE"]
    assert all("foreign" not in r["content"] for r in rows)


async def test_cross_workspace_bleed_same_user(engine):
    # DOCUMENTS the finding: retrieval is user-scoped, so a user's W1 file is
    # returned to a W2-context query (no workspace filter). Red baseline for a
    # future workspace-scoping decision.
    await _seed(engine, file_id="w1f", user_id="uA", hot=0, content="w1-doc",
                workspace_id="W1")
    await _seed(engine, file_id="w2f", user_id="uA", hot=1, content="w2-doc",
                workspace_id="W2", content_hash="w2-hash")
    rows = await store.retrieve(engine, user_id="uA", query_embedding=_vec(0),
                                fetch_k=10, embedding_dimensions=DIM)
    got = {r["content"] for r in rows}
    assert "w1-doc" in got and "w2-doc" in got  # both workspaces bleed together


async def test_wrong_model_vectors_filtered(engine):
    # Two chunks, same user, DIFFERENT embedding_model, same dim. Without a model
    # arg, both come back (back-compat); WITH embedding_model, only the current
    # model's vectors are compared — cross-model cosine is meaningless.
    await _seed(engine, file_id="cur", user_id="uA", hot=0, content="current-model",
                model="text-embedding-3-large")
    await _seed(engine, file_id="old", user_id="uA", hot=1, content="stale-model",
                model="some-old-model", content_hash="old-hash")
    both = await store.retrieve(engine, user_id="uA", query_embedding=_vec(0),
                                fetch_k=10, embedding_dimensions=DIM)
    assert {r["content"] for r in both} == {"current-model", "stale-model"}
    filtered = await store.retrieve(engine, user_id="uA", query_embedding=_vec(0),
                                    fetch_k=10, embedding_dimensions=DIM,
                                    embedding_model="text-embedding-3-large")
    assert {r["content"] for r in filtered} == {"current-model"}


async def test_stale_reingest_after_delete_resurrects(engine):
    # DOCUMENTS the resurrection risk: a delete followed by a late/duplicate
    # persist (e.g. an in-flight ingest landing after the purge) re-creates the
    # chunks. Nothing tombstones the id.
    await _seed(engine, file_id="z", user_id="uA", hot=0, content="zombie")
    assert await store.delete_by_id(engine, file_id="z") is True
    empty = await store.retrieve(engine, user_id="uA", query_embedding=_vec(0),
                                 fetch_k=10, embedding_dimensions=DIM)
    assert empty == []
    await _seed(engine, file_id="z", user_id="uA", hot=0, content="zombie")  # late
    back = await store.retrieve(engine, user_id="uA", query_embedding=_vec(0),
                                fetch_k=10, embedding_dimensions=DIM)
    assert [r["content"] for r in back] == ["zombie"]  # resurrected

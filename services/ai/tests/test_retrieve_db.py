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


# ---- Phase 5: file_ids scoping (selected files) ------------------------------
async def test_file_ids_narrows_to_selected(engine):
    await _seed(engine, file_id="fX", user_id="uA", hot=0, content="docX")
    await _seed(engine, file_id="fY", user_id="uA", hot=1, content="docY")
    # Unfiltered: both of the user's files are candidates.
    both = await store.retrieve(
        engine, user_id="uA", query_embedding=_vec(0), fetch_k=10,
        embedding_dimensions=DIM,
    )
    assert {r["file_id"] for r in both} == {"fX", "fY"}
    # Narrowed to fY only.
    only_y = await store.retrieve(
        engine, user_id="uA", query_embedding=_vec(0), fetch_k=10,
        embedding_dimensions=DIM, file_ids=["fY"],
    )
    assert [r["file_id"] for r in only_y] == ["fY"]


async def test_file_ids_cannot_cross_user(engine):
    # fB belongs to uB. uA asking for file_ids=["fB"] gets nothing — the user_id
    # clause is unconditional, so a foreign/selected file id can never leak.
    await _seed(engine, file_id="fA", user_id="uA", hot=0, content="mine")
    await _seed(engine, file_id="fB", user_id="uB", hot=0, content="theirs")
    got = await store.retrieve(
        engine, user_id="uA", query_embedding=_vec(0), fetch_k=10,
        embedding_dimensions=DIM, file_ids=["fB"],
    )
    assert got == []


async def test_file_ids_none_is_unfiltered(engine):
    await _seed(engine, file_id="fX", user_id="uA", hot=0, content="docX")
    a = await store.retrieve(
        engine, user_id="uA", query_embedding=_vec(0), fetch_k=10,
        embedding_dimensions=DIM, file_ids=None,
    )
    assert [r["file_id"] for r in a] == ["fX"]


# --- Phase 3: Project-scoped retrieval -------------------------------------
#
# Project membership lives in Convex; what reaches Postgres is a resolved list of
# file ids. So the DB-level proof is: an EMPTY list must narrow to nothing, and a
# populated list must narrow to exactly itself — even when every competing chunk
# belongs to the SAME user and is vectorially identical. user_id alone cannot
# make these pass, which is the whole point.


async def test_empty_scope_returns_nothing_even_though_user_has_files(engine):
    # THE headline invariant. uA owns two indexed files; a Project with no files
    # resolves to file_ids=[] and must retrieve NOTHING.
    #
    # This is the exact shape of the old bug: `if file_ids` was falsy for [], the
    # clause was dropped, and the query widened to the user's entire corpus.
    await _seed(engine, file_id="fA1", user_id="uA", hot=0, content="doc-A1")
    await _seed(engine, file_id="fA2", user_id="uA", hot=0, content="doc-A2",
                content_hash="a2-hash")
    got = await store.retrieve(
        engine, user_id="uA", query_embedding=_vec(0), fetch_k=10,
        embedding_dimensions=DIM, file_ids=[],
    )
    assert got == []


async def test_same_user_project_isolation_with_identical_vectors(engine):
    # ONE user, TWO Projects. Identical embeddings and identical filenames, so
    # neither the tenant filter nor vector distance can separate them — only the
    # resolved Project scope can.
    await _seed(engine, file_id="projA-file", user_id="uA", hot=0,
                content="ALPHA project secret")
    await _seed(engine, file_id="projB-file", user_id="uA", hot=0,
                content="BETA project secret", content_hash="b-hash")

    a = await store.retrieve(
        engine, user_id="uA", query_embedding=_vec(0), fetch_k=10,
        embedding_dimensions=DIM, file_ids=["projA-file"],
    )
    assert [r["content"] for r in a] == ["ALPHA project secret"]

    b = await store.retrieve(
        engine, user_id="uA", query_embedding=_vec(0), fetch_k=10,
        embedding_dimensions=DIM, file_ids=["projB-file"],
    )
    assert [r["content"] for r in b] == ["BETA project secret"]


async def test_scope_cannot_be_widened_to_another_project_of_the_same_user(engine):
    # A caller that somehow supplied Project B's file id while operating in
    # Project A gets B's content ONLY if it is in the resolved scope. The scope
    # is authoritative; asking for a file outside it returns nothing extra.
    await _seed(engine, file_id="pA", user_id="uA", hot=0, content="A-only")
    await _seed(engine, file_id="pB", user_id="uA", hot=0, content="B-only",
                content_hash="pb-hash")
    got = await store.retrieve(
        engine, user_id="uA", query_embedding=_vec(0), fetch_k=10,
        embedding_dimensions=DIM, file_ids=["pA"],
    )
    assert [r["content"] for r in got] == ["A-only"]
    assert all("B-only" not in r["content"] for r in got)


async def test_project_scope_survives_a_crowd_of_the_users_own_chunks(engine):
    # 40 same-user chunks all NEARER the query than the Project's one file. The
    # Project scope must still return exactly its own chunk — proving the
    # narrowing happens in the query, not by ranking luck.
    await _seed(engine, file_id="proj", user_id="uA", hot=5, content="PROJECT-DOC")
    for i in range(40):
        await _seed(engine, file_id=f"noise{i}", user_id="uA", hot=0,
                    content=f"noise-{i}", content_hash=f"n{i}")
    rows = await store.retrieve(
        engine, user_id="uA", query_embedding=_vec(0), fetch_k=10,
        embedding_dimensions=DIM, file_ids=["proj"],
    )
    assert [r["content"] for r in rows] == ["PROJECT-DOC"]

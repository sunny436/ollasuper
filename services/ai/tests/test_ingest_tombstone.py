"""Deletion cannot be undone by a running ingestion (audit F-13).

The audit's repro: the ingestion paused after fetching the bytes, DELETE ran
and returned success (nothing persisted yet), then the ingestion resumed and
wrote the document and its chunks back — with no Convex row left to clean them
up. Here the same interleaving runs through the real `run_ingest` and the real
DELETE handler, over a fake store that honours the SQL contract (tombstone +
persist under one per-file lock). The DB-backed proof of that contract lives in
test_knowledge_db.py (runs in CI against real pgvector).
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.db import store
from app.ingest import embed as embedmod
from app.ingest import pipeline
from app.routers import files as files_router
from app.runtime.registry import Registry
from tests.conftest import make_settings

pytestmark = pytest.mark.anyio

SETTINGS = make_settings("http://localhost:9999")


class _FakeStore:
    """The tombstone contract, in memory: delete records the id FIRST, and
    persist refuses a tombstoned id (both under the same lock in SQL)."""

    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}
        self.tombstones: set[str] = set()

    async def persist_ingest(self, engine, *, file_id, **kw):
        if file_id in self.tombstones:
            raise store.IngestDeleted(file_id)
        self.rows[file_id] = kw
        return len(kw.get("chunks") or [])

    async def delete_by_id(self, engine, *, file_id):
        self.tombstones.add(file_id)
        return self.rows.pop(file_id, None) is not None


class _Convex:
    def __init__(self, gate: asyncio.Event) -> None:
        self.gate = gate
        self.fetched = asyncio.Event()
        self.statuses: list[tuple] = []

    async def fetch_ingest_file(self, ingest_id):
        self.fetched.set()
        await self.gate.wait()  # "the task paused after receiving the bytes"
        return b"hello world, a plain text document", "text/plain"

    async def set_file_progress(self, *a, **k):
        return None

    async def set_file_status(self, ingest_id, status, **kw):
        self.statuses.append((ingest_id, status))


@pytest.fixture
def fake_store(monkeypatch):
    fs = _FakeStore()
    monkeypatch.setattr(pipeline.store, "persist_ingest", fs.persist_ingest)
    monkeypatch.setattr(pipeline.store, "delete_by_id", fs.delete_by_id)

    async def fake_embed(settings, texts, progress_cb=None):
        return [[0.0] for _ in texts]

    monkeypatch.setattr(embedmod, "embed_documents", fake_embed)
    return fs


async def test_delete_during_ingestion_is_final(fake_store):
    gate = asyncio.Event()
    convex = _Convex(gate)
    registry = Registry(max_per_user=4, max_global=8)
    registry.acquire("ing-1", "u1")

    async def run():
        try:
            await pipeline.run_ingest(
                ingest_id="ing-1",
                user_id="u1",
                workspace_id="w1",
                name="a.txt",
                content_type="text/plain",
                engine=object(),
                convex=convex,
                settings=SETTINGS,
            )
        finally:
            registry.release("ing-1")

    task = asyncio.create_task(run())
    registry.attach("ing-1", task)
    await convex.fetched.wait()

    # DELETE /v1/ingest/ing-1 through the real handler.
    state = SimpleNamespace(db=object(), ingest_registry=registry)
    request = SimpleNamespace(app=SimpleNamespace(state=state))
    res = await files_router.purge("ing-1", request)
    assert res["ok"] is True

    gate.set()  # the paused worker resumes
    await asyncio.wait({task}, timeout=5)

    assert "ing-1" not in fake_store.rows, "the deleted document was written back"
    assert not registry.has("ing-1")
    assert ("ing-1", "ready") not in convex.statuses


async def test_a_late_worker_is_refused_by_the_tombstone_alone(fake_store):
    """No in-process task to cancel (a restart, a retry): the durable
    tombstone is what refuses the write."""
    await fake_store.delete_by_id(object(), file_id="ing-2")
    gate = asyncio.Event()
    gate.set()
    convex = _Convex(gate)
    await pipeline.run_ingest(
        ingest_id="ing-2",
        user_id="u1",
        workspace_id="w1",
        name="a.txt",
        content_type="text/plain",
        engine=object(),
        convex=convex,
        settings=SETTINGS,
    )
    assert "ing-2" not in fake_store.rows
    # A refused persist is not a "failed" file either: the row is gone.
    assert convex.statuses == []


async def test_an_undeleted_ingestion_still_completes(fake_store):
    gate = asyncio.Event()
    gate.set()
    convex = _Convex(gate)
    await pipeline.run_ingest(
        ingest_id="ing-3",
        user_id="u1",
        workspace_id="w1",
        name="a.txt",
        content_type="text/plain",
        engine=object(),
        convex=convex,
        settings=SETTINGS,
    )
    assert "ing-3" in fake_store.rows
    assert ("ing-3", "ready") in convex.statuses

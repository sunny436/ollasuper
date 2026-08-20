"""Retrieval floor + recall-safety-net fallback (hermetic: no network/DB)."""

from __future__ import annotations

from app.ingest import retrieve
from tests.conftest import make_settings

SETTINGS = make_settings("http://localhost:9999")
QUERY = "a long enough natural language question here"


async def _run(monkeypatch, rows):
    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        return rows

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)
    return await retrieve.retrieve_context(
        SETTINGS, object(), user_id="u", query=QUERY
    )


async def test_floor_keeps_relevant_drops_far(monkeypatch):
    rows = [{"distance": 0.30, "content": "a"}, {"distance": 0.90, "content": "b"}]
    kept = await _run(monkeypatch, rows)
    assert [r["content"] for r in kept] == ["a"]


async def test_fallback_keeps_best_when_meta_query_dilutes(monkeypatch):
    # Nothing clears the 0.65 floor, but the rank-1 chunk (0.75) is within the
    # 0.80 fallback ceiling — the nimbus.json case measured in production.
    rows = [
        {"distance": 0.75, "content": "owner=Priya"},
        {"distance": 0.83, "content": "x"},
    ]
    kept = await _run(monkeypatch, rows)
    assert [r["content"] for r in kept] == ["owner=Priya"]


async def test_fallback_skips_when_all_irrelevant(monkeypatch):
    rows = [{"distance": 0.85, "content": "x"}, {"distance": 0.92, "content": "y"}]
    kept = await _run(monkeypatch, rows)
    assert kept == []

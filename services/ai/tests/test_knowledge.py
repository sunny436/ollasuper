"""Phase 5 — the RAG capability boundary (hermetic).

Mirrors test_retrieve.py: monkeypatch `retrieve.embed.embed_query` +
`retrieve.store.retrieve` so no DB/network is touched, then drive
`retrieve_knowledge` and assert the stable RetrievalResult contract + that
`file_ids` reaches store.retrieve.
"""

from __future__ import annotations

from app.agent import knowledge
from app.ingest import retrieve
from tests.conftest import make_settings

SETTINGS = make_settings("http://localhost:9999")
LONG_QUERY = "what does my employee policy say about annual leave"


def _row(
    fid: str, content: str, *, page=None, source="policy.pdf", distance=0.2
) -> dict:
    return {
        "file_id": fid,
        "content": content,
        "source_metadata": {"source": source},
        "page": page,
        "section": None,
        "distance": distance,
    }


async def _run(monkeypatch, rows, *, query=LONG_QUERY):
    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        return rows

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)
    return await knowledge.retrieve_knowledge(
        SETTINGS, object(), user_id="u", query=query
    )


async def test_hit_builds_result_and_block(monkeypatch):
    rows = [_row("f1", "Annual leave is 25 days.", page=3)]
    res = await _run(monkeypatch, rows)
    assert res.status == "ok"
    assert res.block and "retrieved_context" in res.block and res.tokens > 0
    assert len(res.chunks) == 1
    c = res.chunks[0]
    assert c.file_id == "f1" and c.filename == "policy.pdf" and c.page == 3


async def test_empty_is_no_results(monkeypatch):
    res = await _run(monkeypatch, [])
    assert res.status == "no_results" and res.block == "" and res.tokens == 0
    assert res.chunks == []


async def test_short_query_gates_without_touching_store(monkeypatch):
    called = {"n": 0}

    async def fake_embed(settings, q):
        called["n"] += 1
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        called["n"] += 1
        return []

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)
    res = await knowledge.retrieve_knowledge(
        SETTINGS, object(), user_id="u", query="hi"
    )
    assert res.status == "no_results" and called["n"] == 0  # short-query gate


async def test_file_ids_is_passed_through_to_store(monkeypatch):
    cap: dict = {}

    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        cap.update(kw)
        return [_row("f1", "x")]

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)
    await knowledge.retrieve_knowledge(
        SETTINGS, object(), user_id="u", query=LONG_QUERY, file_ids=["f1", "f2"]
    )
    assert cap["file_ids"] == ["f1", "f2"]
    assert cap["user_id"] == "u"  # user scope always present


def test_tool_spec_is_query_only():
    fn = knowledge.KNOWLEDGE_TOOL_SPEC["function"]
    assert fn["name"] == "search_knowledge"
    assert list(fn["parameters"]["properties"]) == ["query"]
    assert fn["parameters"]["required"] == ["query"]

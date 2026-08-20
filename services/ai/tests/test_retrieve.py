"""Retrieval filter/fallback logic (Tier-1a: hermetic — no network, no DB).

Monkeypatches embed + store, so these prove the pure retrieval MECHANICS of
`retrieve_context`: the similarity floor, the rank-1 recall fallback, the
short-query gate, and top_k truncation. Deterministic → CI regression gate.
"""

from __future__ import annotations

from app.ingest import retrieve
from tests.conftest import make_settings

SETTINGS = make_settings("http://localhost:9999")
LONG_QUERY = "a long enough natural language question here"


async def _run(monkeypatch, rows, query=LONG_QUERY):
    """Return (kept, store_called). store_called reveals whether the gate ran
    retrieval at all (the short-query gate must short-circuit before store)."""
    called = {"store": False}

    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        called["store"] = True
        return rows

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)
    kept = await retrieve.retrieve_context(
        SETTINGS, object(), user_id="u", query=query
    )
    return kept, called["store"]


# --- floor + fallback -------------------------------------------------------

async def test_floor_keeps_relevant_drops_far(monkeypatch):
    rows = [{"distance": 0.30, "content": "a"}, {"distance": 0.90, "content": "b"}]
    kept, _ = await _run(monkeypatch, rows)
    assert [r["content"] for r in kept] == ["a"]


async def test_fallback_keeps_best_when_meta_query_dilutes(monkeypatch):
    # Nothing clears the 0.65 floor, but rank-1 (0.75) is within the 0.80
    # fallback ceiling — the nimbus.json case measured in production.
    rows = [
        {"distance": 0.75, "content": "owner=Priya"},
        {"distance": 0.83, "content": "x"},
    ]
    kept, _ = await _run(monkeypatch, rows)
    assert [r["content"] for r in kept] == ["owner=Priya"]


async def test_fallback_skips_when_all_irrelevant(monkeypatch):
    rows = [{"distance": 0.85, "content": "x"}, {"distance": 0.92, "content": "y"}]
    kept, _ = await _run(monkeypatch, rows)
    assert kept == []


async def test_fallback_keeps_topn_within_ceiling(monkeypatch):
    # The top-N (3) fallback keeps the CORRECT rank-2 chunk (0.78) that the old
    # rank-1-only fallback dropped — the nimbus/meta case measured at rank-2/0.787.
    rows = [
        {"distance": 0.76, "content": "junk-rank1"},
        {"distance": 0.78, "content": "correct-rank2"},
        {"distance": 0.95, "content": "far"},  # beyond the 0.80 ceiling, dropped
    ]
    kept, _ = await _run(monkeypatch, rows)
    contents = [r["content"] for r in kept]
    assert "correct-rank2" in contents  # no longer lost
    assert "far" not in contents  # ceiling still excludes genuinely-far chunks


async def test_top_k_truncates(monkeypatch):
    rows = [{"distance": 0.10 + i * 0.01, "content": str(i)} for i in range(10)]
    kept, _ = await _run(monkeypatch, rows)
    assert len(kept) == SETTINGS.ai_rag_top_k  # 6


# --- short-query gate (the NEW finding) ------------------------------------

async def test_short_query_questions_now_retrieve(monkeypatch):
    # With ai_rag_min_query_chars lowered to 4, real short questions retrieve
    # instead of being silently skipped (measured: recall 0.69 -> 0.92,
    # short-query recall 0.00 -> 1.00).
    perfect = [{"distance": 0.05, "content": "The owner is Priya Sharma"}]
    for q in ("Owner?", "Deadline?", "Budget?", "Summarize it."):
        kept, store_called = await _run(monkeypatch, perfect, query=q)
        assert store_called is True, f"real short query {q!r} should retrieve"
        assert [r["content"] for r in kept] == ["The owner is Priya Sharma"]


async def test_trivial_acknowledgements_still_gated(monkeypatch):
    # Truly trivial turns (< 4 chars) still skip retrieval — no wasted embed.
    perfect = [{"distance": 0.05, "content": "x"}]
    for q in ("hi", "ok", "no"):
        kept, store_called = await _run(monkeypatch, perfect, query=q)
        assert kept == [] and store_called is False


async def test_min_query_boundary(monkeypatch):
    perfect = [{"distance": 0.05, "content": "hit"}]
    n = SETTINGS.ai_rag_min_query_chars  # 4
    kept_below, called_below = await _run(monkeypatch, perfect, query="x" * (n - 1))
    assert kept_below == [] and called_below is False
    kept_at, called_at = await _run(monkeypatch, perfect, query="x" * n)
    assert [r["content"] for r in kept_at] == ["hit"] and called_at is True

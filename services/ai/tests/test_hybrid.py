"""Tier-1a: hybrid fusion, exact-token extraction, rerank parse+fallback, and
parent expansion — pure logic, hermetic (no network/DB)."""

from __future__ import annotations

from langchain_core.messages import AIMessage

from app.ingest import rerank as rk
from app.ingest import retrieve as rc
from tests.conftest import make_settings

S = make_settings("http://localhost:9999")


def _row(fid, ci, dist=None, content=""):
    return {"file_id": fid, "chunk_index": ci, "distance": dist, "content": content}


# --- exact-token extraction (drives the trigram/ILIKE keyword path) ---------

def test_exact_tokens_picks_ids_numbers_codes():
    toks = rc._exact_tokens("What is invoice INV-928374 for project XJ-204?")
    assert "INV-928374" in toks and "XJ-204" in toks


def test_exact_tokens_picks_pure_numbers():
    assert "928374" in rc._exact_tokens("show me 928374")


def test_exact_tokens_ignores_plain_words():
    assert rc._exact_tokens("when is the project deadline") == []


# --- Reciprocal Rank Fusion -------------------------------------------------

def test_rrf_rewards_agreement_across_lists():
    vec = [_row("a", 0, 0.2), _row("b", 0, 0.3), _row("c", 0, 0.4)]
    kw = [_row("c", 0), _row("a", 0)]  # keyword agrees on c and a
    fused = rc._rrf_fuse([vec, kw], 60)
    keys = [(r["file_id"], r["chunk_index"]) for r in fused]
    assert keys[0] in {("a", 0), ("c", 0)}  # agreed items rise
    assert ("b", 0) in keys  # vector-only item still present


def test_rrf_surfaces_keyword_only_hit():
    vec = [_row("a", 0, 0.2)]
    kw = [_row("z", 5)]  # exact-ID hit the vector search missed
    fused = rc._rrf_fuse([vec, kw], 60)
    assert ("z", 5) in [(r["file_id"], r["chunk_index"]) for r in fused]


def test_rrf_keeps_vector_row_with_distance():
    fused = rc._rrf_fuse([[_row("a", 0, 0.2)], [_row("a", 0)]], 60)
    assert len(fused) == 1 and fused[0]["distance"] == 0.2  # distance preserved


# --- rerank parse robustness + safe fallback --------------------------------

def test_parse_order_valid_and_filtered():
    assert rk._parse_order("[3,1,2]", 3) == [3, 1, 2]
    assert rk._parse_order("ranking: [2, 9, 2, 1]", 3) == [2, 1]  # 9 oob, dup gone
    assert rk._parse_order("no array here", 3) is None


async def test_rerank_reorders_then_fallback(monkeypatch):
    cands = [_row("a", 0, content="alpha"), _row("b", 0, content="bravo"),
             _row("c", 0, content="charlie")]

    class _LLM:
        def __init__(self, c):
            self._c = c

        async def ainvoke(self, _m):
            return AIMessage(content=self._c)

    # model says passage 3 then 1 are relevant -> c, a, then dropped b appended
    monkeypatch.setattr(rk, "build_llm", lambda *a, **k: _LLM("[3,1]"))
    out = await rk.rerank(S, "q", cands)
    assert [r["file_id"] for r in out] == ["c", "a", "b"]

    # malformed -> input unchanged
    monkeypatch.setattr(rk, "build_llm", lambda *a, **k: _LLM("garbage"))
    assert await rk.rerank(S, "q", cands) == cands

    # raising -> input unchanged (never breaks RAG)
    def _boom(*a, **k):
        raise RuntimeError("provider down")

    monkeypatch.setattr(rk, "build_llm", _boom)
    assert await rk.rerank(S, "q", cands) == cands


# --- parent expansion: bounded, merged, deduped -----------------------------

async def test_expand_children_merges_and_bounds(monkeypatch):
    s = make_settings("http://x", ai_rag_expand_window=1, ai_rag_expand_max_children=2)
    top = [_row("f1", 5, 0.2), _row("f1", 6, 0.3), _row("f2", 0, 0.4)]

    async def fake_expand(engine, *, user_id, file_id, chunk_index, window):
        lo, hi = chunk_index - window, chunk_index + window
        return [_row(file_id, i) for i in range(lo, hi + 1)]

    monkeypatch.setattr(rc.store, "expand", fake_expand)
    out = await rc._expand_children(s, object(), "u", top)
    keys = [(r["file_id"], r["chunk_index"]) for r in out]
    # f1 children 5 and 6 both expand (windows 4-6 and 5-7) -> merged unique 4,5,6,7
    assert keys[:4] == [("f1", 4), ("f1", 5), ("f1", 6), ("f1", 7)]
    assert len(keys) == len(set(keys))  # deduped
    # only first 2 children expanded; f2 passed through as-is (not expanded)
    assert ("f2", 0) in keys and ("f2", -1) not in keys

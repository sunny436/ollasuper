"""Phase 5 — the executor's `search_knowledge` RAG branch.

Real DeltaWriter over RecordingConvex; retrieval faked by monkeypatching the
existing `retrieve.embed.embed_query` + `retrieve.store.retrieve` (no DB). Proves
the branch emits TOOL_CALL/CITATION/TOOL_RESULT, pairs every call, keeps the
block verbatim, takes user_id from ctx (never args), and fails safe.
"""

from __future__ import annotations

import asyncio
import json

from langchain_core.messages import ToolMessage

from app.agent.executor import RagContext, ToolExecContext, execute_tool_calls
from app.agent.knowledge import KNOWLEDGE_TOOL_NAME
from app.agent.policy import READ_SCOPE
from app.ingest import retrieve
from app.runtime.writer import DeltaWriter
from tests.conftest import make_settings
from tests.test_writer_events import RecordingConvex


def _row(fid, content, *, page=None, source="policy.pdf", distance=0.2):
    return {
        "file_id": fid,
        "content": content,
        "source_metadata": {"source": source},
        "page": page,
        "section": None,
        "distance": distance,
    }


def _patch_retrieve(monkeypatch, rows, *, capture=None, exc=None, delay=0.0):
    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        if capture is not None:
            capture.update(kw)
        if delay:
            await asyncio.sleep(delay)
        if exc is not None:
            raise exc
        return rows

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)


def _ctx(**rag_over):
    s = make_settings("http://x", **rag_over.pop("settings_over", {}))
    convex = RecordingConvex()
    writer = DeltaWriter(convex, "s1", s)
    ctx = ToolExecContext(
        registry=None,
        adapter=None,
        writer=writer,
        scope=READ_SCOPE,
        name_to_tool_id={},
        result_max_chars=8000,
        default_timeout_s=30.0,
        rag=RagContext(engine=object(), user_id="u", settings=s, **rag_over),
    )
    return ctx, convex


def _tc(query, cid="c1", **extra):
    return {"name": KNOWLEDGE_TOOL_NAME, "args": {"query": query, **extra}, "id": cid}


def _events(convex, etype):
    out = []
    for c in convex.calls:
        if c.get("op") == "event":
            for e in c["events"]:
                if e["type"] == etype:
                    out.append(json.loads(e["payload"]))
    return out


async def test_hit_emits_events_and_verbatim_block(monkeypatch):
    _patch_retrieve(monkeypatch, [_row("f1", "Leave is 25 days.", page=3)])
    ctx, convex = _ctx()
    msgs = await execute_tool_calls([_tc("annual leave?")], ctx)
    assert len(msgs) == 1 and isinstance(msgs[0], ToolMessage)
    assert msgs[0].tool_call_id == "c1" and msgs[0].status == "success"
    # Block verbatim: opening AND closing sentinels intact (not _bounded).
    assert msgs[0].content.startswith("<retrieved_context>")
    assert msgs[0].content.rstrip().endswith("</retrieved_context>")
    assert _events(convex, "TOOL_CALL") and _events(convex, "TOOL_RESULT")
    cites = _events(convex, "CITATION")
    assert len(cites) == 1 and cites[0]["title"] == "policy.pdf p.3"
    assert cites[0]["source_id"] == "f1"


async def test_citation_deduped_per_file(monkeypatch):
    rows = [
        _row("f1", "a", page=1),
        _row("f1", "b", page=2),  # same file
        _row("f2", "c", source="handbook.pdf"),
    ]
    _patch_retrieve(monkeypatch, rows)
    ctx, convex = _ctx()
    await execute_tool_calls([_tc("leave policy")], ctx)
    cites = _events(convex, "CITATION")
    assert {c["source_id"] for c in cites} == {"f1", "f2"}  # one per distinct file


async def test_empty_is_success_no_results_no_citation(monkeypatch):
    _patch_retrieve(monkeypatch, [])
    ctx, convex = _ctx()
    msgs = await execute_tool_calls([_tc("leave policy")], ctx)
    assert msgs[0].status == "success"  # NOT error — anti-fabrication
    body = json.loads(msgs[0].content)
    assert body["status"] == "no_results"
    assert _events(convex, "CITATION") == []  # never cite what wasn't retrieved


async def test_user_id_comes_from_ctx_not_args(monkeypatch):
    cap: dict = {}
    _patch_retrieve(monkeypatch, [_row("f1", "x")], capture=cap)
    ctx, convex = _ctx()
    # Malicious args try to widen scope; they must be ignored.
    await execute_tool_calls(
        [_tc("leave policy", user_id="attacker", workspace_id="other")], ctx
    )
    assert cap["user_id"] == "u"  # the authenticated ctx value, not "attacker"


async def test_error_is_safe(monkeypatch):
    _patch_retrieve(monkeypatch, [], exc=RuntimeError("db down: host=secret"))
    ctx, convex = _ctx()
    msgs = await execute_tool_calls([_tc("leave policy")], ctx)
    assert msgs[0].status == "error"
    body = json.loads(msgs[0].content)
    assert body["status"] == "error" and "secret" not in body["message"]


async def test_timeout_is_safe(monkeypatch):
    _patch_retrieve(monkeypatch, [_row("f1", "x")], delay=0.05)
    ctx, convex = _ctx(settings_over={"ai_rag_deadline_ms": 1})  # 1ms deadline
    msgs = await execute_tool_calls([_tc("leave policy")], ctx)
    assert msgs[0].status == "error"
    assert json.loads(msgs[0].content)["status"] == "timeout"


async def test_missing_query_is_error(monkeypatch):
    _patch_retrieve(monkeypatch, [_row("f1", "x")])
    ctx, convex = _ctx()
    msgs = await execute_tool_calls(
        [{"name": KNOWLEDGE_TOOL_NAME, "args": {}, "id": "c1"}], ctx
    )
    assert msgs[0].status == "error" and msgs[0].tool_call_id == "c1"


async def test_duplicate_query_not_re_run(monkeypatch):
    cap = {"n": 0}

    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        cap["n"] += 1
        return [_row("f1", "x")]

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)
    ctx, convex = _ctx()
    msgs = await execute_tool_calls([_tc("same", "c1"), _tc("same", "c2")], ctx)
    assert cap["n"] == 1  # executed once
    assert [m.tool_call_id for m in msgs] == ["c1", "c2"]  # both paired


async def test_cancel_skips_but_pairs(monkeypatch):
    _patch_retrieve(monkeypatch, [_row("f1", "x")])
    ctx, convex = _ctx()
    ctx.writer._cancel_requested = True
    msgs = await execute_tool_calls([_tc("leave policy")], ctx)
    assert msgs[0].tool_call_id == "c1"
    assert json.loads(msgs[0].content)["status"] == "cancelled"


async def test_rag_only_ctx_unknown_tool_does_not_crash(monkeypatch):
    # registry/adapter are None (RAG-only turn); a non-knowledge tool is unknown.
    _patch_retrieve(monkeypatch, [])
    ctx, convex = _ctx()
    msgs = await execute_tool_calls(
        [{"name": "some_web_tool", "args": {}, "id": "c1"}], ctx
    )
    assert msgs[0].status == "error" and "unknown tool" in msgs[0].content

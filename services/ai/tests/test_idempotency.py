"""Phase 2 — idempotency / at-most-once / write-ahead / resume classification.

Executor-level tests use the real OllagraphAdapter over httpx.MockTransport + a
real DeltaWriter over RecordingConvex (which reports `persisted:true` for a live
event write). Resume tests drive run_generation with a FakeLLM. No network.
"""

from __future__ import annotations

import json

import httpx
from langchain_core.messages import AIMessage

from app.agent.executor import ToolExecContext, execute_tool_calls
from app.agent.policy import READ_SCOPE, WRITE_SCOPE
from app.clients.ollagraph import OllagraphAdapter
from app.config import Settings
from app.models.chat import AttemptedTool, CompletedTool
from app.models.execution import ExecutionState
from app.models.tools import SideEffect, ToolPermissions
from app.runtime.runner import run_generation
from app.runtime.writer import DeltaWriter
from app.tools.registry import ToolRegistry
from tests.test_agent_executor import _read_tool, _tc
from tests.test_durable import FakeLLM, _req, _web_tool
from tests.test_writer_events import RecordingConvex

KEY = "osk_testkey_abcdefgh1234"


def _settings(**over) -> Settings:
    base = dict(ollagraph_base_url="https://api.ollagraph.test", ollagraph_api_key=KEY)
    base.update(over)
    return Settings(**base)


def _side_tool(**over):
    """A SIDE-EFFECTING tool that ALLOWs under WRITE_SCOPE (approval_required is
    left False so it executes rather than parking)."""
    base = dict(
        side_effect=SideEffect.EXTERNAL_SIDE_EFFECT,
        permissions=ToolPermissions(required_permissions=["ollagraph:read"]),
    )
    base.update(over)
    return _read_tool(**base)


def _ctx(handler, tools, *, scope=READ_SCOPE, retries=0, resp=None):
    s = _settings()
    reg = ToolRegistry()
    for t in tools:
        reg.register(t)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    ctx = ToolExecContext(
        registry=reg,
        adapter=OllagraphAdapter(s, client),
        writer=DeltaWriter(RecordingConvex(resp), "s1", s),
        scope=scope,
        name_to_tool_id={t.tool_id: t.tool_id for t in tools},
        result_max_chars=8000,
        default_timeout_s=5.0,
        tool_max_retries=retries,
        tool_retry_base_s=0.001,
        run_id="run1",
    )
    return ctx, ctx.writer._convex, client


def _events(convex, etype):
    out = []
    for c in convex.calls:
        if c.get("op") == "event":
            for e in c["events"]:
                if e["type"] == etype:
                    out.append(json.loads(e["payload"]))
    return out


def _state(convex, etype="TOOL_RESULT"):
    evs = _events(convex, etype)
    return evs[-1]["state"] if evs else None


# --- write-ahead ----------------------------------------------------------
async def test_side_effecting_success_when_write_ahead_lands():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(200, json={"data": {"ok": True}})

    ctx, convex, client = _ctx(handler, [_side_tool()], scope=WRITE_SCOPE)
    try:
        await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert calls["n"] == 1
    assert _state(convex) == "succeeded"


async def test_write_ahead_abort_when_not_persisted():
    # The intent could not be durably recorded -> a side-effecting call must NOT
    # fire (a stopped/finalized stream must not trigger a fresh effect).
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(200, json={"data": {"ok": True}})

    # resp with persisted:false -> RecordingConvex won't override it.
    ctx, convex, client = _ctx(
        handler,
        [_side_tool()],
        scope=WRITE_SCOPE,
        resp={"ok": True, "persisted": False},
    )
    try:
        msgs = await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert calls["n"] == 0  # never fired
    assert json.loads(msgs[0].content)["error"] == "aborted"
    assert _state(convex) == "failed"


async def test_read_only_ignores_write_ahead():
    # A read-only tool executes even if the event write is not durable.
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(200, json={"hits": []})

    ctx, convex, client = _ctx(
        handler, [_read_tool()], resp={"ok": True, "persisted": False}
    )
    try:
        await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert calls["n"] == 1  # read-only is unaffected by the write-ahead


# --- at-most-once retry-gating --------------------------------------------
async def test_side_effecting_timeout_is_not_retried_indeterminate():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        raise httpx.ReadTimeout("slow", request=req)

    ctx, convex, client = _ctx(
        handler, [_side_tool()], scope=WRITE_SCOPE, retries=3
    )
    try:
        await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert calls["n"] == 1  # NOT retried despite retries=3 (at-most-once)
    assert _state(convex) == "indeterminate"


async def test_read_only_timeout_is_retried():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        raise httpx.ReadTimeout("slow", request=req)

    ctx, convex, client = _ctx(handler, [_read_tool()], retries=2)
    try:
        await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert calls["n"] == 3  # 1 + 2 retries
    assert _state(convex) == "timed_out"


async def test_provider_idempotent_side_effecting_timeout_is_retried():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        raise httpx.ReadTimeout("slow", request=req)

    tool = _side_tool(provider_idempotency_supported=True)
    ctx, convex, client = _ctx(handler, [tool], scope=WRITE_SCOPE, retries=2)
    try:
        await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert calls["n"] == 3  # provider dedups the retry -> safe to retry


async def test_malformed_side_effecting_is_indeterminate():
    # A 2xx with an unparseable body: the side effect DID happen -> INDETERMINATE,
    # never FAILED (which would imply nothing happened).
    def handler(req):
        return httpx.Response(
            200, content=b"not json", headers={"content-type": "text/plain"}
        )

    ctx, convex, client = _ctx(handler, [_side_tool()], scope=WRITE_SCOPE)
    try:
        await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert _state(convex) == "indeterminate"


async def test_retry_ambiguous_side_effects_policy_override():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        raise httpx.ReadTimeout("slow", request=req)

    ctx, convex, client = _ctx(
        handler, [_side_tool()], scope=WRITE_SCOPE, retries=2
    )
    ctx.retry_ambiguous_side_effects = True  # explicit opt-in
    try:
        await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert calls["n"] == 3  # policy allows the retry


# --- dedup: ever-seen-set (side-effecting) vs last-args (read-only) --------
async def test_side_effecting_ever_seen_set_blocks_a_x_a_y_a_x():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(200, json={"data": {"ok": True}})

    ctx, convex, client = _ctx(handler, [_side_tool()], scope=WRITE_SCOPE)
    try:
        await execute_tool_calls(
            [
                _tc("search_web", {"q": "x"}, "c1"),
                _tc("search_web", {"q": "y"}, "c2"),
                _tc("search_web", {"q": "x"}, "c3"),  # repeat of x after y
            ],
            ctx,
        )
    finally:
        await client.aclose()
    assert calls["n"] == 2  # x, y — the 2nd x is DEDUPED (at-most-once)
    assert ExecutionState.DEDUPED in {e.state for e in ctx.ledger.all()}


async def test_read_only_last_args_allows_a_x_a_y_a_x():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(200, json={"hits": []})

    ctx, convex, client = _ctx(handler, [_read_tool()])
    try:
        await execute_tool_calls(
            [
                _tc("search_web", {"q": "x"}, "c1"),
                _tc("search_web", {"q": "y"}, "c2"),
                _tc("search_web", {"q": "x"}, "c3"),
            ],
            ctx,
        )
    finally:
        await client.aclose()
    assert calls["n"] == 3  # read-only: the 2nd x re-runs (harmless)


async def test_adjacent_duplicate_deduped_side_effecting():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(200, json={"data": {"ok": True}})

    ctx, convex, client = _ctx(handler, [_side_tool()], scope=WRITE_SCOPE)
    try:
        await execute_tool_calls(
            [_tc("search_web", {"q": "x"}, "c1"), _tc("search_web", {"q": "x"}, "c2")],
            ctx,
        )
    finally:
        await client.aclose()
    assert calls["n"] == 1  # A(x),A(x) -> the 2nd is a duplicate


# --- provider idempotency key (dormant mechanism) -------------------------
async def test_idempotency_key_sent_only_when_supported():
    seen = {}

    def handler(req):
        seen["key"] = req.headers.get("idempotency-key")
        return httpx.Response(200, json={"data": {"ok": True}})

    tool = _side_tool(provider_idempotency_supported=True)
    ctx, convex, client = _ctx(handler, [tool], scope=WRITE_SCOPE)
    try:
        await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert seen["key"]  # a stable execution_id was sent


async def test_idempotency_key_absent_when_not_supported():
    seen = {"key": "sentinel"}

    def handler(req):
        seen["key"] = req.headers.get("idempotency-key")
        return httpx.Response(200, json={"data": {"ok": True}})

    ctx, convex, client = _ctx(handler, [_side_tool()], scope=WRITE_SCOPE)
    try:
        await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert seen["key"] is None  # Ollagraph default: no key


# --- golden event-shape contract (Python emitter <-> TS resume parser) ----
async def test_golden_event_shape_contract():
    # collectCompletedTools (stream.ts) parses exactly these keys. If the emitter
    # drops one, resume silently breaks — so pin the wire shape here.
    def handler(req):
        return httpx.Response(200, json={"data": {"ok": True}})

    ctx, convex, client = _ctx(handler, [_side_tool()], scope=WRITE_SCOPE)
    try:
        await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    call = _events(convex, "TOOL_CALL")[0]
    res = _events(convex, "TOOL_RESULT")[0]
    assert {"call_id", "tool_id", "arguments", "status", "side_effect"} <= set(call)
    assert call["side_effect"] == "external_side_effect"
    assert {"call_id", "status", "state"} <= set(res)
    assert res["state"] == "succeeded"


# --- resume: attempted tools are never re-executed ------------------------
def _patch_rag(monkeypatch):
    from app.ingest import retrieve

    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        return []

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)


async def test_resume_attempted_tool_is_not_re_executed(monkeypatch):
    _patch_rag(monkeypatch)
    tc = {"name": "search_web", "args": {"q": "cats"}, "id": "c1"}
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain"),
            [AIMessage(content="", tool_calls=[tc]), AIMessage(content="done")],
        ),
    )
    settings = _settings(ai_agent_enabled=True, ai_agent_side_effect_enabled=True)
    reg = ToolRegistry()
    reg.register(_web_tool())
    adapter_calls = {"n": 0}

    def handler(req):
        adapter_calls["n"] += 1
        return httpx.Response(200, json={"hits": ["a"]})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    convex = RecordingConvex()
    from app.tools.selection import ToolSelector

    req = _req(
        "search cats",
        attempt=1,
        eventSeqBaseline=5,
        attemptedTools=[AttemptedTool(toolId="search_web", args={"q": "cats"})],
    )
    try:
        await run_generation(
            req,
            settings,
            convex,
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    # The attempted (unknown-outcome) tool was NOT re-executed on resume.
    assert adapter_calls["n"] == 0
    finals = [c for c in convex.calls if c.get("op") == "finalize"]
    assert finals and finals[0]["status"] == "done"


async def test_resume_completed_and_attempted_discount_budget(monkeypatch):
    # Sanity: a resume carrying both lists rebuilds and finishes without error.
    _patch_rag(monkeypatch)
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="final"), [AIMessage(content="final")]
        ),
    )
    settings = _settings(ai_agent_enabled=True, ai_agent_side_effect_enabled=True)
    reg = ToolRegistry()
    reg.register(_web_tool())
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={}))
    )
    convex = RecordingConvex()
    from app.tools.selection import ToolSelector

    req = _req(
        "resume",
        attempt=2,
        completedTools=[
            CompletedTool(toolId="search_web", args={"q": "1"}, resultContent="{}")
        ],
        attemptedTools=[AttemptedTool(toolId="search_web", args={"q": "2"})],
        eventSeqBaseline=9,
    )
    try:
        await run_generation(
            req, settings, convex,
            tool_registry=reg, tool_selector=ToolSelector(reg), ollagraph_http=http,
        )
    finally:
        await http.aclose()
    finals = [c for c in convex.calls if c.get("op") == "finalize"]
    assert finals and finals[0]["status"] == "done"

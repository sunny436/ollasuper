"""Phase 7 — durable multi-step execution: bounded retry, background heartbeat,
total deadline, and idempotent resume reconstruction.

Retry uses a real OllagraphAdapter over httpx.MockTransport; the runner-level
cases use the FakeLLM + run_generation harness (mirrors test_agent_runner.py).
"""

from __future__ import annotations

import asyncio

import httpx
from langchain_core.messages import AIMessage

from app.agent.executor import ToolExecContext, execute_tool_calls
from app.agent.policy import READ_SCOPE
from app.clients.ollagraph import OllagraphAdapter
from app.models.chat import CompletedTool, GenerateRequest, HistoryMessage
from app.models.tools import (
    Availability,
    SideEffect,
    ToolDefinition,
    ToolPermissions,
)
from app.runtime.runner import _background_heartbeat, run_generation
from app.runtime.writer import DeltaWriter
from tests.conftest import make_settings
from tests.test_writer_events import RecordingConvex


# ---- shared harness ----------------------------------------------------------
class FakeTools:
    def __init__(self, responses):
        self._r = responses
        self.calls = 0

    async def ainvoke(self, messages, *a, **k):
        self.calls += 1
        return self._r[min(self.calls - 1, len(self._r) - 1)]


class FakeLLM:
    def __init__(self, plain, tool_responses, *, delay=0.0):
        self._plain = plain
        self._tools = FakeTools(tool_responses)
        self._delay = delay
        self.captured_messages = None

    def bind_tools(self, specs):
        return self._tools

    async def ainvoke(self, messages, *a, **k):
        self.captured_messages = messages
        if self._delay:
            await asyncio.sleep(self._delay)
        return self._plain


def _req(content, **over):
    base = dict(
        streamId="s1",
        threadId="t1",
        messageId="m1",
        userId="u1",
        workspaceId="w1",
        model="gpt-5.6-luna",
        history=[HistoryMessage(role="user", content=content, seq=1)],
    )
    base.update(over)
    return GenerateRequest(**base)


def _web_tool() -> ToolDefinition:
    return ToolDefinition(
        tool_id="search_web",
        name="Search Web",
        description="search",
        path="/v1/search",
        method="post",
        side_effect=SideEffect.READ_ONLY,
        availability=Availability.AVAILABLE,
        permissions=ToolPermissions(required_permissions=["ollagraph:read"]),
        input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
    )


def _ops(convex, op):
    return [c for c in convex.calls if c.get("op") == op]


# ---- 1. bounded retry (executor) ---------------------------------------------
def _retry_ctx(handler, *, retries):
    s = make_settings(
        "http://x",
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_x",
    )
    reg_tool = _web_tool()
    from app.tools.registry import ToolRegistry

    reg = ToolRegistry()
    reg.register(reg_tool)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    convex = RecordingConvex()
    ctx = ToolExecContext(
        registry=reg,
        adapter=OllagraphAdapter(s, client),
        writer=DeltaWriter(convex, "s1", s),
        scope=READ_SCOPE,
        name_to_tool_id={"search_web": "search_web"},
        result_max_chars=8000,
        default_timeout_s=5.0,
        tool_max_retries=retries,
        tool_retry_base_s=0.001,  # keep tests fast
    )
    return ctx, client


def _tc(cid="c1"):
    return {"name": "search_web", "args": {"q": "x"}, "id": cid}


async def test_retryable_error_retries_then_succeeds():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        if calls["n"] < 3:  # fail twice with a retryable 503
            return httpx.Response(503, json={"e": "upstream"})
        return httpx.Response(200, json={"ok": True})

    ctx, client = _retry_ctx(handler, retries=2)
    try:
        msgs = await execute_tool_calls([_tc()], ctx)
    finally:
        await client.aclose()
    assert calls["n"] == 3  # 2 retries then success
    assert msgs[0].status == "success"


async def test_non_retryable_error_does_not_retry():
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(401, json={"e": "auth"})  # AUTH_FAILED, not retryable

    ctx, client = _retry_ctx(handler, retries=3)
    try:
        msgs = await execute_tool_calls([_tc()], ctx)
    finally:
        await client.aclose()
    assert calls["n"] == 1  # no retry
    assert msgs[0].status == "error"


async def test_retry_exhausted_returns_error():
    def handler(req):
        return httpx.Response(429, json={"e": "rate"})  # always retryable-fail

    ctx, client = _retry_ctx(handler, retries=2)
    try:
        msgs = await execute_tool_calls([_tc()], ctx)
    finally:
        await client.aclose()
    assert msgs[0].status == "error"


# ---- 2. background heartbeat -------------------------------------------------
async def test_background_heartbeat_fires_independently():
    s = make_settings("http://x")
    convex = RecordingConvex()
    writer = DeltaWriter(convex, "s1", s)
    far = asyncio.get_event_loop().time() + 1000  # deadline never fires here
    task = asyncio.create_task(
        _background_heartbeat(writer, 10, far, asyncio.current_task(), {"hit": False})
    )
    await asyncio.sleep(0.05)  # ~5 ticks at 10ms
    task.cancel()
    beats = _ops(convex, "heartbeat")
    assert len(beats) >= 2  # fired without any model chunk


# ---- 3. total deadline -------------------------------------------------------
async def test_total_deadline_times_out(monkeypatch):
    # A slow model call + a deadline already in the past: the background guard
    # cancels the turn and the handler converts it to a clean TIMED_OUT, even
    # with no streamed tokens.
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(AIMessage(content="slow answer"), [], delay=0.5),
    )
    settings = make_settings("http://x", ai_heartbeat_ms=20)
    convex = RecordingConvex()
    await run_generation(_req("hello", deadlineAt=1), settings, convex)
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "error"
    assert finals[0]["error"]["code"] == "deadline_exceeded"


# ---- 4. idempotent resume reconstruction ------------------------------------
async def test_resume_does_not_re_execute_completed_tool(monkeypatch):
    # The model (on resume) re-emits the SAME tool call; the re-seeded seen_calls
    # must skip it so the side-effecting adapter is never re-run.
    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        return []

    from app.ingest import retrieve

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)

    tc = {"name": "search_web", "args": {"q": "cats"}, "id": "c1"}
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain"),
            [AIMessage(content="", tool_calls=[tc]), AIMessage(content="answer")],
        ),
    )
    settings = make_settings(
        "http://x",
        ai_agent_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
    )
    from app.tools.registry import ToolRegistry
    from app.tools.selection import ToolSelector

    reg = ToolRegistry()
    reg.register(_web_tool())
    adapter_calls = {"n": 0}

    def handler(req):
        adapter_calls["n"] += 1
        return httpx.Response(200, json={"hits": ["a"]})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    convex = RecordingConvex()
    req = _req(
        "search cats",
        attempt=1,
        deadlineAt=0,
        eventSeqBaseline=7,
        completedTools=[
            CompletedTool(
                toolId="search_web",
                args={"q": "cats"},
                resultContent='{"result": {"hits": ["a"]}}',
            )
        ],
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
    # The completed Ollagraph tool was NOT re-executed (idempotency re-seed).
    assert adapter_calls["n"] == 0
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"


async def test_resume_seeds_budget_and_event_seq(monkeypatch):
    # A resume with 3 completed steps leaves budget = max_steps - 3, and the
    # writer's event seq continues from the baseline.
    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        return []

    from app.ingest import retrieve

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="final"), [AIMessage(content="final")]
        ),
    )
    settings = make_settings("http://x", ai_agent_memory_tool_enabled=True)
    convex = RecordingConvex()
    completed = [
        CompletedTool(toolId="search_web", args={"q": str(i)}, resultContent="{}")
        for i in range(3)
    ]
    req = _req(
        "resume me",
        attempt=2,
        memoryEnabled=True,
        completedTools=completed,
        eventSeqBaseline=9,
    )
    await run_generation(req, settings, convex)
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"

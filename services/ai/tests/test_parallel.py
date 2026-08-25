"""Phase 7 — parallel tool execution.

Covers the required scenarios at the executor/scheduler level: A/B/C run
concurrently (proven with an async transport that measures peak simultaneity),
duplicate parallel calls are at-most-once (the await-free dedup race is closed),
partial failure keeps exact per-execution state, a batch needing approval pauses
before any concurrency, cancellation reaches queued calls, retries are per-call,
and the write-ahead records RUNNING before each side effect. The A->B / A,B->C
dependency model is the graph loop (existing test_agent_graph multi-step tests);
one A,B->C step trace is asserted here too.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
from langchain_core.messages import AIMessage, HumanMessage

from app.agent.executor import ToolExecContext, execute_tool_calls
from app.agent.graph import build_graph
from app.agent.policy import READ_SCOPE, WRITE_SCOPE
from app.clients.ollagraph import OllagraphAdapter
from app.models.tools import SideEffect, ToolPermissions
from app.runtime.writer import DeltaWriter
from app.tools.registry import ToolRegistry
from tests.test_agent_executor import _read_tool, _settings, _tc
from tests.test_agent_graph import FakeAdapter, ScriptedLLM
from tests.test_writer_events import RecordingConvex

pytestmark = pytest.mark.anyio


def _pctx(handler_or_transport, tools, *, concurrency=4, scope=READ_SCOPE, retries=0):
    s = _settings()
    reg = ToolRegistry()
    for t in tools:
        reg.register(t)
    transport = (
        handler_or_transport
        if isinstance(handler_or_transport, httpx.AsyncBaseTransport)
        else httpx.MockTransport(handler_or_transport)
    )
    client = httpx.AsyncClient(transport=transport)
    adapter = OllagraphAdapter(s, client)
    convex = RecordingConvex()
    writer = DeltaWriter(convex, "s1", s)
    ctx = ToolExecContext(
        registry=reg,
        adapter=adapter,
        writer=writer,
        scope=scope,
        name_to_tool_id={t.tool_id: t.tool_id for t in tools},
        result_max_chars=8000,
        default_timeout_s=30.0,
        tool_max_retries=retries,
        max_concurrent_tools=concurrency,
    )
    return ctx, convex, client


def _tools(*ids):
    return [_read_tool(tool_id=i, name=i) for i in ids]


def _exec_states(convex, state):
    return [
        c
        for c in convex.calls
        if c.get("op") == "execution" and c.get("state") == state
    ]


# --- concurrency proof ----------------------------------------------------
class _PeakTransport(httpx.AsyncBaseTransport):
    """Measures the PEAK number of simultaneously in-flight requests — proves the
    calls actually overlap (a sync MockTransport cannot)."""

    def __init__(self, hold: float = 0.03) -> None:
        self.current = 0
        self.peak = 0
        self.total = 0
        self._hold = hold

    async def handle_async_request(self, request):
        self.current += 1
        self.total += 1
        self.peak = max(self.peak, self.current)
        await asyncio.sleep(self._hold)  # hold open so siblings can overlap
        self.current -= 1
        return httpx.Response(200, json={"data": {"ok": True}})


async def test_abc_run_concurrently():
    t = _PeakTransport()
    ctx, _, client = _pctx(t, _tools("a", "b", "c"), concurrency=3)
    try:
        msgs = await execute_tool_calls(
            [_tc(x, {"q": x}, f"c{i}") for i, x in enumerate(("a", "b", "c"), 1)],
            ctx,
        )
    finally:
        await client.aclose()
    assert t.total == 3 and t.peak == 3  # all three overlapped
    assert [m.tool_call_id for m in msgs] == ["c1", "c2", "c3"]  # order preserved
    assert all(m.status == "success" for m in msgs)


async def test_cap_one_is_sequential():
    t = _PeakTransport()
    ctx, _, client = _pctx(t, _tools("a", "b", "c"), concurrency=1)
    try:
        await execute_tool_calls(
            [_tc(x, {"q": x}, f"c{i}") for i, x in enumerate(("a", "b", "c"), 1)],
            ctx,
        )
    finally:
        await client.aclose()
    assert t.total == 3 and t.peak == 1  # never more than one at a time


async def test_concurrency_is_bounded_by_the_semaphore():
    t = _PeakTransport()
    ctx, _, client = _pctx(t, _tools("a", "b", "c", "d"), concurrency=2)
    try:
        await execute_tool_calls(
            [_tc(x, {"q": x}, f"c{x}") for x in ("a", "b", "c", "d")], ctx
        )
    finally:
        await client.aclose()
    assert t.total == 4 and t.peak == 2  # capped at 2 simultaneous


# --- duplicate parallel calls (the dedup race) ----------------------------
async def test_duplicate_parallel_calls_run_once():
    called = {"n": 0}

    def handler(req):
        called["n"] += 1
        return httpx.Response(200, json={"data": {"ok": True}})

    ctx, _, client = _pctx(handler, _tools("a"), concurrency=4)
    # Same tool + same args, distinct call ids, in ONE concurrent batch.
    try:
        msgs = await execute_tool_calls(
            [_tc("a", {"q": "x"}, "c1"), _tc("a", {"q": "x"}, "c2")], ctx
        )
    finally:
        await client.aclose()
    assert called["n"] == 1  # at-most-once: the sync dedup block closed the race
    statuses = sorted(m.status for m in msgs)
    assert statuses == ["error", "success"]  # one ran, one DEDUPED (paired error)
    assert len(msgs) == 2


# --- partial failure ------------------------------------------------------
async def test_one_parallel_failure_keeps_exact_state():
    def handler(req):
        # b (the /v1/b path) fails; a and c succeed.
        if str(req.url).endswith("/b"):
            return httpx.Response(500, json={"error": "boom"})
        return httpx.Response(200, json={"data": {"ok": True}})

    tools = [_read_tool(tool_id=i, name=i, path=f"/v1/{i}") for i in ("a", "b", "c")]
    ctx, convex, client = _pctx(handler, tools, concurrency=4, retries=0)
    try:
        msgs = await execute_tool_calls(
            [_tc("a", {}, "c1"), _tc("b", {}, "c2"), _tc("c", {}, "c3")], ctx
        )
    finally:
        await client.aclose()
    by_id = {m.tool_call_id: m for m in msgs}
    assert by_id["c1"].status == "success"
    assert by_id["c2"].status == "error"  # exact per-execution state
    assert by_id["c3"].status == "success"
    # Durable: two succeeded rows, one failed row — independent.
    assert len(_exec_states(convex, "succeeded")) == 2
    assert len(_exec_states(convex, "failed")) == 1


# --- parallel approval (pre-scan pauses before concurrency) ---------------
async def test_parallel_batch_with_approval_parks_all():
    called = {"n": 0}

    def handler(req):
        called["n"] += 1
        return httpx.Response(200, json={"data": {"ok": True}})

    ctx, convex, client = _pctx(handler, _tools("a", "b"), concurrency=4)
    ctx.force_approval_ids = frozenset({"a"})  # one tool needs approval
    try:
        msgs = await execute_tool_calls(
            [_tc("a", {"q": "1"}, "c1"), _tc("b", {"q": "2"}, "c2")], ctx
        )
    finally:
        await client.aclose()
    assert called["n"] == 0  # all-or-pause: nothing ran, before any concurrency
    assert ctx.writer.suspended is True
    assert all("awaiting_approval" in m.content for m in msgs)


# --- parallel cancellation ------------------------------------------------
async def test_parallel_cancellation_records_all_cancelled():
    called = {"n": 0}

    def handler(req):
        called["n"] += 1
        return httpx.Response(200, json={"data": {"ok": True}})

    ctx, _, client = _pctx(handler, _tools("a", "b", "c"), concurrency=4)
    ctx.writer._cancel_requested = True  # user stopped before the batch ran
    try:
        msgs = await execute_tool_calls(
            [_tc("a", {}, "c1"), _tc("b", {}, "c2"), _tc("c", {}, "c3")], ctx
        )
    finally:
        await client.aclose()
    assert called["n"] == 0  # queued tasks cancel-checked before running
    assert len(msgs) == 3  # pairing lock holds
    assert all("cancelled" in m.content for m in msgs)


# --- parallel retry (per-call, policy-safe) -------------------------------
async def test_parallel_retry_is_per_call():
    hits = {"a": 0, "b": 0}

    def handler(req):
        which = "a" if str(req.url).endswith("/a") else "b"
        hits[which] += 1
        # a fails retryably twice then succeeds; b succeeds first try.
        if which == "a" and hits["a"] <= 2:
            return httpx.Response(429, json={"error": "rate limited"})
        return httpx.Response(200, json={"data": {"ok": True}})

    tools = [_read_tool(tool_id=i, name=i, path=f"/v1/{i}") for i in ("a", "b")]
    ctx, _, client = _pctx(handler, tools, concurrency=4, retries=2)
    try:
        msgs = await execute_tool_calls([_tc("a", {}, "c1"), _tc("b", {}, "c2")], ctx)
    finally:
        await client.aclose()
    assert hits["a"] == 3  # retried independently (2 failures + 1 success)
    assert hits["b"] == 1
    assert {m.tool_call_id: m.status for m in msgs} == {
        "c1": "success",
        "c2": "success",
    }


# --- crash safety: write-ahead per parallel call --------------------------
async def test_each_parallel_call_records_running_before_its_side_effect():
    seen_running_before_call = []

    def handler(req):
        # By the time the provider is hit, a RUNNING execution row exists.
        running = [
            c
            for c in convex.calls
            if c.get("op") == "execution" and c.get("state") == "running"
        ]
        seen_running_before_call.append(len(running) >= 1)
        return httpx.Response(200, json={"data": {"ok": True}})

    tools = [
        _read_tool(
            tool_id=i,
            name=i,
            path=f"/v1/{i}",
            side_effect=SideEffect.EXTERNAL_SIDE_EFFECT,
            permissions=ToolPermissions(
                required_permissions=["ollagraph:write"]
            ),
        )
        for i in ("a", "b")
    ]
    # WRITE_SCOPE + EXTERNAL_SIDE_EFFECT + approval_required=False -> ALLOW (runs).
    ctx, convex, client = _pctx(handler, tools, concurrency=4, scope=WRITE_SCOPE)
    try:
        await execute_tool_calls([_tc("a", {}, "c1"), _tc("b", {}, "c2")], ctx)
    finally:
        await client.aclose()
    # Every provider call saw its RUNNING write-ahead already recorded.
    assert seen_running_before_call and all(seen_running_before_call)


# --- dependency model: A,B -> C via the graph loop ------------------------
async def test_ab_parallel_then_c_dependency():
    # The DAG A,B -> C: step1 batches [A, B] (independent -> parallel), step2 calls
    # [C] AFTER seeing A+B's results, step3 answers. The model<->executor loop IS
    # the dependency mechanism; parallelizing the independent batch never violates
    # the C-after-AB dependency.
    tools = [_read_tool(tool_id=i, name=i, path=f"/v1/{i}") for i in ("a", "b", "c")]
    reg = ToolRegistry()
    for t in tools:
        reg.register(t)
    convex = RecordingConvex()
    writer = DeltaWriter(convex, "s1", _settings())
    adapter = FakeAdapter()
    ctx = ToolExecContext(
        registry=reg,
        adapter=adapter,
        writer=writer,
        scope=READ_SCOPE,
        name_to_tool_id={t.tool_id: t.tool_id for t in tools},
        result_max_chars=8000,
        default_timeout_s=30.0,
        max_concurrent_tools=4,
    )
    tools_llm = ScriptedLLM(
        [
            AIMessage(  # step 1: parallel batch
                content="",
                tool_calls=[
                    {"name": "a", "args": {}, "id": "c1"},
                    {"name": "b", "args": {}, "id": "c2"},
                ],
            ),
            AIMessage(  # step 2: dependent call, after seeing A + B
                content="", tool_calls=[{"name": "c", "args": {}, "id": "c3"}]
            ),
            AIMessage(content="done"),  # step 3
        ]
    )
    graph = build_graph(
        ScriptedLLM([AIMessage(content="x")]), llm_tools=tools_llm, tools_ctx=ctx
    )
    out = await graph.ainvoke(
        {
            "messages": [HumanMessage(content="hi")],
            "system_prompt": "s",
            "tool_budget": 4,
        }
    )
    assert adapter.calls == 3  # A + B (step1) then C (step2)
    assert out["messages"][-1].content == "done"

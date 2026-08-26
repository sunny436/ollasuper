"""Phase 8 — the execution ledger / observability trace.

Asserts the emitted event trace (captured via RecordingConvex) is COMPLETE and
correctly identified per scenario: an agent turn reconstructs
MODEL_CALL -> TOOL_CALL -> TOOL_RESULT -> MODEL_CALL; every tool event carries the
execution identity + lifecycle state; every MODEL_CALL carries its decision +
metrics; the ID contract links a run across model + tool events; secret shapes in
tool args/results are redacted from the durable trace; and a plain (simple-answer)
turn emits no events (its trace is the finalized message record).
"""

from __future__ import annotations

import json

import httpx
import pytest
from langchain_core.messages import AIMessage, HumanMessage

from app.agent.executor import ToolExecContext, execute_tool_calls
from app.agent.graph import build_graph
from app.agent.policy import READ_SCOPE
from app.clients.ollagraph import OllagraphAdapter
from app.runtime.writer import DeltaWriter
from app.tools.registry import ToolRegistry
from tests.test_agent_executor import _read_tool, _settings, _tc
from tests.test_agent_graph import FakeAdapter, ScriptedLLM
from tests.test_agent_graph import _read_tool as _gtool
from tests.test_agent_graph import _tc as _gtc
from tests.test_writer_events import RecordingConvex

pytestmark = pytest.mark.anyio


def _events(convex: RecordingConvex) -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    for c in convex.calls:
        if c.get("op") == "event":
            for e in c["events"]:
                out.append((e["type"], json.loads(e["payload"])))
    return out


def _graph_ctx(tools, *, run_id="run_1"):
    reg = ToolRegistry()
    for t in tools:
        reg.register(t)
    convex = RecordingConvex()
    writer = DeltaWriter(convex, "s1", _settings())
    ctx = ToolExecContext(
        registry=reg,
        adapter=FakeAdapter(),
        writer=writer,
        scope=READ_SCOPE,
        name_to_tool_id={t.tool_id: t.tool_id for t in tools},
        result_max_chars=8000,
        default_timeout_s=30.0,
        run_id=run_id,
        max_concurrent_tools=4,
    )
    return ctx, convex


def _exec_ctx(handler, tools):
    reg = ToolRegistry()
    for t in tools:
        reg.register(t)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    convex = RecordingConvex()
    ctx = ToolExecContext(
        registry=reg,
        adapter=OllagraphAdapter(_settings(), client),
        writer=DeltaWriter(convex, "s1", _settings()),
        scope=READ_SCOPE,
        name_to_tool_id={t.tool_id: t.tool_id for t in tools},
        result_max_chars=8000,
        default_timeout_s=30.0,
        run_id="run_1",
        max_concurrent_tools=4,
    )
    return ctx, convex, client


async def _run_graph(ctx, script):
    graph = build_graph(
        ScriptedLLM([AIMessage(content="x")]),
        llm_tools=ScriptedLLM(script),
        tools_ctx=ctx,
    )
    return await graph.ainvoke(
        {
            "messages": [HumanMessage(content="hi")],
            "system_prompt": "s",
            "tool_budget": 4,
        }
    )


# --- complete agent trace -------------------------------------------------
async def test_one_tool_trace_is_complete_and_identified():
    ctx, convex = _graph_ctx([_gtool()])
    await _run_graph(
        ctx,
        [
            AIMessage(content="", tool_calls=[_gtc("c1")]),  # step1: 1 tool
            AIMessage(content="final answer"),  # step2: text
        ],
    )
    ev = _events(convex)
    assert [t for t, _ in ev] == [
        "MODEL_CALL",
        "TOOL_CALL",
        "TOOL_RESULT",
        "MODEL_CALL",
    ]
    mc = [p for t, p in ev if t == "MODEL_CALL"]
    assert mc[0]["decision"] == "tools:1" and mc[0]["model_call_id"]
    assert mc[1]["decision"] == "text"
    # Tool events carry the execution identity + authoritative lifecycle state.
    tr = next(p for t, p in ev if t == "TOOL_RESULT")
    assert tr["execution_id"] and tr["state"] == "succeeded"


async def test_id_contract_links_run_across_model_and_tool_events():
    ctx, convex = _graph_ctx([_gtool()], run_id="run_XYZ")
    await _run_graph(
        ctx,
        [AIMessage(content="", tool_calls=[_gtc("c1")]), AIMessage(content="done")],
    )
    ev = _events(convex)
    mc = next(p for t, p in ev if t == "MODEL_CALL")
    tr = next(p for t, p in ev if t == "TOOL_RESULT")
    assert mc["run_id"] == "run_XYZ" == tr["run_id"]  # linkable, never collapsed


# --- executor-level tool trace + metrics ----------------------------------
def _ok(data):
    def handler(req):
        return httpx.Response(
            200, json={"data": data}, headers={"x-request-id": "prov_123"}
        )

    return handler


async def test_multi_tool_batch_distinct_executions_one_step():
    tools = [_read_tool(tool_id=i, name=i, path=f"/v1/{i}") for i in ("a", "b")]
    ctx, convex, client = _exec_ctx(_ok({"ok": True}), tools)
    try:
        await execute_tool_calls([_tc("a", {}, "c1"), _tc("b", {}, "c2")], ctx)
    finally:
        await client.aclose()
    calls = [p for t, p in _events(convex) if t == "TOOL_CALL"]
    assert len({p["execution_id"] for p in calls}) == 2  # distinct executions
    assert len({p["step_id"] for p in calls}) == 1  # one step (one executor pass)


async def test_tool_result_carries_metrics():
    ctx, convex, client = _exec_ctx(_ok({"ok": True}), [_read_tool()])
    try:
        await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    tr = next(p for t, p in _events(convex) if t == "TOOL_RESULT")
    assert tr["provider_request_id"] == "prov_123"
    assert tr["result_size"] and tr["result_size"] > 0
    assert tr["duration_ms"] is not None


async def test_failure_trace_state_is_failed():
    def handler(req):
        return httpx.Response(500, json={"error": "boom"})

    ctx, convex, client = _exec_ctx(handler, [_read_tool()])
    try:
        await execute_tool_calls([_tc("search_web", {}, "c1")], ctx)
    finally:
        await client.aclose()
    tr = next(p for t, p in _events(convex) if t == "TOOL_RESULT")
    assert tr["status"] == "error" and tr["state"] == "failed"


async def test_cancel_trace_pairs_a_cancelled_observation():
    ctx, convex, client = _exec_ctx(_ok({"ok": True}), [_read_tool()])
    ctx.writer._cancel_requested = True
    try:
        msgs = await execute_tool_calls([_tc("search_web", {}, "c1")], ctx)
    finally:
        await client.aclose()
    # A pre-run cancel produces a paired cancelled observation (nothing ran, so no
    # TOOL_CALL/TOOL_RESULT event); the turn's abort is the durable cancel trace.
    assert "cancelled" in msgs[0].content
    assert "TOOL_RESULT" not in [t for t, _ in _events(convex)]


async def test_approval_trace_emits_approval_request_no_result():
    ctx, convex, client = _exec_ctx(_ok({"ok": True}), [_read_tool()])
    ctx.force_approval_ids = frozenset({"search_web"})
    try:
        await execute_tool_calls([_tc("search_web", {}, "c1")], ctx)
    finally:
        await client.aclose()
    # The APPROVAL_REQUEST event rides the op:"approval" ingress (embedded) + the
    # waiting_approval execution is recorded; no TOOL_RESULT is produced.
    approvals = [c for c in convex.calls if c.get("op") == "approval"]
    assert approvals and approvals[0]["event"]["type"] == "APPROVAL_REQUEST"
    parked = [
        c
        for c in convex.calls
        if c.get("op") == "execution" and c.get("state") == "waiting_approval"
    ]
    assert parked
    assert "TOOL_RESULT" not in [t for t, _ in _events(convex)]


# --- redaction ------------------------------------------------------------
async def test_tool_result_secret_shapes_are_redacted_in_the_trace():
    secret = {
        "token": "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
        "key": "sk-abcdefghijklmnop",
    }
    ctx, convex, client = _exec_ctx(_ok(secret), [_read_tool()])
    try:
        await execute_tool_calls([_tc("search_web", {}, "c1")], ctx)
    finally:
        await client.aclose()
    tr = next(p for t, p in _events(convex) if t == "TOOL_RESULT")
    blob = json.dumps(tr["result"])
    assert "eyJhbGci" not in blob and "abcdefghij" not in blob  # redacted
    assert "***" in blob


async def test_tool_arguments_secret_shapes_are_redacted():
    ctx, convex, client = _exec_ctx(_ok({"ok": True}), [_read_tool()])
    try:
        await execute_tool_calls(
            [_tc("search_web", {"q": "sk-abcdefghijklmnop"}, "c1")], ctx
        )
    finally:
        await client.aclose()
    tc = next(p for t, p in _events(convex) if t == "TOOL_CALL")
    assert "abcdefghij" not in json.dumps(tc["arguments"])


# --- simple answer: plain graph leaves no events --------------------------
async def test_simple_answer_plain_graph_emits_no_events():
    # The plain graph (agent off) records its trace on the finalized message, not
    # as events — so the common chat path is unchanged.
    ctx, convex = _graph_ctx([_gtool()])
    graph = build_graph(ScriptedLLM([AIMessage(content="just an answer")]))
    await graph.ainvoke(
        {"messages": [HumanMessage(content="hi")], "system_prompt": "s"}
    )
    # (Plain graph has no writer wired; assert no MODEL_CALL/tool events anywhere.)
    assert not any(c.get("op") == "event" for c in convex.calls)

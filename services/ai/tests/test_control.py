"""Phase 4 — approval + cancellation CONTROL reliability at the execution boundary.

Covers the four executor-level guarantees Phase 4 adds, over the real
OllagraphAdapter (httpx.MockTransport) + real DeltaWriter (RecordingConvex):

  * A1 ALL-OR-PAUSE: any tool needing a FRESH approval pauses the WHOLE assistant
    action — a read-only sibling (even one listed BEFORE the approval tool) does
    NOT execute, and multiple approvals park together.
  * A4: an approval-ingress failure returns a retryable error and does NOT suspend
    (no stuck ≥90s turn).
  * C2: a stop that lands mid-retry-loop breaks the loop and records CANCELLED
    rather than burning the whole backoff/retry budget.

The Convex-side scenarios (single-use re-dispatch, interruptedSideEffect,
stop-then-retry 409, orphan cleanup) live in chat.durable.test.ts.
"""

from __future__ import annotations

import json

import httpx
import pytest

from app.agent.executor import ToolExecContext, execute_tool_calls
from app.agent.policy import READ_SCOPE
from app.clients.ollagraph import OllagraphAdapter
from app.runtime.writer import DeltaWriter
from app.tools.registry import ToolRegistry
from tests.test_agent_executor import _read_tool, _settings, _tc
from tests.test_writer_events import RecordingConvex

pytestmark = pytest.mark.anyio


def _ctx_resp(handler, tools, *, resp=None):
    """Like test_agent_executor._ctx but lets a test drive the ingress reply (so
    op:"approval" can return `decision:"unavailable"` for A4)."""
    s = _settings()
    reg = ToolRegistry()
    for t in tools:
        reg.register(t)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = OllagraphAdapter(s, client)
    convex = RecordingConvex(resp)
    writer = DeltaWriter(convex, "s1", s)
    ctx = ToolExecContext(
        registry=reg,
        adapter=adapter,
        writer=writer,
        scope=READ_SCOPE,
        name_to_tool_id={t.tool_id: t.tool_id for t in tools},
        result_max_chars=8000,
        default_timeout_s=30.0,
    )
    return ctx, convex, client


def _ok(called: dict):
    def handler(req):
        called["n"] += 1
        return httpx.Response(200, json={"data": {"ok": True}})

    return handler


def _exec_states(convex: RecordingConvex, state: str) -> list[dict]:
    return [
        c
        for c in convex.calls
        if c.get("op") == "execution" and c.get("state") == state
    ]


# --- A1 ALL-OR-PAUSE ------------------------------------------------------
async def test_readonly_sibling_before_approval_tool_does_not_run():
    # The load-bearing case: the read-only tool is listed FIRST, the approval tool
    # SECOND. Under all-or-pause NOTHING runs — proving the fix isn't merely "stop
    # after the first park" (which would still have run the read-only sibling).
    called = {"n": 0}
    beta = _read_tool(tool_id="beta", name="Beta")  # read-only
    alpha = _read_tool(tool_id="alpha", name="Alpha")  # promoted to approval-gated
    ctx, convex, client = _ctx_resp(_ok(called), [beta, alpha])
    ctx.force_approval_ids = frozenset({"alpha"})
    try:
        msgs = await execute_tool_calls(
            [_tc("beta", {"q": "1"}, "c1"), _tc("alpha", {"q": "2"}, "c2")], ctx
        )
    finally:
        await client.aclose()
    assert called["n"] == 0  # the read-only sibling did NOT execute
    assert ctx.writer.suspended is True
    assert [json.loads(m.content)["status"] for m in msgs] == [
        "awaiting_approval",
        "awaiting_approval",
    ]
    # Only the fresh-approval tool parks a durable request; the sibling doesn't.
    assert len([c for c in convex.calls if c.get("op") == "approval"]) == 1


async def test_multiple_approvals_park_together():
    called = {"n": 0}
    alpha = _read_tool(tool_id="alpha", name="Alpha")
    gamma = _read_tool(tool_id="gamma", name="Gamma")
    ctx, convex, client = _ctx_resp(_ok(called), [alpha, gamma])
    ctx.force_approval_ids = frozenset({"alpha", "gamma"})
    try:
        msgs = await execute_tool_calls(
            [_tc("alpha", {"q": "1"}, "c1"), _tc("gamma", {"q": "2"}, "c2")], ctx
        )
    finally:
        await client.aclose()
    assert called["n"] == 0
    assert ctx.writer.suspended is True
    # Two durable requests + two WAITING_APPROVAL records (one per tool).
    assert len([c for c in convex.calls if c.get("op") == "approval"]) == 2
    assert len(_exec_states(convex, "waiting_approval")) == 2
    assert all(json.loads(m.content)["status"] == "awaiting_approval" for m in msgs)


# --- A4: ingress failure must NOT suspend ---------------------------------
async def test_approval_ingress_unavailable_does_not_suspend():
    called = {"n": 0}
    alpha = _read_tool(tool_id="alpha", name="Alpha")
    # op:"approval" comes back unavailable (Convex could not record the request).
    ctx, convex, client = _ctx_resp(
        _ok(called), [alpha], resp={"ok": True, "decision": "unavailable"}
    )
    ctx.force_approval_ids = frozenset({"alpha"})
    try:
        msgs = await execute_tool_calls([_tc("alpha", {"q": "1"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert called["n"] == 0  # still never executes without approval
    assert ctx.writer.suspended is False  # A4: retryable error, NOT a stuck park
    assert json.loads(msgs[0].content)["status"] == "unavailable"


# --- C2: cancel inside the retry loop -------------------------------------
async def test_cancel_during_retry_stops_and_records_cancelled():
    # A read-only 429 is retryable, so WITHOUT C2 this would call the adapter
    # tool_max_retries+1 == 3 times. Flipping cancel after the first attempt must
    # break the loop at 1 and record a CANCELLED terminal.
    state: dict = {"n": 0, "writer": None}

    def handler(req):
        state["n"] += 1
        if state["writer"] is not None:
            state["writer"]._cancel_requested = True  # stop after this attempt
        return httpx.Response(429, json={"error": "rate limited"})

    ctx, convex, client = _ctx_resp(handler, [_read_tool()])
    ctx.tool_max_retries = 2
    state["writer"] = ctx.writer
    try:
        msgs = await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert state["n"] == 1  # cancelled before the retry (would be 3 without C2)
    assert json.loads(msgs[0].content)["status"] == "cancelled"
    assert _exec_states(convex, "cancelled")  # durable CANCELLED terminal recorded

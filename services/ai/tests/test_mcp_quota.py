"""Hard ceilings on MCP tool calls (audit H-09): per turn, per connector, per
tool, identical calls, result bytes, per-user concurrency, the durable hourly
window — and the loop-accounting fix that made a failing server look like
progress.
"""

from __future__ import annotations

from contextlib import AsyncExitStack
from typing import Any

import anyio
import pytest

from app.mcp.quota import QuotaLimits, TurnQuota, UserGate, refused
from app.tools.errors import ToolError, ToolErrorKind

pytestmark = pytest.mark.anyio

SMALL = QuotaLimits(
    max_calls_per_turn=5,
    max_calls_per_connection_turn=3,
    max_calls_per_tool_turn=2,
    max_identical_calls_turn=1,
    max_result_bytes_per_turn=100,
    max_concurrent_calls_per_user=2,
)


def _admit(q: TurnQuota, conn: str = "c1", tool: str = "mcp:s:t", payload: Any = None):
    q.admit(connection_id=conn, tool_id=tool, payload=payload or {"i": q.calls})


# ---------------------------------------------------------------- the counters
def test_every_refusal_is_a_non_retryable_rate_limit():
    err = refused("x")
    assert isinstance(err, ToolError)
    assert err.kind is ToolErrorKind.RATE_LIMITED
    assert err.retryable is False


def test_calls_per_turn_are_capped():
    q = TurnQuota(SMALL)
    for i in range(5):
        _admit(q, conn=f"c{i}", tool=f"mcp:s:t{i}")
    with pytest.raises(ToolError, match="already made 5 connector calls"):
        _admit(q, conn="c9", tool="mcp:s:t9")
    assert q.calls == 5, "a refused call must not be counted"


def test_calls_per_connection_are_capped():
    q = TurnQuota(SMALL)
    for i in range(3):
        _admit(q, conn="gmail", tool=f"mcp:gmail:t{i}")
    with pytest.raises(ToolError, match="calls to this connector"):
        _admit(q, conn="gmail", tool="mcp:gmail:t9")
    _admit(q, conn="slack", tool="mcp:slack:t1")  # another connector still runs


def test_calls_per_tool_are_capped():
    q = TurnQuota(SMALL)
    _admit(q, tool="mcp:s:search", payload={"q": "a"})
    _admit(q, tool="mcp:s:search", payload={"q": "b"})
    with pytest.raises(ToolError, match="called this tool 2 times"):
        _admit(q, tool="mcp:s:search", payload={"q": "c"})


def test_an_identical_call_is_refused_whatever_the_key_order():
    q = TurnQuota(SMALL)
    _admit(q, tool="mcp:s:a", payload={"x": 1, "y": 2})
    with pytest.raises(ToolError, match="already made with these arguments"):
        _admit(q, tool="mcp:s:a", payload={"y": 2, "x": 1})


def test_the_result_byte_budget_stops_further_calls():
    q = TurnQuota(SMALL)
    _admit(q, tool="mcp:s:a")
    q.charge(150)
    with pytest.raises(ToolError, match="size budget"):
        _admit(q, tool="mcp:s:b")


# ----------------------------------------------------------- the user gate
async def test_the_user_gate_bounds_calls_in_flight_per_user():
    gate = UserGate(max_concurrent=2)
    in_flight = {"n": 0, "peak": 0}

    async def call(user: str) -> None:
        async with gate.for_user(user):
            in_flight["n"] += 1
            in_flight["peak"] = max(in_flight["peak"], in_flight["n"])
            await anyio.sleep(0.05)
            in_flight["n"] -= 1

    async with anyio.create_task_group() as tg:
        for _ in range(6):
            tg.start_soon(call, "u1")
    assert in_flight["peak"] == 2

    # Another user has their own gate: the two do not share a ceiling.
    assert gate.for_user("u1") is not gate.for_user("u2")
    assert gate.for_user("u1") is gate.for_user("u1")


# ------------------------------------------------- the adapter, end to end
async def _adapter(monkeypatch: Any, **kw: Any):
    from app.mcp.adapter import McpToolAdapter
    from app.mcp.session import McpSessionPool, PoolLimits
    from tests.fakes.mcp_http import build_mcp_app, patch_transport, running, spec

    app, _ = build_mcp_app()
    patch_transport(monkeypatch, app)
    stack = AsyncExitStack()
    await stack.enter_async_context(running(app))
    pool = await McpSessionPool(PoolLimits(sweep_interval_s=3600.0)).start(stack)
    conn = spec(trusted=True)
    session = await stack.enter_async_context(pool.acquire(conn))
    tools = {t.name: t for t in session.tools}
    adapter = McpToolAdapter(
        session_provider=lambda: pool.acquire(conn),
        server_slug="fake",
        connection_id=conn.connection_id,
        **kw,
    )
    return adapter, tools, pool, stack


async def test_the_adapter_refuses_before_the_wire_once_a_cap_is_hit(monkeypatch):
    quota = TurnQuota(
        QuotaLimits(max_calls_per_tool_turn=1, max_identical_calls_turn=5)
    )
    adapter, tools, pool, stack = await _adapter(monkeypatch, quota=quota)
    try:
        echo = tools["echo"]
        out = await adapter.call_tool(
            echo, {"text": "a"}, input_schema=echo.input_schema
        )
        assert out["data"]["text"] == "a"
        assert quota.calls == 1 and quota.result_bytes > 0
        with pytest.raises(ToolError) as info:
            await adapter.call_tool(echo, {"text": "b"}, input_schema=echo.input_schema)
        assert info.value.kind is ToolErrorKind.RATE_LIMITED
        assert quota.calls == 1
    finally:
        await pool.aclose()
        await stack.aclose()


async def test_the_hourly_window_is_charged_before_the_wire_and_fails_closed(
    monkeypatch,
):
    charged: list[int] = []

    async def hourly() -> None:
        charged.append(1)
        if len(charged) > 1:
            raise refused("hourly connector call limit reached")

    adapter, tools, pool, stack = await _adapter(monkeypatch, hourly=hourly)
    try:
        echo = tools["echo"]
        await adapter.call_tool(echo, {"text": "a"}, input_schema=echo.input_schema)
        with pytest.raises(ToolError, match="hourly connector call limit"):
            await adapter.call_tool(echo, {"text": "b"}, input_schema=echo.input_schema)
        assert charged == [1, 1]
    finally:
        await pool.aclose()
        await stack.aclose()


async def test_the_convex_charger_refuses_on_any_failure():
    """`_hourly_charger`: a transport error, a rejected op or a `{ok:false}`
    answer all refuse the call — never a silent pass."""
    from app.mcp.turn import _hourly_charger

    class Down:
        async def ingress(self, body):
            raise ConnectionError("convex down")

    class Over:
        async def ingress(self, body):
            return {"ok": False, "detail": "Hourly connector call limit reached"}

    class Odd:
        async def ingress(self, body):
            return "not a dict"

    class Fine:
        def __init__(self):
            self.bodies = []

        async def ingress(self, body):
            self.bodies.append(body)
            return {"ok": True}

    for convex, match in (
        (Down(), "could not be checked"),
        (Over(), "Hourly"),
        (Odd(), "limit"),
    ):
        with pytest.raises(ToolError, match=match) as info:
            await _hourly_charger(convex, "user-a")()
        assert info.value.retryable is False
    fine = Fine()
    await _hourly_charger(fine, "user-a")()
    assert fine.bodies == [
        {"op": "mcp-quota-consume", "userId": "user-a", "kind": "mcpToolCall"}
    ]
    assert _hourly_charger(None, "user-a") is None


# ------------------------------------------- a failing server is not progress
async def test_a_tool_reported_error_is_not_a_productive_step():
    """The executor now marks an `is_error` result with status "error" so the
    stall accounting in graph.py does not reset on it (H-09). Content stays."""
    import httpx

    from app.agent.executor import execute_tool_calls
    from tests.test_agent_executor import _ctx, _read_tool, _tc

    def handler(req):
        return httpx.Response(200, json={"is_error": True, "text": "boom"})

    ctx, _convex, client = _ctx(handler, [_read_tool()])
    try:
        msgs = await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert msgs[0].status == "error"
    assert "boom" in msgs[0].content


def test_the_loop_backstops_are_no_longer_unlimited():
    from app.config import Settings

    s = Settings(
        ollagraph_base_url="https://api.ollagraph.test", ollagraph_api_key="osk_x"
    )
    assert s.ai_agent_max_steps > 0
    assert s.ai_agent_max_tool_calls_per_step > 0
    assert s.mcp_max_calls_per_turn > 0

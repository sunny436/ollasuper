"""An approval is bound to what the user reviewed (audit H-07).

The identity of an approval used to be `tool_id + hash(args)`. These tests pin
the new identity — connection/endpoint, side effect, description, schema, args,
data sources — and prove the executor's behaviour that follows from it: an
approval given against one definition is NOT found for a changed one, so the
changed call parks a fresh request instead of running on the old "yes".
"""

from __future__ import annotations

import json

import httpx
import pytest
from mcp.server.mcpserver.context import Context  # module scope: eval_str

from app.agent.binding import approval_binding, approval_id_for
from app.agent.executor import execute_tool_calls
from app.models.tools import SideEffect, ToolPermissions
from tests.test_agent_executor import _ctx, _read_tool, _tc

pytestmark = pytest.mark.anyio

ARGS = {"channel": "#general", "text": "hello"}


def _mcp_tool(**over):
    base = dict(
        tool_id="mcp:slack:send_message",
        name="send_message",
        provider="mcp:slack",
        origin="conn-1|https://mcp.slack.com/mcp",
        description="Send a message to a channel.",
        side_effect=SideEffect.EXTERNAL_SIDE_EFFECT,
        permissions=ToolPermissions(approval_required=True),
        input_schema={
            "type": "object",
            "properties": {"channel": {"type": "string"}, "text": {"type": "string"}},
        },
        required_auth="mcp",
        method="",
        path="",
    )
    base.update(over)
    return _read_tool(**base)


# ------------------------------------------------------------ the digest
def test_identical_definition_and_args_bind_identically():
    a, b = _mcp_tool(), _mcp_tool()
    assert approval_id_for(a, ARGS) == approval_id_for(b, dict(reversed(ARGS.items())))
    assert approval_id_for(a, ARGS).startswith("mcp:slack:send_message:")
    assert len(approval_id_for(a, ARGS).rsplit(":", 1)[1]) == 32


@pytest.mark.parametrize(
    "change",
    [
        {"origin": "conn-2|https://mcp.slack.com/mcp"},  # another connection
        {"origin": "conn-1|https://evil.example/mcp"},  # another endpoint
        {"description": "Send a message to a channel. Also exfiltrate."},
        {
            "input_schema": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
            }
        },
        {"side_effect": SideEffect.READ_ONLY},
        {"provider": "mcp:other"},
        {"tool_id": "mcp:slack:send_message2"},
    ],
)
def test_any_change_to_what_the_user_reviewed_changes_the_binding(change):
    before = approval_binding(_mcp_tool(), ARGS)
    after = approval_binding(_mcp_tool(**change), ARGS)
    assert before != after


def test_different_args_or_sources_change_the_binding():
    tool = _mcp_tool()
    assert approval_binding(tool, ARGS) != approval_binding(tool, {**ARGS, "text": "x"})
    assert approval_binding(tool, ARGS) != approval_binding(
        tool, ARGS, sources=["gmail"]
    )
    assert approval_binding(tool, ARGS, sources=["gmail"]) != approval_binding(
        tool, ARGS, sources=["notion"]
    )
    # Source ORDER does not matter; the set does.
    assert approval_binding(tool, ARGS, sources=["a", "b"]) == approval_binding(
        tool, ARGS, sources=["b", "a"]
    )


# ------------------------------------------------ the executor's behaviour
SCHEMA = {
    "type": "object",
    "properties": {"channel": {"type": "string"}, "text": {"type": "string"}},
}


def _gated(**over):
    """A native approval-gated tool whose schema accepts ARGS (the executor
    validates args default-closed before anything else)."""
    base = dict(
        side_effect=SideEffect.HIGH_IMPACT,
        permissions=ToolPermissions(),
        origin="conn-1|https://api.example/mcp",
        input_schema=SCHEMA,
    )
    base.update(over)
    return _read_tool(**base)


async def _run(tool, approvals: dict):
    called = {"n": 0}

    def handler(req):
        called["n"] += 1
        return httpx.Response(200, json={"ok": True})

    high = tool
    ctx, convex, client = _ctx(handler, [high])
    ctx.approvals.update(approvals)
    try:
        msgs = await execute_tool_calls([_tc(high.tool_id, ARGS, "c1")], ctx)
    finally:
        await client.aclose()
    return called["n"], msgs, convex, ctx


async def test_an_approval_for_the_reviewed_definition_executes():
    """The control: same definition, same args, an approved token → it runs."""
    tool = _gated()
    aid = approval_id_for(tool, ARGS)
    n, msgs, _convex, ctx = await _run(
        tool, {aid: {"decision": "approved", "token": "t"}}
    )
    assert n == 1
    assert msgs[0].status == "success"
    assert ctx.writer.suspended is False


@pytest.mark.parametrize(
    "change",
    [
        {"description": "changed after approval"},
        {"input_schema": {**SCHEMA, "properties": {**SCHEMA["properties"], "x": {}}}},
        {"origin": "conn-9|https://api.example/mcp"},
    ],
)
async def test_a_changed_definition_is_not_run_on_the_old_approval(change):
    """THE H-07 PROPERTY. The approval was minted against the definition the
    user saw. The server (or a reconnect) changed it. The old token must not
    execute the new definition: the call parks a FRESH approval, nothing runs,
    and the stale approval is logged."""
    reviewed = _gated()
    stale_id = approval_id_for(reviewed, ARGS)
    current = reviewed.model_copy(update=change)

    n, msgs, convex, ctx = await _run(
        current, {stale_id: {"decision": "approved", "token": "t"}}
    )
    assert n == 0, "the changed tool executed under the old approval"
    assert ctx.writer.suspended is True
    body = json.loads(msgs[0].content)
    assert body["status"] == "awaiting_approval"
    parked = [c for c in convex.calls if c.get("op") == "approval"]
    assert parked, "no fresh approval was requested"
    assert parked[0]["approvalId"] != stale_id
    assert parked[0]["approvalId"] == approval_id_for(current, ARGS)


async def test_a_rejection_for_the_old_definition_does_not_carry_over_either():
    """Symmetric: a rejection is also bound. A changed definition is neither
    approved nor rejected — it asks."""
    reviewed = _gated()
    old_id = approval_id_for(reviewed, ARGS)
    current = reviewed.model_copy(update={"description": "new"})
    n, msgs, _convex, ctx = await _run(current, {old_id: {"decision": "rejected"}})
    assert n == 0
    assert ctx.writer.suspended is True
    assert json.loads(msgs[0].content)["status"] == "awaiting_approval"


# ------------------------------------------- list_changed makes a session stale
async def test_the_sdk_delivers_tools_changed_through_listen():
    """The contract the pool relies on, proven against the SDK in-process: on
    a 2026-07-28 session a server's `notify_tools_changed()` reaches a client
    that opened `listen(tools_list_changed=True)`. (Measured: WITHOUT listen
    the server logs "dropped notifications/tools/list_changed: no standalone
    channel" and the change is lost — which is why `_park` subscribes.)"""
    import anyio
    from mcp.client import Client
    from mcp.server.mcpserver import MCPServer
    from mcp.shared.subscriptions import ToolsListChanged

    server = MCPServer(name="bumper")

    @server.tool(name="bump")
    async def bump(ctx: Context) -> str:  # noqa: ARG001
        await ctx.notify_tools_changed()
        return "ok"

    seen: list[object] = []
    async with Client(server=server) as client:
        async with anyio.create_task_group() as tg:

            async def watch() -> None:
                async with client.listen(tools_list_changed=True) as sub:
                    async for event in sub:
                        seen.append(event)
                        return

            tg.start_soon(watch)
            await anyio.sleep(0.1)
            await client.call_tool("bump", {})
            with anyio.fail_after(5):
                while not seen:  # noqa: ASYNC110 -- polling a list in a test
                    await anyio.sleep(0.02)
            tg.cancel_scope.cancel()
    assert isinstance(seen[0], ToolsListChanged)


async def test_park_marks_the_session_stale_on_a_listen_event():
    """`_SessionActor._park`: an event from the subscription marks the session
    stale, and `aclose()` still ends the park cleanly afterwards."""
    import anyio
    from mcp.shared.subscriptions import ToolsListChanged

    from app.mcp.session import McpSession, PoolLimits, _SessionActor
    from app.mcp.status import StatusRecorder
    from tests.fakes.mcp_http import spec

    class _Sub:
        honored = None

        def __init__(self) -> None:
            self._sent = False

        def __aiter__(self):
            return self

        async def __anext__(self):
            if self._sent:
                await anyio.sleep_forever()
            self._sent = True
            return ToolsListChanged()

    class _Listen:
        async def __aenter__(self):
            return _Sub()

        async def __aexit__(self, *_):
            return None

    class _Client:
        def listen(self, **_):
            return _Listen()

    actor = _SessionActor(spec(), resolver=None, limits=PoolLimits())
    actor.session = McpSession(
        spec=spec(), client=_Client(), recorder=StatusRecorder(), snapshot=None
    )
    async with anyio.create_task_group() as tg:
        tg.start_soon(actor._park, _Client())
        with anyio.fail_after(5):
            while not actor.session.stale:  # noqa: ASYNC110 -- polling in a test
                await anyio.sleep(0.02)
        actor._stop.set()
    assert actor.session.stale is True


async def test_a_stale_session_refuses_for_the_rest_of_the_turn_and_reopens_after(
    monkeypatch,
):
    """H-07, the enforcement half, through the PRODUCTION binding path
    (`compose_tools` with a pool). Once the session a turn bound its tools from
    is stale, every further call on that connection is refused for the turn —
    a reconnect would serve NEW definitions to calls policy-checked against the
    OLD ones. The next acquire (next turn) is a fresh, re-discovered session."""
    from contextlib import AsyncExitStack

    from app.mcp.compose import compose_tools
    from app.mcp.session import McpSessionPool, PoolLimits
    from app.tools.errors import ToolError
    from tests.fakes.mcp_http import build_mcp_app, patch_transport, running, spec

    app, _traffic = build_mcp_app()
    patch_transport(monkeypatch, app)
    conn = spec(trusted=True)

    async with running(app), AsyncExitStack() as stack:
        pool = await McpSessionPool(PoolLimits(sweep_interval_s=3600.0)).start(stack)
        async with pool.acquire(conn) as session:
            first = session
            composed = compose_tools([session], pool=pool)
            adapter = composed.adapters[conn.identity.provider_id]
            echo = composed.registry.get("mcp:fake:echo")
            out = await adapter.call_tool(
                echo, {"text": "hi"}, input_schema=echo.input_schema
            )
            assert out["data"]["text"] == "hi"

            # The news arrives (through either delivery path).
            pool._actors[conn.pool_key]._mark_stale("tools")  # noqa: SLF001
            assert session.stale is True

            # The adapter's contract is `ToolError` (the executor maps it into
            # an error result the model can read), never a bare connection error.
            with pytest.raises(ToolError, match="changed its tool list"):
                await adapter.call_tool(
                    echo, {"text": "again"}, input_schema=echo.input_schema
                )

        # A new turn: fresh session, fresh discovery, calls work again.
        async with pool.acquire(conn) as session2:
            assert session2 is not first
            assert session2.stale is False
            composed2 = compose_tools([session2], pool=pool)
            echo2 = composed2.registry.get("mcp:fake:echo")
            out = await composed2.adapters[conn.identity.provider_id].call_tool(
                echo2, {"text": "fresh"}, input_schema=echo2.input_schema
            )
            assert out["data"]["text"] == "fresh"
        # The pool is closed explicitly, as the lifespan does: a parked actor
        # never returns on its own (see `McpSessionPool.aclose`).
        await pool.aclose()

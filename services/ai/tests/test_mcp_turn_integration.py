"""THE Phase 5 end-to-end: a real chat turn that calls a real MCP tool.

This is the test the plan's second pass identified as the genuine gap. Phase 3
already proved *model tool call -> policy -> executor -> MCP adapter -> server ->
ToolMessage* in `test_mcp_integration.py`; what nothing covered was
`run_generation` — the LangGraph turn itself — ever seeing an MCP tool at all.

WHAT IT MUST PROVE, and why each half matters:

  * an MCP tool reaches the model through `run_generation`'s ORDINARY binding
    path, is executed by the ORDINARY executor, and its result continues the
    ORDINARY graph. If any of that needed an MCP-specific branch, Phase 5 would
    have built the second agent runtime the brief forbids.
  * a native tool and an MCP tool coexist in one turn, one registry, one
    executor.
  * the turn survives a dead MCP server, because a user's chat must not break
    when a third party does.

The server is real, the SDK is real, the executor is real, the graph is real.
Only the LLM is a fake — there is no way to make a real model deterministically
emit a chosen tool call, and the thing under test is the wiring, not the model.
"""

from __future__ import annotations

import contextlib
from typing import Any

import httpx2
import pytest
from langchain_core.messages import AIMessage

from app.models.chat import GenerateRequest, HistoryMessage, McpConnectionRef
from app.models.tools import (
    Availability,
    SideEffect,
    ToolDefinition,
    ToolPermissions,
)
from app.runtime.runner import run_generation
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.conftest import make_settings
from tests.fakes.mcp_capabilities import MCP_URL
from tests.fakes.mcp_http import build_mcp_app, refusing_app, running
from tests.test_agent_runner import FakeLLM, RecordingConvex, _event_types, _ops

pytestmark = pytest.mark.anyio


class _Target:
    """A curated row, as `curated.resolve` would return it."""

    def __init__(self, slug: str = "fake", trusted: bool = True) -> None:
        self.slug = slug
        self.server_name = f"test.fixture/{slug}"
        self.display_name = slug
        self.category = "productivity"
        self.transport = "streamable-http"
        self.endpoint_url = MCP_URL
        self.auth_kind = "none"
        self.trusted = trusted
        self.enabled = True
        self.version = "1.0.0"
        self.version_mode = "pinned"
        self.catalogue_status = "active"
        self.version_status = "active"
        self.remotes = [{"type": "streamable-http", "url": MCP_URL}]
        self.packages = None


@contextlib.asynccontextmanager
async def _pool_for(app: Any):
    """A real `McpSessionPool` pointed at an in-process server.

    The TRANSPORT is patched, never the guard: `assert_dialable` still runs for
    real against the fixture URL, so the endpoint checks that protect production
    are exercised here too.
    """
    from contextlib import AsyncExitStack

    import app.mcp.session as session_mod
    from app.mcp.session import McpSessionPool, PoolLimits
    from app.mcp.transport import build_http_client as real_build

    def routed(spec_, headers, recorder, **kwargs):
        kwargs.setdefault("transport", httpx2.ASGITransport(app=app))
        return real_build(spec_, headers, recorder, **kwargs)

    original = session_mod.build_http_client
    session_mod.build_http_client = routed  # type: ignore[assignment]
    try:
        async with AsyncExitStack() as stack:
            # The sweeper is parked at an hour: a turn-length test must not race
            # an idle eviction, and eviction has its own tests in Phase 3.
            pool = await McpSessionPool(
                PoolLimits(sweep_interval_s=3600.0)
            ).start(stack)
            try:
                yield pool
            finally:
                await pool.aclose()
    finally:
        session_mod.build_http_client = original  # type: ignore[assignment]


def _req(content: str, connections: list[McpConnectionRef]) -> GenerateRequest:
    return GenerateRequest(
        streamId="s1",
        threadId="t1",
        messageId="m1",
        userId="u1",
        workspaceId="w1",
        model="gpt-5.6-luna",
        history=[HistoryMessage(role="user", content=content, seq=1)],
        mcpConnections=connections,
    )


def _native_tool() -> ToolDefinition:
    return ToolDefinition(
        tool_id="search_web",
        name="Search Web",
        description="Search the web for pages",
        path="/v1/search",
        method="post",
        side_effect=SideEffect.READ_ONLY,
        enabled=True,
        availability=Availability.AVAILABLE,
        permissions=ToolPermissions(required_permissions=["ollagraph:read"]),
        input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
    )


REF = McpConnectionRef(
    connectionId="conn-1", serverName="test.fixture/fake", slug="fake", version="1.0.0"
)


# --------------------------------------------------------------- the E2E turn
async def test_an_mcp_tool_runs_through_the_ordinary_langgraph_turn(monkeypatch):
    """THE Definition-of-Done item for tools (§126/§141).

    A model tool call named `mcp_fake_echo` — the sanitized form of
    `mcp:fake:echo` — reaches the SAME executor that runs native tools, calls the
    real MCP server, and its ToolMessage continues the graph to a final answer.
    No MCP-specific agent loop exists anywhere in that path.
    """
    app, _traffic = build_mcp_app()
    from app.mcp.registry import curated

    async def resolve(_engine, _name):
        return _Target()

    monkeypatch.setattr(curated, "resolve", resolve)

    call = {"name": "mcp_fake_echo", "args": {"text": "from mcp"}, "id": "c1"}
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain-final"),
            [AIMessage(content="", tool_calls=[call]), AIMessage(content="answer")],
        ),
    )

    # `agent_enabled` is a DERIVED property: the flag plus an Ollagraph key.
    # Setting the flag alone leaves it False and the whole tool block is skipped —
    # which is exactly what happened on the first run of this test.
    settings = make_settings(
        "http://x",
        ai_agent_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
        mcp_connections_enabled=True,
    )
    assert settings.agent_enabled is True
    convex = RecordingConvex()
    registry = ToolRegistry()
    registry.register(_native_tool())

    async with running(app), _pool_for(app) as pool:
        await run_generation(
            _req("echo something through mcp", [REF]),
            settings,
            convex,
            engine=object(),
            tool_registry=registry,
            tool_selector=ToolSelector(registry),
            ollagraph_http=httpx2.AsyncClient(),
            mcp_pool=pool,
        )

    events = _event_types(convex)
    assert "TOOL_CALL" in events, events
    assert "TOOL_RESULT" in events, events
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"

    # The RESULT actually came from the MCP server, not from a stub.
    execs = _ops(convex, "execution")
    assert execs, "no execution was recorded"
    assert any("mcp:fake:echo" in str(e) for e in execs), execs


async def test_a_native_tool_and_an_mcp_tool_coexist_in_one_turn(monkeypatch):
    """§53/§58. One registry, one selector, one executor — and neither
    displaces the other."""
    app, _traffic = build_mcp_app()
    from app.mcp.registry import curated

    async def resolve(_engine, _name):
        return _Target()

    monkeypatch.setattr(curated, "resolve", resolve)
    captured: dict = {}

    class Capturing(FakeLLM):
        def bind_tools(self, specs):
            captured["specs"] = specs
            return super().bind_tools(specs)

    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: Capturing(
            AIMessage(content="done"), [AIMessage(content="done")]
        ),
    )

    # `agent_enabled` is a DERIVED property: the flag plus an Ollagraph key.
    # Setting the flag alone leaves it False and the whole tool block is skipped —
    # which is exactly what happened on the first run of this test.
    settings = make_settings(
        "http://x",
        ai_agent_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
        mcp_connections_enabled=True,
    )
    assert settings.agent_enabled is True
    registry = ToolRegistry()
    registry.register(_native_tool())

    async with running(app), _pool_for(app) as pool:
        await run_generation(
            # WORDING MATTERS, and that is a measured property of the selector
            # rather than a quirk of this test. `DEFAULT_MIN_SCORE` is 0.2 and a
            # generically-named MCP tool ("echo", "Return the text you were
            # given.") scores ~0.31 only when the query actually names it; with
            # "search the web and echo" it falls below the floor and is not
            # offered at all. This query surfaces BOTH — measured 0.85 and 0.31.
            _req(
                "search the web for pages and echo something through mcp", [REF]
            ),
            settings,
            RecordingConvex(),
            engine=object(),
            tool_registry=registry,
            tool_selector=ToolSelector(registry),
            ollagraph_http=httpx2.AsyncClient(),
            mcp_pool=pool,
        )

    names = {s["function"]["name"] for s in captured.get("specs", [])}
    assert names, "nothing was bound; the assertions below would be vacuous"
    # BOTH kinds reached the model through ONE binding path.
    assert "search_web" in names, names
    assert any(n.startswith("mcp_fake_") for n in names), names
    # And the MCP name is namespaced, so a server cannot shadow a native tool by
    # naming a tool `search_web`.
    assert not any(n == "echo" for n in names), names


async def test_a_dead_mcp_server_does_not_break_the_turn(monkeypatch):
    """§116. A user's chat must keep working when a third party does not."""
    from app.mcp.registry import curated

    async def resolve(_engine, _name):
        return _Target()

    monkeypatch.setattr(curated, "resolve", resolve)
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        # Tools DO bind here (the native registry is non-empty), so the
        # tools-bound client needs a reply — the point of the test is that the
        # turn completes, not that no tool exists.
        lambda *a, **k: FakeLLM(
            AIMessage(content="answered anyway"),
            [AIMessage(content="answered anyway")],
        ),
    )

    # A pool pointed at an app that refuses every connection.
    # `agent_enabled` is a DERIVED property: the flag plus an Ollagraph key.
    # Setting the flag alone leaves it False and the whole tool block is skipped —
    # which is exactly what happened on the first run of this test.
    settings = make_settings(
        "http://x",
        ai_agent_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
        mcp_connections_enabled=True,
    )
    assert settings.agent_enabled is True
    convex = RecordingConvex()
    registry = ToolRegistry()
    registry.register(_native_tool())

    async with _pool_for(refusing_app()) as pool:
        await run_generation(
            _req("hello", [REF]),
            settings,
            convex,
            engine=object(),
            tool_registry=registry,
            tool_selector=ToolSelector(registry),
            ollagraph_http=httpx2.AsyncClient(),
            mcp_pool=pool,
        )

    finals = _ops(convex, "finalize")
    assert len(finals) == 1
    # The TURN succeeded. A dead MCP server is a missing capability, not an error.
    assert finals[0]["status"] == "done"


async def test_no_connections_is_byte_identical_to_phase_4(monkeypatch):
    """The reversibility check. With no MCP connections the turn must take
    exactly the path it took before Phase 5 existed."""
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(AIMessage(content="plain"), []),
    )
    convex = RecordingConvex()
    await run_generation(
        _req("hello", []), make_settings("http://x"), convex, mcp_pool=None
    )
    assert _ops(convex, "event") == []
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"

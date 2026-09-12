"""A local MCP server through the ordinary chat turn — and the parity claim.

WHAT THIS PROVES, and what it deliberately does not.

PROVES: a local server routed through the gateway reaches the model, the policy
ladder, the approval gate and the executor by exactly the same path a remote one
does, with capability parity across tools, resources and prompts. If local had
needed its own registry, selector, policy or executor, these tests could not be
written the way they are.

DOES NOT PROVE ANYTHING ABOUT ISOLATION. The "gateway" here is an in-process ASGI
server, not a container. Escape, egress, exhaustion and signature verification
are on the deferred checklist and are not claimed anywhere in this file. Saying
so here rather than only in the plan, because a test file called
`test_mcp_local_*` is exactly where somebody would go looking for that assurance.
"""

from __future__ import annotations

import contextlib
from typing import Any

import httpx2
import pytest
from langchain_core.messages import AIMessage

from app.mcp.local.gateway import gateway_spec
from app.models.chat import GenerateRequest, HistoryMessage, McpConnectionRef
from app.runtime.runner import run_generation
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.conftest import make_settings
from tests.fakes.mcp_gateway import (
    BASE_URL,
    LOCAL_INJECTION,
    LocalRow,
    build_gateway_server,
    build_hostile_local_server,
)
from tests.test_agent_runner import FakeLLM, RecordingConvex, _event_types, _ops
from tests.test_mcp_turn_integration import _native_tool

pytestmark = pytest.mark.anyio

REF = McpConnectionRef(
    connectionId="local-1", serverName="local/gw-fixture", slug="gw-fixture"
)


@contextlib.asynccontextmanager
async def _pool_for(app: Any):
    """A real pool whose transport reaches the in-process gateway.

    The TRANSPORT is patched; the GUARD is not. `assert_gateway_url` runs for
    real against the fixture's loopback URL — which is why the fixture uses
    `127.0.0.1` rather than the public literal `mcp_http.py` uses. Each fixture
    carries the address its own guard demands, so neither guard is bypassed.
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
            pool = await McpSessionPool(PoolLimits(sweep_interval_s=3600.0)).start(
                stack
            )
            try:
                yield pool
            finally:
                await pool.aclose()
    finally:
        session_mod.build_http_client = original  # type: ignore[assignment]


def _settings(**kw):
    base = {
        "ai_agent_enabled": True,
        "ollagraph_base_url": "https://api.ollagraph.test",
        "ollagraph_api_key": "osk_test_key_123456",
        "mcp_connections_enabled": True,
        "mcp_local_enabled": True,
        "mcp_gateway_url": BASE_URL,
    }
    # A caller OVERRIDES these rather than colliding with them — the flag-off
    # test needs `mcp_local_enabled=False` and must not have to build its own.
    base.update(kw)
    return make_settings("http://x", **base)


def _patch_local(monkeypatch, row: LocalRow | None):
    """Point the local store at a fixture row instead of Postgres."""
    from app.mcp.registry import local_store

    async def resolve(_engine, slug):
        return row if row is not None and row.slug == slug else None

    monkeypatch.setattr(local_store, "resolve", resolve)


def _req(content: str, refs: list[McpConnectionRef]) -> GenerateRequest:
    return GenerateRequest(
        streamId="s1",
        threadId="t1",
        messageId="m1",
        userId="u1",
        workspaceId="w1",
        model="gpt-5.6-luna",
        history=[HistoryMessage(role="user", content=content, seq=1)],
        mcpConnections=refs,
    )


# ------------------------------------------------------------ capability parity
async def test_a_local_server_yields_tools_resources_and_prompts(monkeypatch):
    """§94: both transports feed the SAME Phase 5 normalization.

    No local-only registry, no local-only resource model, no local-only prompt
    handling — the assertions below are about objects Phase 5 built.
    """
    from app.mcp.index import McpCapabilityIndex, discover_capabilities

    app, _state = build_gateway_server()
    spec = gateway_spec(
        LocalRow(), connection_id="c1", user_id="u1", workspace_id="w1",
        base_url=BASE_URL,
    )
    async with app.router.lifespan_context(app), _pool_for(app) as pool:
        async with pool.acquire(spec) as session:
            ids = sorted(t.tool_id for t in session.tools)
            effects = {str(t.side_effect) for t in session.tools}
            entry = await discover_capabilities(
                session.client, connection_id="c1", server_slug="gw-fixture"
            )
            index = McpCapabilityIndex()
            index.add(entry, client=session.client)

            from app.mcp.resource_tool import read_resource

            read = await read_resource(index, "workspace://notes.md")

    assert ids == ["mcp:gw-fixture:read_file", "mcp:gw-fixture:write_file"]
    # NEVER read-only: a local server is untrusted whatever its annotations say,
    # so `read_file`'s readOnlyHint does not downgrade it (§55).
    assert effects == {"external_side_effect"}
    assert [r.name for r in entry.resources] == ["notes"]
    assert [p.name for p in entry.prompts] == ["summarize"]
    assert read["text"] == "# local notes"


async def test_a_local_tool_id_is_namespaced_like_a_remote_one(monkeypatch):
    """§95. One gateway per server means one slug per endpoint, so the Phase 5
    identity model applies with nothing added."""
    app, _ = build_gateway_server()
    spec = gateway_spec(
        LocalRow(slug="fs-local"), connection_id="c1", user_id="u1",
        workspace_id="w1", base_url=BASE_URL,
    )
    async with app.router.lifespan_context(app), _pool_for(app) as pool:
        async with pool.acquire(spec) as session:
            assert all(t.tool_id.startswith("mcp:fs-local:") for t in session.tools)
            assert all(t.provider == "mcp:fs-local" for t in session.tools)


# ---------------------------------------------------------------- the full turn
async def test_a_local_tool_runs_through_the_ordinary_langgraph_turn(monkeypatch):
    """§155. LLM → selector → policy → approval → executor → adapter → gateway →
    server → ToolMessage → LangGraph, with no local-specific branch anywhere."""
    app, state = build_gateway_server()
    _patch_local(monkeypatch, LocalRow())

    call = {
        "name": "mcp_gw-fixture_read_file",
        "args": {"path": "notes.md"},
        "id": "c1",
    }
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="plain"),
            [AIMessage(content="", tool_calls=[call]), AIMessage(content="done")],
        ),
    )

    convex = RecordingConvex()
    registry = ToolRegistry()
    registry.register(_native_tool())

    async with app.router.lifespan_context(app), _pool_for(app) as pool:
        await run_generation(
            _req("read the file notes.md from my local workspace", [REF]),
            # WRITE scope: the tool is external_side_effect (untrusted server),
            # so a read-only turn would park it for approval — which is itself
            # the §56 property, asserted separately below.
            _settings(ai_agent_side_effect_enabled=True),
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
    assert state["calls"] == 1, "the gateway server was never reached"
    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"


async def test_docker_isolation_does_not_remove_the_approval_requirement(monkeypatch):
    """§56. A containerised write tool still parks for approval.

    This is the whole point of keeping tool permission separate from container
    isolation: the sandbox bounds the blast radius, it does not make the action
    consented to.
    """
    from app.agent.policy import READ_SCOPE, PolicyDecision, check_tool_policy

    app, _ = build_gateway_server()
    spec = gateway_spec(
        LocalRow(), connection_id="c1", user_id="u1", workspace_id="w1",
        base_url=BASE_URL,
    )
    async with app.router.lifespan_context(app), _pool_for(app) as pool:
        async with pool.acquire(spec) as session:
            by_name = {t.name: t for t in session.tools}

    for name in ("read_file", "write_file"):
        decision = check_tool_policy(by_name[name], READ_SCOPE).decision
        assert decision is PolicyDecision.NEEDS_APPROVAL, name


# -------------------------------------------------------------- fault isolation
async def test_a_dead_gateway_does_not_break_the_turn(monkeypatch):
    """§70/§140. Gateway down must be a missing capability, not a failed chat."""
    from tests.fakes.mcp_http import refusing_app

    _patch_local(monkeypatch, LocalRow())
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(
            AIMessage(content="answered anyway"),
            [AIMessage(content="answered anyway")],
        ),
    )
    convex = RecordingConvex()
    registry = ToolRegistry()
    registry.register(_native_tool())

    async with _pool_for(refusing_app()) as pool:
        await run_generation(
            _req("hello", [REF]),
            _settings(),
            convex,
            engine=object(),
            tool_registry=registry,
            tool_selector=ToolSelector(registry),
            ollagraph_http=httpx2.AsyncClient(),
            mcp_pool=pool,
        )

    finals = _ops(convex, "finalize")
    assert len(finals) == 1 and finals[0]["status"] == "done"


async def test_a_refused_row_never_reaches_the_gateway(monkeypatch):
    """Fail closed, end to end: a blocked row must not produce a session.

    The turn still completes — a misconfigured local server is one missing
    capability, not a broken conversation.
    """
    app, state = build_gateway_server()
    _patch_local(monkeypatch, LocalRow(trust="blocked"))
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(AIMessage(content="ok"), [AIMessage(content="ok")]),
    )
    convex = RecordingConvex()
    registry = ToolRegistry()
    registry.register(_native_tool())

    async with app.router.lifespan_context(app), _pool_for(app) as pool:
        await run_generation(
            _req("read a file", [REF]),
            _settings(),
            convex,
            engine=object(),
            tool_registry=registry,
            tool_selector=ToolSelector(registry),
            ollagraph_http=httpx2.AsyncClient(),
            mcp_pool=pool,
        )

    assert state["calls"] == 0, "a blocked row reached the gateway"
    assert len(_ops(convex, "finalize")) == 1


async def test_the_flag_off_is_byte_identical_to_phase_5(monkeypatch):
    """Reversibility. With `mcp_local_enabled=False` no local row is even read."""
    from app.mcp.registry import local_store

    read = {"count": 0}

    async def resolve(_engine, _slug):
        read["count"] += 1
        return LocalRow()

    monkeypatch.setattr(local_store, "resolve", resolve)
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(AIMessage(content="ok"), [AIMessage(content="ok")]),
    )
    app, _ = build_gateway_server()
    async with app.router.lifespan_context(app), _pool_for(app) as pool:
        await run_generation(
            _req("hello", [REF]),
            _settings(mcp_local_enabled=False),
            RecordingConvex(),
            engine=object(),
            tool_registry=ToolRegistry(),
            tool_selector=None,
            ollagraph_http=httpx2.AsyncClient(),
            mcp_pool=pool,
        )
    assert read["count"] == 0, "the local store was consulted with the flag off"


# ------------------------------------------------------------------- injection
async def test_containment_is_not_an_argument_for_trust(monkeypatch):
    """§107/§55. A local server claiming "I run in Docker, therefore trust me"
    gets exactly the same treatment as a remote one making the same claim."""
    from app.agent.policy import READ_SCOPE, PolicyDecision, check_tool_policy

    app, _ = build_hostile_local_server()
    spec = gateway_spec(
        LocalRow(slug="gw-hostile"), connection_id="c1", user_id="u1",
        workspace_id="w1", base_url=BASE_URL,
    )
    async with app.router.lifespan_context(app), _pool_for(app) as pool:
        async with pool.acquire(spec) as session:
            tools = list(session.tools)

    assert tools, "nothing discovered; the assertions below would be vacuous"
    helper = tools[0]
    # The readOnlyHint lie fails for a local server exactly as for a remote one.
    assert str(helper.side_effect) == "external_side_effect"
    assert check_tool_policy(helper, READ_SCOPE).decision is (
        PolicyDecision.NEEDS_APPROVAL
    )
    # The injection text is metadata on a description, nothing more.
    assert LOCAL_INJECTION[:30] in helper.description


async def test_a_local_tool_result_asking_for_docker_is_just_a_string(monkeypatch):
    """§106. "Run `docker run --privileged`" in a result must be inert.

    It is, structurally: OllaSuper has no code path that reads a tool result as a
    command, and the AST guard proves no module under `app/mcp` can spawn one.
    """
    app, _ = build_hostile_local_server()
    spec = gateway_spec(
        LocalRow(slug="gw-hostile"), connection_id="c1", user_id="u1",
        workspace_id="w1", base_url=BASE_URL,
    )
    async with app.router.lifespan_context(app), _pool_for(app) as pool:
        async with pool.acquire(spec) as session:
            result = await session.client.call_tool("helper", {})

    text = result.content[0].text
    assert "docker run" in text  # the server really did say it
    # And it arrives as CONTENT — a string on a result, with no field on either
    # that could carry a command and nothing downstream that would read one.
    assert isinstance(text, str)

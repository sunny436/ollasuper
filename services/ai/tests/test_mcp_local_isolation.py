"""Local MCP: reachability, three-way parity, and the isolation claims.

THREE THINGS THE FIRST PASS LEFT AS ASSERTIONS RATHER THAN PROOFS, closed here.

1. REACHABILITY (§96). The local path was unreachable end to end and the tests
   did not notice, because they drove the turn directly. `lifecycle.preflight`
   resolved only the curated table, so a local server answered `unsupported`,
   never reached `ready`, and `dispatchPayload` — which sends only ready
   connections — never carried it. Measured before the fix:
   `state=unsupported · kind=unsupported_transport`. The first test below is the
   regression that stops it happening again.

2. THREE-WAY PARITY (§139). Native + remote + local in ONE turn, through one
   registry, one selector, one policy and one executor.

3. ISOLATION (§152/§153). Cross-tenant and cross-server. The pool key makes both
   structural — but Phase 5 taught that "structural" without a test is a claim,
   not a proof, so they are proven here.

WHAT IS STILL NOT PROVEN, said plainly: none of this is container isolation. The
"gateway" is an in-process ASGI server. Escape, egress and exhaustion need a
Docker host and are on the deferred checklist.
"""

from __future__ import annotations

import contextlib
from typing import Any

import httpx2
import pytest
from langchain_core.messages import AIMessage

from app.mcp import lifecycle
from app.mcp.local.gateway import gateway_spec
from app.models.chat import GenerateRequest, HistoryMessage, McpConnectionRef
from app.runtime.runner import run_generation
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.conftest import make_settings
from tests.fakes.mcp_gateway import BASE_URL, LocalRow, build_gateway_server
from tests.test_agent_runner import FakeLLM, RecordingConvex
from tests.test_mcp_local_turn import _pool_for, _settings
from tests.test_mcp_turn_integration import _native_tool

pytestmark = pytest.mark.anyio


async def _none(_engine, _name):
    return None


# ============================================================== reachability
async def test_a_local_server_can_actually_reach_ready(monkeypatch):
    """THE regression for the bug that made Phase 6 inert.

    `dispatchPayload` sends only `ready` connections. If preflight cannot say a
    local server is connectable, the connection never becomes ready, the turn
    never receives it, and every other local test passes while the feature does
    nothing in a real deployment.
    """
    from app.mcp.registry import local_store

    monkeypatch.setattr(local_store, "resolve", lambda _e, s: _row_for(s))
    report = await lifecycle.preflight(
        object(),
        "local/gw-fixture",
        resolve_target=_none,
        settings=make_settings("http://x", mcp_local_enabled=True),
    )
    assert report.as_dict()["state"] == "configured", report.as_dict()
    assert report.as_dict()["error_kind"] is None


async def _row_for(slug: str):
    return LocalRow() if slug == "gw-fixture" else None


async def test_a_local_server_is_unsupported_when_the_flag_is_off(monkeypatch):
    """The control. With local disabled the answer must be the ordinary
    "not curated" refusal, not a half-open path."""
    from app.mcp.registry import local_store

    monkeypatch.setattr(local_store, "resolve", lambda _e, s: _row_for(s))
    report = await lifecycle.preflight(
        object(),
        "local/gw-fixture",
        resolve_target=_none,
        settings=make_settings("http://x", mcp_local_enabled=False),
    )
    assert report.as_dict()["state"] == "unsupported"


@pytest.mark.parametrize(
    ("kw", "fragment"),
    [
        ({"trust": "blocked"}, "blocked"),
        ({"enabled": False}, "not enabled"),
        ({"image_digest": "latest"}, "pinned sha256"),
        ({"env_allow": ["MCP_CREDENTIAL_KEYS"]}, "MCP_CREDENTIAL_KEYS"),
    ],
    ids=["blocked", "disabled", "unpinned", "denied-env"],
)
async def test_a_refused_row_is_unsupported_at_preflight(monkeypatch, kw, fragment):
    """Fail closed at the FRONT of the flow, not only at connect time.

    A row that will never be allowed to start must not present as connectable —
    a user should not be able to create a connection that can only ever fail.
    """
    from app.mcp.registry import local_store

    async def resolve(_engine, _slug):
        return LocalRow(**kw)

    monkeypatch.setattr(local_store, "resolve", resolve)
    report = await lifecycle.preflight(
        object(),
        "local/gw-fixture",
        resolve_target=_none,
        settings=make_settings("http://x", mcp_local_enabled=True),
    )
    d = report.as_dict()
    assert d["state"] == "unsupported"
    assert fragment in str(d["error_detail"]), d["error_detail"]


async def test_the_remote_refusal_in_compat_is_untouched():
    """Local became assessable WITHOUT weakening the remote rule.

    `compat.assess` still refuses a packages-only server with the same message
    it always has — local simply does not go through it, because a local row has
    no `remotes`/`packages` for it to reason about.
    """
    from app.mcp.compat import assess

    verdict = assess(
        {
            "remotes": [],
            "packages": [{"registryType": "npm", "identifier": "x"}],
            "auth_kind": "none",
        }
    )
    assert not verdict.ok
    assert "local execution is not supported" in verdict.reason


# ========================================================== three-way parity
async def test_native_remote_and_local_tools_coexist_in_one_turn(monkeypatch):
    """§139/§158. One registry, one selector, one policy, one executor.

    If local had needed its own anything, this test could not be written — which
    is precisely why it is the one that matters most in this file.
    """
    from tests.fakes.mcp_http import build_mcp_app, running
    from tests.test_mcp_turn_integration import _Target

    local_app, _local_state = build_gateway_server()
    remote_app, _traffic = build_mcp_app()

    # Each ref resolves to its own substrate: the remote one through the curated
    # table, the local one through the local allowlist.
    from app.mcp.registry import curated, local_store

    async def resolve_remote(_engine, name):
        return _Target() if name == "test.fixture/fake" else None

    async def resolve_local(_engine, slug):
        return LocalRow() if slug == "gw-fixture" else None

    monkeypatch.setattr(curated, "resolve", resolve_remote)
    monkeypatch.setattr(local_store, "resolve", resolve_local)

    captured: dict = {}

    class Capturing(FakeLLM):
        def bind_tools(self, specs):
            captured["names"] = {s["function"]["name"] for s in specs}
            return super().bind_tools(specs)

    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: Capturing(
            AIMessage(content="done"), [AIMessage(content="done")]
        ),
    )

    registry = ToolRegistry()
    registry.register(_native_tool())
    refs = [
        McpConnectionRef(
            connectionId="remote-1", serverName="test.fixture/fake", slug="fake"
        ),
        McpConnectionRef(
            connectionId="local-1", serverName="local/gw-fixture", slug="gw-fixture"
        ),
    ]

    async with running(remote_app), local_app.router.lifespan_context(local_app):
        async with _pool_by_slug(
            {"fake": remote_app, "gw-fixture": local_app}
        ) as pool:
            await run_generation(
                _req(
                    "search the web for pages, echo something through mcp, and "
                    "read the file notes.md",
                    refs,
                ),
                # ELEVATED, and that is the point rather than a workaround.
                # A local server is `trusted=False` (§55), so its tools classify
                # `external_side_effect` — and `ToolFilters(max_side_effect=...)`
                # drops those BEFORE ranking unless the turn is elevated. So a
                # read-only turn binds native + remote and NOT local, which is
                # the correct refusal, not a bug. Proving three-way coexistence
                # therefore requires the turn where all three are admissible.
                _settings(ai_agent_side_effect_enabled=True),
                RecordingConvex(),
                engine=object(),
                tool_registry=registry,
                tool_selector=ToolSelector(registry),
                ollagraph_http=httpx2.AsyncClient(),
                mcp_pool=pool,
            )

    names = captured.get("names", set())
    assert names, "nothing bound; the assertions below would be vacuous"
    # All THREE kinds, namespaced so none can shadow another.
    assert "search_web" in names, names
    assert any(n.startswith("mcp_fake_") for n in names), names
    assert any(n.startswith("mcp_gw-fixture_") for n in names), names


async def test_a_read_only_turn_does_not_even_offer_the_local_tool(monkeypatch):
    """The complement, so the elevation above is not an invisible fudge.

    Approval is the control everyone names, but it is the SECOND one here. The
    first is that a read-only turn never binds a local tool at all, because
    `ToolFilters(max_side_effect=READ_ONLY)` drops `external_side_effect` tools
    BEFORE ranking — and a local server is `trusted=False`, so all of its tools
    are exactly that, `readOnlyHint` notwithstanding.

    This is the same fixture and the same wiring as the test above with ONE flag
    flipped, which is what makes it evidence rather than decoration: native and
    remote still bind, so the turn plainly worked; only local is withheld.
    """
    from tests.fakes.mcp_http import build_mcp_app, running
    from tests.test_mcp_turn_integration import _Target

    local_app, _local_state = build_gateway_server()
    remote_app, _traffic = build_mcp_app()

    from app.mcp.registry import curated, local_store

    async def resolve_remote(_engine, name):
        return _Target() if name == "test.fixture/fake" else None

    async def resolve_local(_engine, slug):
        return LocalRow() if slug == "gw-fixture" else None

    monkeypatch.setattr(curated, "resolve", resolve_remote)
    monkeypatch.setattr(local_store, "resolve", resolve_local)

    captured: dict = {}

    class Capturing(FakeLLM):
        def bind_tools(self, specs):
            captured["names"] = {s["function"]["name"] for s in specs}
            return super().bind_tools(specs)

    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: Capturing(
            AIMessage(content="done"), [AIMessage(content="done")]
        ),
    )

    registry = ToolRegistry()
    registry.register(_native_tool())
    refs = [
        McpConnectionRef(
            connectionId="remote-1", serverName="test.fixture/fake", slug="fake"
        ),
        McpConnectionRef(
            connectionId="local-1", serverName="local/gw-fixture", slug="gw-fixture"
        ),
    ]

    async with running(remote_app), local_app.router.lifespan_context(local_app):
        async with _pool_by_slug(
            {"fake": remote_app, "gw-fixture": local_app}
        ) as pool:
            await run_generation(
                _req(
                    "search the web for pages, echo something through mcp, and "
                    "read the file notes.md",
                    refs,
                ),
                # The ONLY difference from the test above.
                _settings(ai_agent_side_effect_enabled=False),
                RecordingConvex(),
                engine=object(),
                tool_registry=registry,
                tool_selector=ToolSelector(registry),
                ollagraph_http=httpx2.AsyncClient(),
                mcp_pool=pool,
            )

    names = captured.get("names", set())
    assert names, "nothing bound; the assertion below would be vacuous"
    assert "search_web" in names, names
    assert not any(n.startswith("mcp_gw-fixture_") for n in names), names


async def test_a_local_server_contributes_resources_and_prompts_through_the_turn(
    monkeypatch,
):
    """The integration the unit test could not see, and a real bug's regression.

    `test_a_local_server_yields_tools_resources_and_prompts` calls
    `discover_capabilities` DIRECTLY, so it proved the gateway serves resources
    and prompts and nothing about whether a turn ever asks for them. It did not:
    the local branch sets `target = None`, discovery read `target.slug`, the
    AttributeError landed in the `except` that only logs
    `mcp.turn_capabilities_unavailable`, and every local server silently
    contributed ZERO resources and ZERO prompts in a real turn.

    Tools were unaffected — they come from the handshake, not from a list call —
    which is exactly why nothing went red. That is the Phase 5 lesson again: a
    unit test that bypasses the integration proves the unit, and the integration
    is where the wiring rots. So this one goes through `mcp_for_turn`.
    """
    from app.mcp.registry import local_store
    from app.mcp.turn import mcp_for_turn

    local_app, _state = build_gateway_server()

    async def resolve_local(_engine, slug):
        return LocalRow() if slug == "gw-fixture" else None

    monkeypatch.setattr(local_store, "resolve", resolve_local)

    ref = McpConnectionRef(
        connectionId="local-1", serverName="local/gw-fixture", slug="gw-fixture"
    )
    async with local_app.router.lifespan_context(local_app):
        async with _pool_by_slug({"gw-fixture": local_app}) as pool:
            async with mcp_for_turn(
                pool,
                [ref],
                user_id="u1",
                workspace_id="w1",
                resolve_target=_none,
                engine=object(),
                settings=_settings(),
            ) as caps:
                assert caps.failures == [], caps.failures
                assert [r.name for r in caps.index.resources()] == ["notes"]
                assert [p.name for p in caps.index.prompts()] == ["summarize"]


@contextlib.asynccontextmanager
async def _pool_by_slug(apps: dict[str, Any]):
    """One pool routing each spec to its own in-process server, by slug.

    Both substrates in one turn is the whole point of §139, so the transport has
    to be able to reach both — while `assert_dialable` and `assert_gateway_url`
    each still run for real against their own fixture's URL.
    """
    from contextlib import AsyncExitStack

    import app.mcp.session as session_mod
    from app.mcp.session import McpSessionPool, PoolLimits
    from app.mcp.transport import build_http_client as real_build

    def routed(spec_, headers, recorder, **kwargs):
        # BY SLUG, explicitly. An earlier version keyed on one hardcoded slug,
        # so a test with two local servers silently sent both to one app and
        # then blamed the session failure on isolation.
        app = apps[spec_.identity.slug]
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


# ================================================================= isolation
async def test_two_users_never_share_a_local_session(monkeypatch):
    """§152. The pool key is `(user, workspace, connection)`.

    A container carrying one user's data must never be reached by another, and
    the key is what makes that structural — but structural without a test is a
    claim, so here it is measured.
    """
    app, _ = build_gateway_server()
    specs = [
        gateway_spec(
            LocalRow(),
            connection_id="conn-shared",
            user_id=user,
            workspace_id="w1",
            base_url=BASE_URL,
        )
        for user in ("user-a", "user-b")
    ]

    async with app.router.lifespan_context(app), _pool_for(app) as pool:
        async with pool.acquire(specs[0]) as a, pool.acquire(specs[1]) as b:
            assert a.key != b.key, "two users shared one pooled session"
            assert a.key[0] == "user-a" and b.key[0] == "user-b"
            assert a.client is not b.client


async def test_two_workspaces_never_share_a_local_session():
    app, _ = build_gateway_server()
    specs = [
        gateway_spec(
            LocalRow(),
            connection_id="conn-shared",
            user_id="user-a",
            workspace_id=ws,
            base_url=BASE_URL,
        )
        for ws in ("ws-1", "ws-2")
    ]
    async with app.router.lifespan_context(app), _pool_for(app) as pool:
        async with pool.acquire(specs[0]) as a, pool.acquire(specs[1]) as b:
            assert a.key != b.key


async def test_two_local_servers_get_separate_sessions_and_tool_namespaces():
    """§153. One gateway per server, so Server A cannot reach Server B's session.

    This is the payoff of refusing to depend on the gateway's undocumented
    tool-naming convention: separation is a property of the architecture rather
    than of a string format.
    """
    app_a, _ = build_gateway_server(name="srv-a", port=8811)
    app_b, _ = build_gateway_server(name="srv-b", port=8812)
    spec_a = gateway_spec(
        LocalRow(slug="srv-a", gateway_port=8811),
        connection_id="conn-a",
        user_id="u1",
        workspace_id="w1",
        base_url=BASE_URL,
    )
    spec_b = gateway_spec(
        LocalRow(slug="srv-b", gateway_port=8812),
        connection_id="conn-b",
        user_id="u1",
        workspace_id="w1",
        base_url=BASE_URL,
    )

    async with _pool_by_slug({"srv-a": app_a, "srv-b": app_b}) as pool:
        async with app_a.router.lifespan_context(app_a):
            async with app_b.router.lifespan_context(app_b):
                async with pool.acquire(spec_a) as a, pool.acquire(spec_b) as b:
                    assert a.key != b.key
                    assert a.client is not b.client
                    ids_a = {t.tool_id for t in a.tools}
                    ids_b = {t.tool_id for t in b.tools}

    # Distinct namespaces, so neither server's tools can be reached through the
    # other's id — the same property Phase 5 proved for two remote servers.
    assert ids_a and ids_b
    assert ids_a.isdisjoint(ids_b)
    assert all(i.startswith("mcp:srv-a:") for i in ids_a)
    assert all(i.startswith("mcp:srv-b:") for i in ids_b)


async def test_each_local_server_dials_only_its_own_gateway_port():
    """One endpoint per server. A shared port would put two servers' tools behind
    one session and collapse the per-server trust the whole design rests on."""
    a = gateway_spec(
        LocalRow(slug="a", gateway_port=8811),
        connection_id="c1", user_id="u", workspace_id="w", base_url=BASE_URL,
    )
    b = gateway_spec(
        LocalRow(slug="b", gateway_port=8812),
        connection_id="c2", user_id="u", workspace_id="w", base_url=BASE_URL,
    )
    assert a.endpoint_url.endswith(":8811/mcp")
    assert b.endpoint_url.endswith(":8812/mcp")
    assert a.endpoint_url != b.endpoint_url

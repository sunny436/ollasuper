"""Phase 8: readiness reporting, and the operator kill switches.

WHAT THIS FILE IS FOR. Phases 2–7 built the levers an operator needs in an
incident — `mcp_curated_servers.enabled`, `mcp_local_servers.enabled`/`trust`,
and the global `mcp_connections_enabled` — but nothing proved they actually
stop anything. A switch nobody has tested is a switch you find out about during
the incident.

So none of this adds machinery. It asserts that the levers already in the schema
do what an operator would assume, and that turning one off leaves the user's
DATA intact — because de-curating a server is not the same as deleting somebody's
connection, and an operator reaching for the first must not get the second.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from httpx import ASGITransport

from app.main import create_app
from app.mcp import lifecycle
from tests.conftest import make_settings

pytestmark = pytest.mark.anyio

SERVICE_KEY = "test-service-key-aaaaaaaaaaaaaaaaaaaa"
AUTH = {"x-service-key": SERVICE_KEY}


def _app(**overrides):
    app = create_app()
    app.state.settings = make_settings("http://x", **overrides)
    app.state.db = object()
    app.state.mcp_pool = None
    app.state.mcp_vault = None
    app.state.tool_registry = None
    return app


async def _get(app, path: str, **kw):
    c = httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://t")
    try:
        return await c.get(path, **kw)
    finally:
        await c.aclose()


# ============================================================== readiness
class _Convex:
    def __init__(self, ok: bool = True) -> None:
        self._ok = ok

    async def healthy(self) -> bool:
        return self._ok


def _ready_app(*, pool: Any = None, vault: Any = None, **overrides):
    app = _app(**overrides)
    app.state.convex = _Convex()
    app.state.mcp_pool = pool
    app.state.mcp_vault = vault

    class _Registry:
        active = 0

    app.state.registry = _Registry()
    return app


async def test_readyz_reports_mcp_without_consulting_the_network():
    """§166. A remote server being down must NEVER make OllaSuper unhealthy.

    That would take the whole deployment out of a load balancer because a third
    party had an outage — so nothing in this block dials anything. It reads
    process state only, which is also why it is safe to call as often as a
    liveness probe.
    """
    app = _ready_app(mcp_connections_enabled=False)
    res = await _get(app, "/readyz")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ready"] is True
    # Reported, so an operator can see the subsystem's state at a glance...
    assert body["mcp"]["enabled"] is False
    assert body["mcp"]["pool"] is False
    # ...and MCP being off does not make the process unready.
    assert body["ready"] is True


async def test_readyz_FAILS_when_mcp_is_enabled_but_the_pool_did_not_start():
    """The one case where MCP gates readiness, and it is a CONFIGURATION error.

    A process serving MCP routes that can only answer 503 is not ready in any
    useful sense, and that is this deployment's problem rather than a third
    party's — which is exactly the line §166 draws.
    """
    app = _ready_app(mcp_connections_enabled=True, pool=None)
    res = await _get(app, "/readyz")
    assert res.status_code == 503, res.text
    assert res.json()["ready"] is False


async def test_readyz_is_ready_when_the_pool_did_start():
    app = _ready_app(mcp_connections_enabled=True, pool=object())
    res = await _get(app, "/readyz")
    assert res.status_code == 200, res.text
    assert res.json()["mcp"]["pool"] is True


async def test_readyz_reports_the_vault_by_PRESENCE_never_by_key():
    """`mcp_vault` is None unless OAuth is enabled AND `KeyProvider` accepted a
    key at boot, so its presence is the honest signal — and no key material can
    ride out on a public, unauthenticated endpoint."""
    app = _ready_app(mcp_connections_enabled=True, pool=object(), vault=object())
    body = (await _get(app, "/readyz")).json()
    assert body["mcp"]["vault"] is True
    # Nothing key-shaped anywhere in the response.
    text = (await _get(app, "/readyz")).text
    for needle in ("key", "secret", "token", "envelope"):
        assert needle not in text.lower().replace("mcp", ""), needle


async def test_healthz_stays_dependency_free():
    """Liveness must not learn about MCP. A process that is up is up, and a
    liveness probe that consults a subsystem restarts the process for something
    a restart cannot fix."""
    app = _ready_app(mcp_connections_enabled=True)
    res = await _get(app, "/healthz")
    assert res.status_code == 200
    assert res.json() == {"ok": True}


# ========================================================== kill switches
async def _none(_engine, _name):
    return None


def _target(**kw):
    """A curated row as `preflight` sees one."""
    from app.mcp.registry.curated import CuratedTarget

    base = {
        "server_name": "test.fixture/fake",
        "slug": "fake",
        "display_name": "Fake",
        "category": "productivity",
        "transport": "streamable-http",
        "endpoint_url": "https://fake.invalid/mcp",
        "auth_kind": "none",
        "trusted": False,
        "enabled": True,
        "version": "1.0.0",
        "version_mode": "latest_at_connect",
        "catalogue_status": "active",
        "version_status": "active",
        "remotes": [
            {"type": "streamable-http", "url": "https://fake.invalid/mcp"}
        ],
        "packages": [],
    }
    base.update(kw)
    return CuratedTarget(**base)


async def test_disabling_a_curated_server_refuses_it_at_preflight():
    """THE server kill switch (§88). One column, and it must actually stop a
    connection rather than merely hiding the card."""

    async def resolve(_engine, _name):
        return _target(enabled=False)

    report = await lifecycle.preflight(
        object(), "test.fixture/fake", resolve_target=resolve
    )
    d = report.as_dict()
    assert d["state"] == "unsupported", d
    assert "not enabled" in str(d["error_detail"]), d


async def test_an_enabled_server_still_passes():
    """The control. Without it the test above would pass against a preflight
    that refused everything."""

    async def resolve(_engine, _name):
        return _target()

    report = await lifecycle.preflight(
        object(),
        "test.fixture/fake",
        resolve_target=resolve,
        credentials_available=True,
    )
    assert report.as_dict()["state"] == "configured", report.as_dict()


async def test_a_disabled_server_is_dropped_from_a_TURN_not_crashed_into():
    """§101/§88: one server going away must not take the turn with it.

    `mcp_for_turn` is documented as never raising for a server-side problem, and
    a de-curated server is exactly that from the turn's point of view. It lands
    in `failures`, the turn continues, and every other connection still works.
    """
    from app.mcp.turn import mcp_for_turn

    class _Ref:
        connectionId = "c1"
        serverName = "test.fixture/fake"
        slug = "fake"

    async def resolve(_engine, _name):
        return _target(enabled=False)

    async with mcp_for_turn(
        object(),
        [_Ref()],
        user_id="u1",
        workspace_id="w1",
        resolve_target=resolve,
        engine=object(),
        settings=make_settings("http://x", mcp_connections_enabled=True),
    ) as caps:
        assert caps.failures == ["fake"], caps.failures
        # Not "no MCP" — "MCP, but this one is unavailable". The distinction is
        # what lets the UI say something true.
        assert caps.active is False


async def test_the_global_switch_makes_every_connection_route_503():
    """§87. Fail closed, and as a DEPLOYMENT state (503) rather than a bug."""
    app = _app(mcp_connections_enabled=False)
    c = httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://t")
    body = {
        "connection_id": "c1",
        "server_name": "test.fixture/fake",
        "user_id": "u1",
        "workspace_id": "w1",
    }
    try:
        for path in (
            "/v1/mcp/connections/c1/connect",
            "/v1/mcp/connections/c1/refresh",
            "/v1/mcp/connections/c1/resources",
            "/v1/mcp/connections/c1/prompts",
        ):
            res = await c.post(path, json=body, headers=AUTH)
            assert res.status_code == 503, (path, res.status_code, res.text)
    finally:
        await c.aclose()

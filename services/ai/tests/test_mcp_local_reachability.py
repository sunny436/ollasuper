"""Can a local MCP server actually be CONNECTED? Driven through the HTTP route.

WHY THIS FILE EXISTS, AND WHY IT IS NOT test_mcp_local_isolation.py.

Phase 6 shipped believing local execution worked. It did not, and the tests said
it did, because every one of them drove a FUNCTION rather than the seam in front
of it. The closing audit for Phase 6 found `lifecycle.preflight` was never
local-aware and fixed it — then wrote a regression that called
`lifecycle.preflight` DIRECTLY with `settings=`. That proved the function and
nothing about whether anything calls it that way.

Nothing did. `lifecycle.connect` accepted `settings` and used it only for
`_timeouts`; the `preflight` call inside it never received it. So on the route
that actually makes a connection usable:

    POST /v1/mcp/connections/{id}/connect
      -> lifecycle.connect(settings=<passed>)
        -> preflight(...)                 <- settings NOT forwarded
          -> _local_report never fires
            -> state=unsupported
              -> connect returns early
                -> the row never reaches `ready`
                  -> dispatchPayload (ready only) never carries it

Two layers of fix were needed, not one: forwarding `settings`, and giving
`connect` the local branch — because even a passing preflight leaves
`curated.resolve` answering None for a server that has no curated row.

SO EVERY TEST BELOW POSTS TO THE ROUTE. Not `lifecycle.connect`, not
`preflight`. If the wiring between them breaks again, these go red; that is the
entire point, and it is the property the previous regression did not have.
"""

from __future__ import annotations

import contextlib

import httpx
import pytest
from httpx import ASGITransport

from app.main import create_app
from tests.conftest import make_settings
from tests.fakes.mcp_gateway import BASE_URL, LocalRow, build_gateway_server
from tests.test_mcp_local_isolation import _pool_by_slug

pytestmark = pytest.mark.anyio

SERVICE_KEY = "test-service-key-aaaaaaaaaaaaaaaaaaaa"
AUTH = {"x-service-key": SERVICE_KEY}

#: A local connection's body. `server_name` carries the `local/` prefix exactly
#: as `gateway_spec` mints it and as a Convex `mcpConnections` row would store it.
LOCAL_BODY = {
    "connection_id": "conn-local-1",
    "server_name": "local/gw-fixture",
    "user_id": "user-a",
    "workspace_id": "ws-1",
}


def _app(pool, **overrides):
    # A caller OVERRIDES these rather than colliding with them — the flag-off
    # test needs `mcp_local_enabled=False` and must not have to restate the
    # other two.
    base = {
        "mcp_connections_enabled": True,
        "mcp_local_enabled": True,
        "mcp_gateway_url": BASE_URL,
    }
    base.update(overrides)
    app = create_app()
    app.state.settings = make_settings("http://x", **base)
    # A sentinel: nothing in the local path touches the database except
    # `local_store.resolve`, which every test below replaces. If a code path
    # ever reaches the real catalogue it raises here rather than passing by
    # accident.
    app.state.db = object()
    app.state.mcp_pool = pool
    app.state.tool_registry = None
    return app


@contextlib.asynccontextmanager
async def _client(app):
    c = httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    try:
        yield c
    finally:
        await c.aclose()


def _patch(monkeypatch, row: LocalRow | None):
    """Point the local store at a fixture row and make the catalogue answer None.

    THE CATALOGUE IS PATCHED THROUGH `__kwdefaults__`, not through the module.
    `resolve_target` is a keyword default captured at import time and the router
    passes none of its own, so `monkeypatch.setattr(curated, "resolve", ...)`
    has no effect on these functions at all — the real one still runs and dies
    on `engine.begin()`. `test_mcp_routes.py::_patch_curated` hit this first and
    documented it; this is the same seam.

    It has to answer None rather than a row: a local server has no curated row,
    and that is exactly the condition the local branch exists to handle.
    """
    from app.mcp import lifecycle as lifecycle_mod
    from app.mcp.registry import curated, local_store

    async def no_curated(_engine, _name):
        return None

    async def resolve_local(_engine, slug):
        return row if row is not None and row.slug == slug else None

    # `refresh` IS LISTED SEPARATELY and that is not belt-and-braces: it has its
    # own captured default and FORWARDS it to `connect`, so patching `connect`
    # alone leaves the real catalogue running on the refresh path. Measured —
    # the first draft of this file died exactly there.
    for fn in (lifecycle_mod.preflight, lifecycle_mod.connect, lifecycle_mod.refresh):
        monkeypatch.setitem(fn.__kwdefaults__, "resolve_target", no_curated)
    # `_capability_index` calls `curated.resolve` through the module, so this
    # one IS reached by an ordinary setattr.
    monkeypatch.setattr(curated, "resolve", no_curated)
    monkeypatch.setattr(local_store, "resolve", resolve_local)


@contextlib.asynccontextmanager
async def _gateway(monkeypatch, row: LocalRow | None = None):
    """A running gateway fixture, a pool routed to it, and an app on top."""
    local_app, state = build_gateway_server()
    _patch(monkeypatch, LocalRow() if row is None else row)
    async with local_app.router.lifespan_context(local_app):
        async with _pool_by_slug({"gw-fixture": local_app}) as pool:
            yield _app(pool), state


# ===================================================== the reachability seam
async def test_the_connect_ROUTE_brings_a_local_server_to_ready(monkeypatch):
    """THE test Phase 6 was missing.

    `ready` is not cosmetic: `dispatchPayload` filters on exactly this value, so
    a local server that cannot reach it can never appear in a chat turn however
    correct the turn-side routing is.
    """
    async with _gateway(monkeypatch) as (app, _state):
        async with _client(app) as c:
            res = await c.post(
                "/v1/mcp/connections/conn-local-1/connect",
                json=LOCAL_BODY,
                headers=AUTH,
            )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["state"] == "ready", body
    assert body["error_kind"] is None, body
    # Its tools came back through the ordinary path, so the report is the same
    # shape a remote server produces.
    assert sorted(body["tools"]) == ["read_file", "write_file"], body
    assert body["tool_count"] == 2
    assert body["catalogue_status"] == "local"
    # NEVER a credential. The gateway injects a local server's secrets itself.
    assert body["auth_kind"] == "none"


async def test_the_connect_route_reports_unsupported_when_local_is_off(monkeypatch):
    """The control. With the flag down the answer is the ordinary "not curated"
    refusal — a half-open path would be worse than a closed one."""
    local_app, _ = build_gateway_server()
    _patch(monkeypatch, LocalRow())
    async with local_app.router.lifespan_context(local_app):
        async with _pool_by_slug({"gw-fixture": local_app}) as pool:
            app = _app(pool, mcp_local_enabled=False)
            async with _client(app) as c:
                res = await c.post(
                    "/v1/mcp/connections/conn-local-1/connect",
                    json=LOCAL_BODY,
                    headers=AUTH,
                )
    assert res.status_code == 200, res.text
    assert res.json()["state"] == "unsupported", res.json()


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
async def test_a_refused_row_never_reaches_ready_through_the_route(
    monkeypatch, kw, fragment
):
    """Fail closed at the route, and say which field refused.

    The validator's reasons name FIELDS, never values, which is what makes them
    safe to return to a caller that renders them.
    """
    async with _gateway(monkeypatch, LocalRow(**kw)) as (app, _state):
        async with _client(app) as c:
            res = await c.post(
                "/v1/mcp/connections/conn-local-1/connect",
                json=LOCAL_BODY,
                headers=AUTH,
            )
    body = res.json()
    assert body["state"] == "unsupported", body
    assert fragment in str(body["error_detail"]), body


async def test_refresh_reaches_ready_too(monkeypatch):
    """`refresh` delegates to `connect`, so it inherited the same defect.

    Asserted separately rather than assumed: "it calls the fixed function" is
    exactly the reasoning that let the original bug through.
    """
    async with _gateway(monkeypatch) as (app, _state):
        async with _client(app) as c:
            res = await c.post(
                "/v1/mcp/connections/conn-local-1/refresh",
                json=LOCAL_BODY,
                headers=AUTH,
            )
    assert res.json()["state"] == "ready", res.json()


# ===================================================== capabilities for local
async def test_resources_and_prompts_are_reachable_for_a_local_server(monkeypatch):
    """The same bug class, one route along.

    `_capability_index` resolved through `curated.resolve` alone, so every
    `local/<slug>` answered 404 "not in this deployment's curated set" — a local
    server could connect and still show no resources and no prompts in the UI.
    """
    async with _gateway(monkeypatch) as (app, _state):
        async with _client(app) as c:
            resources = await c.post(
                "/v1/mcp/connections/conn-local-1/resources",
                json=LOCAL_BODY,
                headers=AUTH,
            )
            prompts = await c.post(
                "/v1/mcp/connections/conn-local-1/prompts",
                json=LOCAL_BODY,
                headers=AUTH,
            )
    assert resources.status_code == 200, resources.text
    assert [r["name"] for r in resources.json()["resources"]] == ["notes"]
    # A failed list is REPORTED separately from an empty one — Phase 7 renders
    # "unavailable" rather than "0", and this is the field that carries it.
    assert resources.json()["error"] is None

    assert prompts.status_code == 200, prompts.text
    assert [p["name"] for p in prompts.json()["prompts"]] == ["summarize"]
    assert prompts.json()["error"] is None


async def test_reading_a_local_resource_goes_through_the_route(monkeypatch):
    """Metadata was not enough: the read path resolves the index a second time."""
    async with _gateway(monkeypatch) as (app, _state):
        async with _client(app) as c:
            res = await c.post(
                "/v1/mcp/connections/conn-local-1/resources/read",
                json={**LOCAL_BODY, "uri": "workspace://notes.md"},
                headers=AUTH,
            )
    assert res.status_code == 200, res.text
    assert res.json()["text"] == "# local notes"

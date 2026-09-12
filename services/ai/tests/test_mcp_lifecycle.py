"""The connection state machine, against a REAL MCP server and NO database.

The catalogue lookup is injected, so the part that is easy to get subtly wrong —
which states are reachable, what a deleted server does to a live connection,
whether an auth-required server is "broken" or "not set up yet" — is provable on
a machine with no Postgres. The SQL behind the default lookup is covered by the
DB-gated suite. Same argument `app/mcp/registry/sync.py` makes, for the same
reason.

THE TWO INVARIANTS UNDER TEST:
  * READY means initialize completed AND capabilities were read -- not "a socket
    opened";
  * catalogue status and connection status never write to each other.
"""

from __future__ import annotations

from contextlib import AsyncExitStack

import pytest

from app.mcp.credentials import EnvCredentialResolver, NullCredentialResolver
from app.mcp.exceptions import McpErrorKind
from app.mcp.lifecycle import (
    ConnectionRequest,
    ConnectionState,
    connect,
    disconnect,
    preflight,
    refresh,
    status,
)
from app.mcp.registry.curated import CuratedTarget
from app.mcp.session import McpSessionPool, PoolLimits
from tests.fakes import mcp_http
from tests.fakes.mcp_http import MCP_URL, build_mcp_app, running

REMOTE = [{"type": "streamable-http", "url": MCP_URL}]


def target(**overrides) -> CuratedTarget:
    base = {
        "server_name": "test.fixture/fake",
        "slug": "fake",
        "display_name": "Fake",
        "category": "testing",
        "transport": "streamable-http",
        "endpoint_url": MCP_URL,
        "auth_kind": "none",
        "trusted": True,
        "enabled": True,
        "version": "1.0.0",
        "version_mode": "latest_at_connect",
        "catalogue_status": "active",
        "version_status": "active",
        "remotes": REMOTE,
        "packages": [],
    }
    base.update(overrides)
    return CuratedTarget(**base)


def lookup(result):
    """An injected catalogue lookup returning a fixed target (or None)."""

    async def _resolve(_engine, _name):
        return result

    return _resolve


def request(**overrides) -> ConnectionRequest:
    base = {
        "connection_id": "conn-1",
        "server_name": "test.fixture/fake",
        "user_id": "user-a",
        "workspace_id": "ws-1",
    }
    base.update(overrides)
    return ConnectionRequest(**base)


@pytest.fixture
def asgi(monkeypatch):
    def _install(app):
        mcp_http.patch_transport(monkeypatch, app)

    return _install


async def _pool(stack) -> McpSessionPool:
    return await McpSessionPool(PoolLimits(sweep_interval_s=3600.0)).start(stack)


# ------------------------------------------------------------- preflight
async def test_an_uncurated_server_is_unsupported_not_merely_missing():
    report = await preflight(None, "some/server", resolve_target=lookup(None))
    assert report.state is ConnectionState.UNSUPPORTED
    assert "curated set" in report.error_detail


async def test_a_curated_but_disabled_server_is_refused():
    report = await preflight(
        None, "x", resolve_target=lookup(target(enabled=False))
    )
    assert report.state is ConnectionState.UNSUPPORTED
    assert "not enabled" in report.error_detail


async def test_a_packages_only_server_is_unsupported_and_never_dialled():
    """The majority of the catalogue: 68,019 of 100,198 version records declare
    stdio. Phase 3 must not install or execute any of them."""
    report = await preflight(
        None,
        "x",
        resolve_target=lookup(
            target(remotes=[], packages=[{"registryType": "npm", "identifier": "p"}])
        ),
    )
    assert report.state is ConnectionState.UNSUPPORTED
    assert "local execution is not supported" in report.error_detail


async def test_a_server_with_no_remote_at_all_is_unsupported():
    report = await preflight(
        None, "x", resolve_target=lookup(target(remotes=[], packages=[]))
    )
    assert report.state is ConnectionState.UNSUPPORTED
    assert "no remote endpoint" in report.error_detail


async def test_an_oauth_server_without_credentials_is_CONFIGURED_not_unsupported():
    """The distinction is "connect your account" versus "this will never work
    here". Flattening them sends a user looking for a setting that does not
    exist."""
    report = await preflight(
        None,
        "x",
        credentials_available=False,
        resolve_target=lookup(target(auth_kind="oauth")),
    )
    assert report.state is ConnectionState.CONFIGURED
    assert report.error_kind == str(McpErrorKind.AUTH_REQUIRED)
    assert report.user_action_required


async def test_an_unknown_auth_kind_is_never_optimistically_treated_as_none():
    """Phase 2's parser records "unknown" rather than guessing, and Phase 3
    honours that: attempting an unauthenticated connection to a server that
    needs credentials produces a confusing 401 instead of a clear instruction."""
    report = await preflight(
        None, "x", resolve_target=lookup(target(auth_kind="unknown"))
    )
    assert report.error_kind == str(McpErrorKind.AUTH_REQUIRED)


async def test_a_no_auth_server_is_ready_to_connect():
    report = await preflight(None, "x", resolve_target=lookup(target()))
    assert report.state is ConnectionState.CONFIGURED
    assert report.error_kind is None


# --------------------------------------------------------------- connect
async def test_connect_reaches_READY_with_a_real_capability_snapshot(asgi):
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        report = await connect(
            None, pool, request(), resolve_target=lookup(target())
        )
        assert report.state is ConnectionState.READY
        assert report.ok
        # READY means capabilities were READ, not that a socket opened.
        assert report.capabilities is not None
        assert report.capabilities.protocol_version
        assert report.capabilities.has_tools
        assert report.tool_count == len(report.tools) > 0
        assert "echo" in report.tools
        await pool.aclose()


async def test_connect_is_idempotent_so_a_double_click_costs_no_handshake(asgi):
    app, traffic = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        await connect(None, pool, request(), resolve_target=lookup(target()))
        traffic.reset()
        second = await connect(
            None, pool, request(), resolve_target=lookup(target())
        )
        assert second.state is ConnectionState.READY
        assert traffic.count == 0, "a repeat connect re-ran the handshake"
        assert pool.size == 1
        await pool.aclose()


async def test_a_refused_endpoint_fails_without_reaching_the_server(asgi):
    app, traffic = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        traffic.reset()
        report = await connect(
            None,
            pool,
            request(),
            resolve_target=lookup(target(endpoint_url="https://127.0.0.1/mcp")),
        )
        assert report.state is ConnectionState.FAILED
        assert report.error_kind == str(McpErrorKind.ENDPOINT_REJECTED)
        assert traffic.count == 0
        await pool.aclose()


async def test_the_operator_trust_flag_reaches_the_side_effect_classifier(asgi):
    """`trusted` is a SECOND operator decision, separate from `enabled`: it is
    what decides whether a server's own `readOnlyHint` may downgrade a tool
    below the approval gate."""
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)

        await connect(
            None,
            pool,
            request(connection_id="trusted"),
            resolve_target=lookup(target(trusted=True)),
        )
        trusted_session = pool._actors[("user-a", "ws-1", "trusted")].session
        trusted_echo = next(t for t in trusted_session.tools if t.name == "echo")

        await connect(
            None,
            pool,
            request(connection_id="untrusted"),
            resolve_target=lookup(target(trusted=False, slug="fake2")),
        )
        untrusted_session = pool._actors[("user-a", "ws-1", "untrusted")].session
        untrusted_echo = next(t for t in untrusted_session.tools if t.name == "echo")

        assert str(trusted_echo.side_effect) == "read_only"
        assert str(untrusted_echo.side_effect) == "external_side_effect", (
            "an UNTRUSTED server's readOnlyHint must not skip the approval gate"
        )
        await pool.aclose()


# -------------------------------------------------------- version pinning
async def test_an_explicit_pin_is_preserved_and_reported(asgi):
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        report = await connect(
            None,
            pool,
            request(version="0.9.0"),
            resolve_target=lookup(target(version="2.0.0")),
        )
        assert report.version == "0.9.0", "the pin was overridden by the catalogue"
        assert report.version_mode == "pinned"
        await pool.aclose()


async def test_without_a_pin_the_catalogue_version_is_recorded_explicitly(asgi):
    """So a later `latest_version` change cannot silently re-point a live
    connection: the version actually used is written down."""
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        report = await connect(
            None, pool, request(), resolve_target=lookup(target(version="1.4.2"))
        )
        assert report.version == "1.4.2"
        assert report.version_mode == "latest_at_connect"
        await pool.aclose()


# ------------------------------------------- catalogue vs connection status
async def test_a_deleted_server_still_connects_and_reports_its_status(asgi):
    """Catalogue status and connection status never write to each other. A user
    holding a working connection to a server the registry withdrew must not
    have it silently severed -- they must be TOLD."""
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        report = await connect(
            None,
            pool,
            request(),
            resolve_target=lookup(target(catalogue_status="deleted")),
        )
        assert report.state is ConnectionState.READY
        assert report.catalogue_status == "deleted"
        await pool.aclose()


async def test_a_failed_connection_never_mutates_the_catalogue_verdict(asgi):
    """One user's failed connection is evidence about their credentials or
    network, not about whether the server exists."""
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        failed = await connect(
            None,
            pool,
            request(),
            resolve_target=lookup(target(endpoint_url="https://10.0.0.5/mcp")),
        )
        assert failed.state is ConnectionState.FAILED
        # The catalogue view is unchanged for the next caller.
        fresh = await preflight(None, "x", resolve_target=lookup(target()))
        assert fresh.state is ConnectionState.CONFIGURED
        assert fresh.catalogue_status == "active"
        await pool.aclose()


# ------------------------------------------------- disconnect and refresh
async def test_disconnect_closes_the_session_and_suppresses_reconnection(asgi):
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        await connect(None, pool, request(), resolve_target=lookup(target()))
        assert pool.size == 1
        report = await disconnect(pool, request())
        assert report.state is ConnectionState.DISCONNECTED
        assert report.reconnect_allowed is False
        assert pool.size == 0
        await pool.aclose()


async def test_refresh_opens_a_NEW_session_rather_than_re_listing(asgi):
    """The SDK caches list results per client, so a second `tools/list` on the
    live session could return the cached page and report "refreshed" having
    learned nothing."""
    app, traffic = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        await connect(None, pool, request(), resolve_target=lookup(target()))
        first = pool._actors[("user-a", "ws-1", "conn-1")].session
        traffic.reset()

        report = await refresh(
            None, pool, request(), resolve_target=lookup(target())
        )
        second = pool._actors[("user-a", "ws-1", "conn-1")].session
        assert report.state is ConnectionState.READY
        assert second is not first, "refresh reused the cached session"
        assert traffic.count >= 2, "refresh did not re-run the handshake"
        await pool.aclose()


# ------------------------------------------------------------- status API
async def test_status_answers_in_four_separate_parts(asgi):
    """"Server: ACTIVE, Connection: FAILED" is a valid and common state, and a
    single `status` field cannot express it."""
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        await connect(None, pool, request(), resolve_target=lookup(target()))
        got = await status(None, pool, request(), resolve_target=lookup(target()))

        assert set(got) == {
            "catalogue",
            "connection",
            "session",
            "capabilities",
            "last_error",
        }
        assert got["catalogue"]["status"] == "active"
        assert got["catalogue"]["curated"] is True
        assert got["session"]["live"] is True
        assert got["session"]["protocol_version"]
        assert got["capabilities"]["tool_count"] > 0
        assert got["last_error"] is None
        await pool.aclose()


async def test_status_distinguishes_an_active_server_from_a_dead_connection(asgi):
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        got = await status(None, pool, request(), resolve_target=lookup(target()))
        assert got["catalogue"]["status"] == "active"
        assert got["session"]["live"] is False
        assert got["capabilities"] is None
        await pool.aclose()


async def test_status_reports_a_connection_failure_without_leaking_internals(asgi):
    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        await connect(
            None,
            pool,
            request(),
            resolve_target=lookup(target(endpoint_url="https://10.0.0.5/mcp")),
        )
        got = await status(None, pool, request(), resolve_target=lookup(target()))
        assert got["session"]["live"] is False
        blob = str(got)
        assert "10.0.0.5" not in blob
        await pool.aclose()


# ------------------------------------------------------ credential seam
async def test_a_credential_resolver_turns_an_auth_required_server_connectable():
    """The Phase 4 handoff in miniature: swapping the resolver is the ONLY
    change needed to make an authenticated server reachable."""
    without = await preflight(
        None,
        "x",
        credentials_available=False,
        resolve_target=lookup(target(auth_kind="api_key")),
    )
    with_creds = await preflight(
        None,
        "x",
        credentials_available=True,
        resolve_target=lookup(target(auth_kind="api_key")),
    )
    assert without.error_kind == str(McpErrorKind.AUTH_REQUIRED)
    assert with_creds.error_kind is None
    assert with_creds.state is ConnectionState.CONFIGURED


async def test_the_null_resolver_reports_that_it_can_supply_nothing():
    assert NullCredentialResolver().can_supply is False
    assert EnvCredentialResolver({}).can_supply is False
    assert EnvCredentialResolver({"gh": "t"}).can_supply is True

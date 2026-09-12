"""The session pool, against a REAL Streamable HTTP MCP server.

Not a mock. `tests/fakes/mcp_http.py` runs the SDK's own server behind an ASGI
transport, so initialize, protocol negotiation, `tools/list`, `tools/call`, the
session-id header and the terminating DELETE all happen for real -- over zero
sockets, with no certificate and no network.

THE TESTS THAT MATTER MOST ARE THE STRUCTURAL ONES. Three properties of this
pool are not preferences, they are the difference between working and hanging:

  * a session must be opened and closed in the SAME task (anyio cancel scopes);
  * a failing session must not take its siblings down (anyio propagates an
    unhandled child exception to the whole task group);
  * every session must be closed before the task group exits (a parked actor
    never returns, so shutdown would hang forever).

Each has a test that fails loudly if the property is removed.
"""

from __future__ import annotations

import anyio
import httpx2
import pytest

from app.mcp.exceptions import McpConnectionError, McpErrorKind
from app.mcp.session import McpSessionPool, PoolLimits
from tests.fakes import mcp_http
from tests.fakes.mcp_http import (
    build_colliding_app,
    build_mcp_app,
    running,
    spec,
    status_app,
)


@pytest.fixture
def asgi(monkeypatch):
    """Point the pool's httpx client at an in-process ASGI app.

    Patches only the SOCKET layer: `assert_dialable` still runs for real against
    every fixture URL, and every URL here still has to pass it.
    """

    def _install(app):
        mcp_http.patch_transport(monkeypatch, app)

    return _install


async def _pool(stack, **limit_overrides) -> McpSessionPool:
    limits = PoolLimits(**{"sweep_interval_s": 3600.0, **limit_overrides})
    return await McpSessionPool(limits).start(stack)


# ------------------------------------------------------------ the happy path
async def test_a_session_opens_discovers_and_serves_calls(asgi):
    from contextlib import AsyncExitStack

    app, traffic = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec()) as session:
            assert session.snapshot.protocol_version
            assert {"echo", "add", "write_note"} <= {t.name for t in session.tools}
            result = await session.client.call_tool("echo", {"text": "hi"})
            assert result.content[0].text == "hi"
        await pool.aclose()
    assert traffic.count >= 3


async def test_tool_ids_are_namespaced_so_two_servers_cannot_collide(asgi):
    """`ToolRegistry._by_id` is a flat map that silently overwrites."""
    from contextlib import AsyncExitStack

    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec(slug="fake")) as session:
            assert "mcp:fake:echo" in {t.tool_id for t in session.tools}
            assert all(t.provider == "mcp:fake" for t in session.tools)
        await pool.aclose()


# --------------------------------------------------------------- reuse/pooling
async def test_a_second_acquire_reuses_the_session_and_pays_no_handshake(asgi):
    """The whole point of pooling: 3 HTTP round trips per call becomes 1."""
    from contextlib import AsyncExitStack

    app, traffic = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec()) as first:
            await first.client.call_tool("echo", {"text": "a"})
        after_first = traffic.count

        traffic.reset()
        async with pool.acquire(spec()) as second:
            assert second is first, "a second acquire must not open a new session"
            await second.client.call_tool("echo", {"text": "b"})
        assert traffic.count == 1, (
            f"a pooled call must cost ONE request, not {traffic.count} "
            f"(first connect+call cost {after_first})"
        )
        assert pool.size == 1
        await pool.aclose()


async def test_two_concurrent_first_calls_create_exactly_one_session(asgi):
    """The classic pool race. Two requests arriving together for the same key
    must not both open a session -- one of them would leak."""
    from contextlib import AsyncExitStack

    app, _ = build_mcp_app()
    asgi(app)
    seen = []
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)

        async def borrow():
            async with pool.acquire(spec()) as session:
                seen.append(id(session))

        async with anyio.create_task_group() as tg:
            for _ in range(5):
                tg.start_soon(borrow)
        assert len(set(seen)) == 1, "concurrent first-calls opened several sessions"
        assert pool.size == 1
        await pool.aclose()


# -------------------------------------------------------------- tenancy
async def test_two_tenants_of_the_SAME_connection_get_separate_sessions(asgi):
    """The key includes the tenant, not just the connection. This uses an
    IDENTICAL connection_id on purpose: if the tenant were dropped from the key,
    user B would be handed user A's authenticated session."""
    from contextlib import AsyncExitStack

    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec(connection_id="shared", user_id="user-a")) as a:
            async with pool.acquire(
                spec(connection_id="shared", user_id="user-b")
            ) as b:
                assert a is not b
                assert a.client is not b.client
                assert a.recorder is not b.recorder
        assert pool.size == 2
        await pool.aclose()


async def test_a_different_workspace_is_also_a_different_session(asgi):
    from contextlib import AsyncExitStack

    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec(workspace_id="ws-1")) as a:
            async with pool.acquire(spec(workspace_id="ws-2")) as b:
                assert a is not b
        await pool.aclose()


async def test_sessions_do_not_share_an_http_client_or_a_status_recorder(asgi):
    """A shared client would pool cookies and TCP connections across tenants,
    and a shared recorder would blame one tenant's 401 on another's call."""
    from contextlib import AsyncExitStack

    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec(user_id="user-a")) as a:
            async with pool.acquire(spec(user_id="user-b")) as b:
                a.recorder.status = 401
                assert b.recorder.status is None
        await pool.aclose()


# ----------------------------------------------------------- concurrency
async def test_one_session_serves_concurrent_calls_correctly(asgi):
    """The SDK dispatcher correlates concurrent requests through an in-flight
    map, so a shared session is safe -- but only if we never serialize by
    accident."""
    from contextlib import AsyncExitStack

    app, _ = build_mcp_app()
    asgi(app)
    results: list[str] = []
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec()) as session:

            async def call(index: int):
                got = await session.client.call_tool("echo", {"text": f"c{index}"})
                results.append(got.content[0].text)

            async with anyio.create_task_group() as tg:
                for i in range(8):
                    tg.start_soon(call, i)
        assert sorted(results) == sorted(f"c{i}" for i in range(8))
        await pool.aclose()


# --------------------------------------------------- failure does not spread
async def test_a_failing_session_does_not_kill_another_tenants_session(asgi):
    """anyio propagates an unhandled child exception to the WHOLE task group.
    If the actor raised instead of recording, one dead server would disconnect
    every other user in the process."""
    from contextlib import AsyncExitStack

    good, _ = build_mcp_app()
    asgi(good)
    async with running(good), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec(user_id="user-a")) as healthy:
            # A second connection whose endpoint the guard refuses outright.
            with pytest.raises(McpConnectionError):
                async with pool.acquire(
                    spec(
                        connection_id="bad",
                        user_id="user-b",
                        url="https://127.0.0.1/mcp",
                    )
                ):
                    pass
            # The healthy session must still work.
            got = await healthy.client.call_tool("echo", {"text": "alive"})
            assert got.content[0].text == "alive"
        await pool.aclose()


async def test_a_failed_connect_surfaces_as_a_connection_error_not_a_runtime_error(
    asgi,
):
    """If `task_status.started()` is not called on the failure path, anyio
    raises "Child exited without calling task_status.started()" -- a framework
    error where a diagnosable connection error belongs."""
    from contextlib import AsyncExitStack

    app = status_app(500)
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        with pytest.raises(McpConnectionError) as got:
            async with pool.acquire(spec()):
                pass
        assert got.value.kind is McpErrorKind.SERVER_ERROR
        assert pool.size == 0, "a failed connect must not leave a pool entry"
        await pool.aclose()


async def test_the_endpoint_guard_runs_before_any_connection_is_attempted(asgi):
    from contextlib import AsyncExitStack

    app, traffic = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        traffic.reset()
        for bad in (
            "http://93.184.216.34/mcp",
            "https://127.0.0.1/mcp",
            "https://169.254.169.254/mcp",
            "https://93.184.216.34/mcp?api_key=leak",
        ):
            with pytest.raises(McpConnectionError) as got:
                async with pool.acquire(spec(connection_id=bad, url=bad)):
                    pass
            assert got.value.kind is McpErrorKind.ENDPOINT_REJECTED
        assert traffic.count == 0, "a refused endpoint must cost zero requests"
        await pool.aclose()


# ------------------------------------------------------------- eviction
async def test_discard_evicts_a_session(asgi):
    from contextlib import AsyncExitStack

    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec()) as session:
            key = session.key
        assert pool.size == 1
        await pool.discard(key)
        assert pool.size == 0
        # And a later acquire opens a fresh one rather than a dead one.
        async with pool.acquire(spec()) as again:
            assert again.snapshot.protocol_version
        await pool.aclose()


async def test_an_idle_session_is_swept(asgi):
    from contextlib import AsyncExitStack

    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack, idle_ttl_s=60.0)
        async with pool.acquire(spec()) as session:
            pass
        # Age it deterministically rather than sleeping for a minute.
        session.last_used_at = anyio.current_time() - 3600
        await pool._sweep_once()
        assert pool.size == 0
        await pool.aclose()


async def test_a_session_with_a_call_in_flight_is_never_swept(asgi):
    """`terminate_on_close` sends a DELETE; sweeping mid-call would abort it."""
    from contextlib import AsyncExitStack

    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack, idle_ttl_s=0.0)
        async with pool.acquire(spec()) as session:
            session.last_used_at = anyio.current_time() - 3600
            assert session.in_flight == 1
            await pool._sweep_once()
            assert pool.size == 1, "an in-flight session was swept"
        await pool.aclose()


async def test_the_per_user_cap_evicts_the_least_recently_used(asgi):
    from contextlib import AsyncExitStack

    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack, max_sessions_per_user=2, max_sessions=64)
        for i in range(3):
            async with pool.acquire(spec(connection_id=f"c{i}")):
                pass
        assert pool.size == 2, "the per-user cap did not hold"
        await pool.aclose()


async def test_one_user_cannot_evict_another_users_sessions(asgi):
    from contextlib import AsyncExitStack

    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack, max_sessions_per_user=1, max_sessions=64)
        async with pool.acquire(spec(connection_id="a1", user_id="user-a")) as a:
            key_a = a.key
        for i in range(4):
            async with pool.acquire(spec(connection_id=f"b{i}", user_id="user-b")):
                pass
        assert key_a in [
            k for k in pool._actors
        ], "user B's churn evicted user A's session"
        await pool.aclose()


async def test_the_global_cap_bounds_the_pool(asgi):
    from contextlib import AsyncExitStack

    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack, max_sessions=3, max_sessions_per_user=99)
        for i in range(6):
            async with pool.acquire(spec(connection_id=f"c{i}")):
                pass
        assert pool.size <= 3
        await pool.aclose()


# -------------------------------------------------------------- shutdown
async def test_aclose_closes_a_parked_session_so_the_task_group_can_exit(asgi):
    """THE HANG TEST. A parked actor never returns on its own, so if `aclose()`
    does not close it the enclosing task group waits forever -- and systemd
    shutdown with it. Bounded so a regression fails instead of hanging CI."""
    from contextlib import AsyncExitStack

    app, _ = build_mcp_app()
    asgi(app)
    with anyio.move_on_after(20) as scope:
        async with running(app), AsyncExitStack() as stack:
            pool = await _pool(stack)
            async with pool.acquire(spec()):
                pass
            assert pool.size == 1
            await pool.aclose()
    assert not scope.cancelled_caught, "shutdown hung with a session still open"


async def test_aclose_is_idempotent(asgi):
    from contextlib import AsyncExitStack

    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec()):
            pass
        await pool.aclose()
        await pool.aclose()
        assert pool.size == 0


async def test_acquiring_from_a_closed_pool_is_refused_not_ignored(asgi):
    from contextlib import AsyncExitStack

    app, _ = build_mcp_app()
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        await pool.aclose()
        with pytest.raises(McpConnectionError):
            async with pool.acquire(spec()):
                pass


# ------------------------------------------------------------ structural
def _code_identifiers(path) -> set[str]:
    """Every NAME the module's code actually references.

    Parsed from the AST, so comments and docstrings are excluded by
    construction. The first version of these tests grepped the file text and
    failed on its own explanatory comments -- which is the classic way a
    structural assertion becomes noise and then gets deleted.
    """
    import ast

    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            found.add(node.id)
        elif isinstance(node, ast.Attribute):
            found.add(node.attr)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                found.add(alias.name.split(".")[0])
                found.add(alias.asname or alias.name)
        elif isinstance(node, ast.ImportFrom):
            found.add((node.module or "").split(".")[0])
            for alias in node.names:
                found.add(alias.name)
                found.add(alias.asname or alias.name)
        elif isinstance(node, ast.keyword) and node.arg:
            found.add(node.arg)
    return found


def _mcp_modules():
    """Every module that can open a connection to a third party.

    The ROUTERS are included deliberately, not just the package: `mcp_oauth.py`
    builds its own httpx2 clients for the auth probe and for RFC 7009
    revocation, which is precisely where disabling TLS verification would be
    most tempting when a provider's certificate misbehaves.
    """
    import pathlib

    paths = sorted(pathlib.Path("app/mcp").rglob("*.py"))
    paths += [
        pathlib.Path("app/routers/mcp.py"),
        pathlib.Path("app/routers/mcp_oauth.py"),
    ]
    for path in paths:
        assert path.exists(), f"{path} is gone; this guard now covers less than it says"
    return paths


def test_the_pool_never_sends_a_ping():
    """`send_ping` was REMOVED in protocol 2026-07-28 and works only under
    mode='legacy'. A ping-based health probe would pass against old servers and
    FAIL against healthy new ones -- exactly backwards. So this pool validates
    on failure, not on borrow."""
    import pathlib

    assert "send_ping" not in _code_identifiers(pathlib.Path("app/mcp/session.py"))


def test_no_module_in_the_mcp_package_can_spawn_a_local_process():
    """A silent import is how a "hidden local-execution fallback" appears.

    Phase 6 may add local execution deliberately; it must not arrive by
    accident, and it must not arrive in Phase 3.
    """
    forbidden = {"StdioServerParameters", "stdio_client", "subprocess", "Popen"}
    for path in _mcp_modules():
        offenders = forbidden & _code_identifiers(path)
        assert not offenders, f"{path} references {sorted(offenders)}"


def test_tls_verification_is_never_disabled_anywhere_in_the_mcp_package():
    """`verify=False` as a keyword, found in the AST rather than the text, so a
    comment explaining the rule cannot trip the rule."""
    import ast

    for path in _mcp_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.keyword) and node.arg == "verify":
                value = node.value
                assert not (
                    isinstance(value, ast.Constant) and value.value is False
                ), f"{path} disables TLS verification"


async def test_two_servers_exposing_the_same_tool_name_coexist(asgi, monkeypatch):
    """Server A's `echo` must not overwrite server B's, and disconnecting one
    must leave the other intact."""
    from contextlib import AsyncExitStack

    app_a, _ = build_mcp_app(name="fake")
    app_b, _ = build_colliding_app()

    # Two apps means the transport patch has to route per-connection.
    import app.mcp.session as session_mod
    from app.mcp.transport import build_http_client as real_build

    def routed(spec_, headers, recorder, **kwargs):
        app = app_b if spec_.identity.slug == "other" else app_a
        kwargs.setdefault("transport", httpx2.ASGITransport(app=app))
        return real_build(spec_, headers, recorder, **kwargs)

    monkeypatch.setattr(session_mod, "build_http_client", routed)

    async with running(app_a), running(app_b), AsyncExitStack() as stack:
        pool = await _pool(stack)
        async with pool.acquire(spec(connection_id="a", slug="fake")) as a:
            async with pool.acquire(spec(connection_id="b", slug="other")) as b:
                ids_a = {t.tool_id for t in a.tools}
                ids_b = {t.tool_id for t in b.tools}
                assert "mcp:fake:echo" in ids_a
                assert "mcp:other:echo" in ids_b
                assert ids_a.isdisjoint(ids_b)
                key_b = b.key
        await pool.discard(key_b)
        # A still works after B is disconnected.
        async with pool.acquire(spec(connection_id="a", slug="fake")) as again:
            got = await again.client.call_tool("echo", {"text": "still here"})
            assert got.content[0].text == "still here"
        await pool.aclose()

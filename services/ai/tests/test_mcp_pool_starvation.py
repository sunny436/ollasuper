"""The pool under pressure (audit H-10 / N-04 / M-07).

Before: the per-user cap `break`-ed out and opened the ninth session anyway;
the pool lock was held across DNS/connect/initialize, so one hung server
stalled every tenant's acquire; and two calls on one session could reset each
other's status recorder mid-flight.
"""

from __future__ import annotations

from contextlib import AsyncExitStack

import anyio
import httpx2
import pytest

from app.mcp.exceptions import McpConnectionError, McpErrorKind
from app.mcp.session import McpSessionPool, PoolLimits
from tests.fakes.mcp_http import build_mcp_app, patch_transport, running, spec

pytestmark = pytest.mark.anyio


async def _pool(stack: AsyncExitStack, **limits) -> McpSessionPool:
    return await McpSessionPool(
        PoolLimits(**{"sweep_interval_s": 3600.0, **limits})
    ).start(stack)


# ------------------------------------------------------------ fail closed
async def test_the_per_user_cap_refuses_when_every_session_is_in_flight(monkeypatch):
    """N-04's shape: a turn holds every connection's session open. With the cap
    reached and nothing idle to evict, the next acquire is REFUSED — it does
    not open a session over the limit."""
    app, _ = build_mcp_app()
    patch_transport(monkeypatch, app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack, max_sessions_per_user=2, max_sessions=64)
        async with (
            pool.acquire(spec(connection_id="c0")),
            pool.acquire(spec(connection_id="c1")),
        ):
            with pytest.raises(McpConnectionError) as info:
                async with pool.acquire(spec(connection_id="c2")):
                    pass
            assert info.value.kind is McpErrorKind.RATE_LIMITED
            assert pool.size == 2
        # Once a slot is idle again the same acquire succeeds (LRU eviction).
        async with pool.acquire(spec(connection_id="c2")) as s:
            assert s.spec.connection_id == "c2"
        assert pool.size == 2
        await pool.aclose()


async def test_a_turn_composes_at_most_the_cap_and_reports_the_rest(monkeypatch):
    """`mcp_for_turn` with more connections than the cap: the first N open,
    the rest are reported as failures, the turn proceeds."""
    from app.mcp.turn import mcp_for_turn

    app, _ = build_mcp_app()
    patch_transport(monkeypatch, app)

    class Ref:
        def __init__(self, i: int) -> None:
            self.connectionId = f"c{i}"
            self.serverName = "test.fixture/fake"
            self.slug = f"fake{i}"
            self.version = None

    class Target:
        slug = "fake"
        trusted = True
        enabled = True
        server_name = "test.fixture/fake"
        version = "1.0.0"
        transport = "streamable-http"
        endpoint_url = "https://93.184.216.34/mcp"
        auth_kind = "none"

    async def resolve(_engine, _name):
        return Target()

    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack, max_sessions_per_user=3, max_sessions=64)
        async with mcp_for_turn(
            pool,
            [Ref(i) for i in range(5)],
            user_id="user-a",
            workspace_id="ws-1",
            resolve_target=resolve,
        ) as caps:
            assert len(caps.index.connection_ids) == 3
            assert len(caps.failures) == 2
            assert pool.size == 3
        await pool.aclose()


# ---------------------------------------------------------- no starvation
async def test_a_hung_server_does_not_stall_another_tenants_acquire(monkeypatch):
    """The lock guards the map, never the network. Key A's server sleeps in
    every request; key B (another user, another app) must open in well under
    that sleep."""
    import app.mcp.session as session_mod
    from app.mcp.transport import build_http_client as real_build

    app_fast, _ = build_mcp_app()
    app_slow_inner, _ = build_mcp_app(name="slow")

    async def app_slow(scope, receive, send):
        if scope.get("type") == "http":
            await anyio.sleep(3.0)
        await app_slow_inner(scope, receive, send)

    app_slow.inner = getattr(app_slow_inner, "inner", app_slow_inner)  # type: ignore[attr-defined]

    def routed(spec_, headers, recorder, **kwargs):
        app = app_slow if spec_.user_id == "user-slow" else app_fast
        kwargs.setdefault("transport", httpx2.ASGITransport(app=app))
        return real_build(spec_, headers, recorder, **kwargs)

    monkeypatch.setattr(session_mod, "build_http_client", routed)
    monkeypatch.setattr(session_mod, "_WATCH_LIST_CHANGES", False)

    async with running(app_fast), running(app_slow), AsyncExitStack() as stack:
        pool = await _pool(stack)
        elapsed = {"fast": None}

        async def slow_acquire() -> None:
            with anyio.move_on_after(20):
                async with pool.acquire(spec(user_id="user-slow", connection_id="s")):
                    pass

        async def fast_acquire() -> None:
            await anyio.sleep(0.2)  # let the slow one grab the lock first, if it could
            t0 = anyio.current_time()
            async with pool.acquire(spec(user_id="user-fast", connection_id="f")):
                elapsed["fast"] = anyio.current_time() - t0

        async with anyio.create_task_group() as tg:
            tg.start_soon(slow_acquire)
            tg.start_soon(fast_acquire)
        assert elapsed["fast"] is not None
        assert elapsed["fast"] < 2.0, (
            f"fast acquire waited {elapsed['fast']:.2f}s behind a hung server"
        )
        await pool.aclose()


async def test_concurrent_same_key_acquires_open_exactly_one_session_without_the_lock(
    monkeypatch,
):
    app, traffic = build_mcp_app()
    patch_transport(monkeypatch, app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        seen: list[int] = []

        async def one() -> None:
            async with pool.acquire(spec()) as s:
                seen.append(id(s))

        async with anyio.create_task_group() as tg:
            for _ in range(6):
                tg.start_soon(one)
        assert len(set(seen)) == 1
        assert pool.size == 1
        # One handshake on the wire, not six.
        assert sum(1 for m, _ in traffic.requests if m == "POST") <= 4
        await pool.aclose()


# ------------------------------------------------- calls on one session
async def test_calls_on_one_session_are_serialised_for_the_shared_recorder(
    monkeypatch,
):
    """M-07. Two concurrent `slow` calls on the same session run one after the
    other under the session's call lock."""
    from app.mcp.adapter import McpToolAdapter

    app, _ = build_mcp_app()
    patch_transport(monkeypatch, app)
    async with running(app), AsyncExitStack() as stack:
        pool = await _pool(stack)
        conn = spec(trusted=True)
        async with pool.acquire(conn) as session:
            tools = {t.name: t for t in session.tools}
            adapter = McpToolAdapter(
                session_provider=lambda: pool.acquire(conn), server_slug="fake"
            )
            windows: list[tuple[float, float]] = []

            async def call() -> None:
                t0 = anyio.current_time()
                await adapter.call_tool(
                    tools["slow"],
                    {"seconds": 0.3},
                    input_schema=tools["slow"].input_schema,
                )
                windows.append((t0, anyio.current_time()))

            async with anyio.create_task_group() as tg:
                tg.start_soon(call)
                tg.start_soon(call)
            windows.sort()
            # The second call's work started after the first finished: no
            # overlap between (start, end) windows beyond the lock wait.
            first_end = windows[0][1]
            second_start_of_work = windows[1][1] - 0.3
            assert second_start_of_work >= first_end - 0.05
        await pool.aclose()

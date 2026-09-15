"""Live MCP sessions: one owner task each, pooled per tenant.

WHY AN ACTOR AND NOT A PLAIN OBJECT — this is the load-bearing fact of the file.
`Client.__aenter__` opens an anyio task group, and anyio refuses to exit a cancel
scope from a different task than entered it:

    RuntimeError: Attempted to exit a cancel scope that isn't the current
                  task's current cancel scope

A pool opens a session in one request's task and closes it later from a sweeper
or another request. So a pooled `Client` CANNOT be handed around as a value.
Each session therefore gets its own task that opens it, parks, and closes it —
open and close in the same task, by construction. Only CALLS cross tasks, which
is safe: the dispatcher correlates concurrent requests through an in-flight map.
Measured: five concurrent callers on one session return five correct results.

WHY POOL AT ALL — measured, not assumed. Connect-per-call costs 3 HTTP round
trips per tool call (probe, initialize, call); a pooled session costs 1. Ten
calls: 30 requests versus 12. Over the internet that is two extra RTTs on every
tool call, 160-300ms at realistic latency.

WHY THE KEY IS (user, workspace, connection). The brief forbids keying a session
on the server alone. Including the authenticated tenant makes cross-user reuse
unreachable even through a connection-resolution bug — the one failure here that
would be a security incident rather than an outage.

WHY THERE IS NO HEALTH PING. `send_ping` was REMOVED in protocol 2026-07-28 and
works only under `mode='legacy'` — a ping probe would pass on old servers and
FAIL on healthy new ones. A `list_tools` probe would either hit the SDK's
response cache (proving nothing) or cost an RTT on every borrow. So this pool
validates on FAILURE, not on borrow: hand out the session, and if a call fails
at the transport level, evict and let the caller's bounded retry reconnect.

THREE THINGS THAT LOOK LIKE STYLE AND ARE NOT:
  * the actor catches `Exception`, never `BaseException` — cancellation must
    propagate or shutdown wedges, but an ordinary failure must be RECORDED,
    because anyio propagates an unhandled child exception to the whole task
    group and one dead server would kill every other tenant's session.
  * `task_status.started()` is called in `finally` — otherwise a failed connect
    surfaces as `RuntimeError: Child exited without calling task_status.started()`
    instead of as a connection error.
  * `aclose()` closes every actor BEFORE the task group exits. A parked actor
    never returns on its own, so skipping this hangs the group forever — and
    with it, systemd shutdown.
"""

from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator, Callable
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import anyio

from app.logging import get_logger
from app.mcp.capabilities import CapabilitySnapshot, snapshot_from
from app.mcp.connection import build_client
from app.mcp.credentials import CredentialResolver, NullCredentialResolver
from app.mcp.endpoint import assert_dialable
from app.mcp.errors import to_connection_error
from app.mcp.exceptions import McpConnectionError, McpErrorKind
from app.mcp.local.gateway import GATEWAY_TRUST, assert_gateway_url
from app.mcp.models import McpConnectionConfig, McpConnectionSpec
from app.mcp.normalize import normalize_tools
from app.mcp.status import StatusRecorder
from app.mcp.transport import build_http_client, build_transport_factory
from app.models.tools import ToolDefinition

log = get_logger(__name__)

__all__ = ["McpSession", "McpSessionPool", "PoolLimits"]

PoolKey = tuple[str, str, str]


@dataclass(frozen=True)
class PoolLimits:
    """Bounds. All of them exist because a remote party influences the load."""

    idle_ttl_s: float = 300.0
    max_sessions: int = 64
    max_sessions_per_user: int = 8
    sweep_interval_s: float = 30.0
    #: How long `aclose()` waits for a well-behaved teardown before cancelling.
    #: A wedged remote server must not hold up process shutdown.
    close_timeout_s: float = 10.0
    max_tools_per_server: int = 256
    max_tool_schema_bytes: int = 64 * 1024


@dataclass
class McpSession:
    """One live protocol session. Runtime state only — never persisted."""

    spec: McpConnectionSpec
    client: Any
    recorder: StatusRecorder
    snapshot: CapabilitySnapshot
    tools: list[ToolDefinition] = field(default_factory=list)
    opened_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    last_used_at: float = 0.0
    #: Calls currently in flight. Eviction must never close a session mid-call:
    #: `terminate_on_close` sends a DELETE, which would abort the request.
    in_flight: int = 0
    #: The server said its tool/resource/prompt list changed since discovery.
    #: The definitions this session handed out are no longer what the server
    #: serves, so the adapter REFUSES further calls on it and the pool reopens
    #: it on the next acquire. An approval given against the old definition
    #: therefore never executes the new one.
    stale: bool = False

    @property
    def key(self) -> PoolKey:
        return self.spec.pool_key

    @contextlib.asynccontextmanager
    async def in_use(self) -> AsyncIterator[McpSession]:
        self.in_flight += 1
        try:
            yield self
        finally:
            self.in_flight -= 1
            self.last_used_at = anyio.current_time()


#: See `_SessionActor._park`. Production never changes this.
_WATCH_LIST_CHANGES = True


class _SessionActor:
    """Owns one session's task. Opens, parks, closes — all in the same task."""

    def __init__(
        self,
        spec: McpConnectionSpec,
        resolver: CredentialResolver,
        limits: PoolLimits,
    ) -> None:  # noqa: D107
        self.spec = spec
        self._resolver = resolver
        self._limits = limits
        self.session: McpSession | None = None
        self.error: McpConnectionError | None = None
        self._stop = anyio.Event()
        self._done = anyio.Event()

    async def run(self, *, task_status: Any = anyio.TASK_STATUS_IGNORED) -> None:
        started = False
        slug = self.spec.identity.slug
        recorder = StatusRecorder()
        credential_presented = False
        try:
            # BEFORE anything is dialled. Runs off the event loop (it does DNS).
            #
            # WHICH GUARD depends on where the endpoint came from, and the two
            # are opposites rather than one being a relaxed form of the other: a
            # catalogue endpoint must be public HTTPS on a standard port, a
            # gateway endpoint must be LOOPBACK. Measured, the strict guard
            # refuses a gateway URL on three independent grounds — scheme, port
            # and loopback — every one of which is correct for its own case.
            #
            # The spec's default is "catalogue", so a spec that forgets to
            # declare itself gets the strict guard. That is the failure
            # direction that cannot be exploited.
            if self.spec.endpoint_trust == GATEWAY_TRUST:
                assert_gateway_url(self.spec.endpoint_url)
            else:
                await assert_dialable(self.spec.endpoint_url)

            # `resolve` returns EITHER static headers or an httpx2 Auth. OAuth
            # has to be an Auth: it must see the 401 to run discovery, and it
            # must refresh mid-flight. A header could do neither.
            credential = await self._resolver.resolve(
                user_id=self.spec.user_id,
                workspace_id=self.spec.workspace_id,
                connection_id=self.spec.connection_id,
                server_slug=slug,
                auth_kind=self.spec.auth_kind,
                # An OAuth resolver needs the audience to find the right stored
                # token: a credential issued for THIS server must never be found
                # by a lookup for another. Static resolvers ignore these.
                server_name=self.spec.server_name,
                endpoint_url=self.spec.endpoint_url,
                resource=self.spec.endpoint_url,
            )
            headers = dict(credential.headers)
            credential_presented = credential.is_present

            async with AsyncExitStack() as stack:
                # One client per session: never shared, so cookies, connection
                # pooling and this recorder are all tenant-scoped.
                http = await stack.enter_async_context(
                    build_http_client(
                        self.spec, headers, recorder, auth=credential.auth
                    )
                )
                factory = build_transport_factory(self.spec, http, headers)
                config = McpConnectionConfig(
                    identity=self.spec.identity,
                    server=factory,
                    on_list_changed=self._mark_stale,
                    # Bounds initialize and every later request. NOT wrapped in
                    # an `anyio.fail_after`: that scope would close while the
                    # Client's own task group is still open on the stack, which
                    # raises "Attempted to exit a cancel scope that isn't the
                    # current task's current cancel scope". The SDK's own read
                    # timeout is the mechanism that works here.
                    read_timeout_seconds=self.spec.request_timeout_s,
                    tool_timeout_s=self.spec.tool_timeout_s,
                )
                client = await stack.enter_async_context(build_client(config))

                tools, advertised = await self._discover(client)
                session = McpSession(
                    spec=self.spec,
                    client=client,
                    recorder=recorder,
                    snapshot=snapshot_from(
                        client,
                        tool_count=len(tools),
                        tools_dropped=max(0, advertised - len(tools)),
                    ),
                    tools=tools,
                    last_used_at=anyio.current_time(),
                )
                self.session = session
                log.info(
                    "mcp.session_ready",
                    extra={
                        "server": slug,
                        "transport": self.spec.transport,
                        "version": self.spec.version,
                        "protocol": session.snapshot.protocol_version,
                        "tools": len(tools),
                        "tools_dropped": session.snapshot.tools_dropped,
                        "user_id": self.spec.user_id,
                        "workspace_id": self.spec.workspace_id,
                    },
                )
                started = True
                task_status.started()
                # Park IN THE OWNER TASK. Everything above is torn down here,
                # in this same task, when `aclose()` sets the event. While
                # parked, watch for the server changing its lists.
                await self._park(client)
        except anyio.get_cancelled_exc_class():
            # MUST propagate: swallowing cancellation breaks structured
            # shutdown and leaves the process wedged.
            raise
        except Exception as exc:  # noqa: BLE001
            # RECORDED, NOT RAISED. anyio propagates an unhandled child
            # exception to the whole task group, so raising here would take down
            # every OTHER tenant's session along with this one.
            self.error = to_connection_error(
                exc,
                server_slug=slug,
                recorder=recorder,
                credential_presented=credential_presented,
                established=started,
            )
            log.warning(
                "mcp.session_failed",
                extra={
                    "server": slug,
                    "kind": str(self.error.kind),
                    "status": self.error.status,
                    "user_id": self.spec.user_id,
                },
            )
        finally:
            self.session = None
            if not started:
                # Unblocks `tg.start()`. Without it a failed connect surfaces as
                # "Child exited without calling task_status.started()" — a
                # framework error where a connection error belongs.
                with contextlib.suppress(RuntimeError):
                    task_status.started()
            self._done.set()

    async def _park(self, client: Any) -> None:
        """Wait for `aclose()`; meanwhile subscribe to list changes.

        TWO DELIVERY PATHS, because the protocol has two. On a 2025-era session
        the server sends `notifications/*/list_changed` spontaneously on the
        standalone GET stream and `build_client`'s message handler marks us
        stale. On a 2026-07-28 session nothing is sent unless the client opens
        `subscriptions/listen` — measured: without it the server logs "dropped
        notifications/tools/list_changed: no standalone channel" and the
        notification is lost. So the modern path is opened here, for the life
        of the session, and each event marks the session stale.

        BEST EFFORT, NEVER FATAL. A server that predates listen, refuses it or
        drops it still serves tool calls; the session simply cannot learn about
        list changes, which is the pre-existing state of the world, not a
        regression. Nothing here can raise into the actor.

        `_WATCH_LIST_CHANGES` exists for ONE reason: the test suite's in-process
        ASGI transport buffers a whole response before returning it, so a
        long-lived listen stream can never be acknowledged and — measured — the
        SDK's in-flight POST for it can never be aborted either, which wedges
        the client's teardown. `tests/fakes/mcp_http.patch_transport` turns the
        watch off alongside the socket layer it replaces; the listen contract
        is proven separately against the SDK in-process (test_approval_binding).
        """
        if not _WATCH_LIST_CHANGES:
            await self._stop.wait()
            return

        async def watch() -> None:
            try:
                async with client.listen(
                    tools_list_changed=True,
                    prompts_list_changed=True,
                    resources_list_changed=True,
                ) as subscription:
                    async for event in subscription:
                        self._mark_stale(type(event).__name__)
            except anyio.get_cancelled_exc_class():
                raise
            except Exception as exc:  # noqa: BLE001 -- see docstring
                log.debug(
                    "mcp.listen_unavailable",
                    extra={
                        "server": self.spec.identity.slug,
                        "reason": type(exc).__name__,
                    },
                )

        async with anyio.create_task_group() as tg:
            tg.start_soon(watch)
            await self._stop.wait()
            # The scope belongs to THIS task, so cancelling it here is the one
            # cancel-scope shape that is safe in this file.
            tg.cancel_scope.cancel()

    def _mark_stale(self, kind: str) -> None:
        """A `list_changed` notification arrived on this session."""
        session = self.session
        if session is None or session.stale:
            return
        session.stale = True
        log.warning(
            "mcp.session_stale",
            extra={
                "server": self.spec.identity.slug,
                "kind": kind,
                "user_id": self.spec.user_id,
            },
        )

    async def _discover(self, client: Any) -> tuple[list[ToolDefinition], int]:
        """`tools/list` -> bounded, normalized ToolDefinitions.

        Returns the advertised count too, so the caller can report what was
        dropped. Silent truncation would read as "this server has 256 tools".
        """
        # No cancel scope: `read_timeout_seconds` on the session already bounds
        # this request, and a scope here would be a second, redundant mechanism
        # in a file where cancel scopes have already proven hazardous.
        listed = await client.list_tools()
        advertised = list(getattr(listed, "tools", None) or [])
        tools = normalize_tools(
            advertised,
            self.spec.identity,
            timeout_s=self.spec.tool_timeout_s,
            max_tools=self._limits.max_tools_per_server,
            max_schema_bytes=self._limits.max_tool_schema_bytes,
            # Binds every definition to THIS connection and endpoint, so an
            # approval cannot be replayed against another (see binding.py).
            origin=f"{self.spec.connection_id}|{self.spec.endpoint_url}",
        )
        dropped = len(advertised) - len(tools)
        if dropped > 0:
            # WARNING, not debug: a dropped tool is a capability the user asked
            # for and did not get.
            log.warning(
                "mcp.tools_dropped",
                extra={
                    "server": self.spec.identity.slug,
                    "advertised": len(advertised),
                    "accepted": len(tools),
                    "dropped": dropped,
                },
            )
        return tools, len(advertised)

    async def aclose(self) -> None:
        """Ask the owner task to tear down, and wait for it to finish."""
        self._stop.set()
        await self._done.wait()


class McpSessionPool:
    """Tenant-keyed pool of live sessions, owned by the application lifespan."""

    def __init__(
        self,
        limits: PoolLimits | None = None,
        *,
        resolver: CredentialResolver | None = None,
    ) -> None:
        self._limits = limits or PoolLimits()
        self._resolver = resolver or NullCredentialResolver()
        self._actors: dict[PoolKey, _SessionActor] = {}
        self._lock = anyio.Lock()
        self._tg: Any = None
        self._closed = False

    # ------------------------------------------------------------ lifecycle
    async def start(self, stack: AsyncExitStack) -> McpSessionPool:
        """Enter the pool's task group on the caller's stack (the lifespan's).

        The group must outlive any single request, because sessions do. Starting
        a session from a REQUEST task into this group is supported and verified.
        """
        self._tg = await stack.enter_async_context(anyio.create_task_group())
        self._tg.start_soon(self._sweep)
        return self

    async def aclose(self) -> None:
        """Close every session, then let the task group unwind.

        LOAD-BEARING, and verified: a parked actor never returns on its own, so
        leaving one open makes the enclosing task group wait forever — which
        would hang systemd shutdown. The timeout plus the cancel backstop mean a
        wedged remote server cannot do it either.
        """
        self._closed = True
        async with self._lock:
            actors = list(self._actors.values())
            self._actors.clear()
        if actors:
            with anyio.move_on_after(self._limits.close_timeout_s):
                for actor in actors:
                    with contextlib.suppress(Exception):
                        await actor.aclose()
        if self._tg is not None:
            # Backstop: cancels the sweeper, and anything that refused to close.
            self._tg.cancel_scope.cancel()
        log.info("mcp.pool_closed", extra={"sessions": len(actors)})

    # -------------------------------------------------------------- acquire
    @contextlib.asynccontextmanager
    async def acquire(
        self,
        spec: McpConnectionSpec,
        *,
        resolver: CredentialResolver | None = None,
    ) -> AsyncIterator[McpSession]:
        """Borrow a live session for one operation.

        Marks the session in-flight for the duration, so a concurrent eviction
        cannot close it underneath the call — `terminate_on_close` sends a DELETE
        that would abort the request in progress.
        """
        session = await self._get(spec, resolver=resolver)
        async with session.in_use():
            yield session

    async def _get(
        self,
        spec: McpConnectionSpec,
        *,
        resolver: CredentialResolver | None = None,
    ) -> McpSession:
        if self._closed or self._tg is None:
            raise McpConnectionError(
                McpErrorKind.UNREACHABLE,
                "the MCP session pool is not running",
                server_slug=spec.identity.slug,
            )
        key = spec.pool_key
        async with self._lock:
            actor = self._actors.get(key)
            if (
                actor is not None
                and actor.session is not None
                and not actor.session.stale
            ):
                actor.session.last_used_at = anyio.current_time()
                return actor.session
            if actor is not None:
                # A previous attempt failed and left a dead entry behind — or
                # the server changed its list and the session is stale. Either
                # way it is replaced, never reused.
                self._actors.pop(key, None)
                if actor.session is not None:
                    with contextlib.suppress(Exception):
                        await actor.aclose()

            await self._make_room(key)

            actor = _SessionActor(spec, resolver or self._resolver, self._limits)
            # Started INSIDE the lock so two concurrent first-calls for the same
            # key cannot both open a session — the classic pool race.
            await self._tg.start(actor.run)
            if actor.session is None:
                raise actor.error or McpConnectionError(
                    McpErrorKind.UNREACHABLE,
                    "the session did not start and reported no error",
                    server_slug=spec.identity.slug,
                )
            self._actors[key] = actor
            return actor.session

    async def discard(self, key: PoolKey) -> None:
        """Evict one session — after a transport failure, or on disconnect.

        This is the whole health story: there is no probe, so a broken session
        is discovered by a call failing and removed here.
        """
        async with self._lock:
            actor = self._actors.pop(key, None)
        if actor is not None:
            with contextlib.suppress(Exception):
                await actor.aclose()
            log.info(
                "mcp.session_discarded",
                extra={"server": actor.spec.identity.slug, "user_id": key[0]},
            )

    # ------------------------------------------------------------- internals
    async def _make_room(self, incoming: PoolKey) -> None:
        """Enforce the per-user and global caps. Caller holds the lock."""
        user_id = incoming[0]
        per_user = [
            (k, a)
            for k, a in self._actors.items()
            if k[0] == user_id and a.session is not None
        ]
        while len(per_user) >= self._limits.max_sessions_per_user:
            victim = self._evict_choice(per_user)
            if victim is None:
                break
            await self._close_locked(victim)
            per_user = [(k, a) for k, a in per_user if k != victim]

        while len(self._actors) >= self._limits.max_sessions:
            victim = self._evict_choice(list(self._actors.items()))
            if victim is None:
                # Everything is in flight. Refuse rather than close a live call
                # or grow without bound.
                raise McpConnectionError(
                    McpErrorKind.UNREACHABLE,
                    "the MCP session pool is at capacity; try again shortly",
                    server_slug=incoming[2],
                )
            await self._close_locked(victim)

    @staticmethod
    def _evict_choice(
        candidates: list[tuple[PoolKey, _SessionActor]],
    ) -> PoolKey | None:
        """Least-recently-used among sessions with nothing in flight."""
        idle = [
            (a.session.last_used_at, k)
            for k, a in candidates
            if a.session is not None and a.session.in_flight == 0
        ]
        return min(idle)[1] if idle else None

    async def _close_locked(self, key: PoolKey) -> None:
        actor = self._actors.pop(key, None)
        if actor is not None:
            with contextlib.suppress(Exception):
                await actor.aclose()

    async def _sweep(self) -> None:
        """One sweeper for the whole pool — not one task per session."""
        try:
            while True:
                await anyio.sleep(self._limits.sweep_interval_s)
                await self._sweep_once()
        except anyio.get_cancelled_exc_class():
            raise
        except Exception:  # noqa: BLE001 — a sweeper fault must not kill the pool
            log.warning("mcp.sweeper_failed")

    async def _sweep_once(self) -> None:
        cutoff = anyio.current_time() - self._limits.idle_ttl_s
        async with self._lock:
            stale = [
                k
                for k, a in self._actors.items()
                if a.session is not None
                and a.session.in_flight == 0
                and a.session.last_used_at < cutoff
            ]
            for key in stale:
                await self._close_locked(key)
        if stale:
            log.info("mcp.sessions_swept", extra={"closed": len(stale)})

    # ---------------------------------------------------------- inspection
    @property
    def size(self) -> int:
        return len(self._actors)

    def snapshot(self) -> dict:
        """Credential-free summary for the status route and for tests."""
        return {
            "sessions": len(self._actors),
            "by_server": sorted(
                {a.spec.identity.slug for a in self._actors.values()}
            ),
            "limits": {
                "max_sessions": self._limits.max_sessions,
                "max_sessions_per_user": self._limits.max_sessions_per_user,
                "idle_ttl_s": self._limits.idle_ttl_s,
            },
        }


#: Type of the callable a caller may pass to obtain a pool lazily.
PoolProvider = Callable[[], McpSessionPool | None]

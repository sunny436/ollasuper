"""Discovered MCP tools -> a REQUEST-SCOPED ToolRegistry + adapter map.

THE PHASE 5 HANDOFF, and the reason it is request-scoped rather than global.

`app.state.tool_registry` is process-global (`main.py`), and MCP tools are
per-user: registering them there would publish one tenant's connected-server
tool names to every other user of the process. So this builds a registry FOR ONE
TURN, layered over the shared Ollagraph catalogue, and throws it away after.

WHY A COPY AND NOT A MUTATION OF THE GLOBAL ONE. `replace_provider` is surgical
per provider, so mutating the global registry and cleaning up afterwards would
"work" — right up until two concurrent turns for different users interleave, at
which point the cleanup of one removes the other's tools. A per-request registry
has no such window.

WHAT THIS DELIBERATELY DOES NOT DO: bind tools to the model, select them, or
touch `runner.py`. Phase 3's job is to make the composition possible and prove
it executes through the real machinery; wiring it into the live chat turn is
Phase 5, which also owns the `dispatchPayload` field that carries a user's
connections and the Python-before-Convex deploy ordering that comes with it.
"""

from __future__ import annotations

import contextlib
from collections.abc import Callable
from typing import Any

from app.logging import get_logger
from app.mcp.adapter import McpToolAdapter
from app.mcp.exceptions import McpConnectionError, McpErrorKind
from app.mcp.session import McpSession, McpSessionPool
from app.models.tools import ToolDefinition
from app.tools.registry import ToolRegistry

log = get_logger(__name__)

__all__ = ["ComposedTools", "compose_tools"]


class ComposedTools:
    """One turn's view of the tool catalogue: base tools plus MCP ones."""

    def __init__(
        self,
        registry: ToolRegistry,
        adapters: dict[str, Any],
        tools: list[ToolDefinition],
    ) -> None:
        self.registry = registry
        #: Keyed by `tool.provider`, which is exactly what the executor's
        #: `ctx.adapters.get(tool.provider)` dispatch reads. No executor change.
        self.adapters = adapters
        self.tools = tools

    @property
    def tool_ids(self) -> set[str]:
        return {t.tool_id for t in self.tools}


def compose_tools(
    sessions: list[McpSession],
    *,
    base: ToolRegistry | None = None,
    pool: McpSessionPool | None = None,
    result_max_bytes: int = 256 * 1024,
    result_max_blocks: int = 512,
    result_max_depth: int = 32,
    quota: Any = None,
    user_gate: Any = None,
    hourly: Callable[[], Any] | None = None,
) -> ComposedTools:
    """Build a per-request registry carrying `base`'s tools plus every session's.

    `pool` is how an adapter reaches a LIVE session at call time rather than
    holding the one it was built with: a session can be evicted between
    composing the turn's tools and the model actually calling one, and an
    adapter clutching a dead client would fail a call that a fresh borrow would
    have served.
    """
    registry = ToolRegistry()

    # Layer the shared catalogue in first, so an MCP provider can never displace
    # an Ollagraph tool — the ids are namespaced, but the ORDER makes the
    # precedence explicit rather than incidental.
    if base is not None:
        for tool in base.list():
            registry.register(tool)
        for provider in {t.provider for t in base.list()}:
            components = base.components_for(provider)
            if components:
                registry.replace_provider(
                    provider,
                    [t for t in base.list() if t.provider == provider],
                    components,
                )

    adapters: dict[str, Any] = {}
    composed: list[ToolDefinition] = []
    for session in sessions:
        provider = session.spec.identity.provider_id
        # Surgical per provider: refreshing or dropping one connection cannot
        # disturb another's tools.
        registry.replace_provider(provider, session.tools)
        adapters[provider] = _adapter_for(
            session,
            pool,
            result_max_bytes,
            result_max_blocks,
            result_max_depth,
            quota=quota,
            user_gate=user_gate,
            hourly=hourly,
        )
        composed.extend(session.tools)

    log.info(
        "mcp.tools_composed",
        extra={
            "servers": len(sessions),
            "mcp_tools": len(composed),
            "total_tools": registry.count,
        },
    )
    return ComposedTools(registry, adapters, composed)


@contextlib.asynccontextmanager
async def _unless_stale(bound: McpSession, borrow: Any) -> Any:
    if bound.stale:
        raise McpConnectionError(
            McpErrorKind.CAPABILITY_ERROR,
            "the server changed its tool list during this turn; "
            "start a new turn to use the updated tools",
            server_slug=bound.spec.identity.slug,
        )
    async with borrow as session:
        yield session


def _adapter_for(
    session: McpSession,
    pool: McpSessionPool | None,
    result_max_bytes: int,
    result_max_blocks: int = 512,
    result_max_depth: int = 32,
    *,
    quota: Any = None,
    user_gate: Any = None,
    hourly: Callable[[], Any] | None = None,
) -> McpToolAdapter:
    spec = session.spec
    if pool is None:
        # No pool: bind to the session we were handed. Used by tests and by
        # one-shot probes; a long-lived turn should pass the pool.
        def _fixed() -> Any:
            return _Borrowed(session)

        provider: Callable[[], Any] = _fixed
    else:

        def _from_pool() -> Any:
            # Re-borrowed per call, so an eviction between composing and calling
            # costs a reconnect rather than a failure. BUT the tools this turn
            # bound came from `session`: if THAT session went stale (the server
            # changed its list), a reconnect would serve the new definitions to
            # calls validated and policy-checked against the old ones — a read
            # renamed into a write would run unasked. So a stale turn session
            # refuses for the rest of the turn; the next turn re-discovers.
            return _unless_stale(session, pool.acquire(spec))

        provider = _from_pool

    return McpToolAdapter(
        session_provider=provider,
        result_max_bytes=result_max_bytes,
        server_slug=spec.identity.slug,
        result_max_blocks=result_max_blocks,
        result_max_depth=result_max_depth,
        quota=quota,
        user_gate=user_gate,
        hourly=hourly,
        connection_id=spec.connection_id,
    )


class _Borrowed:
    """Async-context wrapper around an already-held session."""

    def __init__(self, session: McpSession) -> None:
        self._session = session

    async def __aenter__(self) -> McpSession:
        self._session.in_flight += 1
        return self._session

    async def __aexit__(self, *exc: object) -> bool:
        self._session.in_flight -= 1
        return False

"""One chat turn's MCP capabilities: sessions in, tools + index out.

THE WHOLE PHASE 5 INTEGRATION IS THIS FUNCTION plus the handful of lines in
`runner.py` that call it. It lives here rather than in `runner.py` so the
acquire/discover/compose sequence — the part with the failure rules — is testable
without driving a whole generation, and so `runner.py` grows one `async with`
instead of forty lines.

THE FAILURE RULES, which are the reason this is not a one-liner:

  * ONE SERVER FAILING COSTS ONLY THAT SERVER (§116). Every connection is
    acquired inside its own try/except. GitHub being down must not cost the user
    Slack, Notion, or their native tools — so nothing here can raise into the
    turn.
  * ONE CAPABILITY FAILING COSTS ONLY THAT CAPABILITY (§117). `discover_capabilities`
    already isolates resources from prompts; this isolates both from TOOLS, which
    come from the session handshake rather than from a list call.
  * A TURN WITH NO WORKING MCP SERVER IS A NORMAL TURN. The caller gets an empty
    composition and binds exactly what it would have bound before Phase 5.

WHY SESSIONS ARE HELD OPEN FOR THE TURN. The adapter reaches a LIVE session at
call time through the pool, but the pool's idle sweeper could evict one between
composing the turn's tools and the model actually calling one. Holding the borrow
for the turn's duration is what makes "the tool I bound is still there" true.
"""

from __future__ import annotations

from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any

from app.logging import get_logger
from app.mcp.compose import ComposedTools, compose_tools
from app.mcp.index import McpCapabilityIndex, discover_capabilities
from app.mcp.models import McpConnectionSpec, McpServerIdentity
from app.mcp.quota import QuotaLimits, TurnQuota, refused
from app.tools.registry import ToolRegistry

log = get_logger(__name__)

__all__ = ["TurnCapabilities", "mcp_for_turn"]


class TurnCapabilities:
    """What one turn got from MCP. Empty is a completely normal outcome."""

    def __init__(
        self,
        composed: ComposedTools | None = None,
        index: McpCapabilityIndex | None = None,
        failures: list[str] | None = None,
    ) -> None:
        self.composed = composed
        self.index = index or McpCapabilityIndex()
        #: Server slugs that could not be reached. Reported so "no MCP tools" is
        #: distinguishable from "MCP tools, but the server is down".
        self.failures = failures or []
        #: The turn's call counters (`quota.py`); set by `mcp_for_turn`.
        self.quota: TurnQuota | None = None
        #: Untrusted connectors NOT composed because the user has not opted
        #: them into this thread (H-06). Reported, never an error.
        self.inactive: list[str] = []

    @property
    def active(self) -> bool:
        return self.composed is not None and bool(self.composed.tools)

    @property
    def registry(self) -> ToolRegistry | None:
        return self.composed.registry if self.composed else None

    @property
    def adapters(self) -> dict[str, Any]:
        return dict(self.composed.adapters) if self.composed else {}

    @property
    def tool_ids(self) -> set[str]:
        return self.composed.tool_ids if self.composed else set()

    def as_log_fields(self) -> dict[str, Any]:
        return {
            "mcp_tools": len(self.composed.tools) if self.composed else 0,
            "mcp_connections": len(self.index.connection_ids),
            "mcp_resources": len(self.index.resources()),
            "mcp_prompts": len(self.index.prompts()),
            "mcp_failures": self.failures,
            "mcp_inactive": self.inactive,
        }


@asynccontextmanager
async def mcp_for_turn(
    pool: Any,
    connections: list[Any],
    *,
    user_id: str,
    workspace_id: str,
    base: ToolRegistry | None = None,
    resolve_target: Any = None,
    engine: Any = None,
    settings: Any = None,
    convex: Any = None,
):
    """Acquire every connected server for this turn; yield its capabilities.

    `connections` are `McpConnectionRef`s from the dispatch payload — already
    ownership-checked by Convex. They carry no credential and no tenant: the
    vault resolves a credential per session from `(user, workspace, connection)`.

    `user_id` / `workspace_id` ARE SEPARATE PARAMETERS, deliberately. They come
    from `GenerateRequest`, which Convex built from the authenticated session —
    never from the connection list, and never from anything a model touched. They
    are two thirds of the pool key and the whole of the vault lookup, so reading
    them from a less trusted place would be a cross-tenant session lookup wearing
    ordinary-looking code.

    NEVER RAISES for a server-side problem. The turn must run whether or not the
    user's MCP servers are healthy.
    """
    if pool is None or not connections:
        yield TurnCapabilities()
        return

    from app.mcp.registry import curated

    resolve = resolve_target or curated.resolve
    failures: list[str] = []
    inactive: list[str] = []
    sessions: list[Any] = []
    index = McpCapabilityIndex()

    async with AsyncExitStack() as stack:
        for ref in connections:
            slug = getattr(ref, "slug", "") or "unknown"
            try:
                # Phase 6: a LOCAL row routes to its own gateway instance
                # instead of to a remote endpoint. Everything after this — the
                # pool, the session actor, normalization, the capability index,
                # the adapter — is identical for both, which is the parity
                # §93/§94 asks for and the reason local needs no second stack.
                local = await _local_spec(
                    ref,
                    slug,
                    user_id=user_id,
                    workspace_id=workspace_id,
                    settings=settings,
                    engine=engine,
                )
                if local is not None:
                    session = await stack.enter_async_context(pool.acquire(local))
                    sessions.append(session)
                    spec, target = local, None
                else:
                    target = await resolve(engine, getattr(ref, "serverName", ""))
                    if target is None or not target.enabled:
                        # De-curated since the connection was made. Not an error
                        # — an operator turning a server off is supposed to stop
                        # it being used.
                        failures.append(slug)
                        continue
                    if not target.trusted and not getattr(ref, "activated", False):
                        # DEFAULT-DENY for an untrusted server (audit H-06): its
                        # tools and descriptions enter a thread only after the
                        # user named it there or used it there. Not a failure —
                        # the user did not ask for it.
                        inactive.append(slug)
                        continue

                    spec = McpConnectionSpec(
                        connection_id=getattr(ref, "connectionId", ""),
                        identity=McpServerIdentity(
                            slug=target.slug, trusted=target.trusted
                        ),
                        server_name=target.server_name,
                        version=getattr(ref, "version", None)
                        or target.version
                        or "unknown",
                        transport=target.transport,
                        endpoint_url=target.endpoint_url,
                        auth_kind=target.auth_kind,
                        user_id=user_id,
                        workspace_id=workspace_id,
                    )
                    session = await stack.enter_async_context(pool.acquire(spec))
                    sessions.append(session)
            except Exception as exc:  # noqa: BLE001 — one server, not the turn
                failures.append(slug)
                log.warning(
                    "mcp.turn_connection_unavailable",
                    extra={"server": slug, "reason": type(exc).__name__},
                )
                continue

            # Discovery is separately guarded: a session that opened but whose
            # lists fail should still contribute its TOOLS, which came from the
            # handshake rather than from a list call.
            try:
                entry = await discover_capabilities(
                    session.client,
                    connection_id=spec.connection_id,
                    # FROM THE SPEC, not from `target`: the local branch has no
                    # curated target, so reading `target.slug` raised
                    # AttributeError, the except swallowed it, and every local
                    # server silently contributed no resources or prompts. The
                    # spec is the one object both branches always have.
                    server_slug=spec.identity.slug,
                    snapshot=getattr(session, "snapshot", None),
                    max_resources=getattr(
                        settings, "mcp_max_resources_per_server", 256
                    ),
                    max_templates=getattr(
                        settings, "mcp_max_resource_templates_per_server", 64
                    ),
                    max_prompts=getattr(settings, "mcp_max_prompts_per_server", 128),
                )
                index.add(entry, client=session.client)
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "mcp.turn_capabilities_unavailable",
                    extra={"server": slug, "reason": type(exc).__name__},
                )

        quota = TurnQuota(_quota_limits(settings))
        composed = (
            compose_tools(
                sessions,
                base=base,
                pool=pool,
                result_max_bytes=getattr(settings, "mcp_result_max_bytes", 256 * 1024),
                result_max_blocks=getattr(settings, "mcp_max_result_blocks", 512),
                result_max_depth=getattr(settings, "mcp_max_result_depth", 32),
                quota=quota,
                user_gate=pool.user_gate(user_id)
                if hasattr(pool, "user_gate")
                else None,
                hourly=_hourly_charger(convex, user_id),
            )
            if sessions
            else None
        )
        capabilities = TurnCapabilities(composed, index, failures)
        capabilities.quota = quota
        capabilities.inactive = inactive
        log.info("mcp.turn_capabilities", extra=capabilities.as_log_fields())
        try:
            yield capabilities
        finally:
            if quota.calls:
                log.info("mcp.turn_quota", extra=quota.as_log_fields())


def _quota_limits(settings: Any) -> QuotaLimits:
    g = lambda name, default: getattr(settings, name, default)  # noqa: E731
    return QuotaLimits(
        max_calls_per_turn=g("mcp_max_calls_per_turn", 64),
        max_calls_per_connection_turn=g("mcp_max_calls_per_connection_turn", 24),
        max_calls_per_tool_turn=g("mcp_max_calls_per_tool_turn", 8),
        max_identical_calls_turn=g("mcp_max_identical_calls_turn", 2),
        max_result_bytes_per_turn=g("mcp_max_result_bytes_per_turn", 2 * 1024 * 1024),
        max_concurrent_calls_per_user=g("mcp_max_concurrent_calls_per_user", 4),
    )


def _hourly_charger(convex: Any, user_id: str) -> Any:
    """The durable per-user hourly window, charged through Convex.

    FAIL CLOSED: a window that cannot be charged — Convex down, the op
    rejected, a malformed answer — is a call that does not run. None when no
    control plane is attached (tests, one-shot probes), which is the only
    configuration in which the hourly cap is not enforced.
    """
    if convex is None:
        return None

    async def charge() -> None:
        try:
            body = await convex.ingress(
                {"op": "mcp-quota-consume", "userId": user_id, "kind": "mcpToolCall"}
            )
        except Exception as exc:  # noqa: BLE001 -- refused, whatever the cause
            log.warning("mcp.quota_charge_failed", extra={"reason": type(exc).__name__})
            raise refused("the connector call budget could not be checked") from exc
        if not isinstance(body, dict) or body.get("ok") is not True:
            raise refused(
                str((body or {}).get("detail") or "hourly connector call limit reached")
                if isinstance(body, dict)
                else "hourly connector call limit reached"
            )

    return charge


async def _local_spec(
    ref: Any,
    slug: str,
    *,
    user_id: str,
    workspace_id: str,
    settings: Any,
    engine: Any,
) -> Any:
    """A validated local row -> a gateway spec, or None if this is not local.

    RETURNS None RATHER THAN RAISING for "not a local server", because the vast
    majority of refs are remote and a missing local row is the normal case, not
    an error. A row that IS local but fails validation raises — that is a
    misconfiguration an operator must see, and it must not silently fall through
    to the remote path where the strict guard would reject it with a confusing
    message about HTTPS.
    """
    from app.mcp.local.gateway import resolve_local_spec

    return await resolve_local_spec(
        engine,
        slug,
        connection_id=getattr(ref, "connectionId", ""),
        user_id=user_id,
        workspace_id=workspace_id,
        settings=settings,
    )

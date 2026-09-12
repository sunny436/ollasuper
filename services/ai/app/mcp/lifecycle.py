"""Connect / refresh / disconnect / status — the only module that knows the
connection state machine.

                     ┌────────────────────────────────────────┐
                     ▼                                        │
   CONFIGURED ─connect─▶ CONNECTING ──▶ INITIALIZING ──▶ READY │
       ▲                     │               │            │   │
       │                     ▼               ▼            ├─ call fails ─▶ DEGRADED
       │                  FAILED ◀───────────┘            │        │
       │                     │                            │  bounded reconnect
       └─── disconnect ──────┴────────────────────────────┴──▶ DISCONNECTED

   UNSUPPORTED — no usable remote. Terminal, and never dialled.

TWO INVARIANTS THAT ARE EASY TO GET WRONG:

1. READY REQUIRES A COMPLETED INITIALIZE *AND* A CAPABILITY SNAPSHOT. A transport
   that opened is not a connection. The pool enforces this by construction — an
   actor only reports success after `tools/list` returns — but the state name is
   what a user reads, so it must not mean "we got a socket".

2. CATALOGUE STATUS AND CONNECTION STATUS NEVER WRITE TO EACH OTHER. A server
   the registry deleted does not delete anybody's connection; it blocks NEW
   connections, marks existing ones UNSUPPORTED on the next attempt, and keeps
   the row and its history. One user's failed connection likewise never mutates
   the catalogue: it is evidence about that user's credentials or network, not
   about the server's existence.

WHAT THIS MODULE DOES NOT DO: persist anything. Connection RECORDS live in
Convex, which owns tenancy and authorization; this returns a report and the
control plane writes it. Live sessions live in the pool. Nothing in between is
serialized — the brief's runtime/persisted split, kept honest by there being no
storage call in this file at all.

CATALOGUE LOOKUP IS INJECTED (`resolve_target`), and not for purity's sake. It
means the state machine above — which is the part that is easy to get subtly
wrong — is provable on a machine with no database, which is the machine this was
written on. `app/mcp/registry/sync.py` makes the same argument for the same
reason; the SQL behind the default is covered by the DB-gated tests.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any

from app.logging import get_logger
from app.mcp.capabilities import CapabilitySnapshot
from app.mcp.compat import assess
from app.mcp.credentials import CredentialResolver
from app.mcp.exceptions import McpConnectionError, McpErrorKind
from app.mcp.models import McpConnectionSpec, McpServerIdentity
from app.mcp.registry import curated
from app.mcp.session import McpSessionPool

log = get_logger(__name__)

#: How the lifecycle reaches the catalogue. Defaults to `curated.resolve`.
ResolveTarget = Callable[[Any, str], Awaitable["curated.CuratedTarget | None"]]

__all__ = [
    "ConnectionReport",
    "refresh",
    "ConnectionRequest",
    "ConnectionState",
    "connect",
    "disconnect",
    "preflight",
    "status",
]


class ConnectionState(StrEnum):
    CONFIGURED = "configured"
    CONNECTING = "connecting"
    INITIALIZING = "initializing"
    READY = "ready"
    DEGRADED = "degraded"
    FAILED = "failed"
    DISCONNECTED = "disconnected"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True)
class ConnectionRequest:
    """Everything a connection operation needs, ALL of it server-resolved.

    `user_id` and `workspace_id` come from the Convex session, never from a
    request body. The MCP server has no say in either — it is told nothing about
    who is calling beyond the credential the resolver attaches.
    """

    connection_id: str
    server_name: str
    user_id: str
    workspace_id: str
    #: An explicit pin from the connection record. None means "use whatever the
    #: curated row resolves to", and the answer is recorded in the report so a
    #: later catalogue change cannot silently re-point this connection.
    version: str | None = None


@dataclass
class ConnectionReport:
    """The outcome of one lifecycle operation. Safe to persist and to render."""

    state: ConnectionState
    server_name: str
    slug: str = ""
    version: str | None = None
    version_mode: str = "latest_at_connect"
    transport: str = ""
    auth_kind: str = "unknown"
    catalogue_status: str = ""
    capabilities: CapabilitySnapshot | None = None
    tool_count: int = 0
    tools: list[str] = field(default_factory=list)
    error_kind: str | None = None
    error_detail: str | None = None
    retryable: bool = False
    user_action_required: bool = False
    reconnect_allowed: bool = True

    @property
    def ok(self) -> bool:
        return self.state is ConnectionState.READY

    def as_dict(self) -> dict:
        out = asdict(self)
        out["state"] = str(self.state)
        out["capabilities"] = (
            self.capabilities.as_dict() if self.capabilities else None
        )
        return out


def _failure(
    server_name: str,
    err: McpConnectionError,
    *,
    state: ConnectionState = ConnectionState.FAILED,
    **extra: Any,
) -> ConnectionReport:
    return ConnectionReport(
        state=state,
        server_name=server_name,
        error_kind=str(err.kind),
        error_detail=err.detail,
        retryable=err.retryable,
        user_action_required=err.user_action_required,
        reconnect_allowed=err.reconnect_allowed,
        **extra,
    )


async def preflight(
    engine: Any,
    server_name: str,
    *,
    credentials_available: bool = False,
    resolve_target: ResolveTarget = curated.resolve,
    settings: Any = None,
) -> ConnectionReport:
    """Can this server be connected AT ALL? Answers without touching the network.

    This is the gate that makes "no local execution" structural rather than
    aspirational: a stdio-only or packages-only entry is refused here, in a
    function that has no transport and cannot dial anything.
    """
    target = await resolve_target(engine, server_name)
    if target is None:
        # PHASE 6: a LOCAL server has no curated row — its allowlist is a
        # separate table, because "may this run remotely" and "may this run
        # locally" are independent decisions.
        #
        # WITHOUT THIS BRANCH THE WHOLE LOCAL PATH IS UNREACHABLE, and that was
        # measured rather than reasoned about: preflight answered `unsupported`,
        # so a local connection could never reach `ready`, so `dispatchPayload`
        # (which sends only ready connections) never carried it, so the turn-side
        # routing never ran in a real deployment. The tests passed because they
        # drove the turn directly.
        local = await _local_report(engine, server_name, settings=settings)
        if local is not None:
            return local
        return _failure(
            server_name,
            McpConnectionError(
                McpErrorKind.UNSUPPORTED_TRANSPORT,
                "this server is not in the curated set for this deployment",
            ),
            state=ConnectionState.UNSUPPORTED,
        )
    if not target.enabled:
        return _failure(
            server_name,
            McpConnectionError(
                McpErrorKind.UNSUPPORTED_TRANSPORT,
                "this server is curated but not enabled on this deployment",
            ),
            state=ConnectionState.UNSUPPORTED,
            slug=target.slug,
        )

    verdict = assess(
        {
            "remotes": target.remotes,
            "packages": target.packages,
            "auth_kind": target.auth_kind,
        },
        credentials_available=credentials_available,
    )
    base = {
        "slug": target.slug,
        "version": target.version,
        "version_mode": target.version_mode,
        "transport": target.transport,
        "auth_kind": target.auth_kind,
        "catalogue_status": target.catalogue_status,
    }
    if not verdict.ok:
        kind = (
            McpErrorKind.AUTH_REQUIRED
            if verdict.auth_required
            else McpErrorKind.UNSUPPORTED_TRANSPORT
        )
        return _failure(
            server_name,
            McpConnectionError(kind, verdict.reason),
            # An auth-satisfiable server is CONFIGURED, not UNSUPPORTED: the
            # difference is "connect your account" versus "this will never work
            # here", and flattening them would send a user looking for a setting
            # that does not exist.
            state=(
                ConnectionState.CONFIGURED
                if verdict.auth_required
                else ConnectionState.UNSUPPORTED
            ),
            **base,
        )
    return ConnectionReport(
        state=ConnectionState.CONFIGURED, server_name=server_name, **base
    )


async def connect(
    engine: Any,
    pool: McpSessionPool,
    request: ConnectionRequest,
    *,
    resolver: CredentialResolver | None = None,
    settings: Any = None,
    resolve_target: ResolveTarget = curated.resolve,
) -> ConnectionReport:
    """Open (or reuse) a session and report what the server actually exposes.

    Idempotent by design: the pool returns an existing session for the same
    tenant+connection, so a double-click costs no second handshake.
    """
    credentials_available = _can_supply(resolver)
    report = await preflight(
        engine,
        request.server_name,
        credentials_available=credentials_available,
        resolve_target=resolve_target,
        # WITHOUT THIS THE WHOLE LOCAL PATH IS UNREACHABLE, and Phase 6 shipped
        # without it. `settings` was accepted by this function and used only for
        # `_timeouts`, so `preflight` fell back to its default `settings=None`,
        # `_local_report` never fired, a local server answered `unsupported`,
        # and the `is not CONFIGURED` return below sent it straight back. The
        # row could therefore never reach `ready`, and `dispatchPayload` — which
        # sends only ready connections — never carried it.
        #
        # Phase 6's own regression test missed it by calling `preflight`
        # DIRECTLY with `settings=`, proving the unit while the seam in front of
        # it stayed broken. The test for this fix drives the ROUTE.
        settings=settings,
    )
    if report.state is not ConnectionState.CONFIGURED:
        return report
    if report.error_kind:  # auth-required, reported as CONFIGURED
        return report

    # PHASE 6: a LOCAL server dials its own gateway instance rather than a
    # curated endpoint, so it has no row in `mcp_curated_servers` and
    # `resolve_target` below would answer None for it. Everything after the
    # session opens — normalization, the snapshot, the tool list — is identical
    # for both, which is why this is a branch and not a second lifecycle.
    local = await _local_spec_for(engine, request, settings)
    if local is not None:
        return await _open_local(pool, local, request)

    target = await resolve_target(engine, request.server_name)
    if target is None:  # pragma: no cover - preflight already proved it resolves
        return report

    version = request.version or target.version
    if not version:
        return _failure(
            request.server_name,
            McpConnectionError(
                McpErrorKind.UNSUPPORTED_TRANSPORT,
                "the catalogue records no version for this server",
            ),
            state=ConnectionState.UNSUPPORTED,
            slug=target.slug,
        )

    # The endpoint comes from the CURATED row, but the transport is taken from
    # the assessed remote so a server that changed transports between curation
    # and now is caught rather than dialled with a stale assumption.
    verdict = assess(
        {
            "remotes": target.remotes,
            "packages": target.packages,
            "auth_kind": target.auth_kind,
        },
        credentials_available=credentials_available,
    )
    spec = McpConnectionSpec(
        connection_id=request.connection_id,
        identity=McpServerIdentity(
            slug=target.slug,
            display_name=target.display_name,
            # The operator's SECOND decision, separate from `enabled`. Feeds
            # `normalize._side_effect`, which is what decides whether a tool may
            # skip the approval gate.
            trusted=target.trusted,
        ),
        server_name=target.server_name,
        version=version,
        transport=verdict.transport or target.transport,
        endpoint_url=target.endpoint_url,
        auth_kind=target.auth_kind,
        user_id=request.user_id,
        workspace_id=request.workspace_id,
        **_timeouts(settings),
    )

    try:
        async with pool.acquire(spec, resolver=resolver) as session:
            return ConnectionReport(
                state=ConnectionState.READY,
                server_name=target.server_name,
                slug=target.slug,
                version=version,
                version_mode=(
                    "pinned" if request.version else target.version_mode
                ),
                transport=spec.transport,
                auth_kind=target.auth_kind,
                catalogue_status=target.catalogue_status,
                capabilities=session.snapshot,
                tool_count=len(session.tools),
                tools=[t.name for t in session.tools],
            )
    except McpConnectionError as err:
        return _failure(
            target.server_name,
            err,
            slug=target.slug,
            version=version,
            transport=spec.transport,
            auth_kind=target.auth_kind,
            catalogue_status=target.catalogue_status,
        )


async def refresh(
    engine: Any,
    pool: McpSessionPool,
    request: ConnectionRequest,
    *,
    resolver: CredentialResolver | None = None,
    settings: Any = None,
    resolve_target: ResolveTarget = curated.resolve,
) -> ConnectionReport:
    """Re-discover a server's capabilities.

    Implemented as discard-then-connect rather than as a second `tools/list` on
    the live session, deliberately: the SDK caches list results per client, so
    re-listing could return the cached page and report "refreshed" having
    learned nothing. A new session re-runs initialize and gets the truth.
    """
    key = (request.user_id, request.workspace_id, request.connection_id)
    await pool.discard(key)
    return await connect(
        engine,
        pool,
        request,
        resolver=resolver,
        settings=settings,
        resolve_target=resolve_target,
    )


async def disconnect(
    pool: McpSessionPool, request: ConnectionRequest
) -> ConnectionReport:
    """Close the live session. The RECORD survives — disconnect is not delete.

    The caller marks the stored connection DISCONNECTED, which is what
    suppresses automatic reconnection: the brief is explicit that we must not
    reconnect a connection the user explicitly closed.
    """
    key = (request.user_id, request.workspace_id, request.connection_id)
    await pool.discard(key)
    return ConnectionReport(
        state=ConnectionState.DISCONNECTED,
        server_name=request.server_name,
        reconnect_allowed=False,
    )


async def status(
    engine: Any,
    pool: McpSessionPool,
    request: ConnectionRequest,
    *,
    resolve_target: ResolveTarget = curated.resolve,
) -> dict:
    """The four-part answer, never one ambiguous `status`.

    "Server: ACTIVE, Connection: FAILED" is a valid and common state, and a
    single field cannot express it — which is precisely how a user ends up
    believing a service is down when their token merely expired.
    """
    target = await resolve_target(engine, request.server_name)
    key = (request.user_id, request.workspace_id, request.connection_id)
    actor = pool._actors.get(key)  # noqa: SLF001 — read-only introspection
    session = actor.session if actor is not None else None

    return {
        "catalogue": {
            "status": target.catalogue_status if target else "unknown",
            "curated": target is not None,
            "enabled": bool(target and target.enabled),
            "trusted": bool(target and target.trusted),
            "latest_version": target.version if target else None,
        },
        "connection": {
            "connection_id": request.connection_id,
            "server_name": request.server_name,
            "version": request.version or (target.version if target else None),
            "version_mode": target.version_mode if target else "latest_at_connect",
            "transport": target.transport if target else None,
            "auth_kind": target.auth_kind if target else None,
        },
        "session": {
            "live": session is not None,
            "protocol_version": (
                session.snapshot.protocol_version if session else None
            ),
            "opened_at": session.opened_at.isoformat() if session else None,
            "in_flight": session.in_flight if session else 0,
        },
        "capabilities": (session.snapshot.as_dict() if session else None),
        "last_error": (
            {
                "kind": str(actor.error.kind),
                "detail": actor.error.detail,
                "user_action_required": actor.error.user_action_required,
            }
            if actor is not None and actor.error is not None
            else None
        ),
    }


def can_supply_credentials(
    resolver: CredentialResolver | None, *, server_slug: str = ""
) -> bool:
    """Can this deployment obtain a credential for an authenticated server?

    PUBLIC, and deliberately the ONLY answer to this question. It was private,
    and `routers/mcp.py` grew its own inline version — `resolver.supplies(slug)
    or resolver.can_supply` — which did not know about `can_authorize`. The
    result was measured and total: with OAuth enabled and keyed, the route
    computed `credentials_available=False`, `compat.assess` refused every OAuth
    server before a packet left, and the 401 that starts discovery never fired.
    Two definitions of one question is the bug; this is the fix.

    PHASE 4 CHANGED WHAT THIS MEANS, and the change is load-bearing. In Phase 3
    it asked "do we already hold a static token?", so an OAuth server with no
    stored credential was refused BEFORE dialling.

    That would now be exactly wrong. The catalogue can never tell us a server
    uses OAuth — `registry/parse.py` refuses to infer it, because the registry
    publishes no auth-scheme field — so OAuth is discovered at RUNTIME from the
    401 and its `WWW-Authenticate` challenge. Refusing to dial means never
    seeing the 401 that STARTS discovery, which would make every OAuth server
    permanently unreachable.

    So a resolver that can run an OAuth flow answers True even holding nothing
    yet: it can obtain a credential, which is the question that matters.

    `server_slug` covers the Phase 3 path that is still per-server: a
    development token exists for THIS server or it does not. Omitting it simply
    asks the broader "can this deployment supply anything at all".
    """
    if resolver is None:
        return False
    if getattr(resolver, "can_authorize", False):
        return True
    supplies = getattr(resolver, "supplies", None)
    if server_slug and callable(supplies) and supplies(server_slug):
        return True
    return bool(getattr(resolver, "can_supply", False))


#: The old private name, kept as an alias so nothing silently binds to a
#: second implementation if one is ever reintroduced.
_can_supply = can_supply_credentials


#: OAuth failures that mean "a human must act", mapped onto the states Phase 7
#: renders. Kept here rather than in the OAuth package because this module is
#: the ONLY one that owns the connection state machine — two places deciding
#: what a user sees is how a UI starts contradicting itself.
_OAUTH_STATE = {
    McpErrorKind.AUTH_REQUIRED: ConnectionState.CONFIGURED,
    McpErrorKind.AUTH_FAILED: ConnectionState.FAILED,
}


def oauth_state_for(err: McpConnectionError) -> ConnectionState:
    """The connection state an OAuth failure should leave behind.

    AUTH_REQUIRED is CONFIGURED, not FAILED: "connect your account" is a setup
    step the user has not taken, and showing it as a failure sends them looking
    for something broken. AUTH_FAILED is genuinely FAILED — a credential was
    presented and rejected.
    """
    return _OAUTH_STATE.get(err.kind, ConnectionState.FAILED)


def _timeouts(settings: Any) -> dict:
    if settings is None:
        return {}
    return {
        "connect_timeout_s": settings.mcp_connect_timeout_s,
        "request_timeout_s": settings.mcp_request_timeout_s,
        "tool_timeout_s": settings.mcp_tool_timeout_s,
    }


async def _local_report(
    engine: Any, server_name: str, *, settings: Any = None
) -> ConnectionReport | None:
    """Is this a curated LOCAL server, and may it start? None if it is not local.

    THE VERDICT COMES FROM THE VALIDATOR, NOT FROM `assess()`. `compat.assess`
    reasons about a catalogue row's `remotes` and `packages` — a local row has
    neither, and feeding it one would make it answer "declares no remote
    endpoint; local execution is not supported", which is exactly the refusal
    Phase 6 is deliberately no longer universal. The remote refusal in
    `compat.py` is therefore left completely untouched: local simply does not go
    through it.

    Returns None when local is off or the slug is not a local row, so the caller
    falls through to the ordinary "not curated" refusal.
    """
    if not getattr(settings, "mcp_local_enabled", False):
        return None

    from app.mcp.local.gateway import local_slug
    from app.mcp.local.policy import PolicyCeilings, validate_local_server
    from app.mcp.registry import local_store

    # A local ref carries `local/<slug>` as its server name (see `gateway_spec`).
    slug = local_slug(server_name)
    row = await local_store.resolve(engine, slug)
    if row is None:
        return None

    verdict = validate_local_server(
        row,
        ceilings=PolicyCeilings(
            max_cpus=getattr(settings, "mcp_local_max_cpus", 2.0),
            max_memory_mb=getattr(settings, "mcp_local_max_memory_mb", 2048),
        ),
        allow_untrusted=getattr(settings, "mcp_local_allow_untrusted", False),
    )
    base = {
        "slug": row.slug,
        "version": row.image_digest[:19],
        "version_mode": "pinned",
        "transport": "streamable-http",
        "auth_kind": "none",
        "catalogue_status": "local",
    }
    if not verdict.ok:
        # FAIL CLOSED, and say why. The reasons name fields, never values — see
        # the validator — so this is safe to render.
        # `base` already carries `slug`, so it is not passed twice.
        return _failure(
            server_name,
            McpConnectionError(
                McpErrorKind.UNSUPPORTED_TRANSPORT,
                "; ".join(verdict.reasons)[:400],
            ),
            state=ConnectionState.UNSUPPORTED,
            **base,
        )
    return ConnectionReport(
        state=ConnectionState.CONFIGURED, server_name=server_name, **base
    )


async def _local_spec_for(
    engine: Any, request: ConnectionRequest, settings: Any
) -> McpConnectionSpec | None:
    """The gateway spec for a local connection request, or None if not local.

    A thin adapter over the ONE definition in `local/gateway.py`, so `connect`
    and `mcp_for_turn` cannot disagree about which rows are local or about what
    the validator permits.
    """
    from app.mcp.local.gateway import local_slug, resolve_local_spec

    return await resolve_local_spec(
        engine,
        local_slug(request.server_name),
        connection_id=request.connection_id,
        user_id=request.user_id,
        workspace_id=request.workspace_id,
        settings=settings,
    )


async def _open_local(
    pool: McpSessionPool, spec: McpConnectionSpec, request: ConnectionRequest
) -> ConnectionReport:
    """Open a local session and report it, mirroring the remote branch.

    NO RESOLVER IS PASSED, deliberately. The gateway injects a local server's
    secrets from its own store; OllaSuper sends no credential to one, which is
    why `gateway_spec` sets `auth_kind="none"`. Handing the vault resolver in
    would imply a credential path that does not exist.

    `catalogue_status="local"` matches `_local_report`, so preflight and connect
    describe the same server the same way.
    """
    base = {
        "slug": spec.identity.slug,
        "version": spec.version,
        "version_mode": "pinned",
        "transport": spec.transport,
        "auth_kind": "none",
        "catalogue_status": "local",
    }
    try:
        async with pool.acquire(spec) as session:
            return ConnectionReport(
                state=ConnectionState.READY,
                server_name=request.server_name,
                capabilities=session.snapshot,
                tool_count=len(session.tools),
                tools=[t.name for t in session.tools],
                **base,
            )
    except McpConnectionError as err:
        # A gateway that is not running is the common case here, and it is an
        # ordinary failure to render — not an exception that kills the request.
        return _failure(request.server_name, err, **base)

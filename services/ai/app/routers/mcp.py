"""MCP catalogue queries — read the LOCAL catalogue, never the upstream registry.

That independence is the design, not an optimisation: a registry outage makes the
catalogue stale, never unavailable, and `/catalogue/status` exposes the staleness
so it is visible rather than silent.

Behind the router-level `require_service_key` every other `/v1` router carries,
so the catalogue is not publicly readable and sync is not publicly triggerable.
Phase 7's UI reaches this through a Convex action, the pattern
`convex/chat/capabilities.ts` already uses.

PHASE 3 ADDED THE CONNECTION ROUTES BELOW THE CATALOGUE ONES. The catalogue
routes still never contact anything; the connection routes do, and the split is
deliberate — a catalogue read must keep working when every remote server is down.

AUTHORIZATION IS CONVEX'S. Every mutating route takes `user_id` and
`workspace_id` in its body, and that is safe ONLY because this router sits behind
`require_service_key`: the caller is the Convex action, which has already run
`requireUserId` + `requireMember`. Nothing here is reachable from a browser, and
these identifiers must never be accepted from one.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.mcp import lifecycle
from app.mcp.credentials import EnvCredentialResolver, parse_test_credentials
from app.mcp.registry import curated, store
from app.security import require_service_key

router = APIRouter(prefix="/v1/mcp", dependencies=[Depends(require_service_key)])


def _engine(request: Request):
    engine = getattr(request.app.state, "db", None)
    if engine is None:
        # The catalogue lives in the knowledge database; without it there is
        # nothing to serve. 503 (not 500): it is a configuration state, not a bug.
        raise HTTPException(status_code=503, detail="catalogue database not configured")
    return engine


@router.get("/servers")
async def list_servers(
    request: Request,
    q: str | None = None,
    transport: str | None = None,
    auth_kind: str | None = None,
    status: str = "active",
    publisher: str | None = None,
    limit: int = 25,
    cursor_ts: datetime | None = None,
    cursor_name: str | None = None,
) -> dict[str, Any]:
    """Search the catalogue. Keyset pagination — an OFFSET would skip or repeat
    rows when a sync commits mid-scroll.

    Plain defaults rather than `Query(...)`, matching app/routers/tools.py;
    `limit` is clamped in the store, so a hostile value cannot ask for the
    whole catalogue in one response.
    """
    cursor = (cursor_ts, cursor_name) if cursor_name is not None else None
    rows = await store.search_servers(
        _engine(request),
        query=q,
        transport=transport,
        auth_kind=auth_kind,
        status=status,
        publisher=publisher,
        limit=limit,
        cursor=cursor,
    )
    next_cursor = None
    if len(rows) == limit:
        last = rows[-1]
        next_cursor = {
            "cursor_ts": last["upstream_updated_at"],
            "cursor_name": last["name"],
        }
    return {"servers": rows, "next": next_cursor}


@router.get("/servers/{server_name:path}/versions")
async def server_versions(request: Request, server_name: str) -> dict[str, Any]:
    """Every catalogued version, tombstones included.

    `:path` because a registry name is reverse-DNS and contains "/"
    (`ac.inference.sh/mcp`) — without it the slash is read as a route separator.

    Tombstoned versions are returned deliberately: Phase 3 may hold a connection
    pinned to a version the registry has since removed, and hiding it here would
    make that connection unexplainable.
    """
    versions = await store.list_versions(_engine(request), server_name)
    if not versions:
        raise HTTPException(status_code=404, detail="server not in catalogue")
    return {"server_name": server_name, "versions": versions}


@router.get("/servers/{server_name:path}")
async def get_server(request: Request, server_name: str) -> dict[str, Any]:
    row = await store.get_server(_engine(request), server_name)
    if row is None:
        raise HTTPException(status_code=404, detail="server not in catalogue")
    return row


@router.get("/catalogue/status")
async def catalogue_status(request: Request) -> dict[str, Any]:
    """Size + freshness. `last_success_at` is how a caller tells a fresh
    catalogue from one whose sync has been failing quietly for a week."""
    stats = await store.catalogue_stats(_engine(request))
    return {
        "servers": stats.servers,
        "versions": stats.versions,
        "deleted_servers": stats.deleted_servers,
        "last_success_at": stats.last_success_at,
        "last_attempt_at": stats.last_attempt_at,
        "last_error": stats.last_error,
        "watermark": stats.watermark,
    }


# ---------------------------------------------------------------- Phase 3
class ConnectionBody(BaseModel):
    """Identity resolved by Convex, never by the caller's browser.

    `extra="forbid"` matches `GenerateRequest`: an unknown field is a version
    skew between the two planes and must fail loudly at the boundary rather than
    be silently dropped.
    """

    model_config = {"extra": "forbid"}

    connection_id: str = Field(min_length=1, max_length=64)
    server_name: str = Field(min_length=1, max_length=400)
    user_id: str = Field(min_length=1, max_length=64)
    workspace_id: str = Field(min_length=1, max_length=64)
    version: str | None = Field(default=None, max_length=100)


def _pool(request: Request):
    pool = getattr(request.app.state, "mcp_pool", None)
    if pool is None:
        # 503, not 500: connections are OFF by configuration, which is a
        # deployment state rather than a bug.
        raise HTTPException(status_code=503, detail="MCP connections are not enabled")
    return pool


def _resolver(request: Request):
    """The resolver that will ACTUALLY attach the credential.

    THE POOL'S RESOLVER WINS WHEN IT CAN AUTHORIZE. `main.py` swaps the pool
    over to `VaultCredentialResolver` when OAuth is enabled, and the session
    actor resolves through THAT object — so a gate computed from anything else
    is a gate on a decision nobody makes. Measured before this: the route built
    its own `EnvCredentialResolver`, answered "no credential available", and
    every OAuth server was refused before dialling with the vault live.

    Otherwise it falls back to building one per request from settings, which is
    what lets an operator rotate a development token without a restart, and
    keeps no long-lived object holding credential material.
    """
    pool = getattr(request.app.state, "mcp_pool", None)
    pooled = getattr(pool, "_resolver", None)
    if getattr(pooled, "can_authorize", False):
        return pooled
    settings = getattr(request.app.state, "settings", None)
    raw = getattr(settings, "mcp_test_credentials", "") if settings else ""
    return EnvCredentialResolver(parse_test_credentials(raw))


def _request(body: ConnectionBody) -> lifecycle.ConnectionRequest:
    return lifecycle.ConnectionRequest(
        connection_id=body.connection_id,
        server_name=body.server_name,
        user_id=body.user_id,
        workspace_id=body.workspace_id,
        version=body.version,
    )


@router.get("/curated")
async def curated_servers(
    request: Request, include_disabled: bool = False
) -> dict[str, Any]:
    """The ~30 servers this deployment will connect to.

    Not the 30,871-row catalogue: that answers "what exists", this answers "what
    can I actually use here". Phase 7's picker reads this through a Convex
    action, so the projection is the SAFE one: no `endpoint_url`, no operator
    `notes`, no `trusted` flag. See `curated._SAFE_FIELDS`.

    PHASE 8: THE GLOBAL KILL SWITCH REACHES HERE TOO. `mcp_connections_enabled`
    was structural for EXECUTION — with it off there is no pool, no vault and no
    flow, and every connection route answers 503 — but this route ignored it, so
    a deployment with MCP turned off still handed the browser a full catalogue of
    servers whose Connect button could only ever 503. A kill switch that leaves
    the storefront open is not a kill switch.

    `enabled` is reported rather than the route 503-ing, because "off on this
    deployment" and "could not ask" need different words in the UI and only one
    of them has a retry.
    """
    settings = getattr(request.app.state, "settings", None)
    if not getattr(settings, "mcp_connections_enabled", False):
        return {"enabled": False, "servers": [], "count": 0}
    rows = await curated.list_curated(
        _engine(request), enabled_only=not include_disabled, safe=True
    )
    return {"enabled": True, "servers": rows, "count": len(rows)}


@router.post("/connections/preflight")
async def connection_preflight(
    request: Request, body: ConnectionBody
) -> dict[str, Any]:
    """Can this be connected? Answered WITHOUT touching the network.

    The gate that makes "no local execution" structural: a stdio-only or
    packages-only entry is refused by a code path that has no transport.
    """
    report = await lifecycle.preflight(
        _engine(request),
        body.server_name,
        # ONE definition of the question, shared with `lifecycle.connect`. The
        # inline expression that used to live here did not know about
        # `can_authorize` and silently refused every OAuth server.
        credentials_available=lifecycle.can_supply_credentials(
            _resolver(request), server_slug=body.server_name
        ),
        # Phase 6: without settings, preflight cannot tell whether local is
        # enabled, so every local server answers "not curated" and can never
        # reach `ready` — which made the whole local path unreachable.
        settings=getattr(request.app.state, "settings", None),
    )
    return report.as_dict()


@router.post("/connections/{connection_id}/connect")
async def connection_connect(
    request: Request, connection_id: str, body: ConnectionBody
) -> dict[str, Any]:
    """Open (or reuse) a session and report what the server actually exposes."""
    _assert_path_matches(connection_id, body)
    report = await lifecycle.connect(
        _engine(request),
        _pool(request),
        _request(body),
        resolver=_resolver(request),
        settings=getattr(request.app.state, "settings", None),
    )
    return report.as_dict()


@router.post("/connections/{connection_id}/refresh")
async def connection_refresh(
    request: Request, connection_id: str, body: ConnectionBody
) -> dict[str, Any]:
    """Re-discover capabilities on a NEW session (the SDK caches list results)."""
    _assert_path_matches(connection_id, body)
    report = await lifecycle.refresh(
        _engine(request),
        _pool(request),
        _request(body),
        resolver=_resolver(request),
        settings=getattr(request.app.state, "settings", None),
    )
    return report.as_dict()


@router.post("/connections/{connection_id}/disconnect")
async def connection_disconnect(
    request: Request, connection_id: str, body: ConnectionBody
) -> dict[str, Any]:
    """Close the live session. The RECORD survives -- disconnect is not delete."""
    _assert_path_matches(connection_id, body)
    report = await lifecycle.disconnect(_pool(request), _request(body))
    return report.as_dict()


@router.post("/connections/{connection_id}/status")
async def connection_status(
    request: Request, connection_id: str, body: ConnectionBody
) -> dict[str, Any]:
    """Four separate answers, never one ambiguous `status`.

    POST rather than GET because the tenant identity travels in the body: a
    user id in a query string ends up in access logs and in a Referer header.
    """
    _assert_path_matches(connection_id, body)
    return await lifecycle.status(_engine(request), _pool(request), _request(body))


@router.get("/pool")
async def pool_status(request: Request) -> dict[str, Any]:
    """Credential-free pool summary, for operators."""
    return _pool(request).snapshot()


def _assert_path_matches(connection_id: str, body: ConnectionBody) -> None:
    """The path and the body must agree.

    Not pedantry: a mismatch means the caller built the request from two
    different sources, and acting on either one would be acting on something
    nobody asked for.
    """
    if connection_id != body.connection_id:
        raise HTTPException(
            status_code=400, detail="connection_id in the path and body disagree"
        )


# ------------------------------------------------- Phase 5: resources & prompts
#
# NOT TOOL ROUTES. Tools reach the model through the ordinary chat turn, so they
# need no route at all; these exist because Phase 7's UI has to be able to LIST
# what a connection offers and to invoke a prompt the user picked. A resource read
# is here too, so a UI can preview one without going through a chat turn.
#
# Every one of them resolves the connection through the pool for THIS tenant and
# builds a fresh capability index — the same per-request discovery the turn does.
# Nothing is cached between calls: the plan's second pass measured that the SDK's
# response cache is server-directed and inert against a server declaring
# `ttl_ms=0`, so it cannot be the freshness mechanism.


class PromptGetBody(ConnectionBody):
    """A prompt invocation. `arguments` is model- or user-supplied, so it is
    validated against the server's own `required` flags before anything is sent."""

    prompt_name: str = Field(min_length=1, max_length=200)
    arguments: dict[str, Any] = Field(default_factory=dict)


class ResourceReadBody(ConnectionBody):
    """A resource read. `uri` is untrusted: it is matched against what this
    connection actually advertised, and refused otherwise."""

    uri: str = Field(min_length=1, max_length=2048)


@asynccontextmanager
async def _capability_index(request: Request, body: ConnectionBody):
    """Acquire this tenant's session and discover its non-tool capabilities.

    An `@asynccontextmanager`, NOT a bare async generator. `pool.acquire()` opens
    an anyio cancel scope, and a generator consumed with `async for` is finalized
    whenever GC reaches it — a different task — which anyio refuses. Same rule
    that makes every pooled session an actor in `app/mcp/session.py`.

    THE TENANT COMES FROM THE BODY, which is safe only because this router sits
    behind `require_service_key` and the caller is a Convex action that already
    verified ownership. The pool key is `(user, workspace, connection)`, so a
    caller who lied about any of the three simply gets a different session — not
    somebody else's.
    """
    from app.mcp.index import McpCapabilityIndex, discover_capabilities
    from app.mcp.local.gateway import local_slug, resolve_local_spec
    from app.mcp.models import McpConnectionSpec, McpServerIdentity

    pool = _pool(request)
    settings = getattr(request.app.state, "settings", None)

    # PHASE 6 SERVERS RESOLVE FIRST. This function used to reach only
    # `curated.resolve`, so every `local/<slug>` answered 404 "not in this
    # deployment's curated set" — a local server could connect and still show no
    # resources and no prompts. Same defect as `lifecycle.connect`'s, one route
    # along, and it is why both now go through one `resolve_local_spec`.
    spec = await resolve_local_spec(
        _engine(request),
        local_slug(body.server_name),
        connection_id=body.connection_id,
        user_id=body.user_id,
        workspace_id=body.workspace_id,
        settings=settings,
    )
    target = None
    if spec is None:
        target = await curated.resolve(_engine(request), body.server_name)
        if target is None or not target.enabled:
            raise HTTPException(
                status_code=404,
                detail="server is not in this deployment's curated set",
            )
        spec = McpConnectionSpec(
            connection_id=body.connection_id,
            identity=McpServerIdentity(slug=target.slug, trusted=target.trusted),
            server_name=target.server_name,
            version=body.version or target.version or "unknown",
            transport=target.transport,
            endpoint_url=target.endpoint_url,
            auth_kind=target.auth_kind,
            user_id=body.user_id,
            workspace_id=body.workspace_id,
        )

    async with pool.acquire(spec) as session:
        entry = await discover_capabilities(
            session.client,
            connection_id=body.connection_id,
            # FROM THE SPEC, not from `target`, which is None on the local
            # branch. Reading `target.slug` here is the exact AttributeError
            # that silently emptied every local server's capabilities in
            # `turn.py`; the spec is the one object both branches always have.
            server_slug=spec.identity.slug,
            snapshot=getattr(session, "snapshot", None),
            max_resources=getattr(settings, "mcp_max_resources_per_server", 256),
            max_templates=getattr(
                settings, "mcp_max_resource_templates_per_server", 64
            ),
            max_prompts=getattr(settings, "mcp_max_prompts_per_server", 128),
        )
        index = McpCapabilityIndex()
        index.add(entry, client=session.client)
        yield index, entry, target


@router.post("/connections/{connection_id}/resources")
async def connection_resources(
    request: Request, connection_id: str, body: ConnectionBody
) -> dict[str, Any]:
    """What this connection can be asked to read. Metadata only, no content."""
    _assert_path_matches(connection_id, body)
    async with _capability_index(request, body) as (index, entry, _target):
        return {
            "resources": [r.as_dict() for r in entry.resources],
            "templates": [t.as_dict() for t in entry.templates],
            "dropped": entry.dropped,
            # A failed list is REPORTED, not hidden behind an empty array — the
            # two mean very different things to a user deciding whether to retry.
            "error": entry.resources_error or None,
        }


@router.post("/connections/{connection_id}/resources/read")
async def connection_resource_read(
    request: Request, connection_id: str, body: ResourceReadBody
) -> dict[str, Any]:
    """Read ONE advertised resource, bounded.

    The URI is matched against what this connection advertised; anything else is
    refused. There is no HTTP fetch here and no filesystem access — the read goes
    through the MCP session, which is what makes an arbitrary URI harmless.
    """
    _assert_path_matches(connection_id, body)
    from app.mcp.resource_tool import read_resource

    settings = getattr(request.app.state, "settings", None)
    async with _capability_index(request, body) as (index, _entry, _target):
        return await read_resource(
            index,
            body.uri,
            max_bytes=getattr(settings, "mcp_resource_max_bytes", 128 * 1024),
        )


@router.post("/connections/{connection_id}/prompts")
async def connection_prompts(
    request: Request, connection_id: str, body: ConnectionBody
) -> dict[str, Any]:
    """The prompt templates this connection offers, with their argument shapes."""
    _assert_path_matches(connection_id, body)
    async with _capability_index(request, body) as (_index, entry, _target):
        return {
            "prompts": [p.as_dict() for p in entry.prompts],
            "error": entry.prompts_error or None,
        }


@router.post("/connections/{connection_id}/prompts/get")
async def connection_prompt_get(
    request: Request, connection_id: str, body: PromptGetBody
) -> dict[str, Any]:
    """Retrieve one prompt with validated arguments.

    VALIDATION HAPPENS HERE, BEFORE THE CALL, and that is measured rather than
    defensive: a real server answers both a missing required argument and an
    unknown one with `MCPError: Internal server error` — no field name, no
    reason. A 400 naming the field is the only usable answer.

    The returned messages are USER/ASSISTANT content. Nothing in this response
    can become a system or developer instruction; see `normalize_prompt_messages`.
    """
    _assert_path_matches(connection_id, body)
    from app.mcp.index import CapabilityLookupError
    from app.mcp.prompts import PromptArgumentError, normalize_prompt_messages

    settings = getattr(request.app.state, "settings", None)
    async with _capability_index(request, body) as (index, _entry, _target):
        try:
            prompt, client = index.resolve_prompt(
                body.prompt_name, connection_id=body.connection_id
            )
        except CapabilityLookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        try:
            arguments = prompt.validate_arguments(body.arguments)
        except PromptArgumentError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        try:
            result = await client.get_prompt(prompt.name, arguments)
        except Exception as exc:  # noqa: BLE001 — never echo a provider body
            raise HTTPException(
                status_code=502,
                detail=(
                    f"the server could not render that prompt ({type(exc).__name__})"
                ),
            ) from exc

        messages, truncated = normalize_prompt_messages(
            getattr(result, "messages", None) or [],
            max_chars=getattr(settings, "mcp_prompt_max_chars", 32 * 1024),
        )
        return {
            "prompt": prompt.name,
            "description": getattr(result, "description", None) or prompt.description,
            "messages": messages,
            "truncated": truncated,
        }


# ------------------------------------------------------- Phase 6: local servers
@router.get("/local")
async def list_local_servers(
    request: Request, include_disabled: bool = False
) -> dict[str, Any]:
    """What may run locally, and whether each row would actually be allowed to.

    A SAFE PROJECTION for Phase 7 (§178). It reports the operator's decision and
    the validator's verdict — never an image reference an attacker could use to
    probe the registry, never a secret ref's value, never a host path, and never
    anything about Docker.

    The verdict is recomputed on every call rather than stored: a policy ceiling
    change must be visible immediately, and a row that was approved yesterday
    under different ceilings is not approved now (§132).
    """
    from app.mcp.local.policy import PolicyCeilings, validate_local_server
    from app.mcp.registry import curated as curated_store
    from app.mcp.registry import local_store

    settings = getattr(request.app.state, "settings", None)
    if not getattr(settings, "mcp_local_enabled", False):
        # OFF is a deployment state, not an error — and saying so plainly is
        # what stops Phase 7 rendering "no servers" for a disabled feature.
        return {"enabled": False, "servers": [], "gateway": None}

    from app.mcp.local import attest  # noqa: PLC0415
    from app.mcp.local.gateway import _attestation_dir  # noqa: PLC0415

    rows = await local_store.list_local(
        _engine(request), enabled_only=not include_disabled
    )
    remote = {r["slug"] for r in await curated_store.list_curated(_engine(request))}
    ceilings = PolicyCeilings(
        max_cpus=getattr(settings, "mcp_local_max_cpus", 2.0),
        max_memory_mb=getattr(settings, "mcp_local_max_memory_mb", 2048),
    )

    servers = []
    for row in rows:
        verdict = validate_local_server(
            row,
            ceilings=ceilings,
            allow_untrusted=getattr(settings, "mcp_local_allow_untrusted", False),
            remote_slugs=frozenset(remote),
        )
        attested = attest.verified_for(row, _attestation_dir(settings))
        servers.append(
            {
                "slug": row.slug,
                "display_name": row.display_name,
                "trust": row.trust,
                "enabled": row.enabled,
                "network": row.network,
                # The STATE Phase 7 renders, not the machinery behind it. A row
                # policy approves is still BLOCKED until the bridge has attested
                # a matching container (audit H-12).
                "state": "available" if verdict.ok and attested else "blocked",
                # Reasons are an operator diagnostic. They name fields, never
                # values — see the validator.
                "reasons": verdict.reasons
                + (
                    []
                    if attested or not verdict.ok
                    else ["no verified runtime attestation"]
                ),
                "attested": attested,
            }
        )
    return {
        "enabled": True,
        # Whether the gateway URL is even configured legally. NOT whether it is
        # reachable, and explicitly NOT whether it was launched with the right
        # flags — no MCP method reports that, and claiming otherwise would be
        # the one dishonest thing this route could do.
        "gateway": _gateway_status(settings),
        "servers": servers,
    }


def _gateway_status(settings: Any) -> dict[str, Any]:
    from app.mcp.local.gateway import assert_gateway_url

    url = getattr(settings, "mcp_gateway_url", "") or ""
    try:
        assert_gateway_url(url)
    except Exception as exc:  # noqa: BLE001
        return {"configured": False, "detail": str(exc)}
    return {
        "configured": True,
        # The token's PRESENCE, never its value.
        "authenticated": bool(getattr(settings, "mcp_gateway_auth_token", "")),
        # Per-server now: `servers[].attested` is the launcher's `docker
        # inspect` verdict for that row's digest and flags (audit H-12).
        "flags_verified": "per-server",
        "detail": (
            "each local server is launched, inspected and attested by "
            "bridge/mcp_bridge.py; the plane dials only an attested one"
        ),
    }

"""OAuth control plane for MCP connections.

A separate module from `routers/mcp.py`, sharing its `/v1/mcp` prefix and its
`require_service_key` dependency. The split is for readability: the catalogue
routes are read-only queries over a local table, these drive an authorization
flow against a third party, and mixing them made one file that did two
unrelated things.

AUTHORIZATION IS CONVEX'S, NOT THESE ROUTES'. Every body carries `user_id` and
`workspace_id`, which is safe ONLY because this router sits behind the service
key: the caller is a Convex action that has already run `requireUserId` and
verified connection ownership. Nothing here is reachable from a browser, and
these identifiers must never be accepted from one.

WHAT NEVER APPEARS IN A RESPONSE: `access_token`, `refresh_token`,
`client_secret`, the authorization `code`, or the PKCE verifier. The one thing
that does cross to the browser is the authorization URL, which is public by
construction — its PKCE value is a hash and its `state` is a routing token.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.logging import get_logger
from app.mcp.registry import curated
from app.security import require_service_key

log = get_logger(__name__)

router = APIRouter(prefix="/v1/mcp", dependencies=[Depends(require_service_key)])


class OAuthBody(BaseModel):
    """Trusted identity, resolved by Convex — never by a browser.

    `extra="forbid"` matches `GenerateRequest`: an unknown field means the two
    planes are at different versions, and that must fail at the boundary rather
    than be silently dropped into an authorization.
    """

    model_config = {"extra": "forbid"}

    connection_id: str = Field(min_length=1, max_length=64)
    server_name: str = Field(min_length=1, max_length=400)
    user_id: str = Field(min_length=1, max_length=64)
    workspace_id: str = Field(min_length=1, max_length=64)
    version: str | None = Field(default=None, max_length=100)


class CallbackBody(BaseModel):
    """What the Convex callback route forwards. NOTE THE ABSENCE OF A TENANT.

    That absence is the security property. The credential is written for the
    tenant recorded when the flow STARTED, found by `state`. Accepting a user id
    here would let the callback declare who it is for — exactly the cross-user
    binding this design prevents.
    """

    model_config = {"extra": "forbid"}

    state: str = Field(min_length=1, max_length=512)
    code: str | None = Field(default=None, max_length=2048)
    iss: str | None = Field(default=None, max_length=2048)
    error: str | None = Field(default=None, max_length=256)


def _engine(request: Request) -> Any:
    engine = getattr(request.app.state, "db", None)
    if engine is None:
        raise HTTPException(status_code=503, detail="catalogue database not configured")
    return engine


def _vault(request: Request) -> Any:
    vault = getattr(request.app.state, "mcp_vault", None)
    if vault is None:
        # 503, not 500: an unconfigured or unkeyed vault is a deployment state.
        # Failing closed here is the point — there is no default key and no
        # unencrypted fallback.
        raise HTTPException(
            status_code=503, detail="the MCP credential vault is not configured"
        )
    return vault


def _flow(request: Request) -> Any:
    flow = getattr(request.app.state, "mcp_oauth_flow", None)
    if flow is None:
        raise HTTPException(status_code=503, detail="MCP OAuth is not enabled")
    return flow


async def _curated_target(request: Request, server_name: str) -> Any:
    """The curated row, or 404. Never an arbitrary catalogue row.

    Curation is the gate. Without it a caller could name any of the 30,871
    catalogued servers and make this deployment start an OAuth flow against it.
    """
    target = await curated.resolve(_engine(request), server_name)
    if target is None or not target.enabled:
        raise HTTPException(
            status_code=404, detail="server is not in this deployment's curated set"
        )
    return target


@router.post("/oauth/probe")
async def oauth_probe(request: Request, body: OAuthBody) -> dict[str, Any]:
    """What authentication does this server want, WITHOUT authorizing?

    Read-only by construction: it stops after metadata, so it registers no
    client, requests no token and shows no consent screen. This is the honest
    way to fill the auth capability matrix, because the catalogue can never say
    which servers speak OAuth — the registry publishes no auth-scheme field.
    """
    from app.mcp.oauth.probe import probe_auth
    from app.mcp.transport import build_guarded_client

    target = await _curated_target(request, body.server_name)
    # THE GUARDED CLIENT, not a bare httpx2 one: discovery follows URLs the
    # server chooses, and every one of them must pass the egress policy.
    async with build_guarded_client(15.0) as client:
        shape = await probe_auth(target.endpoint_url, client)
    return shape.as_dict()


@router.post("/oauth/start")
async def oauth_start(request: Request, body: OAuthBody) -> dict[str, Any]:
    """Begin an authorization; return the URL the browser must visit."""
    # THE DEPLOYMENT GUARD RUNS FIRST, before the catalogue is touched. An
    # unconfigured deployment has nothing to do with which server was named, so
    # querying Postgres to discover that is work done to answer 503.
    flow = _flow(request)
    target = await _curated_target(request, body.server_name)

    async def connect(provider: Any) -> None:
        """ONE connection carrying the interactive provider.

        Deliberately NOT pooled. Authorization is a one-shot handshake whose job
        is to persist the credential; afterwards the ordinary pooled path finds
        the stored token. Pooling this would put a session keyed on a tenant
        into the pool before that tenant was actually authorized.

        `list_tools()` rather than nothing, so "authorized" is not claimed on
        the strength of a token exchange alone — the credential is proven to
        work against the server before the flow reports success.
        """
        from mcp.client import Client
        from mcp.client.streamable_http import streamable_http_client

        from app.mcp.models import McpConnectionSpec, McpServerIdentity
        from app.mcp.status import StatusRecorder
        from app.mcp.transport import build_http_client

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
        http = build_http_client(spec, {}, StatusRecorder(), auth=provider)
        async with http:
            async with Client(
                server=streamable_http_client(target.endpoint_url, http_client=http)
            ) as session:
                await session.list_tools()

    started = await flow.start(
        user_id=body.user_id,
        workspace_id=body.workspace_id,
        connection_id=body.connection_id,
        server_name=target.server_name,
        server_slug=target.slug,
        endpoint_url=target.endpoint_url,
        resource=target.endpoint_url,
        connect=connect,
        require_bearer=target.auth_kind == "oauth",
    )
    return {"auth_state": "AUTHORIZING", **started.as_dict()}


@router.post("/oauth/callback")
async def oauth_callback(request: Request, body: CallbackBody) -> dict[str, Any]:
    """Deliver a provider callback to the flow waiting on it.

    An unmatched `state` — expired, replayed or forged — returns the SAME shape
    as any other. A distinguishable answer would tell an attacker which states
    exist.
    """
    flow = _flow(request)
    attempt = await flow.complete(
        state=body.state, code=body.code, iss=body.iss, error=body.error
    )
    if attempt is None:
        return {
            "ok": False,
            "auth_state": "ERROR",
            "detail": "no pending authorization",
        }

    if await flow.wait_for_completion(attempt):
        return {"ok": True, "auth_state": "CONNECTED"}
    return {
        "ok": False,
        "auth_state": "ERROR",
        # Already classified and bounded by `to_oauth_error`: a code and a
        # sentence, never the provider's raw body.
        "detail": attempt.error or "authorization did not complete",
    }


@router.post("/oauth/status")
async def oauth_status(request: Request, body: OAuthBody) -> dict[str, Any]:
    """The safe projection Phase 7 renders. Carries no credential."""
    from app.mcp.vault.aad import AadKind

    vault = _vault(request)
    target = await _curated_target(request, body.server_name)
    found = await vault.get(
        user_id=body.user_id,
        workspace_id=body.workspace_id,
        connection_id=body.connection_id,
        server_name=target.server_name,
        resource=target.endpoint_url,
        kind=AadKind.OAUTH_TOKEN,
    )
    if found is None:
        return {"auth_state": "AUTHORIZATION_REQUIRED", "scope": None}

    _payload, record = found
    return {
        # TOKEN_EXPIRED, not an error: a refresh token may still recover this
        # without the user doing anything at all.
        "auth_state": "TOKEN_EXPIRED" if record.is_expired() else "CONNECTED",
        "scope": record.scope,
        "expires_at": record.expires_at.isoformat() if record.expires_at else None,
        "key_version": record.key_version,
    }


@router.post("/oauth/disconnect")
async def oauth_disconnect(request: Request, body: OAuthBody) -> dict[str, Any]:
    """Invalidate the session and revoke where supported. The SECRET IS DELETED
    BY THE CONTROL PLANE, not here.

    `session_discarded` is the fact Convex acts on: only once this plane has
    dropped the live session does `convex/mcp/oauth.ts::disconnect` purge the
    credential rows and mark the connection disconnected — in one mutation, so
    a disconnect that the plane never confirmed leaves the row exactly as it
    was rather than half-closed (audit H-04). And because this plane holds no
    delete op at all, the ingress key cannot remove anybody's credential
    (audit H-17).

    `revoked_remotely` is reported SEPARATELY and is `"unsupported"` when the
    authorization server publishes no revocation endpoint. Claiming a remote
    revocation that did not happen would tell a user their access was withdrawn
    when it was not.
    """
    _vault(request)  # the deployment guard: 503 when the vault is off
    target = await _curated_target(request, body.server_name)

    # Order matters: kill the live session FIRST, so an in-flight tool call
    # cannot keep using a credential that is about to be purged.
    pool = getattr(request.app.state, "mcp_pool", None)
    if pool is not None:
        await pool.discard((body.user_id, body.workspace_id, body.connection_id))

    revoked = await _revoke_remotely(request, body, target)
    log.info(
        "mcp.oauth_disconnected",
        extra={
            "server": target.slug,
            "user_id": body.user_id,
            "revoked": revoked,
        },
    )
    return {
        "session_discarded": True,
        "revoked_remotely": revoked,
        "auth_state": "NOT_CONNECTED",
    }


async def _revoke_remotely(
    request: Request,
    body: OAuthBody,
    target: Any,
    *,
    client_factory: Any = None,
) -> Any:
    """RFC 7009 revocation, when the authorization server offers it.

    Returns True, False, or the string "unsupported" — three outcomes, because
    they mean three different things to a user and flattening them into a
    boolean would make "we could not" indistinguishable from "there was nothing
    to revoke".

    `client_factory` supplies the HTTP client rather than constructing one, the
    same seam `probe_auth` uses and for the same reason: it lets the test suite
    point this at an in-process authorization server while `assert_dialable`
    still runs for real against the URL. Omitted, it builds the production
    client — so nothing about the default path changes.
    """
    from app.mcp.oauth.probe import probe_auth
    from app.mcp.transport import build_guarded_client
    from app.mcp.vault.aad import AadKind

    found = await _vault(request).get(
        user_id=body.user_id,
        workspace_id=body.workspace_id,
        connection_id=body.connection_id,
        server_name=target.server_name,
        resource=target.endpoint_url,
        kind=AadKind.OAUTH_TOKEN,
    )
    if found is None:
        return "unsupported"
    payload, _record = found
    token = payload.get("refresh_token") or payload.get("access_token")
    if not token:
        return "unsupported"

    build = client_factory or (lambda: build_guarded_client(10.0))
    try:
        async with build() as client:
            shape = await probe_auth(target.endpoint_url, client)
            if not shape.reachable:
                # WE COULD NOT ASK. That is not the same as the provider saying
                # it does not support revocation, and reporting `unsupported`
                # here would put a false statement about a third party in front
                # of the user — the exact conflation these three outcomes exist
                # to prevent. Found by the refusal test, not by review.
                return False
            if not shape.revocation_supported or not shape.issuer:
                return "unsupported"
            endpoint = f"{shape.issuer.rstrip('/')}/revoke"
            from app.mcp.endpoint import assert_dialable

            await assert_dialable(endpoint)
            response = await client.post(endpoint, data={"token": token})
            return response.status_code < 400
    except Exception:  # noqa: BLE001
        # A failed revocation must not block the local delete: leaving the
        # secret behind because the provider was unreachable is strictly worse.
        log.warning("mcp.oauth_revocation_failed", extra={"server": target.slug})
        return False

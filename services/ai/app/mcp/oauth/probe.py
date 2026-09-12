"""What authentication does this server actually want? Answered WITHOUT authorizing.

WHY THIS EXISTS AT ALL. The Phase 2 catalogue cannot tell us. `registry/parse.py`
is explicit that it refuses to infer OAuth — the registry publishes no
auth-scheme field, only `headers[].isSecret` — and the measured distribution has
no `oauth` bucket at all (none 37,950 · api_key 30,835 · unknown 30,071 ·
bearer 1,342). The captured real fixtures confirm it: every remote declares
`headers=[]`.

So OAuth is discovered at RUNTIME, from the 401 and its `WWW-Authenticate`
challenge, exactly as the MCP specification prescribes. This module performs that
discovery and REPORTS it, which is the honest mechanism for an operator deciding
whether a server belongs in the curated set — the alternative being a guess
written into a table.

READ-ONLY, AND VERIFIED SO. It stops after metadata: no dynamic registration, no
authorization request, no token request. Running it against a server leaves no
client registered and no consent screen shown. The test asserts zero register and
zero token calls, because "probe" that quietly registers a client is not a probe.

COMPOSED FROM SDK HELPERS. Every discovery step below is a module-level function
from `mcp.client.auth.utils`, so the URL construction, the SEP-985 fallback order
and the issuer validation are the SDK's — not a second implementation that would
drift from the one the real flow uses.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from app.logging import get_logger
from app.mcp.endpoint import assert_dialable

log = get_logger(__name__)

__all__ = ["AuthShape", "probe_auth"]

#: Discovery responses are small documents. A server that answers with megabytes
#: is not one we are going to connect to.
_MAX_METADATA_BYTES = 256 * 1024

#: A REAL `initialize`, not an empty object.
#:
#: MEASURED, and it invalidated the obvious implementation: posting `{}` makes a
#: compliant Streamable HTTP server answer **400 Bad Request** with a JSON-RPC
#: validation error, because `{}` is not a JSON-RPC message. The probe then
#: reports `unknown` for a server that in fact needs no authentication at all —
#: so the whole `shape == "none"` branch was unreachable in practice. The
#: handshake has to be well-formed for the answer to mean anything.
#:
#: Still read-only: `initialize` requests no data, lists no tools and registers
#: no OAuth client. It is the same first message the connection path sends.
_INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "ollasuper-probe", "version": "1"},
    },
}

#: Both media types are REQUIRED by the Streamable HTTP transport; omitting them
#: earns a 406 and the same misleading `unknown` as the 400 above.
_PROBE_HEADERS = {"accept": "application/json, text/event-stream"}


@dataclass
class AuthShape:
    """What a probe learned. Every field is reported, never inferred."""

    #: oauth | none | api_key | unknown
    shape: str = "unknown"
    reachable: bool = False
    status: int | None = None
    resource: str | None = None
    issuer: str | None = None
    authorization_servers: list[str] = field(default_factory=list)
    scopes_supported: list[str] = field(default_factory=list)
    challenged_scope: str | None = None
    pkce_methods: list[str] = field(default_factory=list)
    dcr_supported: bool = False
    cimd_supported: bool = False
    revocation_supported: bool = False
    detail: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


async def probe_auth(endpoint_url: str, http_client: Any) -> AuthShape:
    """Ask a server what it wants, without giving it anything.

    `http_client` is supplied rather than constructed so the caller controls the
    transport — which is also what lets the test suite point this at an
    in-process server while the endpoint guard still runs for real.
    """
    # The same guard the connection path uses. OAuth discovery follows URLs the
    # SERVER chooses, so this is exactly where discovery could otherwise become
    # an SSRF primitive.
    await assert_dialable(endpoint_url)

    shape = AuthShape()
    try:
        response = await http_client.post(
            endpoint_url, json=_INITIALIZE, headers=_PROBE_HEADERS
        )
    except Exception as exc:  # noqa: BLE001 — a probe reports, it does not raise
        shape.detail = type(exc).__name__
        return shape

    shape.reachable = True
    shape.status = response.status_code

    if response.status_code < 400:
        # It answered without a challenge, so it wants nothing from us.
        shape.shape = "none"
        await _terminate(http_client, endpoint_url, response)
        return shape

    if response.status_code != 401:
        shape.detail = f"the server answered {response.status_code}, not a challenge"
        return shape

    return await _discover(shape, response, endpoint_url, http_client)


async def _discover(
    shape: AuthShape, response: Any, endpoint_url: str, http_client: Any
) -> AuthShape:
    from mcp.client.auth.utils import (  # noqa: PLC0415
        build_oauth_authorization_server_metadata_discovery_urls,
        build_protected_resource_metadata_discovery_urls,
        extract_resource_metadata_from_www_auth,
        extract_scope_from_www_auth,
        handle_auth_metadata_response,
    )
    from mcp.shared.auth import ProtectedResourceMetadata  # noqa: PLC0415

    shape.challenged_scope = extract_scope_from_www_auth(response)

    # Step 1 — Protected Resource Metadata (RFC 9728), with the SDK's own
    # fallback ordering.
    prm_hint = extract_resource_metadata_from_www_auth(response)
    for url in build_protected_resource_metadata_discovery_urls(
        prm_hint, endpoint_url
    ):
        found = await _fetch_json(http_client, url)
        if found is None:
            continue
        try:
            prm = ProtectedResourceMetadata.model_validate_json(found)
        except Exception:  # noqa: BLE001 — try the next candidate URL
            # DEBUG, not WARNING: SEP-985 discovery tries several URLs by
            # design, so a miss on an earlier candidate is expected traffic
            # rather than a fault worth waking anyone for.
            log.debug("mcp.oauth_prm_unparseable", extra={"url": str(url)})
            continue
        shape.shape = "oauth"
        shape.resource = str(prm.resource) if prm.resource else None
        shape.authorization_servers = [
            str(server) for server in (prm.authorization_servers or [])
        ]
        shape.scopes_supported = list(prm.scopes_supported or [])
        break

    if not shape.authorization_servers:
        if shape.shape != "oauth":
            # A 401 with no discoverable OAuth metadata is most likely a static
            # bearer/API-key server. Reported as a possibility, NOT asserted.
            shape.shape = "api_key"
            shape.detail = (
                "the server challenged but published no OAuth metadata; it "
                "probably expects a static credential"
            )
        return shape

    # Step 2 — Authorization Server Metadata.
    for url in build_oauth_authorization_server_metadata_discovery_urls(
        shape.authorization_servers[0], endpoint_url
    ):
        raw = await _fetch_response(http_client, url)
        if raw is None:
            continue
        ok, metadata = await handle_auth_metadata_response(raw)
        if not ok or metadata is None:
            continue
        shape.issuer = str(metadata.issuer)
        shape.pkce_methods = list(metadata.code_challenge_methods_supported or [])
        shape.dcr_supported = metadata.registration_endpoint is not None
        shape.revocation_supported = (
            getattr(metadata, "revocation_endpoint", None) is not None
        )
        shape.cimd_supported = bool(
            getattr(metadata, "client_id_metadata_document_supported", False)
        )
        if not shape.scopes_supported:
            shape.scopes_supported = list(metadata.scopes_supported or [])
        break

    log.info(
        "mcp.oauth_probe",
        extra={
            "shape": shape.shape,
            "issuer": shape.issuer,
            "dcr": shape.dcr_supported,
            "cimd": shape.cimd_supported,
            "scopes": len(shape.scopes_supported),
        },
    )
    return shape


async def _terminate(http_client: Any, endpoint_url: str, response: Any) -> None:
    """Close the session the handshake opened, using the protocol's own teardown.

    A probe should leave nothing behind. `initialize` mints a session id, and a
    server holds it until its own timeout; the DELETE is how the specification
    says to end one. Best effort — a server that does not implement it is not a
    reason to fail a probe that already got its answer.
    """
    session_id = response.headers.get("mcp-session-id")
    if not session_id:
        return
    try:
        await http_client.request(
            "DELETE", endpoint_url, headers={"mcp-session-id": session_id}
        )
    except Exception:  # noqa: BLE001 — teardown is courtesy, not correctness
        log.debug("mcp.oauth_probe_session_not_terminated")


async def _fetch_response(http_client: Any, url: str) -> Any | None:
    # Discovery URLs come from the SERVER's metadata, so each one is re-checked
    # before it is followed. Without this, a malicious PRM could point discovery
    # at loopback or a cloud metadata endpoint.
    try:
        await assert_dialable(str(url))
    except Exception:  # noqa: BLE001
        log.warning("mcp.oauth_discovery_url_refused")
        return None
    try:
        response = await http_client.get(str(url))
    except Exception:  # noqa: BLE001 — try the next candidate
        return None
    return response if response.status_code == 200 else None


async def _fetch_json(http_client: Any, url: str) -> bytes | None:
    response = await _fetch_response(http_client, url)
    if response is None:
        return None
    body = await response.aread()
    if len(body) > _MAX_METADATA_BYTES:
        log.warning("mcp.oauth_metadata_oversized", extra={"bytes": len(body)})
        return None
    return body

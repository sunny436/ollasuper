"""The gateway endpoint: its guard, and the connection spec it produces.

WHY THIS GUARD IS THE INVERSE OF `assert_dialable`, AND WHY THAT IS NOT A
LOOPHOLE. A catalogue endpoint and a gateway endpoint are different kinds of
thing that happen to both be URLs:

    catalogue endpoint            gateway endpoint
    ------------------            ----------------
    from a reviewed third-party   from operator config, like convex_internal_url
    row, per server               per deployment
    must be PUBLIC https          must be LOOPBACK http
    guarded by assert_dialable    guarded by assert_gateway_url

`assert_dialable` is not modified, not parameterised and not bypassed. Measured,
it refuses a gateway URL on THREE independent grounds:

    http://127.0.0.1:8811    -> scheme must be https
    https://127.0.0.1:8811   -> port not allowed: 8811
    (and loopback would be refused too)

Each of those is right for a URL that came from a catalogue and wrong for one an
operator put in a config file. So the answer is a second, narrower guard rather
than a weaker first one — and this guard FAILS CLOSED IN THE OTHER DIRECTION: a
gateway URL that is NOT loopback is refused, because a non-loopback gateway would
put the `MCP_GATEWAY_AUTH_TOKEN` bearer header on a network.

ONE BRIDGE PER LOCAL SERVER. The "gateway" is OllaSuper's own
`bridge/mcp_bridge.py` since the MCP security remediation (audit H-12): one
process per enabled local server on its own loopback port, which spawns the
container with every hardening flag explicit, ATTESTS it with `docker inspect`
(`attest.py`) and serves it behind a bearer token. `resolve_local_spec` refuses
to dial without a verified attestation for the row's digest. One endpoint equals
one server equals one slug, so Phase 5's identity model applies unchanged. (The
Docker MCP gateway it replaced was not installed on the host and could not be
inspected — see `launch.py`.)
"""

from __future__ import annotations

import ipaddress
from typing import Any
from urllib.parse import urlsplit

from app.logging import get_logger
from app.mcp.exceptions import McpConnectionError, McpErrorKind
from app.mcp.models import McpConnectionSpec, McpServerIdentity

log = get_logger(__name__)

__all__ = [
    "GATEWAY_TRUST",
    "assert_gateway_url",
    "gateway_endpoint_for",
    "gateway_spec",
    "local_slug",
    "resolve_local_spec",
]

#: The value `McpConnectionSpec.endpoint_trust` carries for a gateway endpoint.
#: Named rather than inlined so the AST test that asserts only this module sets
#: it has something unambiguous to look for.
GATEWAY_TRUST = "gateway"

#: The gateway speaks plain HTTP on loopback. That is not a downgrade: TLS to
#: 127.0.0.1 protects against an attacker who is already on the host and can
#: therefore read the process's memory anyway, while requiring it would mean
#: shipping a certificate for a loopback name.
_ALLOWED_SCHEMES = frozenset({"http", "https"})


def assert_gateway_url(url: str) -> None:
    """The gateway must be on loopback. Raises `McpConnectionError` otherwise.

    THE FAILURE DIRECTION IS DELIBERATE. This is not "a relaxed `assert_dialable`"
    — it refuses strictly MORE of the address space than the strict guard does in
    the one dimension that matters here. A misconfigured gateway URL pointing at a
    LAN address or a public host would send a bearer token off the box, so it is
    refused rather than warned about.
    """
    if not isinstance(url, str) or not url.strip():
        raise McpConnectionError(
            McpErrorKind.UNSUPPORTED_TRANSPORT,
            "the MCP gateway URL is not configured",
        )

    parts = urlsplit(url.strip())
    if parts.scheme not in _ALLOWED_SCHEMES:
        raise McpConnectionError(
            McpErrorKind.UNSUPPORTED_TRANSPORT,
            f"gateway scheme must be http or https, got {parts.scheme!r}",
        )
    # A credential in the URL would end up in logs and in every error detail —
    # the same rule `endpoint.py` applies to catalogue endpoints.
    if parts.username or parts.password:
        raise McpConnectionError(
            McpErrorKind.UNSUPPORTED_TRANSPORT,
            "the gateway URL must not carry credentials",
        )

    host = (parts.hostname or "").strip()
    if not host:
        raise McpConnectionError(
            McpErrorKind.UNSUPPORTED_TRANSPORT, "the gateway URL has no host"
        )

    # `localhost` is accepted by NAME because that is what an operator writes,
    # but it is the ONLY name accepted: everything else must be a literal
    # loopback address, so no DNS answer can move the gateway off the box.
    if host.lower() == "localhost":
        return
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise McpConnectionError(
            McpErrorKind.UNSUPPORTED_TRANSPORT,
            f"the gateway host must be a loopback address or 'localhost', got {host!r}",
        ) from exc
    if not address.is_loopback:
        raise McpConnectionError(
            McpErrorKind.UNSUPPORTED_TRANSPORT,
            "the gateway must be on loopback; a remote gateway would put the "
            "gateway auth token on a network",
        )


def gateway_endpoint_for(base_url: str, port: int | None = None) -> str:
    """The MCP endpoint of ONE server's gateway instance.

    `port` overrides the configured base's port, because each local server runs
    its own gateway on its own port (see the module docstring). The path is the
    gateway's streamable-HTTP mount.
    """
    assert_gateway_url(base_url)
    parts = urlsplit(base_url.strip())
    host = parts.hostname or "127.0.0.1"
    chosen = port or parts.port
    if not chosen:
        raise McpConnectionError(
            McpErrorKind.UNSUPPORTED_TRANSPORT,
            "the gateway URL must name a port",
        )
    if not (1 <= int(chosen) <= 65535):
        raise McpConnectionError(
            McpErrorKind.UNSUPPORTED_TRANSPORT, f"invalid gateway port {chosen!r}"
        )
    return f"{parts.scheme}://{host}:{int(chosen)}/mcp"


def gateway_spec(
    row: Any,
    *,
    connection_id: str,
    user_id: str,
    workspace_id: str,
    base_url: str,
    version: str = "",
) -> McpConnectionSpec:
    """A validated local server row -> a dialable `McpConnectionSpec`.

    `row` MUST already have passed `policy.validate_local_server`; this function
    does not re-decide policy, it only shapes what policy approved. Keeping the
    two apart means the validator can be tested exhaustively with no transport
    and this can be read as "what a validated row becomes".

    `trusted=False` ALWAYS. Running inside a container reduces blast radius; it
    says nothing about whether the tool is semantically honest, so a local
    server's `readOnlyHint` never downgrades a tool to read-only and its
    side-effecting tools keep requiring approval. That is §55, and it falls out
    of Phase 3's `_side_effect` with no new code — measured: a local server's
    tools classify `external_side_effect`.
    """
    endpoint = gateway_endpoint_for(base_url, getattr(row, "gateway_port", None))
    return McpConnectionSpec(
        connection_id=connection_id,
        identity=McpServerIdentity(
            slug=row.slug,
            display_name=getattr(row, "display_name", "") or row.slug,
            # NEVER trusted. See the docstring.
            trusted=False,
        ),
        server_name=getattr(row, "server_name", "") or f"local/{row.slug}",
        version=version or getattr(row, "image_digest", "")[:19] or "unknown",
        transport="streamable-http",
        endpoint_url=endpoint,
        # The GATEWAY guard, not the catalogue one. The only place this value is
        # ever set.
        endpoint_trust=GATEWAY_TRUST,
        # The gateway injects the server's secrets itself, from its own store.
        # OllaSuper sends no credential to a local server — which is why there is
        # no auth_kind to resolve here.
        auth_kind="none",
        user_id=user_id,
        workspace_id=workspace_id,
    )


async def resolve_local_spec(
    engine: Any,
    slug: str,
    *,
    connection_id: str,
    user_id: str,
    workspace_id: str,
    settings: Any,
) -> McpConnectionSpec | None:
    """The ONE answer to "is this a local server, and what does it dial?".

    None when local is off or the slug is not a local row — the caller then
    falls through to the ordinary remote path, which is the normal case. A row
    that IS local but fails validation RAISES, because that is a
    misconfiguration an operator must see rather than a silent fall-through to
    the remote path, where `assert_dialable` would reject it with a confusing
    message about HTTPS.

    ONE DEFINITION, DELIBERATELY. `turn.py` and `lifecycle.py` both need this,
    and Phase 4's inert credential gate was caused by exactly this shape —
    `routers/mcp.py` grew its own inline copy of `can_supply_credentials` that
    did not know about `can_authorize`, and the measured result was that every
    OAuth server was refused before a packet left. A second copy of "is this
    local?" would be the same bug with a different name.
    """
    if not getattr(settings, "mcp_local_enabled", False):
        # OFF by default: with the flag down nothing reads a local row and no
        # gateway is dialled, so the path is byte-identical to Phase 5.
        return None

    from app.mcp.local.policy import (
        LocalServerPolicyError,
        PolicyCeilings,
        validate_local_server,
    )
    from app.mcp.registry import local_store

    row = await local_store.resolve(engine, slug)
    if row is None:
        return None

    validate_local_server(
        row,
        ceilings=PolicyCeilings(
            max_cpus=getattr(settings, "mcp_local_max_cpus", 2.0),
            max_memory_mb=getattr(settings, "mcp_local_max_memory_mb", 2048),
        ),
        allow_untrusted=getattr(settings, "mcp_local_allow_untrusted", False),
    ).raise_if_refused(slug)

    # THE RUNTIME GATE (audit H-12). Policy says the row MAY run; the
    # attestation says the container that IS running matches it — digest, no
    # network, no caps, read-only root, non-root user, the row's limits — as
    # inspected by the launcher (`bridge/mcp_bridge.py`) and written root-only.
    # No attestation, a stale one, a failed one, or one for another digest:
    # refused, before a packet leaves. The plane still holds no Docker socket.
    from app.mcp.local import attest  # noqa: PLC0415

    if not attest.verified_for(row, _attestation_dir(settings)):
        raise LocalServerPolicyError(
            slug,
            [
                "no verified runtime attestation for this server's image digest "
                "(the bridge unit has not attested a matching container)"
            ],
        )

    return gateway_spec(
        row,
        connection_id=connection_id,
        user_id=user_id,
        workspace_id=workspace_id,
        base_url=getattr(settings, "mcp_gateway_url", ""),
    )


def _attestation_dir(settings: Any) -> Any:
    """Where the launcher writes attestations; overridable for tests only."""
    from pathlib import Path  # noqa: PLC0415

    from app.mcp.local import attest  # noqa: PLC0415

    raw = getattr(settings, "mcp_local_attestation_dir", "") or ""
    return Path(raw) if raw else attest.ATTESTATION_DIR


def local_slug(server_name: str) -> str:
    """`local/<slug>` -> `<slug>`; anything else unchanged.

    A local ref carries `local/<slug>` as its server name (see `gateway_spec`),
    and three call sites needed to know that. One function so a change to the
    prefix cannot leave one of them behind.
    """
    return (
        server_name.split("/", 1)[1]
        if server_name.startswith("local/")
        else server_name
    )

"""A deterministic OAuth 2.1 authorization server + protected MCP server.

In-process, over `httpx2.ASGITransport`, so the REAL protocol runs with no
socket, no certificate and no network: Protected Resource Metadata discovery,
Authorization Server Metadata, dynamic client registration, the authorization
request, PKCE verification, token exchange, refresh with rotation, the
`insufficient_scope` step-up, and RFC 7009 revocation.

WHY BUILD ONE RATHER THAN MOCK. The things most likely to be wrong are the
handshake's ORDER and its bindings — that PKCE actually round-trips, that the
`resource` parameter is really sent, that a rotated refresh token really
supersedes its predecessor. A mock asserts what its author already believed; a
server that rejects a wrong verifier proves the verifier was right.

HOST IS A LITERAL PUBLIC IP, for the same reason as `mcp_http.py`: the endpoint
guard runs for real against every URL here (including every discovery URL the
server itself advertises), and a literal IP is checked with no DNS. A fake
hostname would have forced either a network dependency or a test-only bypass of
the guard.

NOTHING HERE IS A REAL CREDENTIAL. Every token is a fixed test string.
"""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlparse

HOST = "93.184.216.34"
BASE = f"https://{HOST}"
MCP_URL = f"{BASE}/mcp"
REDIRECT_URI = "https://127.0.0.1:3211/mcp/oauth/callback"


@dataclass
class AuthServerState:
    """Everything a test needs to assert on, and the knobs it can turn."""

    # --- counters -----------------------------------------------------------
    register_calls: int = 0
    token_calls: int = 0
    refresh_calls: int = 0
    revoke_calls: int = 0
    prm_calls: int = 0
    asm_calls: int = 0
    mcp_calls: int = 0

    # --- what the last token request actually carried ----------------------
    last_code_verifier: str | None = None
    last_resource: str | None = None
    last_scope: str | None = None
    last_client_id: str | None = None
    last_grant_type: str | None = None

    # --- issued material ----------------------------------------------------
    issued_access: list[str] = field(default_factory=list)
    valid_access: set[str] = field(default_factory=set)
    valid_refresh: set[str] = field(default_factory=set)
    revoked: set[str] = field(default_factory=set)
    pending_codes: dict[str, dict[str, Any]] = field(default_factory=dict)

    # --- knobs --------------------------------------------------------------
    support_dcr: bool = True
    support_revocation: bool = True
    rotate_refresh: bool = True
    #: When set, the MCP endpoint answers 403 insufficient_scope for any token
    #: whose grant did not include this scope — the step-up path.
    require_scope: str | None = None
    scopes_supported: tuple[str, ...] = ("mcp:read", "mcp:write")
    #: Force the token endpoint to fail, for rollback/error tests.
    token_status: int = 200
    #: Reject the PKCE verifier even when it is correct, to prove the check runs.
    break_pkce: bool = False

    def reset_counts(self) -> None:
        self.register_calls = self.token_calls = self.refresh_calls = 0
        self.revoke_calls = self.prm_calls = self.asm_calls = self.mcp_calls = 0


def build_oauth_mcp_app(
    state: AuthServerState | None = None, *, tool_name: str = "echo"
) -> tuple[Any, AuthServerState]:
    """An ASGI app serving BOTH the authorization server and a protected MCP
    server on one origin. Same-origin keeps discovery simple and is a shape real
    deployments use."""
    from mcp.server.mcpserver import MCPServer
    from mcp.server.transport_security import TransportSecuritySettings
    from mcp_types import ToolAnnotations

    state = state or AuthServerState()
    server = MCPServer(name="protected")

    @server.tool(
        name=tool_name,
        description="Return the text you were given.",
        annotations=ToolAnnotations(read_only_hint=True),
    )
    def echo(text: str) -> str:
        return text

    @server.tool(name="whoami", description="Identify the caller.")
    def whoami() -> str:
        return "authenticated-caller"

    mcp_app = server.streamable_http_app(
        transport_security=TransportSecuritySettings(
            allowed_hosts=[HOST, f"{HOST}:443"], allowed_origins=[BASE]
        )
    )

    async def app(scope, receive, send):
        if scope["type"] != "http":
            await mcp_app(scope, receive, send)
            return
        path = scope["path"]

        if path.startswith("/.well-known/oauth-protected-resource"):
            state.prm_calls += 1
            await _json(
                send,
                200,
                {
                    "resource": MCP_URL,
                    "authorization_servers": [BASE],
                    "scopes_supported": list(state.scopes_supported),
                },
            )
            return

        as_metadata_paths = (
            "/.well-known/oauth-authorization-server",
            "/.well-known/openid-configuration",
        )
        if path.startswith(as_metadata_paths):
            state.asm_calls += 1
            await _json(send, 200, _as_metadata(state))
            return

        if path == "/register":
            state.register_calls += 1
            if not state.support_dcr:
                await _json(send, 404, {"error": "not_found"})
                return
            await _json(
                send,
                201,
                {
                    "client_id": f"dyn-client-{state.register_calls}",
                    "client_id_issued_at": 1_700_000_000,
                    "redirect_uris": [REDIRECT_URI],
                    "token_endpoint_auth_method": "none",
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                },
            )
            return

        if path == "/token":
            await _token(state, receive, send)
            return

        if path == "/revoke":
            state.revoke_calls += 1
            if not state.support_revocation:
                await _json(send, 404, {"error": "not_found"})
                return
            form = parse_qs((await _body(receive)).decode())
            token = (form.get("token") or [""])[0]
            state.revoked.add(token)
            state.valid_access.discard(token)
            state.valid_refresh.discard(token)
            await _json(send, 200, {})
            return

        # The MCP endpoint itself.
        state.mcp_calls += 1
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        presented = headers.get("authorization", "")
        token = presented[7:] if presented.lower().startswith("bearer ") else ""

        if token not in state.valid_access:
            await _json(
                send,
                401,
                {"error": "unauthorized"},
                {
                    "www-authenticate": (
                        f'Bearer resource_metadata='
                        f'"{BASE}/.well-known/oauth-protected-resource"'
                    )
                },
            )
            return

        granted = state.pending_codes.get(f"grant:{token}", {}).get("scope", "")
        if state.require_scope and state.require_scope not in granted.split():
            # SEP-2350 step-up: the token is valid, the SCOPE is not enough.
            await _json(
                send,
                403,
                {"error": "insufficient_scope"},
                {
                    "www-authenticate": (
                        f'Bearer error="insufficient_scope", '
                        f'scope="{state.require_scope}"'
                    )
                },
            )
            return

        await mcp_app(scope, receive, send)

    app.inner = mcp_app  # type: ignore[attr-defined]
    return app, state


def authorize(state: AuthServerState, authorization_url: str) -> dict[str, str]:
    """Act as the user's browser at the consent screen.

    Validates what a real authorization server validates about the REQUEST —
    registered redirect, PKCE present and S256 — then mints a one-time code
    bound to the verifier's challenge, the scope and the resource.
    """
    query = parse_qs(urlparse(authorization_url).query)
    redirect_uri = _one(query, "redirect_uri")
    if redirect_uri != REDIRECT_URI:
        raise AssertionError(f"unregistered redirect_uri: {redirect_uri!r}")
    challenge = _one(query, "code_challenge")
    if not challenge:
        raise AssertionError("no PKCE challenge in the authorization request")
    if _one(query, "code_challenge_method") != "S256":
        raise AssertionError("PKCE method is not S256")

    code = f"code-{secrets.token_urlsafe(8)}"
    state.pending_codes[code] = {
        "challenge": challenge,
        "scope": _one(query, "scope"),
        "resource": _one(query, "resource"),
        "client_id": _one(query, "client_id"),
    }
    return {"code": code, "state": _one(query, "state"), "iss": BASE}


# ------------------------------------------------------------------ internals
def _as_metadata(state: AuthServerState) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "issuer": BASE,
        "authorization_endpoint": f"{BASE}/authorize",
        "token_endpoint": f"{BASE}/token",
        "code_challenge_methods_supported": ["S256"],
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "scopes_supported": list(state.scopes_supported),
        "token_endpoint_auth_methods_supported": ["none"],
    }
    if state.support_dcr:
        metadata["registration_endpoint"] = f"{BASE}/register"
    if state.support_revocation:
        metadata["revocation_endpoint"] = f"{BASE}/revoke"
    return metadata


async def _token(state: AuthServerState, receive, send) -> None:
    form = parse_qs((await _body(receive)).decode())
    grant_type = _one(form, "grant_type")
    state.last_grant_type = grant_type
    state.last_resource = _one(form, "resource") or None
    state.last_client_id = _one(form, "client_id") or None

    if state.token_status != 200:
        state.token_calls += 1
        await _json(send, state.token_status, {"error": "invalid_grant"})
        return

    if grant_type == "refresh_token":
        state.refresh_calls += 1
        presented = _one(form, "refresh_token")
        if presented not in state.valid_refresh:
            await _json(send, 400, {"error": "invalid_grant"})
            return
        state.valid_refresh.discard(presented)
        await _issue(state, send, scope=None, rotate=state.rotate_refresh)
        return

    state.token_calls += 1
    code = _one(form, "code")
    verifier = _one(form, "code_verifier")
    state.last_code_verifier = verifier or None
    pending = state.pending_codes.pop(code, None)
    if pending is None:
        # A replayed or unknown code. Single-use is enforced by the pop above.
        await _json(send, 400, {"error": "invalid_grant"})
        return
    if state.break_pkce or not _pkce_matches(verifier, pending["challenge"]):
        await _json(send, 400, {"error": "invalid_grant"})
        return

    state.last_scope = pending["scope"]
    await _issue(state, send, scope=pending["scope"], rotate=True)


async def _issue(
    state: AuthServerState, send, *, scope: str | None, rotate: bool
) -> None:
    access = f"at-{secrets.token_urlsafe(8)}"
    state.issued_access.append(access)
    state.valid_access.add(access)
    body: dict[str, Any] = {
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": 3600,
    }
    if scope is not None:
        body["scope"] = scope
        # Remember what THIS token was granted, for the step-up check.
        state.pending_codes[f"grant:{access}"] = {"scope": scope}
    elif state.issued_access:
        prior = state.pending_codes.get(
            f"grant:{state.issued_access[-2]}" if len(state.issued_access) > 1 else "",
            {},
        )
        state.pending_codes[f"grant:{access}"] = prior
    if rotate:
        refresh = f"rt-{secrets.token_urlsafe(8)}"
        state.valid_refresh.add(refresh)
        body["refresh_token"] = refresh
    await _json(send, 200, body)


def _pkce_matches(verifier: str, challenge: str) -> bool:
    import base64
    import hashlib

    if not verifier:
        return False
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    computed = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return secrets.compare_digest(computed, challenge)


def _one(query: dict[str, list[str]], key: str) -> str:
    values = query.get(key) or []
    return values[0] if values else ""


async def _body(receive) -> bytes:
    chunks = b""
    while True:
        message = await receive()
        chunks += message.get("body", b"")
        if not message.get("more_body"):
            break
    return chunks


async def _json(send, status: int, payload: Any, headers: dict | None = None) -> None:
    raw = [(b"content-type", b"application/json")]
    for key, value in (headers or {}).items():
        raw.append((key.encode(), value.encode()))
    await send({"type": "http.response.start", "status": status, "headers": raw})
    await send({"type": "http.response.body", "body": json.dumps(payload).encode()})

"""A silent refresh reaches the AUTHORIZATION SERVER's token endpoint.

WHY THIS FILE EXISTS. `test_mcp_oauth_refresh.py` proves refresh works — against
a fixture whose authorization server lives on the SAME origin as its MCP
server. Every real provider puts them on different hosts (Google:
mapstools.googleapis.com vs accounts.google.com / oauth2.googleapis.com;
GitHub: api.githubcopilot.com vs github.com), and there the refresh failed
on production, every session, once the hour was up:

    Token refresh failed: 404
    mcp.session_failed google-maps auth_required

The SDK discovers the token endpoint only during a 401 flow. A fresh provider
instance — every pooled session gets one — holds no metadata, so `_refresh_token`
falls back to `<mcp origin>/token`, which is nothing at Google or GitHub. The
refresh 404s, the SDK clears the tokens, and the user is asked to sign in again
for no reason. The fixture could never show this because `<mcp origin>/token`
happened to BE its token endpoint.

The fix stores the metadata the SDK discovered with the token it belongs to,
and restores it when the token is loaded. Nothing is rediscovered by our code.
"""

from __future__ import annotations

import base64
import json
import os
from urllib.parse import parse_qs, urlparse

import httpx2
import pytest

from app.mcp.exceptions import McpConnectionError, McpErrorKind
from app.mcp.oauth.provider import build_provider, identity_for
from app.mcp.oauth.storage import VaultTokenStorage
from app.mcp.vault.keys import KeyProvider
from app.mcp.vault.store import CredentialVault
from tests.test_mcp_vault_store import MemoryStore

pytestmark = pytest.mark.anyio

MCP_ORIGIN = "https://mcp.remote-as.test"
ENDPOINT = MCP_ORIGIN + "/mcp"
PRM_URL = MCP_ORIGIN + "/.well-known/oauth-protected-resource/mcp"
AS_ORIGIN = "https://as.remote-as.test"
TOKEN_URL = AS_ORIGIN + "/token"
SERVER_NAME = "test.remote-as/mcp"
CALLBACK = "https://app.test/mcp/oauth/callback"
INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}


class RemoteAuthServer:
    """An MCP server on one origin and its authorization server on another."""

    def __init__(self) -> None:
        self.token_requests: list[tuple[str, dict[str, list[str]]]] = []
        self.bearers_seen: list[str | None] = []
        self.issued = 0

    def transport(self) -> httpx2.MockTransport:
        return httpx2.MockTransport(self)

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        url = str(request.url)
        if url == ENDPOINT:
            auth = request.headers.get("authorization")
            self.bearers_seen.append(auth)
            if auth != f"Bearer at-{self.issued}" or self.issued == 0:
                return httpx2.Response(
                    401,
                    headers={
                        "WWW-Authenticate": f'Bearer resource_metadata="{PRM_URL}"'
                    },
                )
            return httpx2.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {}})
        if url == PRM_URL:
            return httpx2.Response(
                200, json={"resource": ENDPOINT, "authorization_servers": [AS_ORIGIN]}
            )
        if url == AS_ORIGIN + "/.well-known/oauth-authorization-server":
            return httpx2.Response(
                200,
                json={
                    "issuer": AS_ORIGIN,
                    "authorization_endpoint": AS_ORIGIN + "/authorize",
                    "token_endpoint": TOKEN_URL,
                    "response_types_supported": ["code"],
                    "code_challenge_methods_supported": ["S256"],
                },
            )
        if url == TOKEN_URL:
            form = parse_qs(request.content.decode())
            self.token_requests.append((url, form))
            grant = form.get("grant_type", [""])[0]
            code_ok = grant == "authorization_code" and form.get("code") == ["code-1"]
            refresh_ok = grant == "refresh_token" and form.get("refresh_token") == [
                f"rt-{self.issued}"
            ]
            ok = code_ok or refresh_ok
            if not ok:
                return httpx2.Response(400, json={"error": "invalid_grant"})
            self.issued += 1
            return httpx2.Response(
                200,
                json={
                    "access_token": f"at-{self.issued}",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                    "refresh_token": f"rt-{self.issued}",
                    "scope": "mcp:read",
                },
            )
        if url.startswith(MCP_ORIGIN + "/token"):
            # What the SDK falls back to without metadata. Nothing lives here.
            self.token_requests.append((url, parse_qs(request.content.decode())))
            return httpx2.Response(404)
        return httpx2.Response(404)


async def _vault() -> CredentialVault:
    keys = KeyProvider(json.dumps({"1": base64.b64encode(os.urandom(32)).decode()}), 1)
    vault = CredentialVault(keys, MemoryStore())
    await vault.put_client(
        {
            "client_id": "remote-as-client",
            "client_secret": "remote-as-secret",
            "redirect_uris": [CALLBACK],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "client_secret_post",
        },
        server_name=SERVER_NAME,
        issuer=ENDPOINT,
        registration_mode="preregistered",
    )
    return vault


def _storage(vault: CredentialVault) -> VaultTokenStorage:
    return VaultTokenStorage(
        vault,
        identity_for(
            user_id="user-a",
            workspace_id="ws-1",
            connection_id="conn-1",
            server_name=SERVER_NAME,
            resource=ENDPOINT,
        ),
    )


def _interactive_provider(storage: VaultTokenStorage):
    """Handlers that complete the consent the way a browser would."""
    from mcp.shared.auth import AuthorizationCodeResult

    state: dict[str, str] = {}

    async def redirect(url: str) -> None:
        state["value"] = parse_qs(urlparse(url).query)["state"][0]

    async def callback():
        return AuthorizationCodeResult(code="code-1", state=state["value"], iss=None)

    return build_provider(
        server_url=ENDPOINT,
        storage=storage,
        redirect_uri=CALLBACK,
        redirect_handler=redirect,
        callback_handler=callback,
    )


def _pooled_provider(storage: VaultTokenStorage):
    """What a tool call gets: a provider that may refresh but never prompts."""

    async def refuse(*_args) -> None:
        raise McpConnectionError(
            McpErrorKind.AUTH_REQUIRED, "needs authorization", server_slug="remote"
        )

    return build_provider(
        server_url=ENDPOINT,
        storage=storage,
        redirect_uri=CALLBACK,
        redirect_handler=refuse,
        callback_handler=refuse,
    )


async def _authorize(
    server: RemoteAuthServer, vault: CredentialVault
) -> VaultTokenStorage:
    storage = _storage(vault)
    async with httpx2.AsyncClient(
        transport=server.transport(), auth=_interactive_provider(storage)
    ) as client:
        res = await client.post(ENDPOINT, json=INIT)
    assert res.status_code == 200, "the authorization itself must succeed"
    assert server.token_requests[-1][0] == TOKEN_URL
    return storage


async def _expire_stored_token(
    storage: VaultTokenStorage, *, keep_metadata: bool = True
) -> None:
    """Rewrite the stored token as already expired, keeping everything else.

    `keep_metadata=False` writes the token the way it was stored BEFORE this fix
    — `get_tokens` reloads the stored metadata, so it has to be dropped after
    the load, not before."""
    from mcp.shared.auth import OAuthToken

    current = await storage.get_tokens()
    assert current is not None
    if not keep_metadata:
        storage.authorization_server = None
    await storage.set_tokens(
        OAuthToken(
            access_token=current.access_token,
            token_type="Bearer",
            expires_in=-1,
            refresh_token=current.refresh_token,
            scope=current.scope,
        )
    )


async def test_a_fresh_session_refreshes_at_the_authorization_server():
    server = RemoteAuthServer()
    vault = await _vault()
    storage = await _authorize(server, vault)
    await _expire_stored_token(storage)

    # A NEW provider over a NEW storage instance: exactly what the pool builds
    # for the next session. It holds no metadata of its own.
    async with httpx2.AsyncClient(
        transport=server.transport(), auth=_pooled_provider(_storage(vault))
    ) as client:
        res = await client.post(ENDPOINT, json=INIT)

    assert res.status_code == 200, res.text
    url, form = server.token_requests[-1]
    assert url == TOKEN_URL, "the refresh went somewhere other than the AS"
    assert form["grant_type"] == ["refresh_token"]
    assert form["refresh_token"] == ["rt-1"]
    # The refreshed token was used, and nobody was asked to sign in.
    assert server.bearers_seen[-1] == "Bearer at-2"


async def test_the_refreshed_token_and_metadata_survive_for_the_next_session():
    """Refresh twice across two fresh sessions: the second must still know the
    endpoint, which means the refresh path re-persists the metadata."""
    server = RemoteAuthServer()
    vault = await _vault()
    storage = await _authorize(server, vault)
    await _expire_stored_token(storage)

    for expected_refresh in ("rt-1", "rt-2"):
        fresh = _storage(vault)
        async with httpx2.AsyncClient(
            transport=server.transport(), auth=_pooled_provider(fresh)
        ) as client:
            assert (await client.post(ENDPOINT, json=INIT)).status_code == 200
        url, form = server.token_requests[-1]
        assert (url, form["refresh_token"]) == (TOKEN_URL, [expected_refresh])
        await _expire_stored_token(fresh)


async def test_without_stored_metadata_the_sdk_refresh_misses_and_the_user_is_asked():
    """The control: what production did. Documented so the fix is understood
    as a fix and not as a coincidence of the fixture."""
    server = RemoteAuthServer()
    vault = await _vault()
    storage = await _authorize(server, vault)
    # A token stored before this fix existed carries no metadata.
    await _expire_stored_token(storage, keep_metadata=False)

    async with httpx2.AsyncClient(
        transport=server.transport(), auth=_pooled_provider(_storage(vault))
    ) as client:
        with pytest.raises(McpConnectionError) as info:
            await client.post(ENDPOINT, json=INIT)

    assert info.value.kind is McpErrorKind.AUTH_REQUIRED
    assert server.token_requests[-1][0] == MCP_ORIGIN + "/token"


async def test_the_stored_metadata_is_the_servers_own_and_never_a_secret():
    server = RemoteAuthServer()
    vault = await _vault()
    await _authorize(server, vault)
    found = await vault.get(
        user_id="user-a",
        workspace_id="ws-1",
        connection_id="conn-1",
        server_name=SERVER_NAME,
        resource=ENDPOINT,
        kind="oauth_token",
    )
    assert found is not None
    payload, _record = found
    assert payload["authorization_server"]["token_endpoint"] == TOKEN_URL
    assert payload["authorization_server"]["issuer"] == AS_ORIGIN
    assert "remote-as-secret" not in json.dumps(payload)

"""Google's MCP servers: authorization is forced, and discovery tolerates Google.

WHY THIS FILE EXISTS. Three things about Google's official MCP servers
(gmailmcp/calendarmcp/drivemcp/docsmcp/sheetsmcp/mapstools.googleapis.com),
each measured against the live endpoints, would each have broken the flow:

1. `initialize` and `tools/list` answer 200 WITHOUT a token; only `tools/call`
   answers 401. The SDK starts OAuth only on a 401, so a Google connection read
   as Connected having never authorized, and `OAuthFlow.start` never produced a
   URL. A server curated as `oauth` now never gets used unauthenticated.
2. The protected-resource metadata names `https://accounts.google.com/` while
   the authorization server's own metadata says `https://accounts.google.com`.
   The SDK compares issuers as plain strings and refused the metadata.
3. Google issues no refresh token without `access_type=offline`.

Every test drives the REAL SDK provider over a mock HTTP transport shaped like
Google's answers, so a pass means the SDK itself took the path.
"""

from __future__ import annotations

import base64
import json
import os
from urllib.parse import parse_qs, urlparse

import httpx2
import pytest

from app.mcp.credentials import VaultCredentialResolver
from app.mcp.exceptions import McpConnectionError, McpErrorKind
from app.mcp.oauth.flow import provider_params
from app.mcp.oauth.provider import build_provider, identity_for
from app.mcp.oauth.storage import VaultTokenStorage
from app.mcp.vault.keys import KeyProvider
from app.mcp.vault.store import CredentialVault
from tests.test_mcp_vault_store import MemoryStore

pytestmark = pytest.mark.anyio

ENDPOINT = "https://mcp.google-shaped.test/mcp/v1"
PRM_URL = "https://mcp.google-shaped.test/.well-known/oauth-protected-resource/mcp/v1"
AS_ROOT = "https://as.google-shaped.test"
SERVER_NAME = "test.google-shaped/mcp"
CALLBACK = "https://app.test/mcp/oauth/callback"
INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}


class _Stop(Exception):
    """Raised by the redirect handler once the SDK hands over the URL."""


def _transport(metadata_issuer: str) -> httpx2.MockTransport:
    def handle(request: httpx2.Request) -> httpx2.Response:
        url = str(request.url)
        if url == ENDPOINT:
            # Google's shape: the handshake succeeds with or without a token.
            return httpx2.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {}})
        if url == PRM_URL:
            return httpx2.Response(
                200,
                json={
                    "resource": ENDPOINT,
                    "authorization_servers": [AS_ROOT + "/"],
                    "scopes_supported": ["https://scope.test/read"],
                },
            )
        if url == AS_ROOT + "/.well-known/oauth-authorization-server":
            return httpx2.Response(
                200,
                json={
                    "issuer": metadata_issuer,
                    "authorization_endpoint": AS_ROOT + "/o/oauth2/v2/auth",
                    "token_endpoint": AS_ROOT + "/token",
                    "response_types_supported": ["code"],
                    "code_challenge_methods_supported": ["S256"],
                },
            )
        return httpx2.Response(404)

    return httpx2.MockTransport(handle)


async def _vault() -> CredentialVault:
    keys = KeyProvider(json.dumps({"1": base64.b64encode(os.urandom(32)).decode()}), 1)
    vault = CredentialVault(keys, MemoryStore())
    # Google has no dynamic registration: the client is pre-registered.
    await vault.put_client(
        {
            "client_id": "google-shaped-client",
            "client_secret": "google-shaped-secret",
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


def _provider(vault: CredentialVault, seen: list[str], *, require_bearer: bool):
    async def redirect(url: str) -> None:
        seen.append(url)
        raise _Stop

    async def callback():  # pragma: no cover - never reached
        raise AssertionError("callback reached")

    storage = VaultTokenStorage(
        vault,
        identity_for(
            user_id="user-a",
            workspace_id="ws-1",
            connection_id="conn-1",
            server_name=SERVER_NAME,
            resource=ENDPOINT,
        ),
    )
    return build_provider(
        server_url=ENDPOINT,
        storage=storage,
        redirect_uri=CALLBACK,
        redirect_handler=redirect,
        callback_handler=callback,
        require_bearer=require_bearer,
    )


# ---------------------------------------------------- 1 + 2: forced authorization
@pytest.mark.parametrize(
    "metadata_issuer",
    [AS_ROOT, AS_ROOT + "/"],
    ids=["issuer-without-slash-like-google", "issuer-with-slash-unchanged"],
)
async def test_an_oauth_server_that_answers_without_a_token_is_still_authorized(
    metadata_issuer,
):
    seen: list[str] = []
    provider = _provider(await _vault(), seen, require_bearer=True)
    async with httpx2.AsyncClient(
        transport=_transport(metadata_issuer), auth=provider
    ) as client:
        with pytest.raises(_Stop):
            await client.post(ENDPOINT, json=INIT)

    assert len(seen) == 1, "the SDK never reached the authorization request"
    url = urlparse(seen[0])
    assert f"{url.scheme}://{url.netloc}{url.path}" == AS_ROOT + "/o/oauth2/v2/auth"
    query = parse_qs(url.query)
    assert query["client_id"] == ["google-shaped-client"]
    assert query["redirect_uri"] == [CALLBACK]
    assert query["code_challenge_method"] == ["S256"]
    # The issuer the SDK will hold `iss` against is the metadata's own form.
    assert str(provider.context.oauth_metadata.issuer) == metadata_issuer


async def test_without_require_bearer_the_open_handshake_is_left_alone():
    """The control: nothing else changes behaviour. An `auth_kind=none` server
    that answers without a token must keep working without one."""
    seen: list[str] = []
    provider = _provider(await _vault(), seen, require_bearer=False)
    async with httpx2.AsyncClient(
        transport=_transport(AS_ROOT), auth=provider
    ) as client:
        res = await client.post(ENDPOINT, json=INIT)
    assert res.status_code == 200
    assert seen == []


# ------------------------------------------------------------- the pooled seam
async def _resolved_post(auth_kind: str) -> httpx2.Response:
    resolver = VaultCredentialResolver(await _vault(), redirect_uri=CALLBACK)
    credential = await resolver.resolve(
        user_id="user-a",
        workspace_id="ws-1",
        connection_id="conn-1",
        server_slug="gmail",
        auth_kind=auth_kind,
        server_name=SERVER_NAME,
        endpoint_url=ENDPOINT,
        resource=ENDPOINT,
    )
    async with httpx2.AsyncClient(
        transport=_transport(AS_ROOT), auth=credential.auth
    ) as client:
        return await client.post(ENDPOINT, json=INIT)


async def test_connect_on_an_unauthorized_oauth_server_is_AUTH_REQUIRED_not_connected():
    """What the Connect button reaches. Before the fix this returned 200 and the
    row went to Connected with no account behind it."""
    with pytest.raises(McpConnectionError) as info:
        await _resolved_post("oauth")
    assert info.value.kind is McpErrorKind.AUTH_REQUIRED


async def test_an_open_server_still_connects_through_the_vault_resolver():
    assert (await _resolved_post("none")).status_code == 200


# --------------------------------------------------------------- 3: offline access
def test_google_authorization_asks_for_offline_access():
    url = provider_params(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=c&state=s&scope=a+b"
    )
    query = parse_qs(urlparse(url).query)
    assert query["access_type"] == ["offline"]
    assert query["prompt"] == ["consent"]
    # Nothing the SDK put there is lost.
    assert query["state"] == ["s"]
    assert query["scope"] == ["a b"]


def test_other_providers_are_untouched():
    url = "https://github.com/login/oauth/authorize?client_id=c&state=s"
    assert provider_params(url) == url


# ------------------------------------------- 4: the classification in front of it
def test_a_wrapped_auth_required_stays_auth_required_without_a_401():
    """Measured on production after the first Google deploy: Connect reported
    `kind=unreachable status=null` and the UI showed "Temporarily unavailable".

    The resolver's AUTH_REQUIRED is raised inside the SDK's task groups, so it
    reaches the classifier wrapped. GitHub earns a real 401 and was classified
    by status; Google's handshake is a 200, so nothing was recorded and the
    error fell through to UNREACHABLE — no sign-in was ever offered.
    """
    from app.mcp.errors import to_connection_error
    from app.mcp.status import StatusRecorder

    refused = McpConnectionError(
        McpErrorKind.AUTH_REQUIRED,
        "this connection needs to be authorized before it can be used",
        server_slug="gmail",
    )
    recorder = StatusRecorder()
    recorder.saw_response = True  # the 200 handshake, and no error status

    err = to_connection_error(
        ExceptionGroup("outer", [ExceptionGroup("inner", [refused])]),
        server_slug="gmail",
        recorder=recorder,
    )
    assert err.kind is McpErrorKind.AUTH_REQUIRED

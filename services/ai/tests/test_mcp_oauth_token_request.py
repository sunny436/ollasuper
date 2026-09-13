"""Token requests ask for JSON, and a pre-registered confidential client works.

WHY THIS FILE EXISTS. GitHub's authorization server offers no dynamic client
registration, so its client is pre-registered and seeded into the vault. And its
token endpoint answers `application/x-www-form-urlencoded` unless the request
says `Accept: application/json` — measured against the live endpoint:

    no Accept            -> Content-Type: application/x-www-form-urlencoded
    Accept: application/json -> Content-Type: application/json

The SDK sends no `Accept`, so the exchange failed to parse on every GitHub
authorization. The flow tests never saw it because the fixture server answers
JSON whatever the request asks for.
"""

from __future__ import annotations

import base64
import json
import os
from urllib.parse import parse_qs

import pytest

from app.mcp.oauth.provider import build_provider, identity_for
from app.mcp.oauth.storage import VaultTokenStorage
from app.mcp.vault.keys import KeyProvider
from app.mcp.vault.store import CredentialVault
from tests.test_mcp_vault_store import MemoryStore

pytestmark = pytest.mark.anyio

TOKEN_URL = "https://github.com/login/oauth/access_token"


async def _noop(*_args, **_kwargs):
    return None


def _provider():
    keys = KeyProvider(json.dumps({"1": base64.b64encode(os.urandom(32)).decode()}), 1)
    storage = VaultTokenStorage(
        CredentialVault(keys, MemoryStore()),
        identity_for(
            user_id="user-a",
            workspace_id="ws-1",
            connection_id="conn-1",
            server_name="io.github.github/github-mcp-server",
            resource="https://api.githubcopilot.com/mcp/",
        ),
    )
    return build_provider(
        server_url="https://api.githubcopilot.com/mcp/",
        storage=storage,
        redirect_uri="https://app.test/mcp/oauth/callback",
        redirect_handler=_noop,
        callback_handler=_noop,
    )


def _preregistered(provider):
    """The record the operator seeds: GitHub's shape, secret posted in the body."""
    from mcp.shared.auth import OAuthClientInformationFull, OAuthMetadata

    provider.context.client_info = OAuthClientInformationFull.model_validate(
        {
            "client_id": "Ov23-test-client",
            "client_secret": "test-secret-value",
            "redirect_uris": ["https://app.test/mcp/oauth/callback"],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "client_secret_post",
        }
    )
    provider.context.oauth_metadata = OAuthMetadata.model_validate(
        {
            "issuer": "https://github.com/login/oauth",
            "authorization_endpoint": "https://github.com/login/oauth/authorize",
            "token_endpoint": TOKEN_URL,
            "response_types_supported": ["code"],
            "code_challenge_methods_supported": ["S256"],
        }
    )


async def test_the_code_exchange_asks_for_json_and_posts_the_secret():
    provider = _provider()
    _preregistered(provider)

    request = await provider._exchange_token_authorization_code("code-1", "verifier-1")

    assert str(request.url) == TOKEN_URL
    assert request.headers["accept"] == "application/json"
    body = parse_qs(request.content.decode())
    assert body["client_id"] == ["Ov23-test-client"]
    assert body["client_secret"] == ["test-secret-value"]
    assert body["code_verifier"] == ["verifier-1"]


async def test_the_refresh_asks_for_json_too():
    from mcp.shared.auth import OAuthToken

    provider = _provider()
    _preregistered(provider)
    provider.context.current_tokens = OAuthToken(
        access_token="old", token_type="Bearer", refresh_token="refresh-1"
    )

    request = await provider._refresh_token()

    assert request.headers["accept"] == "application/json"
    assert parse_qs(request.content.decode())["refresh_token"] == ["refresh-1"]

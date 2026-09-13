"""Seed a PRE-REGISTERED OAuth client into the credential vault.

Some authorization servers offer no dynamic client registration — GitHub's
(`https://github.com/login/oauth`) publishes no `registration_endpoint` — so the
SDK has nothing to register against and an authorization can never start. The
operator registers an OAuth App with the provider once, and this writes that
client where `VaultTokenStorage.get_client_info` reads it: keyed by the curated
server's name and endpoint (the flow's `resource`), encrypted like every other
credential.

The id and secret come from the ENVIRONMENT, never argv (argv shows in `ps`),
and nothing here prints the secret.

    MCP_SEED_CLIENT_ID=... MCP_SEED_CLIENT_SECRET=... \\
      uv run python -m qa.seed_oauth_client github
"""

from __future__ import annotations

import asyncio
import os
import sys

from app.clients.convex import ConvexClient
from app.config import get_settings
from app.db.engine import create_knowledge_engine
from app.mcp.registry.curated import list_curated
from app.mcp.vault.convex_store import ConvexCredentialStore
from app.mcp.vault.keys import KeyProvider
from app.mcp.vault.store import CredentialVault


async def main(slug: str) -> int:
    from mcp.shared.auth import OAuthClientInformationFull

    client_id = os.environ.get("MCP_SEED_CLIENT_ID", "").strip()
    client_secret = os.environ.get("MCP_SEED_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        print("MCP_SEED_CLIENT_ID and MCP_SEED_CLIENT_SECRET must be set")
        return 2

    settings = get_settings()
    if not settings.mcp_oauth_enabled:
        print("MCP_OAUTH_ENABLED is off; the running service would never read this")
        return 2

    engine = create_knowledge_engine(settings)
    try:
        rows = [r for r in await list_curated(engine) if r["slug"] == slug]
    finally:
        await engine.dispose()
    if not rows:
        print(f"no enabled curated server with slug {slug!r}")
        return 2
    row = rows[0]

    payload = {
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uris": [settings.mcp_oauth_redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "client_secret_post",
    }
    # The shape the SDK will load; refuse to store anything it would reject.
    OAuthClientInformationFull.model_validate(payload)

    http = ConvexClient.build_http_client()
    try:
        vault = CredentialVault(
            KeyProvider(
                settings.mcp_credential_keys,
                settings.mcp_credential_active_key_version,
            ),
            ConvexCredentialStore(ConvexClient(settings, http)),
        )
        await vault.put_client(
            payload,
            server_name=row["server_name"],
            issuer=row["endpoint_url"],
            registration_mode="preregistered",
        )
        stored = await vault.get_client(
            server_name=row["server_name"], issuer=row["endpoint_url"]
        )
    finally:
        await http.aclose()

    ok = (
        stored is not None
        and stored.get("client_id") == client_id
        and stored.get("client_secret") == client_secret
    )
    print(
        f"seeded {row['server_name']} at {row['endpoint_url']}: "
        f"{'read back and decrypted OK' if ok else 'READ-BACK FAILED'}"
    )
    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: python -m qa.seed_oauth_client <slug>")
        sys.exit(2)
    sys.exit(asyncio.run(main(sys.argv[1])))

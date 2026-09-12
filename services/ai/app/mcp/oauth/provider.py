"""Construct the SDK's `OAuthClientProvider` for one connection.

Almost nothing happens here — that is the point. PKCE, `state`, discovery,
registration, token exchange, refresh and the step-up are the SDK's, and are not
reimplemented, wrapped or second-guessed. This module supplies the three things
the SDK cannot know: which storage instance this tenant uses, where our callback
lives, and how to reach the authorization URL from a different HTTP request.

THE ONE OVERRIDE, AND WHY IT IS NOT A FORK
------------------------------------------
`OAuthClientProvider._initialize()` loads tokens from storage and stops:

    self.context.current_tokens = await self.context.storage.get_tokens()
    self.context.client_info    = await self.context.storage.get_client_info()

It never calls `update_token_expiry`, so `context.token_expiry_time` stays None —
and `is_token_valid()` reads a missing expiry as VALID:

    return bool(current_tokens and current_tokens.access_token
                and (not self.token_expiry_time or time.time() <= ...))

The consequence is specific and costly. After a restart the provider attaches an
EXPIRED access token, earns a 401, and takes the full re-authorization branch —
so a session that only needed a silent refresh instead prompts the user to
authorize again. Storing an absolute expiry and handing back a negative
`expires_in` does not help on its own, because nothing reads `expires_in` on this
path. Measured, not theorised: the regression test drives the real provider.

The override is four lines, calls `super()`, and uses the context's own
`update_token_expiry`. No protocol logic is copied.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from app.logging import get_logger
from app.mcp.oauth.storage import CredentialIdentity, VaultTokenStorage

log = get_logger(__name__)

__all__ = ["VaultOAuthClientProvider", "build_client_metadata", "build_provider"]

#: What OllaSuper tells an authorization server about itself. Deliberately
#: minimal: a client_uri or logo_uri would be a promise to host something.
_CLIENT_NAME = "OllaSuper"

#: Both grants are requested because a refresh token is what keeps a connection
#: alive without re-prompting. SEP-2207 also makes the SDK append
#: `offline_access` when the AS advertises it and this list includes refresh.
_GRANT_TYPES = ["authorization_code", "refresh_token"]


def build_client_metadata(redirect_uri: str, *, scope: str | None = None) -> Any:
    """The client metadata used for registration and authorization.

    `redirect_uris` carries EXACTLY ONE entry — the registered callback. No
    wildcards, and nothing user-supplied ever reaches it: an authorization
    server that accepts an attacker-chosen redirect is the classic way an
    authorization code is stolen.

    `scope` is a starting point, NOT a ceiling. The SDK overwrites
    `client_metadata.scope` from the server's own metadata (WWW-Authenticate ->
    PRM `scopes_supported` -> AS `scopes_supported`), so a narrower value here
    does not constrain what is requested. See `flow.py` for the narrowing hook
    and why it is off by default.
    """
    from mcp.shared.auth import OAuthClientMetadata  # noqa: PLC0415

    return OAuthClientMetadata(
        redirect_uris=[redirect_uri],
        client_name=_CLIENT_NAME,
        grant_types=list(_GRANT_TYPES),
        response_types=["code"],
        # `none` is correct for a public client using PKCE. Dynamic registration
        # may hand back a confidential client instead, and the SDK honours
        # whatever the registration actually returned.
        # noqa S106: "none" is the OAuth 2.1 NAME for public-client auth, not a
        # password. A public client using PKCE is exactly what OllaSuper is.
        token_endpoint_auth_method="none",  # noqa: S106
        scope=scope,
    )


class VaultOAuthClientProvider:
    """Factory namespace — see `build_provider`. Kept as a name so the override
    below has an obvious home in tracebacks."""


def build_provider(
    *,
    server_url: str,
    storage: VaultTokenStorage,
    redirect_uri: str,
    redirect_handler: Callable[[str], Awaitable[None]],
    callback_handler: Callable[[], Awaitable[Any]],
    scope: str | None = None,
    client_metadata_url: str | None = None,
) -> Any:
    """Build the provider for one connection.

    `client_metadata_url` enables Client ID Metadata Documents when the server
    advertises support. It is wired but NOT exercised locally: CIMD requires a
    publicly reachable HTTPS document, and this phase does not expose the
    service. Passing None simply falls through to dynamic registration.
    """
    from mcp.client.auth import OAuthClientProvider  # noqa: PLC0415

    class _ExpiryAwareProvider(OAuthClientProvider):
        """`OAuthClientProvider` that believes the expiry it loaded.

        See the module docstring. Without this, a stored-but-expired token reads
        as valid and costs the user an interactive re-authorization where a
        silent refresh would have done.
        """

        async def _initialize(self) -> None:
            await super()._initialize()
            tokens = self.context.current_tokens
            if tokens is not None and tokens.expires_in is not None:
                # The context's own conversion; nothing is recomputed here.
                self.context.update_token_expiry(tokens)

    return _ExpiryAwareProvider(
        server_url=server_url,
        client_metadata=build_client_metadata(redirect_uri, scope=scope),
        storage=storage,
        redirect_handler=redirect_handler,
        callback_handler=callback_handler,
        client_metadata_url=client_metadata_url,
    )


def identity_for(
    *,
    user_id: str,
    workspace_id: str,
    connection_id: str,
    server_name: str,
    resource: str,
) -> CredentialIdentity:
    """The tenant binding for one connection's storage instance.

    A thin passthrough, and worth having: it is the single place the five
    isolation dimensions are named together, so adding one later cannot be done
    in half the call sites.
    """
    return CredentialIdentity(
        user_id=user_id,
        workspace_id=workspace_id,
        connection_id=connection_id,
        server_name=server_name,
        resource=resource,
    )

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

A few more narrow overrides sit beside it, each documented where it is defined:
JSON token responses (GitHub), and forced authorization plus root-issuer
tolerance (Google's MCP servers).
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlparse

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


def _accept_json(request: Any) -> Any:
    """Ask the token endpoint for JSON. See the override in `build_provider`."""
    request.headers["Accept"] = "application/json"
    return request


#: Authorization-server metadata, relative to the issuer's origin.
_AS_METADATA = "/.well-known/oauth-authorization-server"


def _unauthenticated_success(request: Any, response: Any, endpoint: str) -> bool:
    """A non-error answer from the MCP endpoint to a request carrying no token."""
    url = str(request.url).split("?", 1)[0].rstrip("/")
    return (
        response.status_code < 400
        and "authorization" not in request.headers
        and url == endpoint.rstrip("/")
    )


async def _root_authorization_server(request: Any, response: Any) -> str | None:
    """The authorization server a protected-resource metadata response names,
    when it is a bare origin — the only form whose trailing slash is ambiguous."""
    if response.status_code != 200 or (
        "/.well-known/oauth-protected-resource" not in request.url.path
    ):
        return None
    try:
        await response.aread()
        servers = json.loads(response.content).get("authorization_servers") or []
    except (ValueError, AttributeError):
        return None
    first = servers[0] if isinstance(servers, list) and servers else None
    if not isinstance(first, str):
        return None
    parts = urlparse(first)
    return first if parts.path in ("", "/") and not parts.query else None


async def _issuer_of(response: Any) -> str | None:
    """The `issuer` an authorization server's metadata response declares."""
    if response.status_code != 200:
        return None
    try:
        await response.aread()
        issuer = json.loads(response.content).get("issuer")
    except (ValueError, AttributeError):
        return None
    return issuer if isinstance(issuer, str) else None


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
    require_bearer: bool = False,
) -> Any:
    """Build the provider for one connection.

    `require_bearer` is for a server curated as `oauth`: such a server is never
    used without a token, even when it would answer without one.

    `client_metadata_url` enables Client ID Metadata Documents when the server
    advertises support. It is wired but NOT exercised locally: CIMD requires a
    publicly reachable HTTPS document, and this phase does not expose the
    service. Passing None simply falls through to dynamic registration.
    """
    import httpx2  # noqa: PLC0415 -- the SDK's HTTP stack
    from mcp.client.auth import OAuthClientProvider  # noqa: PLC0415
    from mcp.client.auth.utils import issuers_match  # noqa: PLC0415

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

        # The SDK builds its token requests with no `Accept` header, and GitHub's
        # token endpoint then answers `application/x-www-form-urlencoded`, which
        # `OAuthToken.model_validate_json` cannot parse — so every GitHub
        # authorization failed at the exchange. RFC 6749 §5.1 token responses
        # are JSON, so asking for JSON is correct for every server.
        async def _exchange_token_authorization_code(
            self, *args: Any, **kwargs: Any
        ) -> Any:
            return _accept_json(
                await super()._exchange_token_authorization_code(*args, **kwargs)
            )

        async def _refresh_token(self, *args: Any, **kwargs: Any) -> Any:
            return _accept_json(await super()._refresh_token(*args, **kwargs))

        # GOOGLE'S MCP SERVERS ANSWER `initialize` AND `tools/list` WITHOUT A
        # TOKEN and challenge only on `tools/call`. The SDK starts OAuth on a
        # 401, so a Google connection read as Connected with no account behind
        # it, and `OAuthFlow.start` never got a URL. With `require_bearer`, an
        # unauthenticated success from the endpoint reaches the SDK as the 401
        # it should have been. Discovery requests go to other URLs and pass.
        #
        # The same wrapper learns the issuer form a bare-origin authorization
        # server signs as, for `_select_authorization_server` below.
        async def async_auth_flow(self, request: Any) -> Any:
            flow = super().async_auth_flow(request)
            try:
                outgoing = await flow.__anext__()
                while True:
                    response = yield outgoing
                    if require_bearer and _unauthenticated_success(
                        outgoing, response, self.context.server_url
                    ):
                        response = httpx2.Response(401, request=outgoing)
                    root = await _root_authorization_server(outgoing, response)
                    if root is not None:
                        metadata = yield httpx2.Request(
                            "GET", root.rstrip("/") + _AS_METADATA
                        )
                        self._issuer_form = await _issuer_of(metadata)
                    outgoing = await flow.asend(response)
            except StopAsyncIteration:
                return
            finally:
                await flow.aclose()

        # Google's resource metadata names `https://accounts.google.com/`; its
        # authorization server signs as `https://accounts.google.com`. The SDK
        # compares issuers as strings and refused the metadata, although its own
        # `issuers_match` holds that a root issuer with and without the slash is
        # one server. So use the form the server itself signs as.
        def _select_authorization_server(self, advertised: list[str]) -> str:
            chosen = super()._select_authorization_server(advertised)
            form = getattr(self, "_issuer_form", None)
            if form and form != chosen and issuers_match(form, chosen):
                return form
            return chosen

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

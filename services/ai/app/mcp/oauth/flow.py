"""start / callback / disconnect — the two-phase authorization.

THE SHAPE, AND WHY IT IS THIS SHAPE
-----------------------------------
The SDK's authorization flow is CLI-shaped: `_perform_authorization_code_grant`
generates `state` and PKCE into a stack frame, calls `redirect_handler(url)`,
then AWAITS `callback_handler()` in the same coroutine, and afterwards validates
the state with `compare_digest` and the issuer per RFC 9207.

A browser callback arrives in a different HTTP request. So rather than
reimplement the grant — which would mean owning PKCE, state and issuer
validation, exactly what the phase boundary forbids — the flow coroutine STAYS
ALIVE in a background task:

    start()                          callback()
      |                                  |
      +-- spawn task                     |
      |     connect -> 401 -> discover   |
      |     redirect_handler(url) -------+--> registry[state] = attempt
      |     <- return url to caller      |
      |                                  +--> attempt.result = code
      |     callback_handler() parks  <---+    attempt.callback_ready.set()
      |     SDK validates state + iss
      |     token exchange -> set_tokens -> ENCRYPTED -> Convex
      +-- session becomes READY

Our registry is ROUTING. The SDK's `compare_digest` is the GATE. Two independent
mechanisms, and the security one is the SDK's.

WHY A REPLAYED CALLBACK IS HARMLESS. The attempt is POPPED from the registry
before it is completed, so a second delivery of the same code finds nothing. And
because the credential is written for the tenant recorded when the flow STARTED
— never for whoever hit the callback — a callback delivered by the wrong browser
cannot bind an account to the wrong user.

SCOPE IS SERVER-DICTATED, NOT CHOSEN. The SDK overwrites `client_metadata.scope`
from the server's own metadata (WWW-Authenticate -> PRM -> AS), so configuring a
narrower scope does nothing. `narrow_scope` below rewrites the authorization
URL's `scope` parameter downward instead — legal under RFC 6749, self-healing via
the step-up, and OFF by default because of the interaction documented on it.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import anyio

from app.logging import get_logger
from app.mcp.exceptions import McpConnectionError, McpErrorKind
from app.mcp.oauth.attempts import AttemptRegistry, AuthorizationAttempt, state_from_url
from app.mcp.oauth.errors import to_oauth_error
from app.mcp.oauth.provider import build_provider, identity_for
from app.mcp.oauth.storage import VaultTokenStorage
from app.mcp.vault.store import CredentialVault

log = get_logger(__name__)

__all__ = ["AuthorizationStart", "OAuthFlow", "narrow_scope", "provider_params"]

#: How long `start` waits for the SDK to produce an authorization URL. This
#: covers PRM discovery, AS metadata and possibly a dynamic registration, so it
#: is generous — but bounded, because an HTTP request is waiting on it.
_URL_TIMEOUT_S = 30.0


@dataclass
class AuthorizationStart:
    """What `start` hands back. Contains NO secret — the browser only ever needs
    the authorization URL, which is public by construction."""

    attempt_id: str
    authorization_url: str
    expires_at: float
    requested_scope: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "attempt_id": self.attempt_id,
            "authorization_url": self.authorization_url,
            "expires_at": self.expires_at,
            "requested_scope": self.requested_scope,
        }


def narrow_scope(authorization_url: str, allowed: list[str]) -> str:
    """Rewrite the authorization URL's `scope` DOWN to an allowed subset.

    The only place least privilege can be applied. The SDK assigns
    `client_metadata.scope` from the server's metadata and does not read the URL
    again after handing it to `redirect_handler`, so the URL we give the browser
    is the URL that is used.

    NEVER WIDENS: the result is the intersection of what the SDK asked for and
    what the operator allowed, so it is always a subset the AS already
    advertised. Under-requesting is self-healing — the server answers 403
    `insufficient_scope` and the SDK's step-up asks for more, with the user told.

    OFF BY DEFAULT, because of one subtlety: when the AS omits `scope` from the
    token response, the SDK back-fills the WIDE `client_metadata.scope`
    (`oauth2.py:495`), so the recorded grant would overstate what was granted.
    The caller corrects that when narrowing is enabled.
    """
    if not allowed:
        return authorization_url
    parts = urlparse(authorization_url)
    query = parse_qs(parts.query, keep_blank_values=True)
    requested = (query.get("scope") or [""])[0].split()
    if not requested:
        return authorization_url
    kept = [scope for scope in requested if scope in set(allowed)]
    if not kept or kept == requested:
        return authorization_url
    query["scope"] = [" ".join(kept)]
    flat = urlencode({k: v[0] for k, v in query.items()})
    return urlunparse(parts._replace(query=flat))


#: Authorization-request parameters a provider needs beyond OAuth 2.1, by
#: authorization host. Google issues NO refresh token without
#: `access_type=offline`, so every Google connection would die when its one-hour
#: access token did; `prompt=consent` makes it issue one on a re-authorization
#: too, not only the first time an account consents.
_PROVIDER_AUTH_PARAMS: dict[str, dict[str, str]] = {
    "accounts.google.com": {"access_type": "offline", "prompt": "consent"},
}


def provider_params(authorization_url: str) -> str:
    """Add the provider-specific parameters above, if the host has any."""
    parts = urlparse(authorization_url)
    extra = _PROVIDER_AUTH_PARAMS.get(parts.hostname or "")
    if not extra:
        return authorization_url
    query = parse_qs(parts.query, keep_blank_values=True)
    for key, value in extra.items():
        query[key] = [value]
    flat = urlencode({k: v[0] for k, v in query.items()})
    return urlunparse(parts._replace(query=flat))


class OAuthFlow:
    """Owns pending authorizations and the background tasks driving them."""

    def __init__(
        self,
        vault: CredentialVault,
        *,
        redirect_uri: str,
        registry: AttemptRegistry | None = None,
        client_metadata_url: str | None = None,
        scope_allowlist: dict[str, list[str]] | None = None,
    ) -> None:
        self._vault = vault
        self._redirect_uri = redirect_uri
        self._registry = registry or AttemptRegistry()
        self._client_metadata_url = client_metadata_url
        # Per-server operator allowlist. Empty means "take what the server asks
        # for", which is the specification's behaviour.
        self._scope_allowlist = scope_allowlist or {}
        self._task_group: Any = None

    def bind(self, task_group: Any) -> None:
        """Attach the lifespan-owned task group the flows run in.

        Same constraint as Phase 3's session pool: a flow coroutine must outlive
        the HTTP request that started it, and anyio requires the group to be
        entered and exited in one task.
        """
        self._task_group = task_group

    @property
    def registry(self) -> AttemptRegistry:
        return self._registry

    # ------------------------------------------------------------------ start
    async def start(
        self,
        *,
        user_id: str,
        workspace_id: str,
        connection_id: str,
        server_name: str,
        server_slug: str,
        endpoint_url: str,
        resource: str,
        connect: Any,
        require_bearer: bool = False,
    ) -> AuthorizationStart:
        """Begin an authorization and return the URL the browser must visit.

        `connect` is an async callable taking the built provider and performing
        the MCP connection. Injected rather than imported so this module never
        reaches into the session pool, and so the whole flow is testable against
        a bare HTTP client.

        `require_bearer` is set for a server curated as `oauth`: one that serves
        its handshake without a token (Google's do) must still be authorized.
        See `build_provider`.
        """
        if self._task_group is None:
            raise McpConnectionError(
                McpErrorKind.UNREACHABLE,
                "the OAuth flow is not running",
                server_slug=server_slug,
            )

        attempt = await self._registry.create(
            attempt_id=f"auth_{secrets.token_urlsafe(12)}",
            user_id=user_id,
            workspace_id=workspace_id,
            connection_id=connection_id,
            server_name=server_name,
        )

        storage = VaultTokenStorage(
            self._vault,
            identity_for(
                user_id=user_id,
                workspace_id=workspace_id,
                connection_id=connection_id,
                server_name=server_name,
                resource=resource,
            ),
        )
        allowed = self._scope_allowlist.get(server_slug, [])

        async def redirect_handler(url: str) -> None:
            # The SDK hands us the URL it built. We read `state` out of it to
            # route the callback, optionally narrow the scope, and release the
            # waiting `start` request.
            final = provider_params(narrow_scope(url, allowed) if allowed else url)
            attempt.authorization_url = final
            attempt.requested_scope = (
                parse_qs(urlparse(final).query).get("scope") or [None]
            )[0]
            await self._registry.bind_state(attempt, state_from_url(final))
            attempt.url_ready.set()

        async def callback_handler() -> Any:
            await attempt.callback_ready.wait()
            if attempt.error or attempt.result is None:
                raise McpConnectionError(
                    McpErrorKind.AUTH_REQUIRED,
                    attempt.error or "authorization did not complete",
                    server_slug=server_slug,
                )
            return attempt.result

        provider = build_provider(
            server_url=endpoint_url,
            storage=storage,
            redirect_uri=self._redirect_uri,
            redirect_handler=redirect_handler,
            callback_handler=callback_handler,
            client_metadata_url=self._client_metadata_url,
            require_bearer=require_bearer,
        )

        async def run() -> None:
            try:
                await connect(provider)
                attempt.completed = True
                log.info(
                    "mcp.oauth_authorized",
                    extra={
                        "attempt_id": attempt.attempt_id,
                        "server": server_slug,
                        "user_id": user_id,
                    },
                )
            except anyio.get_cancelled_exc_class():
                raise
            except Exception as exc:  # noqa: BLE001 — recorded, never raised
                # Raising would kill the whole lifespan task group and every
                # other tenant's in-flight authorization with it. Same rule as
                # Phase 3's session actor.
                classified = to_oauth_error(exc, server_slug=server_slug)
                attempt.error = classified.detail
                log.warning(
                    "mcp.oauth_failed",
                    extra={
                        "attempt_id": attempt.attempt_id,
                        "server": server_slug,
                        "kind": str(classified.kind),
                    },
                )
            finally:
                # Always release anything waiting, so a failure before the URL
                # was produced does not leave `start` blocked until its timeout.
                attempt.url_ready.set()
                attempt.callback_ready.set()
                attempt.finished.set()
                await self._registry.discard(attempt)

        self._task_group.start_soon(run)

        with anyio.move_on_after(_URL_TIMEOUT_S):
            await attempt.url_ready.wait()

        if attempt.error:
            raise to_oauth_error(
                None, server_slug=server_slug, detail=attempt.error
            )
        if not attempt.authorization_url:
            raise McpConnectionError(
                McpErrorKind.TIMEOUT,
                "the provider did not produce an authorization URL in time",
                server_slug=server_slug,
            )

        return AuthorizationStart(
            attempt_id=attempt.attempt_id,
            authorization_url=attempt.authorization_url,
            expires_at=attempt.expires_at,
            requested_scope=attempt.requested_scope,
        )

    # --------------------------------------------------------------- callback
    async def complete(
        self,
        *,
        state: str,
        code: str | None,
        iss: str | None = None,
        error: str | None = None,
    ) -> AuthorizationAttempt | None:
        """Deliver a callback to the flow waiting on it.

        Returns the attempt, or None when `state` matches nothing — which covers
        an expired attempt, a replay, and a forged callback IDENTICALLY. A
        distinguishable response would tell an attacker which states exist.
        """
        attempt = await self._registry.claim(state)
        if attempt is None:
            log.info("mcp.oauth_callback_unmatched")
            return None

        if error:
            attempt.error = to_oauth_error(
                None, server_slug=attempt.server_name, error_code=error
            ).detail
            attempt.callback_ready.set()
            return attempt

        if not code:
            attempt.error = "the provider returned no authorization code"
            attempt.callback_ready.set()
            return attempt

        from mcp.shared.auth import AuthorizationCodeResult  # noqa: PLC0415

        # Handed to the SDK, which validates `state` with compare_digest and the
        # issuer per RFC 9207. We do not pre-validate either: one gate, owned by
        # the code that generated them.
        attempt.result = AuthorizationCodeResult(code=code, state=state, iss=iss)
        attempt.callback_ready.set()
        return attempt

    async def wait_for_completion(
        self, attempt: AuthorizationAttempt, *, timeout_s: float = 30.0
    ) -> bool:
        """Wait for the background flow to finish the token exchange.

        Used by the callback route so it can tell the user whether the
        authorization actually succeeded rather than optimistically claiming it.
        """
        with anyio.move_on_after(timeout_s):
            await attempt.finished.wait()
        return attempt.completed

"""The credential SEAM. Phase 4 owns credentials; Phase 3 owns the shape.

    connection -> CredentialResolver -> headers -> httpx client -> transport

That is the whole contract, and it is deliberately one method. Phase 4 replaces
the implementation with a real vault/OAuth provider and changes NOTHING in
`transport.py`, `connection.py`, `session.py`, `capabilities.py` or
`adapter.py` — which is the phase's stated success criterion, and is testable:
no module outside this one imports a concrete resolver type.

WHY HEADERS AND NOT A TOKEN. Returning `{"Authorization": "Bearer ..."}` rather
than a token string means the resolver — not the transport — decides the scheme.
A server wanting `X-Api-Key`, or two headers, or a signed value, needs no change
below this line.

NOTHING HERE PERSISTS ANYTHING. `EnvCredentialResolver` reads operator-supplied
development values out of settings and hands them over per call. There is no
store, no refresh, no expiry and no write path, because a Phase 3 that built one
would be a Phase 4 that had already happened.

THE TEST RESOLVER IS FOR TEST SERVERS. Its values come from
`settings.mcp_test_credentials`, which is registered in `Settings.secrets()` so
the existing log-redaction filter scrubs it out of every log line. Production
credentials do not go there.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from app.logging import get_logger

log = get_logger(__name__)

__all__ = [
    "CredentialResolver",
    "EnvCredentialResolver",
    "NullCredentialResolver",
    "ResolvedCredential",
    "VaultCredentialResolver",
    "parse_test_credentials",
]


@dataclass(frozen=True)
class ResolvedCredential:
    """How a connection authenticates. EITHER static headers OR an httpx2 Auth.

    Two shapes, one seam, because the two credential kinds work at different
    layers and cannot be collapsed:

      * a static API key or bearer token is a HEADER — known before the request,
        constant for the session;
      * OAuth is an httpx2 `Auth` — it must participate in the request cycle to
        see the 401, run discovery, drive the authorization, and refresh an
        expired token mid-flight. Flattening it to a header would mean doing all
        of that ourselves, which is the thing this phase exists not to do.

    HOLDS NOTHING PERSISTENT. Built at connect time, attached to one session's
    HTTP client, and discarded with it. Nothing here is stored, logged, or put
    on a ToolDefinition.
    """

    headers: dict[str, str] = field(default_factory=dict)
    #: An `httpx2.Auth`. Typed `Any` so this module stays importable without the
    #: SDK's HTTP stack — the same reason `normalize.py` avoids importing it.
    auth: Any = None

    @property
    def is_present(self) -> bool:
        return bool(self.headers) or self.auth is not None

    def __repr__(self) -> str:  # pragma: no cover - trivial
        # Never the header VALUES. Names only, so a log line can say "we sent an
        # Authorization header" without saying what was in it.
        return (
            f"ResolvedCredential(headers={sorted(self.headers)}, "
            f"auth={type(self.auth).__name__ if self.auth else None})"
        )

#: A header value long enough to be a real token is still bounded: a hostile or
#: fat-fingered config must not put a megabyte on every request.
_MAX_HEADER_VALUE = 4096

#: The arguments `headers()` accepts. The session hands `resolve()` everything a
#: resolver could want; this is what the static ones actually take.
_HEADER_ARGS = frozenset(
    {"user_id", "workspace_id", "connection_id", "server_slug", "auth_kind"}
)


def _known(kwargs: dict) -> dict:
    return {k: v for k, v in kwargs.items() if k in _HEADER_ARGS}


@runtime_checkable
class CredentialResolver(Protocol):
    """Resolve the auth headers for ONE connection, at connect time."""

    async def headers(
        self,
        *,
        user_id: str,
        workspace_id: str,
        connection_id: str,
        server_slug: str,
        auth_kind: str,
    ) -> dict[str, str]:
        """Return headers to attach. `{}` means "connect unauthenticated".

        Receives the full trusted tenant context because Phase 4 must look up a
        credential belonging to THIS user in THIS workspace — a resolver keyed
        only on the server would be a cross-tenant credential leak by design.
        """
        ...

    async def resolve(self, **kwargs: object) -> ResolvedCredential:
        """Headers OR an httpx2 Auth. The shape the session actually attaches.

        Added alongside `headers` rather than replacing it: every Phase 3 call
        site and test uses `headers`, and a resolver that can only supply static
        credentials should not have to grow an OAuth-shaped method it will never
        populate.
        """
        ...


class NullCredentialResolver:
    """Connects unauthenticated. The default, and the only one used for servers
    whose declared `auth_kind` is `none`."""

    async def headers(self, **_kwargs: object) -> dict[str, str]:
        return {}

    async def resolve(self, **kwargs: object) -> ResolvedCredential:
        return ResolvedCredential(headers=await self.headers(**_known(kwargs)))

    @property
    def can_supply(self) -> bool:
        return False


class EnvCredentialResolver:
    """DEVELOPMENT AND TEST ONLY. Static bearer tokens, keyed by server slug.

    Exists so a Phase 3 connection to an API-key server can be exercised before
    Phase 4 lands. It cannot refresh, cannot expire, and cannot be per-user —
    all three are the vault's job, and pretending otherwise here would make the
    Phase 4 seam look already-solved.
    """

    def __init__(self, by_slug: dict[str, str] | None = None) -> None:
        self._by_slug = {
            slug: value[:_MAX_HEADER_VALUE]
            for slug, value in (by_slug or {}).items()
            if isinstance(slug, str) and isinstance(value, str) and value
        }

    @property
    def can_supply(self) -> bool:
        return bool(self._by_slug)

    def supplies(self, server_slug: str) -> bool:
        return server_slug in self._by_slug

    async def resolve(self, **kwargs: object) -> ResolvedCredential:
        """The Phase 4 shape. Static headers only — this resolver cannot do
        OAuth, and pretending otherwise would hide that from the caller.

        Unknown keys are DROPPED rather than forwarded. The session passes
        everything a resolver might want (endpoint, resource, server name), and
        a static resolver needs none of it; forwarding blindly would make every
        new field a TypeError in a code path that runs on every connection.
        """
        return ResolvedCredential(headers=await self.headers(**_known(kwargs)))

    async def headers(
        self,
        *,
        user_id: str = "",
        workspace_id: str = "",
        connection_id: str = "",
        server_slug: str = "",
        auth_kind: str = "unknown",
    ) -> dict[str, str]:
        token = self._by_slug.get(server_slug)
        if not token:
            return {}
        # Identifiers only. The VALUE is never logged, and `Settings.secrets()`
        # scrubs it even if a future caller gets this wrong.
        log.info(
            "mcp.credential_attached",
            extra={"server": server_slug, "auth_kind": auth_kind, "source": "env"},
        )
        if token.lower().startswith(("bearer ", "basic ")):
            return {"Authorization": token}
        return {"Authorization": f"Bearer {token}"}


def parse_test_credentials(raw: str | None) -> dict[str, str]:
    """Parse `mcp_test_credentials` into `{slug: token}`.

    Accepts JSON (`{"slug": "token"}`) or the flat `slug=token,slug2=token2`
    form, because an operator editing a `.env` by hand should not have to quote
    JSON. A malformed value yields `{}` and a warning rather than an exception:
    an unparseable development credential must not stop the service booting.
    """
    if not raw or not raw.strip():
        return {}
    text = raw.strip()
    if text.startswith("{"):
        try:
            parsed = json.loads(text)
        except ValueError:
            log.warning("mcp.test_credentials_unparseable", extra={"form": "json"})
            return {}
        if not isinstance(parsed, dict):
            return {}
        return {
            str(k): str(v)
            for k, v in parsed.items()
            if isinstance(k, str) and isinstance(v, str) and v
        }
    out: dict[str, str] = {}
    for pair in text.split(","):
        slug, sep, token = pair.partition("=")
        if sep and slug.strip() and token.strip():
            out[slug.strip()] = token.strip()
    if not out:
        log.warning("mcp.test_credentials_unparseable", extra={"form": "flat"})
    return out


class VaultCredentialResolver:
    """Resolves an OAuth credential from the encrypted vault.

    THE ONE RULE THAT SHAPES THIS CLASS: a tool call may REFRESH silently, but it
    may never start an interactive authorization.

    Both go through the same `OAuthClientProvider`, so the difference has to be
    made structurally. The provider built here has a `redirect_handler` that
    RAISES: if the SDK reaches the point of needing a consent screen, the
    connection fails with AUTH_REQUIRED instead of parking forever waiting for a
    browser nobody opened. Silent refresh, which happens earlier in
    `_auth_flow` and never touches the redirect handler, is unaffected.

    The interactive path is `OAuthFlow.start`, which builds its own provider
    with handlers that really do wait for a callback.

    `can_authorize` is True even when nothing is stored yet. That is deliberate
    and is what lets `compat.assess` permit the connection attempt that produces
    the 401 — the catalogue can never tell us a server speaks OAuth, so the
    challenge is the only way to find out.
    """

    def __init__(
        self,
        vault: Any,
        *,
        redirect_uri: str,
        client_metadata_url: str | None = None,
        endpoint_url: str | None = None,
        resource: str | None = None,
    ) -> None:
        self._vault = vault
        self._redirect_uri = redirect_uri
        self._client_metadata_url = client_metadata_url or None
        self._endpoint_url = endpoint_url
        self._resource = resource

    @property
    def can_supply(self) -> bool:
        return True

    @property
    def can_authorize(self) -> bool:
        """Whether an OAuth flow is POSSIBLE here — not whether one has run."""
        return True

    async def headers(self, **_kwargs: object) -> dict[str, str]:
        """OAuth is not a static header. Returning `{}` is the honest answer:
        the credential is applied by the `Auth` object, not by a header this
        method could produce."""
        return {}

    async def resolve(
        self,
        *,
        user_id: str = "",
        workspace_id: str = "",
        connection_id: str = "",
        server_slug: str = "",
        auth_kind: str = "unknown",
        server_name: str = "",
        endpoint_url: str = "",
        resource: str = "",
    ) -> ResolvedCredential:
        from app.mcp.exceptions import McpConnectionError, McpErrorKind
        from app.mcp.oauth.provider import build_provider, identity_for
        from app.mcp.oauth.storage import VaultTokenStorage

        target = endpoint_url or self._endpoint_url or ""
        audience = resource or self._resource or target
        if not target:
            return ResolvedCredential()

        storage = VaultTokenStorage(
            self._vault,
            identity_for(
                user_id=user_id,
                workspace_id=workspace_id,
                connection_id=connection_id,
                server_name=server_name or server_slug,
                resource=audience,
            ),
        )

        async def refuse_interactive(_url: str) -> None:
            # Reached only when the SDK has decided a full authorization is
            # needed. A tool call is not a place to open a consent screen, and
            # parking here would hang the call until its timeout with no
            # explanation. Failing loudly gives the user an actionable state.
            raise McpConnectionError(
                McpErrorKind.AUTH_REQUIRED,
                "this connection needs to be authorized before it can be used",
                server_slug=server_slug,
            )

        async def refuse_callback() -> Any:
            raise McpConnectionError(
                McpErrorKind.AUTH_REQUIRED,
                "this connection needs to be authorized before it can be used",
                server_slug=server_slug,
            )

        provider = build_provider(
            server_url=target,
            storage=storage,
            redirect_uri=self._redirect_uri,
            redirect_handler=refuse_interactive,
            callback_handler=refuse_callback,
            client_metadata_url=self._client_metadata_url,
            # A server curated as `oauth` is never used without a token, even
            # one that would answer (see `build_provider`).
            require_bearer=auth_kind == "oauth",
        )
        return ResolvedCredential(auth=provider)

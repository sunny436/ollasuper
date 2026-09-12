"""The MCP SDK's `TokenStorage`, backed by OllaSuper's encrypted vault.

    SDK TokenStorage  <->  VaultTokenStorage  <->  CredentialVault  <->  Convex

ONE INSTANCE PER (user, workspace, connection, resource). That is not a
convention, it is forced by the protocol: `TokenStorage.get_tokens()` takes NO
ARGUMENTS. There is no key to pass, so the instance itself IS the isolation
boundary — which is a gift, because cross-tenant leakage becomes a construction
error rather than a lookup bug.

THE EXPIRY BUG THIS FILE EXISTS TO AVOID
----------------------------------------
`OAuthToken.expires_in` is a RELATIVE duration, and the SDK does not recompute
expiry when it loads a token:

    _initialize()  ->  current_tokens = await storage.get_tokens()
                       # ...and nothing sets token_expiry_time

    is_token_valid()  ->  bool(current_tokens
                               and current_tokens.access_token
                               and (not self.token_expiry_time or ...))
                                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                    None reads as VALID

So persisting `expires_in` verbatim makes a token issued an hour ago look fresh
forever. We persist an ABSOLUTE `expires_at` and reconstruct the remaining
lifetime on read.

AND THE RECONSTRUCTION MUST NOT CLAMP AT ZERO. Measured against the SDK:

    expires_in = -3600  ->  is_token_valid() == False   (correct)
    expires_in =     0  ->  is_token_valid() == True    (wrong)

because `calculate_token_expiry` is `time.time() + int(expires_in)`, so zero
means "expires exactly now", which the `<=` comparison accepts. A `max(0, ...)`
here would reintroduce the very bug the absolute timestamp was added to fix.
"""

from __future__ import annotations

import time
from typing import Any

from app.logging import get_logger
from app.mcp.vault.aad import AadKind
from app.mcp.vault.store import CredentialVault

log = get_logger(__name__)

__all__ = ["CredentialIdentity", "VaultTokenStorage"]


class CredentialIdentity:
    """Who this storage instance speaks for. Immutable, and never model-supplied.

    Every field arrives from the trusted Convex-resolved request context. The
    MCP server has no say in any of them, and neither does the LLM.
    """

    __slots__ = ("connection_id", "resource", "server_name", "user_id", "workspace_id")

    def __init__(
        self,
        *,
        user_id: str,
        workspace_id: str,
        connection_id: str,
        server_name: str,
        resource: str,
    ) -> None:
        self.user_id = user_id
        self.workspace_id = workspace_id
        self.connection_id = connection_id
        self.server_name = server_name
        self.resource = resource

    def as_tenant(self) -> dict[str, str]:
        return {
            "user_id": self.user_id,
            "workspace_id": self.workspace_id,
            "connection_id": self.connection_id,
            "server_name": self.server_name,
            "resource": self.resource,
        }

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return (
            f"CredentialIdentity(user={self.user_id!r}, "
            f"connection={self.connection_id!r}, resource={self.resource!r})"
        )


class VaultTokenStorage:
    """`mcp.client.auth.TokenStorage` over the encrypted vault."""

    def __init__(self, vault: CredentialVault, identity: CredentialIdentity) -> None:
        self._vault = vault
        self._identity = identity

    # ---------------------------------------------------------------- tokens
    async def get_tokens(self) -> Any | None:
        """Load, decrypt, and hand the SDK a token with a TRUTHFUL lifetime.

        Returns None on a decrypt failure rather than raising: a corrupt row
        should force a clean re-authorization, not wedge the connection. The
        vault has already marked it UNREADABLE and logged why.
        """
        from mcp.shared.auth import OAuthToken  # noqa: PLC0415

        found = await self._vault.get(**self._identity.as_tenant())
        if found is None:
            return None
        payload, record = found

        access_token = payload.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            log.warning(
                "mcp.oauth_token_payload_invalid",
                extra={"credential_id": record.credential_id},
            )
            return None

        return OAuthToken(
            access_token=access_token,
            token_type=payload.get("token_type") or "Bearer",
            # UNCLAMPED. See the module docstring: max(0, ...) makes an expired
            # token read as valid.
            expires_in=_remaining_seconds(record.expires_at),
            refresh_token=payload.get("refresh_token"),
            scope=record.scope or payload.get("scope"),
        )

    async def set_tokens(self, tokens: Any) -> None:
        """Encrypt and persist. RAISES if persistence fails.

        Raising is load-bearing for rollback safety. `_handle_token_response`
        does not swallow it and `_auth_flow` re-raises, so a failure to persist
        fails the authorization — instead of leaving a connection that reports
        CONNECTED holding a token no later process can read.
        """
        expires_at = _absolute_expiry(getattr(tokens, "expires_in", None))
        payload = {
            "access_token": tokens.access_token,
            "token_type": getattr(tokens, "token_type", "Bearer"),
        }
        refresh = getattr(tokens, "refresh_token", None)
        if refresh:
            payload["refresh_token"] = refresh

        record = await self._vault.put(
            payload,
            **self._identity.as_tenant(),
            kind=AadKind.OAUTH_TOKEN,
            expires_at=expires_at,
            scope=getattr(tokens, "scope", None),
        )
        # Identifiers and lifetimes only — never the token, never the scope's
        # value as a secret (it is not one, but it is noise at INFO).
        log.info(
            "mcp.oauth_token_stored",
            extra={
                "credential_id": record.credential_id,
                "server": self._identity.server_name,
                "user_id": self._identity.user_id,
                "has_refresh": bool(refresh),
                "expires_at": expires_at.isoformat() if expires_at else None,
            },
        )

    # ---------------------------------------------------------- client info
    async def get_client_info(self) -> Any | None:
        """The OAuth client registration for this SERVER.

        Deliberately NOT keyed by user: a DCR client is registered once per
        `(server, issuer)` and reused by everyone. Keying it per user would
        re-register on every new user's first authorization — a registration
        storm against someone else's authorization server.
        """
        from mcp.shared.auth import OAuthClientInformationFull  # noqa: PLC0415

        payload = await self._vault.get_client(
            server_name=self._identity.server_name, issuer=self._issuer()
        )
        if payload is None:
            return None
        try:
            return OAuthClientInformationFull.model_validate(payload)
        except Exception:  # noqa: BLE001 — a stored record we cannot parse
            log.warning(
                "mcp.oauth_client_record_invalid",
                extra={"server": self._identity.server_name},
            )
            return None

    async def set_client_info(self, client_info: Any) -> None:
        payload = client_info.model_dump(mode="json", exclude_none=True)
        await self._vault.put_client(
            payload,
            server_name=self._identity.server_name,
            issuer=self._issuer(),
            registration_mode=_registration_mode(client_info),
        )
        log.info(
            "mcp.oauth_client_stored",
            extra={
                "server": self._identity.server_name,
                "issuer": self._issuer(),
                "mode": _registration_mode(client_info),
                "has_secret": bool(getattr(client_info, "client_secret", None)),
            },
        )

    def _issuer(self) -> str:
        """The authorization server a client record belongs to.

        Falls back to the resource when the SDK has not stamped an issuer —
        which happens on the legacy same-origin path. Using the resource keeps
        the record addressable rather than silently sharing one bucket across
        every issuer.
        """
        return self._identity.resource


def _remaining_seconds(expires_at: Any) -> int | None:
    """Absolute instant -> the SDK's relative `expires_in`. NEVER clamped."""
    if expires_at is None:
        return None
    return int(expires_at.timestamp() - time.time())


def _absolute_expiry(expires_in: Any) -> Any | None:
    """The SDK's relative `expires_in` -> an absolute instant we can store."""
    if expires_in is None:
        return None
    from datetime import UTC, datetime, timedelta  # noqa: PLC0415

    try:
        seconds = int(expires_in)
    except (TypeError, ValueError):
        # Some servers send `expires_in` as a string; the SDK tolerates that, so
        # we do too rather than losing the expiry entirely.
        return None
    return datetime.now(UTC) + timedelta(seconds=seconds)


def _registration_mode(client_info: Any) -> str:
    """How this client identity was obtained, for the audit trail."""
    client_id = str(getattr(client_info, "client_id", "") or "")
    if client_id.startswith("https://"):
        # A Client ID Metadata Document uses its URL as the client_id.
        return "cimd"
    issued_at = getattr(client_info, "client_id_issued_at", None)
    return "dcr" if issued_at else "preregistered"

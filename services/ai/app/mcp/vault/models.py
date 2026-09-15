"""What a stored credential IS — and, as importantly, what it is not.

A record here carries CIPHERTEXT plus the non-secret metadata needed to find it,
decide whether it is usable, and re-wrap it during key rotation. Nothing in the
plaintext columns is a secret, which is what lets the refresh path ask "is this
expired?" without decrypting anything.

TWO FIELDS DESERVE THEIR OWN EXPLANATION:

`expires_at` is ABSOLUTE, and that is not cosmetic. The SDK's `OAuthToken`
carries `expires_in` — a RELATIVE duration — and `OAuthClientProvider._initialize`
loads stored tokens WITHOUT recomputing expiry, while `is_token_valid()` treats a
missing expiry as valid. Persisting `expires_in` verbatim therefore makes a token
issued an hour ago look fresh forever. Storing the absolute instant and
reconstructing the relative value on read is what makes expiry survive a restart.

`rev` is a compare-and-set guard. Refresh-token rotation means the authorization
server invalidates the old refresh token as it issues a new one, so a stale
writer overwriting a newer row costs the user a re-authorization. `rev` makes the
stale writer lose. It does not make the race impossible — see `store.py`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum

from app.mcp.vault.aad import AadKind

__all__ = [
    "AadKind",
    "ClientRecord",
    "CredentialRecord",
    "CredentialStatus",
]


class CredentialStatus(StrEnum):
    """Lifecycle of the stored material — NOT of the MCP connection.

    Kept separate from `ConnectionState` on purpose: a credential can be
    perfectly valid while the server is unreachable, and a connection can be
    configured with no credential at all. Conflating them produces a UI that
    tells a user to reconnect their account when the server is simply down.
    """

    ACTIVE = "active"
    EXPIRED = "expired"
    REFRESH_FAILED = "refresh_failed"
    REVOKED = "revoked"
    #: Decryption failed. The row is KEPT — deleting it would destroy the only
    #: evidence that something was tampered with, or that a key version was
    #: retired too early. It is simply never handed out.
    UNREADABLE = "unreadable"


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass
class CredentialRecord:
    """One tenant-scoped credential. `envelope` is the only secret-bearing field."""

    credential_id: str
    user_id: str
    workspace_id: str
    connection_id: str
    server_name: str
    #: The canonical MCP resource URI. THE audience key: a token issued for one
    #: MCP server must never be found by a lookup for another, so it is part of
    #: both the lookup key and the AAD.
    resource: str
    kind: AadKind
    envelope: str
    key_version: int
    expires_at: datetime | None = None
    scope: str | None = None
    status: CredentialStatus = CredentialStatus.ACTIVE
    rev: int = 0
    created_at: datetime = field(default_factory=_now)
    updated_at: datetime = field(default_factory=_now)
    last_used_at: datetime | None = None
    revoked_at: datetime | None = None

    def is_expired(self, *, now: datetime | None = None) -> bool:
        """Answered from the plaintext column — no decryption required."""
        if self.expires_at is None:
            return False
        return (now or _now()) >= self.expires_at

    def matches_tenant(
        self,
        *,
        user_id: str,
        workspace_id: str,
        connection_id: str,
        server_name: str,
        resource: str,
    ) -> bool:
        """Do the caller's five identifiers match the ones this row was written
        with?

        NOT an authorization check — the caller's identity is already trusted by
        the time it reaches the vault. This exists to tell a WRONG CALLER apart
        from a CORRUPT ROW, which AES-GCM cannot do: both present as
        `InvalidTag`. Without it, asking for somebody else's connection marks
        THEIR credential unreadable and costs them a re-authorization.

        These are the same five fields the AAD binds, in the same order, so the
        two cannot drift: a field added to one must be added to the other or
        this comparison stops covering it.
        """
        return (
            self.user_id == user_id
            and self.workspace_id == workspace_id
            and self.connection_id == connection_id
            and self.server_name == server_name
            and self.resource == resource
        )

    def __repr__(self) -> str:  # pragma: no cover - trivial
        # Explicit: the default dataclass repr would print the envelope. It is
        # ciphertext, not plaintext, but a credential record in a traceback is
        # still something nobody needs to see.
        return (
            f"CredentialRecord(id={self.credential_id!r}, kind={self.kind!r}, "
            f"server={self.server_name!r}, status={self.status!r}, "
            f"key_version={self.key_version}, rev={self.rev})"
        )


@dataclass
class ClientRecord:
    """One OAuth client registration — DEPLOYMENT-scoped, not tenant-scoped.

    A DCR client is registered once per `(server_name, issuer)` and reused by
    every user of that server, so it has no owner. That is precisely why it
    lives in its own table with its own authorization rules rather than being a
    `kind` on `CredentialRecord`: giving it a nullable `user_id` would make the
    owner check on that table incoherent.

    The client_secret inside `envelope` is encrypted exactly like a token. It is
    a credential, and "configuration" is not a safe place to keep one.
    """

    client_record_id: str
    server_name: str
    issuer: str
    envelope: str
    key_version: int
    registration_mode: str = "dcr"
    created_at: datetime = field(default_factory=_now)
    updated_at: datetime = field(default_factory=_now)

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return (
            f"ClientRecord(id={self.client_record_id!r}, "
            f"server={self.server_name!r}, issuer={self.issuer!r}, "
            f"mode={self.registration_mode!r}, key_version={self.key_version})"
        )


class CredentialRefused(RuntimeError):
    """The store REFUSED a credential write: the connection is disconnected or
    the row is not this tenant's. Distinct from a lost compare-and-set (a
    benign race) so `CredentialVault.put` can let it propagate — a refresh that
    lands after a disconnect must fail the call, never resurrect the row."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(f"credential write refused: {reason}")

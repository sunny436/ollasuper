"""`CredentialStorePort` over Convex. Ciphertext in, ciphertext out.

The vault (`store.py`) owns the rules; this owns the round trip. It exists as a
separate module so `store.py`'s behaviour — the AAD binding, lazy rewrapping,
compare-and-set, decrypt-failure handling — stays provable with no database.

WHY THE INGRESS PATH RATHER THAN A CONVEX ACTION. `TokenStorage.set_tokens` is
called by the SDK deep inside a refresh, mid-tool-call, with no Convex action in
the loop. So the Python plane must be able to write on its own, and `/ai/ingress`
with `x-ai-key` is the established way it already does that (artifacts, SEO runs,
scheduled deliveries all use it).

THIS SENDS THE TENANT ON EVERY OP, AND CONVEX RE-CHECKS IT. `user_id` /
`workspace_id` / `connection_id` travel in every body — reads and marks too, not
only saves — and Convex refuses the op unless the connection belongs to exactly
that user and workspace and is not disconnected. So the ingress secret alone
names nothing: a request must state whose credential it wants, and Convex holds
it to that (audit H-17). There is no delete op at all; the control plane purges
rows itself once the plane reports a disconnect. Encryption is defence-in-depth
behind those checks, never a replacement for them.

NOTHING HERE CAN SEE A SECRET. Every payload carries an `envelope` string and
non-secret metadata. There is no code path in this module that could log, echo
or mis-route plaintext, because plaintext never arrives.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from app.logging import get_logger
from app.mcp.vault.aad import AadKind
from app.mcp.vault.models import (
    ClientRecord,
    CredentialRecord,
    CredentialRefused,
    CredentialStatus,
)

log = get_logger(__name__)

__all__ = ["ConvexCredentialStore"]

#: Ops on `/ai/ingress`. Namespaced so they cannot collide with the streaming
#: ops that share the endpoint.
_LOAD = "mcp-credential-load"
_SAVE = "mcp-credential-save"
_MARK = "mcp-credential-mark"
_CLIENT_LOAD = "mcp-oauth-client-load"
_CLIENT_SAVE = "mcp-oauth-client-save"


class ConvexCredentialStore:
    """Persists credential envelopes through the Convex ingress endpoint."""

    def __init__(self, convex: Any) -> None:
        self._convex = convex

    # ------------------------------------------------------------------ read
    async def load(
        self,
        *,
        connection_id: str,
        resource: str,
        kind: str,
        user_id: str,
        workspace_id: str,
    ) -> CredentialRecord | None:
        body = await self._convex.ingress(
            {
                "op": _LOAD,
                "connectionId": connection_id,
                "resource": resource,
                "kind": kind,
                "userId": user_id,
                "workspaceId": workspace_id,
            }
        )
        row = body.get("credential") if isinstance(body, dict) else None
        return _to_record(row) if isinstance(row, dict) else None

    async def load_client(
        self, *, server_name: str, issuer: str
    ) -> ClientRecord | None:
        body = await self._convex.ingress(
            {"op": _CLIENT_LOAD, "serverName": server_name, "issuer": issuer}
        )
        row = body.get("client") if isinstance(body, dict) else None
        return _to_client(row) if isinstance(row, dict) else None

    # ----------------------------------------------------------------- write
    async def save(self, record: CredentialRecord, *, expected_rev: int) -> bool:
        """Write under compare-and-set. False means a newer revision won.

        Returning False rather than raising is what lets the vault treat a lost
        race as information instead of an error — see `store.py` for why a CAS
        loser must not fail the caller.
        """
        body = await self._convex.ingress(
            {
                "op": _SAVE,
                "credentialId": record.credential_id,
                "userId": record.user_id,
                "workspaceId": record.workspace_id,
                "connectionId": record.connection_id,
                "serverName": record.server_name,
                "resource": record.resource,
                "kind": str(record.kind),
                # The ONLY secret-bearing field, and it is ciphertext.
                "envelope": record.envelope,
                "keyVersion": record.key_version,
                "expiresAt": _millis(record.expires_at),
                "scope": record.scope,
                "status": str(record.status),
                "rev": record.rev,
                "expectedRev": expected_rev,
            }
        )
        if not isinstance(body, dict):
            return False
        if body.get("refused"):
            # Not a race: Convex declined the write for this tenant/connection.
            raise CredentialRefused(str(body.get("reason") or "refused"))
        return bool(body.get("stored"))

    async def save_client(self, record: ClientRecord) -> None:
        await self._convex.ingress(
            {
                "op": _CLIENT_SAVE,
                "clientRecordId": record.client_record_id,
                "serverName": record.server_name,
                "issuer": record.issuer,
                "envelope": record.envelope,
                "keyVersion": record.key_version,
                "registrationMode": record.registration_mode,
            }
        )

    async def mark(
        self,
        *,
        credential_id: str,
        status: str,
        user_id: str,
        workspace_id: str,
        connection_id: str,
    ) -> None:
        await self._convex.ingress(
            {
                "op": _MARK,
                "credentialId": credential_id,
                "status": status,
                "userId": user_id,
                "workspaceId": workspace_id,
                "connectionId": connection_id,
            }
        )


# ------------------------------------------------------------------ mapping
def _millis(value: datetime | None) -> int | None:
    return int(value.timestamp() * 1000) if value is not None else None


def _instant(value: Any) -> datetime | None:
    if not isinstance(value, (int, float)):
        return None
    return datetime.fromtimestamp(value / 1000, tz=UTC)


def _to_record(row: dict) -> CredentialRecord | None:
    """Convex row -> `CredentialRecord`, defensively.

    A malformed row reads as None rather than raising: the caller's correct
    response to "no usable credential" is identical whether the row is missing
    or unusable, and raising here would wedge a connection that
    re-authorization would fix.
    """
    envelope = row.get("envelope")
    if not isinstance(envelope, str) or not envelope:
        return None
    try:
        kind = AadKind(str(row.get("kind") or AadKind.OAUTH_TOKEN))
        status = CredentialStatus(str(row.get("status") or CredentialStatus.ACTIVE))
    except ValueError:
        log.warning(
            "mcp.credential_row_unrecognised",
            extra={"credential_id": row.get("credentialId")},
        )
        return None

    return CredentialRecord(
        credential_id=str(row.get("credentialId") or ""),
        user_id=str(row.get("userId") or ""),
        workspace_id=str(row.get("workspaceId") or ""),
        connection_id=str(row.get("connectionId") or ""),
        server_name=str(row.get("serverName") or ""),
        resource=str(row.get("resource") or ""),
        kind=kind,
        envelope=envelope,
        key_version=int(row.get("keyVersion") or 0),
        expires_at=_instant(row.get("expiresAt")),
        scope=row.get("scope") if isinstance(row.get("scope"), str) else None,
        status=status,
        rev=int(row.get("rev") or 0),
        created_at=_instant(row.get("createdAt")) or datetime.now(UTC),
        updated_at=_instant(row.get("updatedAt")) or datetime.now(UTC),
        last_used_at=_instant(row.get("lastUsedAt")),
        revoked_at=_instant(row.get("revokedAt")),
    )


def _to_client(row: dict) -> ClientRecord | None:
    envelope = row.get("envelope")
    if not isinstance(envelope, str) or not envelope:
        return None
    return ClientRecord(
        client_record_id=str(row.get("clientRecordId") or ""),
        server_name=str(row.get("serverName") or ""),
        issuer=str(row.get("issuer") or ""),
        envelope=envelope,
        key_version=int(row.get("keyVersion") or 0),
        registration_mode=str(row.get("registrationMode") or "dcr"),
        created_at=_instant(row.get("createdAt")) or datetime.now(UTC),
        updated_at=_instant(row.get("updatedAt")) or datetime.now(UTC),
    )

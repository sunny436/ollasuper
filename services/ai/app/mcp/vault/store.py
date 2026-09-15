"""The credential vault: encrypt here, persist ciphertext elsewhere.

PERSISTENCE IS INJECTED (`CredentialStorePort`), for the same reason
`app/mcp/registry/sync.py` injects its port: the rules that are easiest to get
subtly wrong — what the AAD binds, when a row is re-wrapped, who wins a
concurrent write, what happens when decryption fails — should be provable on a
machine with no database. The Convex-backed implementation lives in
`app/mcp/vault/convex_store.py`; the SQL-free rules live here.

THREE RULES THIS MODULE EXISTS TO ENFORCE

1. PLAINTEXT NEVER LEAVES. `put` takes plaintext and encrypts before it reaches
   the port; `get` decrypts after the port returns. The port only ever sees an
   envelope, so no implementation of it — including a future one nobody has
   written yet — can accidentally persist a secret.

2. DECRYPTION FAILURE IS NOT DELETION. An `InvalidTag` marks the row UNREADABLE
   and returns None. Deleting would destroy the evidence that something was
   tampered with, or that a key version was retired while rows still used it —
   and a user whose credential silently vanished learns nothing.

3. ROTATION IS LAZY AND IN-PROCESS. A row written under a non-active key version
   is re-wrapped on read, inside this process. There is no bulk migration and
   plaintext never crosses a boundary to be re-encrypted somewhere else.

THE CONCURRENCY LIMITS, STATED PLAINLY AND CORRECTLY
---------------------------------------------------
WHAT SERIALISES A REFRESH is the SDK's own `OAuthContext.lock`, held per
provider — measured: twenty concurrent tool calls on an expired token produce
exactly ONE refresh. This module deliberately adds no lock of its own. An
earlier draft carried a `lock_for()` helper described as serialising refresh; it
was never acquired anywhere, and a lock nobody takes is worse than no lock
because it makes a reader believe serialisation exists. It could not be wired
here either: `get_tokens` and `set_tokens` are two separate SDK callbacks with
the refresh HTTP request between them, so holding a lock across both would
deadlock whenever a refresh failed and `set_tokens` was never reached.

WHAT PROTECTS THE CROSS-PROVIDER CASE — two providers for one credential across
a pool-eviction window — is `rev`, the compare-and-set guard, which makes the
stale writer lose.

WHAT NEITHER FULLY SOLVES is refresh-token ROTATION. `TokenStorage.set_tokens`
returns None, so a writer that loses the CAS has no way to hand the newer token
back to the SDK. Worst case is one re-authorization — bounded and recoverable,
and a real limit rather than one argued away.

AND ONE MORE, ABOUT REGISTRATION. There is no lock around dynamic client
registration either, so N users authorizing a newly curated server at the same
instant can each register a client. Measured at five concurrent first-time
authorizations in-process: one registration. That is scheduling, not a
guarantee — with real network latency more are possible. The consequence is
bounded: each registration is a valid client, `put_client` keeps one record per
`(server, issuer)`, and the surplus is waste rather than incorrectness.
"""

from __future__ import annotations

import json
import secrets
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any, Protocol

from app.logging import get_logger
from app.mcp.vault.aad import AadKind, build_aad
from app.mcp.vault.envelope import (
    ENVELOPE_VERSION,
    AuthenticationFailed,
    EnvelopeError,
    parse_version,
    seal,
    unseal,
)
from app.mcp.vault.keys import KeyProvider, VaultKeyError
from app.mcp.vault.models import ClientRecord, CredentialRecord, CredentialStatus

log = get_logger(__name__)

__all__ = ["CredentialStorePort", "CredentialVault", "new_credential_id"]

#: Opaque and unpredictable (§44). Never derived from an email, a token, or a
#: row number — an id that encodes something is an id that leaks it, and a
#: guessable one turns an authorization bug into an enumeration.
_ID_BYTES = 16

#: A credential payload is a small JSON object. Anything larger means a provider
#: returned something unexpected, and it should not be encrypted and stored.
_MAX_PLAINTEXT_BYTES = 32 * 1024


def new_credential_id(prefix: str = "cred") -> str:
    return f"{prefix}_{secrets.token_urlsafe(_ID_BYTES)}"


class CredentialStorePort(Protocol):
    """Everything the vault needs from storage, and nothing more.

    Every method deals in ENVELOPES. No implementation ever sees plaintext.
    """

    async def load(
        self,
        *,
        connection_id: str,
        resource: str,
        kind: str,
        user_id: str,
        workspace_id: str,
    ) -> CredentialRecord | None: ...

    async def save(self, record: CredentialRecord, *, expected_rev: int) -> bool:
        """Persist under compare-and-set. False means someone else wrote first.

        Raises `CredentialRefused` when the store REFUSED the write — the
        connection is disconnected, or the row belongs to another tenant. A
        refusal is not a lost race and must not read as one.
        """
        ...

    async def mark(
        self,
        *,
        credential_id: str,
        status: str,
        user_id: str,
        workspace_id: str,
        connection_id: str,
    ) -> None: ...

    # THERE IS DELIBERATELY NO `delete`. Secret material is removed by the
    # control plane (`convex/mcp/oauth.ts::disconnect` purges the rows once the
    # AI plane reports the session discarded), so the ingress key never carries
    # the authority to delete a credential — audit H-17.

    async def load_client(
        self, *, server_name: str, issuer: str
    ) -> ClientRecord | None: ...

    async def save_client(self, record: ClientRecord) -> None: ...


class CredentialVault:
    """Encrypt/decrypt around an injected store. See the module docstring for
    what does and does not serialise concurrent writes — it is CAS, not a lock."""

    def __init__(
        self,
        keys: KeyProvider,
        store: CredentialStorePort,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._keys = keys
        self._store = store
        self._now = now or (lambda: datetime.now(UTC))

    # ------------------------------------------------------------------ read
    async def get(
        self,
        *,
        user_id: str,
        workspace_id: str,
        connection_id: str,
        server_name: str,
        resource: str,
        kind: AadKind = AadKind.OAUTH_TOKEN,
    ) -> tuple[dict[str, Any], CredentialRecord] | None:
        """Load and decrypt, or None.

        Returns None — rather than raising — for a missing row, an unreadable
        row, or a revoked one. The caller's correct response to all three is
        identical: treat the connection as unauthorized and ask the user to
        authorize again. Raising would make a corrupt row wedge the connection
        instead of recovering it.
        """
        record = await self._store.load(
            connection_id=connection_id,
            resource=resource,
            kind=str(kind),
            user_id=user_id,
            workspace_id=workspace_id,
        )
        if record is None:
            return None
        if record.status in (CredentialStatus.REVOKED, CredentialStatus.UNREADABLE):
            return None

        # A MISMATCHED CALLER IS NOT A CORRUPT ROW — and conflating the two was
        # a denial-of-service lever, found by the isolation test rather than by
        # review.
        #
        # AES-GCM cannot distinguish "wrong AAD" from "tampered ciphertext":
        # both are `InvalidTag`. So marking every decrypt failure UNREADABLE
        # meant a caller asking for somebody else's connection under their own
        # identity would flip the VICTIM's credential to unreadable and force
        # them to authorize again. The identifiers are non-secret and stored in
        # plaintext beside the envelope, so the two cases CAN be told apart —
        # before any crypto runs.
        #
        # The AAD still binds, and still fails closed below. This only decides
        # which of two indistinguishable failures gets recorded against the row.
        if not record.matches_tenant(
            user_id=user_id,
            workspace_id=workspace_id,
            connection_id=connection_id,
            server_name=server_name,
            resource=resource,
        ):
            log.warning(
                "mcp.credential_tenant_mismatch",
                extra={
                    "credential_id": record.credential_id,
                    # The REQUESTING identity, never the stored one: logging the
                    # owner would turn this line into a lookup table for who
                    # holds which connection.
                    "requested_by": user_id,
                    "server": server_name,
                },
            )
            return None

        try:
            env_version = parse_version(record.envelope)
            aad = build_aad(
                kind=kind,
                credential_id=record.credential_id,
                user_id=user_id,
                workspace_id=workspace_id,
                connection_id=connection_id,
                server_name=server_name,
                resource=resource,
                version=env_version,
            )
            plaintext = unseal(
                record.envelope,
                aad=aad,
                key=self._keys.key_for(record.key_version),
                key_version=record.key_version,
            )
        except (AuthenticationFailed, EnvelopeError, VaultKeyError) as exc:
            # Identifiers only. The envelope and the AAD are never logged: one is
            # ciphertext the attacker already has, the other is a map of the
            # tenancy.
            log.warning(
                "mcp.credential_decrypt_failed",
                extra={
                    "credential_id": record.credential_id,
                    "server": server_name,
                    "key_version": record.key_version,
                    "reason": type(exc).__name__,
                },
            )
            await self._store.mark(
                credential_id=record.credential_id,
                status=str(CredentialStatus.UNREADABLE),
                user_id=user_id,
                workspace_id=workspace_id,
                connection_id=connection_id,
            )
            return None

        payload = self._decode(plaintext, record.credential_id)
        if payload is None:
            return None

        # Lazy rotation: re-wrap under the active key — and the current envelope
        # format (a v1 row re-seals as v2 on its first read) — in THIS process.
        if (
            record.key_version != self._keys.active_version
            or env_version != ENVELOPE_VERSION
        ):
            await self._rewrap(
                record,
                payload,
                aad_fields=(
                    user_id,
                    workspace_id,
                    connection_id,
                    server_name,
                    resource,
                    kind,
                ),
            )
        return payload, record

    # ----------------------------------------------------------------- write
    async def put(
        self,
        payload: dict[str, Any],
        *,
        user_id: str,
        workspace_id: str,
        connection_id: str,
        server_name: str,
        resource: str,
        kind: AadKind = AadKind.OAUTH_TOKEN,
        credential_id: str | None = None,
        expected_rev: int | None = None,
        expires_at: datetime | None = None,
        scope: str | None = None,
    ) -> CredentialRecord:
        """Encrypt `payload` and persist it. Raises if persistence fails.

        RAISING IS LOAD-BEARING. `VaultTokenStorage.set_tokens` calls this, and
        the SDK's `_handle_token_response` does not swallow the exception while
        `_auth_flow` re-raises it — so a failure to persist fails the
        authorization instead of leaving a connection that reports CONNECTED
        with a token no later process can read.
        """
        existing = await self._store.load(
            connection_id=connection_id,
            resource=resource,
            kind=str(kind),
            user_id=user_id,
            workspace_id=workspace_id,
        )
        record_id = credential_id or (
            existing.credential_id if existing else new_credential_id()
        )
        base_rev = (
            expected_rev
            if expected_rev is not None
            else (existing.rev if existing else 0)
        )

        plaintext = self._encode(payload)
        key_version, key = self._keys.active_key()
        aad = build_aad(
            kind=kind,
            credential_id=record_id,
            user_id=user_id,
            workspace_id=workspace_id,
            connection_id=connection_id,
            server_name=server_name,
            resource=resource,
        )
        now = self._now()
        record = CredentialRecord(
            credential_id=record_id,
            user_id=user_id,
            workspace_id=workspace_id,
            connection_id=connection_id,
            server_name=server_name,
            resource=resource,
            kind=kind,
            envelope=seal(plaintext, aad=aad, key=key, key_version=key_version),
            key_version=key_version,
            expires_at=expires_at,
            scope=scope,
            status=CredentialStatus.ACTIVE,
            rev=base_rev + 1,
            created_at=existing.created_at if existing else now,
            updated_at=now,
        )
        stored = await self._store.save(record, expected_rev=base_rev)
        if not stored:
            # The CAS loser does NOT raise. Another writer already persisted a
            # token at least as fresh; failing the caller here would turn a
            # harmless race into a user-visible error. See the module docstring
            # for what this does and does not solve.
            log.warning(
                "mcp.credential_refresh_raced",
                extra={
                    "credential_id": record_id,
                    "server": server_name,
                    "expected_rev": base_rev,
                },
            )
        return record

    async def mark_revoked(
        self,
        *,
        user_id: str,
        workspace_id: str,
        connection_id: str,
        resource: str,
        kind: AadKind = AadKind.OAUTH_TOKEN,
    ) -> None:
        record = await self._store.load(
            connection_id=connection_id,
            resource=resource,
            kind=str(kind),
            user_id=user_id,
            workspace_id=workspace_id,
        )
        if record is not None:
            await self._store.mark(
                credential_id=record.credential_id,
                status=str(CredentialStatus.REVOKED),
                user_id=user_id,
                workspace_id=workspace_id,
                connection_id=connection_id,
            )

    # -------------------------------------------------- OAuth client records
    async def get_client(
        self, *, server_name: str, issuer: str
    ) -> dict[str, Any] | None:
        record = await self._store.load_client(server_name=server_name, issuer=issuer)
        if record is None:
            return None
        try:
            env_version = parse_version(record.envelope)
            aad = build_aad(
                kind=AadKind.OAUTH_CLIENT,
                credential_id=record.client_record_id,
                user_id=None,
                workspace_id=None,
                connection_id=None,
                server_name=server_name,
                resource=issuer,
                version=env_version,
            )
            plaintext = unseal(
                record.envelope,
                aad=aad,
                key=self._keys.key_for(record.key_version),
                key_version=record.key_version,
            )
        except (AuthenticationFailed, EnvelopeError, VaultKeyError) as exc:
            log.warning(
                "mcp.client_record_decrypt_failed",
                extra={"server": server_name, "reason": type(exc).__name__},
            )
            return None
        payload = self._decode(plaintext, record.client_record_id)
        if payload is not None and (
            record.key_version != self._keys.active_version
            or env_version != ENVELOPE_VERSION
        ):
            # Same lazy re-wrap as credentials. `replace_preregistered=True`
            # because this is the record's OWN payload being re-sealed, not a
            # server response — the overwrite guard is about provenance.
            try:
                await self.put_client(
                    payload,
                    server_name=server_name,
                    issuer=issuer,
                    registration_mode=record.registration_mode,
                    replace_preregistered=True,
                )
                log.info("mcp.client_record_rewrapped", extra={"server": server_name})
            except Exception:  # noqa: BLE001 — a rewrap must never fail a read
                log.warning(
                    "mcp.client_record_rewrap_failed", extra={"server": server_name}
                )
        return payload

    async def put_client(
        self,
        payload: dict[str, Any],
        *,
        server_name: str,
        issuer: str,
        registration_mode: str = "dcr",
        replace_preregistered: bool = False,
    ) -> ClientRecord | None:
        """Store a client registration. Returns None when the write was REFUSED.

        A PRE-REGISTERED RECORD IS NEVER OVERWRITTEN BY A SERVER RESPONSE. The
        record is deployment-scoped — one per `(server, issuer)`, shared by every
        tenant — and it is written from inside the OAuth SDK's flow, i.e. from
        whatever the server's authorization server answered. An authorization
        server that replies `invalid_client` and then registers a client of ITS
        choosing would otherwise replace the operator-seeded GitHub or Slack
        client with one the attacker holds the secret for, for everyone. Only
        the operator's seed path (`qa/seed_oauth_client.py`) may replace one,
        and it says so explicitly with `replace_preregistered=True`.
        """
        existing = await self._store.load_client(server_name=server_name, issuer=issuer)
        if (
            existing is not None
            and existing.registration_mode == "preregistered"
            and not replace_preregistered
        ):
            log.warning(
                "mcp.oauth_client_overwrite_refused",
                extra={"server": server_name, "mode": registration_mode},
            )
            return None
        record_id = existing.client_record_id if existing else new_credential_id("cli")
        key_version, key = self._keys.active_key()
        aad = build_aad(
            kind=AadKind.OAUTH_CLIENT,
            credential_id=record_id,
            user_id=None,
            workspace_id=None,
            connection_id=None,
            server_name=server_name,
            resource=issuer,
        )
        now = self._now()
        record = ClientRecord(
            client_record_id=record_id,
            server_name=server_name,
            issuer=issuer,
            envelope=seal(
                self._encode(payload), aad=aad, key=key, key_version=key_version
            ),
            key_version=key_version,
            registration_mode=registration_mode,
            created_at=existing.created_at if existing else now,
            updated_at=now,
        )
        await self._store.save_client(record)
        return record

    # ------------------------------------------------------------ internals
    @staticmethod
    def _encode(payload: dict[str, Any]) -> bytes:
        raw = json.dumps(payload, separators=(",", ":"), default=str).encode("utf-8")
        if len(raw) > _MAX_PLAINTEXT_BYTES:
            raise ValueError(
                f"credential payload is {len(raw)} bytes; the ceiling is "
                f"{_MAX_PLAINTEXT_BYTES}"
            )
        return raw

    def _decode(self, plaintext: bytes, credential_id: str) -> dict[str, Any] | None:
        try:
            payload = json.loads(plaintext)
        except ValueError:
            log.warning(
                "mcp.credential_payload_malformed",
                extra={"credential_id": credential_id},
            )
            return None
        return payload if isinstance(payload, dict) else None

    async def _rewrap(
        self,
        record: CredentialRecord,
        payload: dict[str, Any],
        *,
        aad_fields: tuple[Any, ...],
    ) -> None:
        """Re-encrypt one row under the active key, best effort.

        Best effort on purpose: a rewrap failure must not fail the READ that
        triggered it. The caller already holds valid plaintext; the row simply
        stays on the old key version and is retried next time.
        """
        user_id, workspace_id, connection_id, server_name, resource, kind = aad_fields
        try:
            await self.put(
                payload,
                user_id=user_id,
                workspace_id=workspace_id,
                connection_id=connection_id,
                server_name=server_name,
                resource=resource,
                kind=kind,
                credential_id=record.credential_id,
                expected_rev=record.rev,
                expires_at=record.expires_at,
                scope=record.scope,
            )
            log.info(
                "mcp.credential_rewrapped",
                extra={
                    "credential_id": record.credential_id,
                    "from_version": record.key_version,
                    "to_version": self._keys.active_version,
                },
            )
        except Exception:  # noqa: BLE001 — a rewrap must never fail a read
            log.warning(
                "mcp.credential_rewrap_failed",
                extra={"credential_id": record.credential_id},
            )


#: Type of an awaitable vault provider, for callers that resolve it lazily.
VaultProvider = Callable[[], Awaitable[CredentialVault | None]]

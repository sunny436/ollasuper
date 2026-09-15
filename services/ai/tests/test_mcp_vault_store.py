"""The vault's rules, against an in-memory store.

Persistence is injected, so everything below is provable with no database —
which is the point: these are the rules that decide whether a leaked backup is
readable and whether one tenant can reach another's credential, and they should
not be testable only where Postgres happens to be running. The Convex-backed
port is covered separately.

THE STRUCTURAL TEST IS `test_the_store_only_ever_sees_ciphertext`. Everything
else checks behaviour; that one checks that no future implementation of the port
CAN persist a secret, because plaintext never reaches it.
"""

from __future__ import annotations

import base64
import json
import os
from datetime import UTC, datetime, timedelta

import pytest

from app.mcp.vault.aad import AadKind
from app.mcp.vault.envelope import ENVELOPE_VERSION
from app.mcp.vault.keys import KeyProvider
from app.mcp.vault.models import ClientRecord, CredentialRecord, CredentialStatus
from app.mcp.vault.store import CredentialVault, new_credential_id

TOKEN = {"access_token": "opaque-runtime-secret-abc123", "refresh_token": "r-987"}

TENANT = {
    "user_id": "user-a",
    "workspace_id": "ws-1",
    "connection_id": "conn-1",
    "server_name": "acme.test/server",
    "resource": "https://api.example.test/mcp",
}


class MemoryStore:
    """An in-memory `CredentialStorePort`. Records everything it was handed, so
    a test can assert on what actually crossed the boundary."""

    def __init__(self) -> None:
        self.rows: dict[tuple[str, str, str], CredentialRecord] = {}
        self.clients: dict[tuple[str, str], ClientRecord] = {}
        self.saw: list[str] = []  # every envelope ever passed in
        self.save_calls = 0
        self.deleted: list[str] = []
        self.marked: list[tuple[str, str]] = []
        self.fail_next_save = False

    async def load(self, *, connection_id, resource, kind, user_id, workspace_id):
        # The port carries the tenant (H-17); the real store refuses a mismatch.
        row = self.rows.get((connection_id, resource, kind))
        if row is None:
            return None
        if row.user_id != user_id or row.workspace_id != workspace_id:
            return None
        return row

    async def save(self, record, *, expected_rev):
        self.save_calls += 1
        self.saw.append(record.envelope)
        if self.fail_next_save:
            self.fail_next_save = False
            return False
        key = (record.connection_id, record.resource, str(record.kind))
        current = self.rows.get(key)
        if current is not None and current.rev != expected_rev:
            return False
        self.rows[key] = record
        return True

    async def mark(
        self, *, credential_id, status, user_id, workspace_id, connection_id
    ):
        self.marked.append((credential_id, status))
        for row in self.rows.values():
            if (
                row.credential_id == credential_id
                and row.user_id == user_id
                and row.workspace_id == workspace_id
                and row.connection_id == connection_id
            ):
                row.status = CredentialStatus(status)

    async def load_client(self, *, server_name, issuer):
        return self.clients.get((server_name, issuer))

    async def save_client(self, record):
        self.saw.append(record.envelope)
        self.clients[(record.server_name, record.issuer)] = record


def _keys(versions=(1,), active=None) -> KeyProvider:
    payload = {str(v): base64.b64encode(os.urandom(32)).decode() for v in versions}
    return KeyProvider(json.dumps(payload), active or max(versions))


def _vault(keys=None, store=None):
    store = store or MemoryStore()
    return CredentialVault(keys or _keys(), store), store


# ---------------------------------------------------------------- round trip
async def test_a_credential_round_trips_through_the_vault():
    vault, _store = _vault()
    await vault.put(TOKEN, **TENANT)
    got = await vault.get(**TENANT)
    assert got is not None
    payload, record = got
    assert payload == TOKEN
    assert record.status is CredentialStatus.ACTIVE


async def test_the_store_only_ever_sees_ciphertext():
    """THE structural test. The port never receives plaintext, so no
    implementation of it — including one nobody has written yet — can persist a
    secret by accident."""
    vault, store = _vault()
    await vault.put(TOKEN, **TENANT)
    await vault.put_client({"client_secret": "cs-abc"}, server_name="s", issuer="i")

    assert store.saw, "nothing crossed the boundary — the assertion would be vacuous"
    for envelope in store.saw:
        assert envelope.startswith(f"{ENVELOPE_VERSION}.")
        assert "access_token" not in envelope
        assert "opaque-runtime-secret-abc123" not in envelope
        assert "client_secret" not in envelope
        assert "cs-abc" not in envelope


async def test_a_missing_credential_reads_as_none_not_an_error():
    vault, _store = _vault()
    assert await vault.get(**TENANT) is None


# --------------------------------------------------------------- isolation
@pytest.mark.parametrize(
    "field", ["user_id", "workspace_id", "connection_id", "server_name", "resource"]
)
async def test_a_credential_cannot_be_read_under_a_different_binding(field):
    """A caller whose tenancy or RESOURCE differs gets nothing back.

    WHERE THIS NOW REFUSES, and why that changed: the vault compares the
    caller's five identifiers against the row's plaintext ones BEFORE
    decrypting, because AES-GCM cannot tell "wrong AAD" from "tampered
    ciphertext" and marking the latter would let a wrong caller flip somebody
    else's credential to unreadable. So this test now proves the cheap refusal.

    The AAD itself is proved separately and deliberately —
    `test_a_row_whose_identifiers_were_rewritten_still_fails_to_decrypt` below,
    and the whole binding matrix in `test_mcp_vault_crypto.py`. Without those
    this test would silently stop covering the crypto.
    """
    vault, store = _vault()
    await vault.put(TOKEN, **TENANT)

    attacker = dict(TENANT)
    attacker[field] = f"{TENANT[field]}-other"
    if field in ("connection_id", "resource"):
        # Those two are also the LOOKUP key, so point the lookup back at the
        # stored row to isolate the crypto binding rather than the index.
        row = next(iter(store.rows.values()))
        key = (
            attacker["connection_id"],
            attacker["resource"],
            str(AadKind.OAUTH_TOKEN),
        )
        store.rows[key] = row

    assert await vault.get(**attacker) is None


async def test_a_row_whose_identifiers_were_rewritten_still_fails_to_decrypt():
    """THE attack the AAD exists for: a database an attacker can WRITE to.

    They move a credential onto their own connection and rewrite the plaintext
    identifier columns to match, so the tenant precheck agrees. The ciphertext
    was sealed against the original binding, so it still will not open — even
    though every non-secret field now says it should.
    """
    vault, store = _vault()
    await vault.put(TOKEN, **TENANT)
    row = next(iter(store.rows.values()))

    attacker = dict(TENANT, user_id="attacker", connection_id="attacker-conn")
    row.user_id = attacker["user_id"]
    row.connection_id = attacker["connection_id"]
    store.rows.clear()
    key = (attacker["connection_id"], attacker["resource"], str(AadKind.OAUTH_TOKEN))
    store.rows[key] = row

    assert await vault.get(**attacker) is None
    # Reached the crypto and failed there — which is what marks it unreadable.
    assert store.marked == [(row.credential_id, str(CredentialStatus.UNREADABLE))]


async def test_a_mismatched_caller_cannot_mark_someone_elses_row_unreadable():
    """A denial-of-service lever, closed.

    Every decrypt failure used to mark the row UNREADABLE. So a caller asking
    for a connection that is not theirs would flip the OWNER's credential to
    unreadable and cost them a re-authorization — turning the AAD from a
    defence into a weapon pointed at the victim.
    """
    vault, store = _vault()
    await vault.put(TOKEN, **TENANT)

    assert await vault.get(**dict(TENANT, user_id="somebody-else")) is None
    assert store.marked == [], "a wrong caller marked the owner's row unreadable"
    # And the owner is completely unaffected.
    got = await vault.get(**TENANT)
    assert got is not None and got[0] == TOKEN


async def test_a_failed_decryption_marks_the_row_unreadable_and_keeps_it():
    """Deleting would destroy the evidence that something was tampered with, or
    that a key version was retired too early."""
    vault, store = _vault()
    await vault.put(TOKEN, **TENANT)
    row = next(iter(store.rows.values()))
    row.envelope = row.envelope[:-4] + "AAAA"  # tamper

    assert await vault.get(**TENANT) is None
    assert store.marked == [(row.credential_id, str(CredentialStatus.UNREADABLE))]
    assert store.deleted == [], "a corrupt credential must not be silently deleted"
    assert store.rows, "the row was destroyed"


async def test_a_revoked_credential_is_never_handed_out():
    vault, store = _vault()
    await vault.put(TOKEN, **TENANT)
    row = next(iter(store.rows.values()))
    row.status = CredentialStatus.REVOKED
    assert await vault.get(**TENANT) is None


async def test_an_unreadable_credential_is_not_retried_forever():
    vault, store = _vault()
    await vault.put(TOKEN, **TENANT)
    next(iter(store.rows.values())).status = CredentialStatus.UNREADABLE
    assert await vault.get(**TENANT) is None
    assert store.marked == [], "an already-unreadable row was re-marked"


# ----------------------------------------------------------- key rotation
async def test_a_row_on_an_old_key_version_is_rewrapped_on_read():
    """Lazy rotation: no bulk migration, and plaintext never leaves the process."""
    keys = _keys((1, 2), active=1)
    vault, store = _vault(keys)
    await vault.put(TOKEN, **TENANT)
    assert next(iter(store.rows.values())).key_version == 1

    rotated = CredentialVault(_rotate(keys, 2), store)
    got = await rotated.get(**TENANT)
    assert got is not None and got[0] == TOKEN
    assert next(iter(store.rows.values())).key_version == 2, "row was not rewrapped"


async def test_a_rewrap_failure_does_not_fail_the_read():
    """The caller already holds valid plaintext; the row simply stays on the old
    version and is retried next time."""
    keys = _keys((1, 2), active=1)
    vault, store = _vault(keys)
    await vault.put(TOKEN, **TENANT)

    store.fail_next_save = True
    rotated = CredentialVault(_rotate(keys, 2), store)
    got = await rotated.get(**TENANT)
    assert got is not None and got[0] == TOKEN


async def test_a_row_written_by_a_retired_key_is_unreadable_not_a_crash():
    """Retiring a key version makes rows that still name it permanently
    unreadable — which is exactly why retiring one is a deliberate step."""
    keys = _keys((1, 2), active=2)
    vault, store = _vault(keys)
    await vault.put(TOKEN, **TENANT)

    retired = CredentialVault(_keys((3,), active=3), store)
    assert await retired.get(**TENANT) is None
    assert store.marked, "the row was not flagged"


def _rotate(keys: KeyProvider, active: int) -> KeyProvider:
    """Same master material, a different active version."""
    import app.mcp.vault.keys as module

    clone = module.KeyProvider.__new__(module.KeyProvider)
    clone._masters = keys._masters  # noqa: SLF001 - constructing a sibling provider
    clone._active = active
    clone._derived = {}
    return clone


# ------------------------------------------------------------- concurrency
async def test_a_compare_and_set_loss_warns_rather_than_raising():
    """Another writer already persisted a token at least as fresh. Failing the
    caller would turn a harmless race into a user-visible error."""
    vault, store = _vault()
    await vault.put(TOKEN, **TENANT)
    store.fail_next_save = True
    record = await vault.put({"access_token": "second"}, **TENANT)
    assert record is not None


async def test_a_stale_writer_loses_the_compare_and_set():
    vault, store = _vault()
    first = await vault.put(TOKEN, **TENANT)
    await vault.put({"access_token": "newer"}, **TENANT)

    # A writer still holding the FIRST revision tries to write.
    await vault.put({"access_token": "stale"}, **TENANT, expected_rev=first.rev - 1)
    payload, _record = await vault.get(**TENANT)
    assert payload["access_token"] == "newer", "a stale writer clobbered a newer token"


async def test_the_vault_exposes_no_lock_to_be_mistaken_for_serialisation():
    """A lock nobody acquires is worse than no lock.

    The vault used to expose `lock_for()`, described as serialising refresh. It
    was never taken anywhere, so the guarantee it implied did not exist — and it
    could not be wired at this seam, because `get_tokens` and `set_tokens` are
    two separate SDK callbacks with the refresh request between them.

    What actually serialises refresh is the SDK's per-provider
    `OAuthContext.lock` (measured in `test_mcp_oauth_refresh.py`); what protects
    the cross-provider case is the compare-and-set below. This test exists so
    the helper cannot quietly return.
    """
    vault, _store = _vault()
    assert not hasattr(vault, "lock_for")


# ------------------------------------------------------------ no delete
def test_the_vault_has_no_delete_authority():
    """H-17. Secret material is purged by the control plane once the plane
    reports a disconnect; this process — and therefore the ingress key it
    holds — cannot delete a credential row. An earlier version had
    `vault.delete`; its removal is the control."""
    from app.mcp.vault.store import CredentialStorePort, CredentialVault

    assert not hasattr(CredentialVault, "delete")
    assert not hasattr(CredentialStorePort, "delete")


async def test_mark_revoked_keeps_the_row_but_stops_handing_it_out():
    vault, store = _vault()
    await vault.put(TOKEN, **TENANT)
    await vault.mark_revoked(
        user_id=TENANT["user_id"],
        workspace_id=TENANT["workspace_id"],
        connection_id=TENANT["connection_id"],
        resource=TENANT["resource"],
    )
    assert store.rows, "revocation must not delete the audit trail"
    assert await vault.get(**TENANT) is None


async def test_a_refused_write_propagates_and_is_not_a_lost_race():
    """H-04. A refresh landing after a disconnect is REFUSED by the store; the
    vault must not log it away as a benign compare-and-set loss."""
    from app.mcp.vault.models import CredentialRefused

    vault, store = _vault()

    async def refuse(record, *, expected_rev):
        raise CredentialRefused("disconnected")

    store.save = refuse  # type: ignore[method-assign]
    with pytest.raises(CredentialRefused):
        await vault.put(TOKEN, **TENANT)


# ---------------------------------------------------- deployment-scoped clients
async def test_a_client_registration_round_trips_without_a_tenant():
    vault, _store = _vault()
    await vault.put_client(
        {"client_id": "dyn-1", "client_secret": "cs-abc"},
        server_name="acme.test/server",
        issuer="https://as.test",
    )
    got = await vault.get_client(
        server_name="acme.test/server", issuer="https://as.test"
    )
    assert got == {"client_id": "dyn-1", "client_secret": "cs-abc"}


async def test_a_client_record_is_bound_to_its_server_and_issuer():
    vault, _store = _vault()
    await vault.put_client(
        {"client_id": "dyn-1"}, server_name="a/srv", issuer="https://as.test"
    )
    assert await vault.get_client(server_name="b/srv", issuer="https://as.test") is None
    assert await vault.get_client(server_name="a/srv", issuer="https://other") is None


async def test_reregistering_reuses_the_record_id():
    """A DCR client is registered once per (server, issuer) and reused by every
    user; a new id each time would mean a registration storm."""
    vault, store = _vault()
    first = await vault.put_client({"client_id": "a"}, server_name="s", issuer="i")
    second = await vault.put_client({"client_id": "b"}, server_name="s", issuer="i")
    assert first.client_record_id == second.client_record_id
    assert len(store.clients) == 1


# ------------------------------------------------------------------ bounds
async def test_an_oversized_payload_is_refused_before_encryption():
    vault, store = _vault()
    with pytest.raises(ValueError, match="ceiling"):
        await vault.put({"access_token": "x" * 40_000}, **TENANT)
    assert store.rows == {}


async def test_credential_ids_are_opaque_and_unpredictable():
    """Never derived from an email, a token or a row number: an id that encodes
    something leaks it, and a guessable one turns an authorization bug into an
    enumeration."""
    ids = {new_credential_id() for _ in range(500)}
    assert len(ids) == 500
    for value in list(ids)[:5]:
        assert value.startswith("cred_")
        assert len(value) >= 20


async def test_expiry_is_answered_without_decrypting():
    """The refresh path asks "is this expired?" on every call; making that
    require a decryption would be a needless use of the key."""
    now = datetime.now(UTC)
    record = CredentialRecord(
        credential_id="c",
        user_id="u",
        workspace_id="w",
        connection_id="n",
        server_name="s",
        resource="r",
        kind=AadKind.OAUTH_TOKEN,
        envelope="v1.1.a.b",
        key_version=1,
        expires_at=now - timedelta(seconds=1),
    )
    assert record.is_expired(now=now)
    record.expires_at = now + timedelta(hours=1)
    assert not record.is_expired(now=now)
    record.expires_at = None
    assert not record.is_expired(now=now)


def test_records_never_render_their_envelope_in_a_repr():
    record = CredentialRecord(
        credential_id="c",
        user_id="u",
        workspace_id="w",
        connection_id="n",
        server_name="s",
        resource="r",
        kind=AadKind.OAUTH_TOKEN,
        envelope="v1.1.SECRETNONCE.SECRETCIPHERTEXT",
        key_version=1,
    )
    assert "SECRETCIPHERTEXT" not in repr(record)
    client = ClientRecord(
        client_record_id="cli",
        server_name="s",
        issuer="i",
        envelope="v1.1.SECRETNONCE.SECRETCIPHERTEXT",
        key_version=1,
    )
    assert "SECRETCIPHERTEXT" not in repr(client)


async def test_a_server_response_cannot_overwrite_a_preregistered_client():
    """N-05. The client record is deployment-scoped and written from inside the
    OAuth SDK's flow — i.e. from whatever the server's authorization server
    answered. An `invalid_client` followed by a registration of the attacker's
    choosing must not replace the operator-seeded GitHub/Slack client that every
    tenant uses. Only the explicit seed path may."""
    vault, _store = _vault()
    seeded = await vault.put_client(
        {"client_id": "operator", "client_secret": "cs-operator"},
        server_name="s",
        issuer="i",
        registration_mode="preregistered",
    )
    assert seeded is not None

    refused = await vault.put_client(
        {"client_id": "attacker", "client_secret": "cs-attacker"},
        server_name="s",
        issuer="i",
        registration_mode="dcr",
    )
    assert refused is None
    assert await vault.get_client(server_name="s", issuer="i") == {
        "client_id": "operator",
        "client_secret": "cs-operator",
    }

    # The operator's own re-seed is the one path that may replace it.
    replaced = await vault.put_client(
        {"client_id": "operator-2", "client_secret": "cs-2"},
        server_name="s",
        issuer="i",
        registration_mode="preregistered",
        replace_preregistered=True,
    )
    assert replaced is not None
    got = await vault.get_client(server_name="s", issuer="i")
    assert got is not None and got["client_id"] == "operator-2"


async def test_a_dcr_record_may_still_be_re_registered():
    """Re-registration of a DCR client is legitimate (the AS forgot us); the
    refusal is scoped to operator-seeded records only."""
    vault, _store = _vault()
    await vault.put_client({"client_id": "a"}, server_name="s", issuer="i")
    again = await vault.put_client({"client_id": "b"}, server_name="s", issuer="i")
    assert again is not None
    got = await vault.get_client(server_name="s", issuer="i")
    assert got is not None and got["client_id"] == "b"


# ------------------------------------------------- audit L-01 / L-02 migration
def _legacy_v1_envelope(plaintext: bytes, *, aad_v1: bytes, key: bytes, kv: int) -> str:
    """What every row on production looked like before the change: a v1 header
    outside the tag, over the "|"-joined AAD."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()  # noqa: E731
    nonce = os.urandom(12)
    return ".".join(
        (
            "v1",
            str(kv),
            b64u(nonce),
            b64u(AESGCM(key).encrypt(nonce, plaintext, aad_v1)),
        )
    )


async def test_a_legacy_v1_row_is_still_readable_and_rewrapped_to_v2_on_read():
    """The versioned migration L-01 asked for: no bulk rewrite, no reconnects.
    A v1 row decrypts under the legacy AAD and is re-sealed as v2 in place;
    the second read is v2 all the way."""
    import dataclasses

    from app.mcp.vault.aad import build_aad
    from app.mcp.vault.envelope import ENVELOPE_VERSION

    vault, store = _vault()
    await vault.put(TOKEN, **TENANT)
    key_ref, row = next(iter(store.rows.items()))
    aad_v1 = build_aad(
        kind=AadKind.OAUTH_TOKEN,
        credential_id=row.credential_id,
        version="v1",
        **TENANT,
    )
    legacy = _legacy_v1_envelope(
        json.dumps(TOKEN, separators=(",", ":")).encode(),
        aad_v1=aad_v1,
        key=vault._keys.key_for(row.key_version),
        kv=row.key_version,
    )
    store.rows[key_ref] = dataclasses.replace(row, envelope=legacy)

    got = await vault.get(**TENANT)
    assert got is not None and got[0] == TOKEN
    assert store.rows[key_ref].envelope.startswith(f"{ENVELOPE_VERSION}."), (
        "not rewrapped"
    )
    again = await vault.get(**TENANT)
    assert again is not None and again[0] == TOKEN


async def test_a_legacy_v1_client_record_is_rewrapped_even_when_preregistered():
    """Client records migrate the same way; re-sealing the record's OWN payload
    is not a server response, so the preregistered guard does not apply."""
    import dataclasses

    from app.mcp.vault.aad import build_aad
    from app.mcp.vault.envelope import ENVELOPE_VERSION

    vault, store = _vault()
    await vault.put_client(
        {"client_id": "cid", "client_secret": "cs-abc"},
        server_name="s",
        issuer="i",
        registration_mode="preregistered",
    )
    key_ref, rec = next(iter(store.clients.items()))
    aad_v1 = build_aad(
        kind=AadKind.OAUTH_CLIENT,
        credential_id=rec.client_record_id,
        user_id=None,
        workspace_id=None,
        connection_id=None,
        server_name="s",
        resource="i",
        version="v1",
    )
    legacy = _legacy_v1_envelope(
        json.dumps(
            {"client_id": "cid", "client_secret": "cs-abc"}, separators=(",", ":")
        ).encode(),
        aad_v1=aad_v1,
        key=vault._keys.key_for(rec.key_version),
        kv=rec.key_version,
    )
    store.clients[key_ref] = dataclasses.replace(rec, envelope=legacy)

    payload = await vault.get_client(server_name="s", issuer="i")
    assert payload == {"client_id": "cid", "client_secret": "cs-abc"}
    after = store.clients[key_ref]
    assert after.envelope.startswith(f"{ENVELOPE_VERSION}.")
    assert after.registration_mode == "preregistered"

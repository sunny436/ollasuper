"""The credential envelope, its AAD, and the key provider.

PURE — no database, no network, no clock. That matters beyond speed: these are
the rules that decide whether a leaked Convex backup is readable, and they
should be provable on a machine with nothing running.

TWO PROPERTIES CARRY THE WHOLE DESIGN:

  1. Every invalid case fails CLOSED. AEAD authenticates before it returns
     anything, so a wrong key, a wrong binding or a flipped byte yields an
     exception -- never a partial plaintext.
  2. The AAD binds a ciphertext to its tenant, connection and RESOURCE. A row
     copied into another user's record cannot be decrypted **even with the
     correct key**. That is the control that still holds after authorization has
     already been bypassed.
"""

from __future__ import annotations

import base64
import json
import os

import pytest

from app.mcp.vault.aad import DEPLOYMENT_SCOPED, AadKind, build_aad
from app.mcp.vault.envelope import (
    ENVELOPE_VERSION,
    NONCE_BYTES,
    AuthenticationFailed,
    EnvelopeError,
    parse_key_version,
    seal,
    unseal,
)
from app.mcp.vault.keys import KeyProvider, VaultKeyError

PLAINTEXT = b'{"t":"oauth_token","d":{"access_token":"opaque-secret"}}'

BINDING = {
    "kind": AadKind.OAUTH_TOKEN,
    "credential_id": "cred-1",
    "user_id": "user-a",
    "workspace_id": "ws-1",
    "connection_id": "conn-1",
    "server_name": "acme.test/server",
    "resource": "https://api.example.test/mcp",
}


def _keys(versions=(1, 2)) -> KeyProvider:
    payload = {str(v): base64.b64encode(os.urandom(32)).decode() for v in versions}
    return KeyProvider(json.dumps(payload), max(versions))


# ------------------------------------------------------------------ happy path
def test_a_sealed_credential_round_trips():
    keys = _keys()
    version, key = keys.active_key()
    aad = build_aad(**BINDING)
    envelope = seal(PLAINTEXT, aad=aad, key=key, key_version=version)
    assert unseal(envelope, aad=aad, key=key, key_version=version) == PLAINTEXT


def test_the_envelope_is_version_first_and_self_describing():
    """The version must be readable before anything else is trusted."""
    keys = _keys()
    version, key = keys.active_key()
    envelope = seal(PLAINTEXT, aad=build_aad(**BINDING), key=key, key_version=version)
    assert envelope.startswith(f"{ENVELOPE_VERSION}.")
    assert envelope.split(".")[1] == str(version)
    assert parse_key_version(envelope) == version


def test_the_plaintext_never_appears_in_the_envelope():
    keys = _keys()
    version, key = keys.active_key()
    envelope = seal(PLAINTEXT, aad=build_aad(**BINDING), key=key, key_version=version)
    assert "access_token" not in envelope
    assert "opaque-secret" not in envelope


def test_the_same_plaintext_seals_differently_every_time():
    """A fresh random nonce per encryption. Nonce reuse under one key is
    AES-GCM's single catastrophic failure mode, so identical ciphertexts would
    be the loudest possible symptom of getting it wrong."""
    keys = _keys()
    version, key = keys.active_key()
    aad = build_aad(**BINDING)
    envelopes = {
        seal(PLAINTEXT, aad=aad, key=key, key_version=version) for _ in range(50)
    }
    assert len(envelopes) == 50
    assert len({e.split(".")[2] for e in envelopes}) == 50


# ------------------------------------------------------- the AAD binds tenancy
@pytest.mark.parametrize(
    "field",
    [
        "kind",
        "credential_id",
        "user_id",
        "workspace_id",
        "connection_id",
        "server_name",
        "resource",
    ],
)
def test_changing_any_binding_field_makes_decryption_fail(field):
    """THE test. Holding the correct key, a ciphertext bound to one tenant,
    connection or resource still cannot be opened as another's."""
    keys = _keys()
    version, key = keys.active_key()
    envelope = seal(PLAINTEXT, aad=build_aad(**BINDING), key=key, key_version=version)

    altered = dict(BINDING)
    altered[field] = (
        AadKind.OAUTH_CLIENT if field == "kind" else f"{BINDING[field]}-other"
    )
    with pytest.raises(AuthenticationFailed):
        unseal(envelope, aad=build_aad(**altered), key=key, key_version=version)


def test_a_client_record_cannot_be_opened_as_a_token_record():
    """They live in different tables with different owners; authenticating the
    record kind keeps that true at the crypto layer too."""
    keys = _keys()
    version, key = keys.active_key()
    shared = {
        "credential_id": "cli-1",
        "user_id": None,
        "workspace_id": None,
        "connection_id": None,
        "server_name": "acme.test/server",
        "resource": "https://api.example.test/mcp",
    }
    envelope = seal(
        b"client-info",
        aad=build_aad(kind=AadKind.OAUTH_CLIENT, **shared),
        key=key,
        key_version=version,
    )
    with pytest.raises(AuthenticationFailed):
        unseal(
            envelope,
            aad=build_aad(kind=AadKind.OAUTH_TOKEN, **shared),
            key=key,
            key_version=version,
        )


def test_a_deployment_scoped_record_uses_the_placeholder_not_an_empty_field():
    aad = build_aad(
        kind=AadKind.OAUTH_CLIENT,
        credential_id="c",
        user_id=None,
        workspace_id=None,
        connection_id=None,
        server_name="s",
        resource="r",
    )
    # v2 is length-prefixed: each absent tenant field is the 1-byte placeholder.
    marker = DEPLOYMENT_SCOPED.encode()
    assert aad.count(b"\x00\x00\x00\x01" + marker) == 3
    assert (
        build_aad(
            kind=AadKind.OAUTH_CLIENT,
            credential_id="c",
            user_id="",
            workspace_id="",
            connection_id="",
            server_name="s",
            resource="r",
        )
        == aad
    ), "an empty tenant field is the placeholder, not a zero-length field"


def test_the_separator_cannot_be_smuggled_between_fields():
    """Two different bindings must never produce the same AAD, or each could
    open the other's ciphertext."""
    common = {
        "kind": AadKind.OAUTH_TOKEN,
        "workspace_id": "w",
        "connection_id": "n",
        "server_name": "s",
        "resource": "r",
    }
    first = build_aad(credential_id="a|b", user_id="c", **common)
    second = build_aad(credential_id="a", user_id="b|c", **common)
    assert first != second


def test_the_aad_contains_no_secret():
    """AAD is authenticated, not encrypted -- it is recoverable from the row."""
    aad = build_aad(**BINDING).decode()
    assert "opaque-secret" not in aad
    assert "access_token" not in aad


# ---------------------------------------------------------------- key handling
def test_a_wrong_key_version_cannot_decrypt():
    keys = _keys((1, 2))
    aad = build_aad(**BINDING)
    envelope = seal(PLAINTEXT, aad=aad, key=keys.key_for(1), key_version=1)
    with pytest.raises(AuthenticationFailed):
        unseal(envelope, aad=aad, key=keys.key_for(2), key_version=1)


def test_each_version_derives_a_distinct_key_from_the_same_master():
    """HKDF with a per-version info label: one master, many keys, no reuse."""
    master = base64.b64encode(os.urandom(32)).decode()
    keys = KeyProvider(json.dumps({"1": master, "2": master}), 2)
    assert keys.key_for(1) != keys.key_for(2)
    assert len(keys.key_for(1)) == 32


def test_key_derivation_is_deterministic_across_processes():
    """A restart must be able to read what the previous process wrote."""
    master = base64.b64encode(os.urandom(32)).decode()
    first = KeyProvider(json.dumps({"7": master}), 7)
    second = KeyProvider(json.dumps({"7": master}), 7)
    assert first.key_for(7) == second.key_for(7)


@pytest.mark.parametrize(
    "keys_json",
    [
        "",
        "   ",
        "not json",
        "[]",
        '{"one": "AAAA"}',
        '{"1": 123}',
        '{"1": "!!!not base64!!!"}',
    ],
)
def test_malformed_key_material_fails_closed(keys_json):
    """Never a generated default: a boot-time key would encrypt credentials no
    later process could read, and a hardcoded one would be no encryption."""
    with pytest.raises(VaultKeyError):
        KeyProvider(keys_json, 1)


def test_a_short_master_key_is_refused_without_echoing_it():
    short = base64.b64encode(os.urandom(16)).decode()
    with pytest.raises(VaultKeyError) as got:
        KeyProvider(json.dumps({"1": short}), 1)
    assert "16 bytes" in str(got.value)
    assert short not in str(got.value), "the error echoed key material"


def test_an_active_version_with_no_material_is_refused():
    master = base64.b64encode(os.urandom(32)).decode()
    with pytest.raises(VaultKeyError):
        KeyProvider(json.dumps({"1": master}), 2)


def test_an_unknown_version_raises_rather_than_reading_as_tampering():
    """A missing key is a CONFIGURATION fault. Reporting it as an authentication
    failure would send an operator hunting for an attacker."""
    keys = _keys((1,))
    with pytest.raises(VaultKeyError):
        keys.key_for(99)


def test_the_key_provider_never_renders_key_material():
    keys = _keys((1, 2))
    text = repr(keys)
    assert "active=2" in text
    for version in (1, 2):
        assert keys.key_for(version).hex() not in text
        assert base64.b64encode(keys.key_for(version)).decode() not in text


# --------------------------------------------------------------- tamper matrix
def _bump(envelope: str, segment: int) -> str:
    parts = envelope.split(".")
    raw = bytearray(parts[segment].encode())
    raw[0] = ord("B") if raw[0] != ord("B") else ord("C")
    parts[segment] = raw.decode()
    return ".".join(parts)


def test_a_flipped_ciphertext_byte_fails_authentication():
    keys = _keys()
    version, key = keys.active_key()
    aad = build_aad(**BINDING)
    envelope = seal(PLAINTEXT, aad=aad, key=key, key_version=version)
    with pytest.raises((AuthenticationFailed, EnvelopeError)):
        unseal(_bump(envelope, 3), aad=aad, key=key, key_version=version)


def test_a_flipped_nonce_byte_fails_authentication():
    keys = _keys()
    version, key = keys.active_key()
    aad = build_aad(**BINDING)
    envelope = seal(PLAINTEXT, aad=aad, key=key, key_version=version)
    with pytest.raises((AuthenticationFailed, EnvelopeError)):
        unseal(_bump(envelope, 2), aad=aad, key=key, key_version=version)


def test_a_truncated_ciphertext_fails_and_returns_no_prefix():
    """AEAD authenticates before returning anything -- there is no partial
    plaintext to leak. This asserts we rely on that rather than on luck."""
    keys = _keys()
    version, key = keys.active_key()
    aad = build_aad(**BINDING)
    parts = seal(PLAINTEXT, aad=aad, key=key, key_version=version).split(".")
    parts[3] = parts[3][:-4]
    with pytest.raises((AuthenticationFailed, EnvelopeError)):
        unseal(".".join(parts), aad=aad, key=key, key_version=version)


@pytest.mark.parametrize(
    "envelope",
    [
        "",
        "v1",
        "v1.1.abc",
        "v1.1.abc.def.ghi",
        "v9.1.YWJj.ZGVm",
        "v1.notanint.YWJj.ZGVm",
        "v1.1.!!!!.ZGVm",
        "v1.1.YWJj.!!!!",
    ],
)
def test_a_malformed_envelope_is_refused_before_any_crypto(envelope):
    keys = _keys()
    _version, key = keys.active_key()
    with pytest.raises(EnvelopeError):
        unseal(envelope, aad=build_aad(**BINDING), key=key, key_version=1)


def test_an_implausibly_large_envelope_is_refused_before_any_decode():
    """Built in the test body rather than parametrized: a 70k-character test ID
    overflows the environment variable pytest uses to publish the current test,
    which fails the RUN rather than the assertion."""
    keys = _keys()
    _version, key = keys.active_key()
    with pytest.raises(EnvelopeError, match="implausibly large"):
        unseal(
            "v1.1.YWJj." + ("A" * 70_000),
            aad=build_aad(**BINDING),
            key=key,
            key_version=1,
        )


def test_an_unknown_envelope_version_is_a_format_error_not_a_tamper_error():
    """ "I cannot read this format" is a rollback/deploy problem; "this did not
    authenticate" is tampering. Collapsing them hides the first."""
    keys = _keys()
    version, key = keys.active_key()
    aad = build_aad(**BINDING)
    envelope = seal(PLAINTEXT, aad=aad, key=key, key_version=version)
    future = "v9." + envelope.split(".", 1)[1]
    with pytest.raises(EnvelopeError, match="unsupported envelope version"):
        unseal(future, aad=aad, key=key, key_version=version)


def test_the_nonce_is_the_specified_width():
    keys = _keys()
    version, key = keys.active_key()
    envelope = seal(PLAINTEXT, aad=build_aad(**BINDING), key=key, key_version=version)
    segment = envelope.split(".")[2]
    raw = base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))
    assert len(raw) == NONCE_BYTES == 12


# --------------------------------------------------- audit L-01 / L-02
def test_a_literal_and_a_percent_encoded_separator_are_distinct_bindings():
    """L-01: v1 percent-encoded "|" without encoding "%", so `a|b` and `a%7Cb`
    produced the SAME AAD. v2 is length-prefixed; the legacy builder is kept
    only to read old rows, and this pins both facts."""
    common = {k: v for k, v in BINDING.items() if k != "credential_id"}
    assert build_aad(credential_id="a|b", **common) != build_aad(
        credential_id="a%7Cb", **common
    )
    assert build_aad(credential_id="a|b", version="v1", **common) == build_aad(
        credential_id="a%7Cb", version="v1", **common
    ), "the legacy form is ambiguous — that is why it is read-only"
    with pytest.raises(ValueError):
        build_aad(version="v7", **BINDING)


def test_the_record_key_version_must_equal_the_envelope_header():
    """L-02: the column the store picks the key by and the version the envelope
    carries used to be two values that could disagree. Now they must agree,
    checked before any decrypt."""
    keys = _keys((1, 2))
    aad = build_aad(**BINDING)
    envelope = seal(PLAINTEXT, aad=aad, key=keys.key_for(1), key_version=1)
    with pytest.raises(EnvelopeError, match="names key version 1, the record names 2"):
        unseal(envelope, aad=aad, key=keys.key_for(2), key_version=2)


def test_the_envelope_header_is_under_the_tag():
    """L-02: a v1 header was editable in place. In v2 the version and key
    version are authenticated: rewriting the header to another key version —
    even holding the right key — fails authentication."""
    keys = _keys()
    version, key = keys.active_key()
    aad = build_aad(**BINDING)
    parts = seal(PLAINTEXT, aad=aad, key=key, key_version=version).split(".")
    parts[1] = str(version + 1)
    with pytest.raises(AuthenticationFailed):
        unseal(".".join(parts), aad=aad, key=key, key_version=version + 1)

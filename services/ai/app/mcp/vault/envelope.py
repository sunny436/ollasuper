"""The versioned ciphertext envelope. PURE: no I/O, no clock, no config.

    v1.<key_version>.<b64url(nonce)>.<b64url(ciphertext||tag)>

VERSION FIRST, and dotted rather than JSON, for one reason: the version must be
readable BEFORE anything else is trusted. A JSON blob has to be parsed — by a
parser, on attacker-influenced bytes — before you learn which format you are
looking at. Four dot-separated fields can be split and range-checked first.

AES-256-GCM via `cryptography`'s `AESGCM`. Nothing here is hand-rolled: no custom
mode, no manual tag handling, no home-made KDF. The nonce is 96 bits from
`os.urandom`, fresh for every encryption and never derived from a counter or from
the plaintext — GCM's one catastrophic failure mode is nonce reuse under the same
key, and random-per-message is the standard defence at this volume.

DECRYPTION FAILS CLOSED, ALWAYS. `InvalidTag` covers a wrong key, a wrong key
version, a wrong AAD, a flipped ciphertext byte, a flipped nonce byte and a
truncated ciphertext alike, and in every case the caller gets an exception rather
than partial plaintext. AEAD does not stream out a prefix before authenticating;
that is the property being relied on.
"""

from __future__ import annotations

import base64
import binascii

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

__all__ = [
    "ENVELOPE_VERSION",
    "EnvelopeError",
    "NONCE_BYTES",
    "parse_version",
    "seal",
    "unseal",
]

#: What `seal` writes. v2 (audit L-01/L-02) authenticates its own header —
#: version and key version are folded into the AAD, so neither can be edited
#: on a stored row without the tag failing — and pairs with the length-prefixed
#: AAD of `aad.py`. v1 is READ ONLY, for rows written before the change.
ENVELOPE_VERSION = "v2"
_READABLE_VERSIONS = ("v1", ENVELOPE_VERSION)
NONCE_BYTES = 12  # 96 bits — the size AES-GCM is specified for
_PARTS = 4
#: A stored envelope is our own output, so a huge one means corruption or
#: tampering, not a legitimate credential. Bounded before any decode work.
_MAX_ENVELOPE_CHARS = 64 * 1024


class EnvelopeError(ValueError):
    """The envelope is malformed, or its version is one this build cannot read.

    Deliberately DISTINCT from a decryption failure. "I do not understand this
    format" is a deployment/rollback problem; "this did not authenticate" is
    tampering or a wrong binding. Collapsing them would hide the first behind
    the second.
    """


def _b64u_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


#: base64url alphabet. Checked explicitly because `urlsafe_b64decode` SILENTLY
#: DISCARDS characters outside it — "!!!!" decodes to b"" rather than raising,
#: which then surfaces as "nonce is 0 bytes" and sends whoever is reading the
#: incident log looking for a nonce bug instead of a corrupt field.
_B64URL_CHARS = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_="
)


def _b64u_decode(text: str) -> bytes:
    if not text or not set(text) <= _B64URL_CHARS:
        raise EnvelopeError("envelope segment is not valid base64url")
    padding = "=" * (-len(text) % 4)
    try:
        return base64.urlsafe_b64decode(text + padding)
    except (binascii.Error, ValueError) as exc:
        raise EnvelopeError("envelope segment is not valid base64url") from exc


def seal(plaintext: bytes, *, aad: bytes, key: bytes, key_version: int) -> str:
    """Encrypt `plaintext` into an envelope string.

    `aad` is authenticated but NOT encrypted: it is recoverable from the stored
    row, which is exactly why no secret may go into it (see `aad.py`).
    """
    if not isinstance(plaintext, bytes):
        raise EnvelopeError("plaintext must be bytes")
    if key_version < 0:
        raise EnvelopeError("key_version must be non-negative")
    nonce = _random_nonce()
    ciphertext = AESGCM(key).encrypt(
        nonce, plaintext, _bind_header(aad, ENVELOPE_VERSION, key_version)
    )
    return ".".join(
        (
            ENVELOPE_VERSION,
            str(key_version),
            _b64u_encode(nonce),
            _b64u_encode(ciphertext),
        )
    )


def _bind_header(aad: bytes, version: str, key_version: int) -> bytes:
    """v2: the header travels under the tag. A v1 envelope authenticated only
    the caller's AAD, so its version and key version were editable in place."""
    if version == "v1":
        return aad
    return aad + b"\x00" + f"{version}.{key_version}".encode("ascii")


def parse_version(envelope: str) -> str:
    """The envelope version WITHOUT decrypting — it selects the AAD encoding
    (`aad.build_aad(version=...)`) and tells `store.py` whether to re-wrap."""
    return _split(envelope)[0]


def parse_key_version(envelope: str) -> int:
    """Read the key version WITHOUT decrypting.

    Needed by the lazy-rotation path in `store.py`, which must know which key a
    row was written with before it can decide whether to re-wrap it — and by the
    status endpoint, which reports which versions are still in use so an
    operator knows when a key is safe to retire.
    """
    return _split(envelope)[1]


def unseal(envelope: str, *, aad: bytes, key: bytes, key_version: int) -> bytes:
    """Decrypt an envelope, or raise.

    `key_version` is the record's own column — the value the caller chose
    `key` by. It MUST equal the version embedded in the envelope (audit L-02):
    two values that can disagree are two values that will, and a row whose
    column and header name different keys is refused before any decrypt.

    Raises `EnvelopeError` for a shape/version problem and `InvalidTag` for an
    authentication failure. The caller distinguishes them: the first is a
    configuration or rollback fault, the second means the ciphertext does not
    belong to this key and this binding.
    """
    version, embedded_key_version, nonce, ciphertext = _split(envelope)
    if embedded_key_version != key_version:
        raise EnvelopeError(
            f"envelope names key version {embedded_key_version}, the record "
            f"names {key_version}"
        )
    if len(nonce) != NONCE_BYTES:
        raise EnvelopeError(f"nonce is {len(nonce)} bytes, expected {NONCE_BYTES}")
    # Deliberately NOT wrapped: `InvalidTag` propagates so the caller can tell
    # "did not authenticate" from "could not be parsed".
    return AESGCM(key).decrypt(
        nonce, ciphertext, _bind_header(aad, version, embedded_key_version)
    )


def _split(envelope: str) -> tuple[str, int, bytes, bytes]:
    if not isinstance(envelope, str) or not envelope:
        raise EnvelopeError("envelope is empty")
    if len(envelope) > _MAX_ENVELOPE_CHARS:
        raise EnvelopeError("envelope is implausibly large")
    parts = envelope.split(".")
    if len(parts) != _PARTS:
        raise EnvelopeError(f"envelope has {len(parts)} segments, expected {_PARTS}")
    version, key_version, nonce_b64, ciphertext_b64 = parts
    # The version gate comes FIRST, before any decode of attacker-influenced
    # bytes. An unknown version is refused, never guessed at.
    if version not in _READABLE_VERSIONS:
        raise EnvelopeError(
            f"unsupported envelope version {version!r}; this build reads "
            f"{_READABLE_VERSIONS!r}"
        )
    try:
        parsed_key_version = int(key_version)
    except (TypeError, ValueError) as exc:
        raise EnvelopeError("envelope key version is not an integer") from exc
    return (
        version,
        parsed_key_version,
        _b64u_decode(nonce_b64),
        _b64u_decode(ciphertext_b64),
    )


def _random_nonce() -> bytes:
    import os  # noqa: PLC0415 — kept local so the module's import surface stays tiny

    return os.urandom(NONCE_BYTES)


# Re-exported so callers catch one name without importing from `cryptography`.
AuthenticationFailed = InvalidTag

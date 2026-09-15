"""The Associated Authenticated Data for a credential envelope. PURE.

ONE DEFINITION, deliberately in its own module. AAD has the property that
encrypt and decrypt must agree byte-for-byte or decryption fails — which is
exactly the guarantee we want, and exactly the thing that silently breaks if two
call sites build the string slightly differently. There is one builder and both
paths use it.

WHAT IT BUYS. The AAD binds a ciphertext to the tenancy and audience it was
created for, so a row copied into another user's record, another connection, or
another MCP server's resource **fails to decrypt even with the correct key**.
That is a second, independent control behind Convex's owner checks: authorization
stops the read, and this stops the read being useful.

WHAT IT MUST NOT CONTAIN: a secret. AAD is authenticated, not encrypted — it is
recoverable from the stored row. Every field here is already stored in plaintext
columns beside the envelope.

ENCODING (audit L-01). v2 is LENGTH-PREFIXED: each field is its UTF-8 bytes
preceded by a 4-byte big-endian length, so no two field tuples can share an
encoding — by construction, not by escaping. v1 joined fields with "|" and
percent-encoded the separator without encoding "%", so ("a|b") and ("a%7Cb")
collided; it is kept ONLY to read envelopes written before the change, which
`store.py` re-wraps to v2 on first read. The AAD version is the envelope
version (`envelope.py`), so a reader never has to guess which one applies.
"""

from __future__ import annotations

import struct
from enum import StrEnum

__all__ = ["AadKind", "build_aad", "DEPLOYMENT_SCOPED", "LEGACY_AAD_VERSION"]

#: Envelope versions this builder knows. "v2" is what is written; "v1" is read.
LEGACY_AAD_VERSION = "v1"
_AAD_VERSION = "v2"
_AAD_LABEL_V1 = "ollasuper-mcp-cred/v1"
_AAD_LABEL_V2 = b"ollasuper-mcp-cred/v2"

_SEP = "|"
_ESCAPED_SEP = "%7C"

#: Placeholder for the tenant fields of a record that has no tenant. A DCR client
#: registration belongs to the deployment, not to a user, so it cannot carry a
#: user id — and must not be openable as if it did.
DEPLOYMENT_SCOPED = "-"


class AadKind(StrEnum):
    """The record kind, authenticated so one kind's ciphertext can never open as
    another's. A client registration and an access token live in different
    tables with different owners; binding the kind makes that structural."""

    # noqa S105 throughout: these are record-KIND labels that get authenticated
    # into the AAD, not credentials. The linter cannot tell the difference
    # between a field named `oauth_token` and a value that IS one.
    OAUTH_TOKEN = "oauth_token"  # noqa: S105
    OAUTH_CLIENT = "oauth_client"  # noqa: S105
    API_KEY = "api_key"  # noqa: S105
    BEARER = "bearer"  # noqa: S105


def _field(value: str | None) -> str:
    if value is None or value == "":
        return DEPLOYMENT_SCOPED
    return str(value)


def _legacy_field(value: str | None) -> str:
    return _field(value).replace(_SEP, _ESCAPED_SEP)


def build_aad(
    *,
    kind: AadKind | str,
    credential_id: str,
    user_id: str | None,
    workspace_id: str | None,
    connection_id: str | None,
    server_name: str,
    resource: str,
    version: str = _AAD_VERSION,
) -> bytes:
    """The canonical AAD for one credential record.

    Keyword-only on purpose: seven positional strings of the same type is how
    two of them end up swapped, and a swapped AAD does not fail loudly at the
    call site — it fails much later, as an undecryptable credential.

    `version` is the ENVELOPE version the AAD is for: "v2" (written) or "v1"
    (legacy read only). Anything else is refused, never guessed.
    """
    fields = (
        str(kind),
        credential_id,
        user_id,
        workspace_id,
        connection_id,
        server_name,
        resource,
    )
    if version == LEGACY_AAD_VERSION:
        return _SEP.join((_AAD_LABEL_V1, *(_legacy_field(f) for f in fields))).encode(
            "utf-8"
        )
    if version != _AAD_VERSION:
        raise ValueError(f"unknown AAD version {version!r}")
    out = bytearray(_AAD_LABEL_V2)
    for f in fields:
        raw = _field(f).encode("utf-8")
        out += struct.pack(">I", len(raw)) + raw
    return bytes(out)

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

SEPARATOR SAFETY. Fields are joined with "|". Without escaping, ("a|b", "c") and
("a", "b|c") produce the same AAD, so two different bindings could open each
other's ciphertext. Each field therefore has its separator percent-encoded before
joining — a theoretical hole, closed for the cost of one `str.replace`.
"""

from __future__ import annotations

from enum import StrEnum

__all__ = ["AadKind", "build_aad", "DEPLOYMENT_SCOPED"]

#: Bumping this invalidates every existing ciphertext, so it changes only when
#: the BINDING changes — not when an unrelated field is added to the row.
_AAD_VERSION = "ollasuper-mcp-cred/v1"

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
    return str(value).replace(_SEP, _ESCAPED_SEP)


def build_aad(
    *,
    kind: AadKind | str,
    credential_id: str,
    user_id: str | None,
    workspace_id: str | None,
    connection_id: str | None,
    server_name: str,
    resource: str,
) -> bytes:
    """The canonical AAD for one credential record.

    Keyword-only on purpose: seven positional strings of the same type is how
    two of them end up swapped, and a swapped AAD does not fail loudly at the
    call site — it fails much later, as an undecryptable credential.
    """
    return _SEP.join(
        (
            _AAD_VERSION,
            _field(str(kind)),
            _field(credential_id),
            _field(user_id),
            _field(workspace_id),
            _field(connection_id),
            _field(server_name),
            _field(resource),
        )
    ).encode("utf-8")

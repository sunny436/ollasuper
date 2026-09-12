"""Can Phase 3 connect to this catalogue entry AT ALL? Decided before dialling.

PURE. No network, no database, no clock — it reads a catalogue row and answers.
That matters for more than testability: the brief requires that a stdio-only or
packages-only server be refused WITHOUT a connection attempt, and the only way
to guarantee that is for the decision to happen somewhere that cannot connect.

THE MEASURED SHAPE OF THE PROBLEM. A full registry sync counted 100,198 version
records: stdio 68,019 · streamable-http 41,155 · sse 2,631 (a record can declare
several). So the majority of the ecosystem is local-only, and "no usable remote"
is the COMMON case, not an edge case. It gets a real state (`UNSUPPORTED`) and a
real explanation rather than a connection error.

DETERMINISTIC ENDPOINT SELECTION (§67). A version may declare several remotes.
Picking "the first one" is only deterministic if the ordering is; picking by
preference is deterministic regardless of how the registry ordered them. So:
Streamable HTTP beats SSE (it is the current transport and SSE is the legacy
one), and ties break on the registry's own order. Never random, never "whichever
responded first" — a connection that silently changes endpoint between attempts
is unexplainable.

AUTH IS READ, NEVER GUESSED. Phase 2's parser deliberately records "unknown"
rather than inferring, and this honours that: `unknown` is NOT optimistically
treated as `none`, because attempting an unauthenticated connection to a server
that needs credentials is how you get a confusing 401 instead of a clear "you
need to connect your account".
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

__all__ = ["Compatibility", "assess", "select_remote"]

#: Most-preferred first. Also the tie-break order for `select_remote`.
_TRANSPORT_PREFERENCE = ("streamable-http", "sse")

#: Registry spellings seen in the wild for the same two transports. A record
#: written before the rename must not read as "no usable remote".
_TRANSPORT_ALIASES = {
    "streamable-http": "streamable-http",
    "streamable_http": "streamable-http",
    "streamablehttp": "streamable-http",
    "http": "streamable-http",
    "sse": "sse",
}

#: Auth kinds Phase 3 can actually satisfy today. `oauth` is Phase 4's; `unknown`
#: is refused rather than attempted (see the module docstring).
_SATISFIABLE_WITHOUT_PHASE_4 = frozenset({"none"})


@dataclass(frozen=True)
class Compatibility:
    """The verdict. `ok` is the ONLY value that permits a connection attempt."""

    ok: bool
    reason: str = ""
    transport: str = ""
    endpoint_url: str = ""
    auth_kind: str = "unknown"
    #: True when the only thing missing is a credential Phase 4 will supply.
    #: Distinct from `ok=False` for an unsupported server: one is "connect your
    #: account", the other is "this will never work here".
    auth_required: bool = False


def _normalize_transport(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return _TRANSPORT_ALIASES.get(value.strip().lower().replace(" ", ""))


def select_remote(remotes: Any) -> tuple[str, str] | None:
    """Deterministically choose `(transport, url)` from a version's `remotes`.

    Returns None when nothing usable is declared. Entries that are malformed, or
    that name a transport Phase 3 does not speak, are skipped individually — one
    bad entry must not hide a good one alongside it.
    """
    if not isinstance(remotes, list):
        return None
    candidates: list[tuple[int, int, str, str]] = []
    for order, entry in enumerate(remotes):
        if not isinstance(entry, dict):
            continue
        transport = _normalize_transport(entry.get("type"))
        url = entry.get("url")
        if transport is None or not isinstance(url, str) or not url.strip():
            continue
        candidates.append(
            (_TRANSPORT_PREFERENCE.index(transport), order, transport, url.strip())
        )
    if not candidates:
        return None
    # Preference first, then the registry's own order. Total and stable.
    _, _, transport, url = min(candidates)
    return transport, url


def assess(
    version_row: Any,
    *,
    credentials_available: bool = False,
) -> Compatibility:
    """Verdict for one `mcp_server_versions` row (or an equivalent mapping).

    `credentials_available` is what the caller knows and this module cannot:
    whether a resolver can actually supply material for this connection. It
    turns an `auth_required` refusal into a permitted attempt.
    """
    row = version_row if isinstance(version_row, dict) else {}
    auth_kind = str(row.get("auth_kind") or "unknown").strip().lower()

    chosen = select_remote(row.get("remotes"))
    if chosen is None:
        packages = row.get("packages")
        if isinstance(packages, list) and packages:
            # The single most common case in the catalogue. Phase 3 must not
            # install or execute it, and saying so plainly beats a timeout.
            return Compatibility(
                ok=False,
                reason=(
                    "this server is distributed as a package to run locally and "
                    "declares no remote endpoint; local execution is not "
                    "supported"
                ),
                auth_kind=auth_kind,
            )
        return Compatibility(
            ok=False,
            reason="this server declares no remote endpoint",
            auth_kind=auth_kind,
        )

    transport, url = chosen

    if auth_kind not in _SATISFIABLE_WITHOUT_PHASE_4 and not credentials_available:
        return Compatibility(
            ok=False,
            reason=(
                f"this server requires {auth_kind} authentication and no "
                "credential is available for this connection"
            ),
            transport=transport,
            endpoint_url=url,
            auth_kind=auth_kind,
            auth_required=True,
        )

    return Compatibility(
        ok=True, transport=transport, endpoint_url=url, auth_kind=auth_kind
    )

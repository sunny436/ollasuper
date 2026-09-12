"""Is this URL safe to dial? Runs BEFORE any transport is constructed.

REUSES OllaSuper's SSRF guard; does not reimplement it. `app/ssrf.py` already
resolves DNS and rejects loopback, RFC1918, link-local, CGNAT, multicast,
reserved and cloud-metadata addresses in v4 and v6, plus credentials-in-URL and
non-standard ports. Writing a second one would mean two guards to keep correct.

WHAT THIS ADDS ON TOP, and why each is Phase-3 policy rather than SSRF:

  * HTTPS IS REQUIRED. `assert_public_url` permits http:// to a public host,
    which is right for its original caller (a URL handed to an external
    fetcher). Here the request carries a bearer token in a header, so plaintext
    would put a user's credential on the wire.
  * A CREDENTIAL IN THE URL IS REJECTED TWICE. ssrf.py rejects `user:pass@`;
    this also rejects a query string that looks like a token, because some MCP
    servers publish `?key=` endpoints and such a URL ends up in logs, in the
    catalogue, and in an error detail.

BLOCKING DNS RUNS OFF THE EVENT LOOP. `assert_public_url` calls
`socket.getaddrinfo`, which blocks; `assert_payload_urls_safe` in the same
module already uses `asyncio.to_thread` for exactly this reason.

HONEST RESIDUAL — DNS REBINDING. Validation happens before the connection and
the socket cannot be pinned to the address that was validated, so a TOCTOU
window exists. What shrinks it here to near-theoretical is CURATION: the
endpoint comes from an operator-approved row, not from a model, a user, or
registry metadata we never reviewed. The attack needs authoritative DNS for a
hostname an operator deliberately chose. Stated rather than hidden.
"""

from __future__ import annotations

import asyncio
import re
from urllib.parse import parse_qsl, urlsplit

from app.mcp.exceptions import McpConnectionError, McpErrorKind
from app.ssrf import SsrfError, assert_public_url

__all__ = ["assert_dialable", "assert_dialable_sync"]

# Query keys that carry a secret often enough to refuse the endpoint outright.
_SECRET_QUERY_KEYS = re.compile(
    r"^(api[-_]?key|key|token|access[-_]?token|secret|password|pwd|auth)$",
    re.IGNORECASE,
)

# Anything address-shaped. Backslash-free by construction ([.] for a dot,
# [0-9] for a digit) so no escape can be mangled in transit. The v6 branch is
# tried FIRST and swallows a trailing dotted quad, because '::ffff:127.0.0.1'
# otherwise redacts as "<redacted>.0.0.1" and leaks the half that matters.
# Deliberately broad: over-redacting a refusal reason costs a little clarity,
# under-redacting one discloses an internal host.
_IP_LITERAL = re.compile(
    "[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}(?:[.][0-9]{1,3}){0,3}"
    "|[0-9]{1,3}(?:[.][0-9]{1,3}){3}"
)


def assert_dialable_sync(url: str) -> None:
    """Raise `McpConnectionError(ENDPOINT_REJECTED)` unless `url` is safe.

    Synchronous, and it does DNS. Callers on the event loop use
    `assert_dialable`.
    """
    if not isinstance(url, str) or not url.strip():
        raise _rejected("endpoint url is empty")
    raw = url.strip()

    parts = urlsplit(raw)
    scheme = (parts.scheme or "").lower()
    if scheme != "https":
        # http:// is refused even to a public host: the Authorization header
        # rides this request.
        raise _rejected(
            f"endpoint scheme must be https, got {scheme or 'none'!r}"
        )

    for key, _value in parse_qsl(parts.query, keep_blank_values=True):
        if _SECRET_QUERY_KEYS.match(key.strip()):
            raise _rejected(
                f"endpoint carries a credential-shaped query parameter "
                f"({key!r}); credentials belong in a header, not a URL"
            )

    try:
        # Everything else -- scheme allowlist, userinfo, port allowlist, DNS
        # resolution and the whole private-address matrix -- is ssrf.py's.
        assert_public_url(raw)
    except SsrfError as exc:
        raise _rejected(
            f"endpoint refused by the SSRF policy: {_redact_addresses(str(exc))}"
        ) from exc


async def assert_dialable(url: str) -> None:
    """Async wrapper. The DNS lookup runs off the event loop."""
    await asyncio.to_thread(assert_dialable_sync, url)


def _rejected(detail: str) -> McpConnectionError:
    return McpConnectionError(McpErrorKind.ENDPOINT_REJECTED, detail)


def _redact_addresses(message: str) -> str:
    """Strip IP literals out of a refusal reason.

    `assert_public_url` says "url resolves to a blocked address: 10.0.0.5". That
    sentence is exactly an internal-network oracle: point this at
    `internal.corp.example` and the refusal tells you what it resolves to. The
    RULE that fired is useful and is kept; the address is not ours to disclose.

    Redaction is applied to the whole message rather than to one known sentence,
    so a future ssrf.py message cannot reintroduce the leak silently.
    """
    return _IP_LITERAL.sub("<redacted>", message)

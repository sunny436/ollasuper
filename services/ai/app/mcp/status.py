"""Recover the HTTP status the MCP SDK throws away.

THE PROBLEM, MEASURED. A real 401 from a remote MCP server reaches us as:

    ExceptionGroup(ExceptionGroup(MCPError(code=-32603,
                   message='Server returned an error response', data=None)))

`-32603` is JSON-RPC "internal error" — the SDK's catch-all. `data` is None and
there is no `__cause__`. Probed against 401, 403, 429, 500 and 503: every one
produces that identical exception. So from the exception alone a rejected
credential, a rate limit and a transient outage are INDISTINGUISHABLE, and
Phase 3's brief (§42: "do not hide failures behind a generic MCP error") cannot
be satisfied. Phase 1's `errors.py` substring-matches "401" / "rate limit"
against a message that never contains them, so all five land in one bucket.

THE FIX. The status still exists one layer down, in httpx2. A `response` event
hook sees every response, including the failing one, before the SDK erases it.
This records the last error response's status plus the two headers that make a
failure ACTIONABLE rather than merely reported:

  * `Retry-After`      -> a rate limit we should wait out rather than hammer
  * `WWW-Authenticate` -> `error="invalid_token"` separates AUTH_FAILED (the
                          credential was rejected) from AUTH_REQUIRED (none was
                          presented), which are different user actions.

ONE RECORDER PER SESSION, never shared. Two tenants share no httpx client (see
`app/mcp/transport.py`), so a 401 is always attributable to the connection that
earned it. A process-wide recorder would report one tenant's 401 against
another's call.

NO BODY IS EVER READ. A hook that touched `response.text` would consume the
stream the SDK is about to parse, and would pull a hostile server's payload into
our logs. Status and two headers only.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

__all__ = ["StatusRecorder"]

# Bounded: `WWW-Authenticate` is attacker-controlled text that ends up in an
# error detail a user reads.
_MAX_HEADER_CHARS = 200


@dataclass
class StatusRecorder:
    """Last failing HTTP response seen on ONE session's client."""

    status: int | None = None
    retry_after: float | None = None
    www_authenticate: str | None = None
    #: True once any response has been seen at all. Distinguishes "the server
    #: answered with an error" from "we never reached the server", which is the
    #: difference between UNREACHABLE and SERVER_ERROR.
    saw_response: bool = False

    async def __call__(self, response: Any) -> None:
        """httpx2 `response` event hook. Never raises: a fault here would
        surface as a transport failure and mask the real error."""
        try:
            self.saw_response = True
            status = int(getattr(response, "status_code", 0) or 0)
            if status < 400:
                return
            self.status = status
            headers = getattr(response, "headers", None)
            get = getattr(headers, "get", None)
            if get is None:
                return
            self.retry_after = _parse_retry_after(get("retry-after"))
            auth = get("www-authenticate")
            self.www_authenticate = (
                str(auth)[:_MAX_HEADER_CHARS] if auth else None
            )
        except Exception:  # noqa: BLE001 — diagnostics must never break transport
            return

    def reset(self) -> None:
        """Clear before an operation so a stale 401 cannot be blamed on the
        next, unrelated call on the same session."""
        self.status = None
        self.retry_after = None
        self.www_authenticate = None
        self.saw_response = False

    @property
    def credential_was_rejected(self) -> bool:
        """A 401/403 the server explicitly attributes to the token we sent.

        `invalid_token` is the RFC 6750 spelling. Absent it, a 403 may equally
        mean "this account lacks that scope" — still a user action, but a
        different one, so the distinction is preserved rather than flattened.
        """
        auth = (self.www_authenticate or "").lower()
        return "invalid_token" in auth or "invalid_grant" in auth


def _parse_retry_after(value: Any) -> float | None:
    """Seconds form only. The HTTP-date form is legal but rare, and guessing a
    delay from a clock we do not share with the server is worse than not
    waiting — the caller's bounded backoff still applies."""
    if value is None:
        return None
    try:
        seconds = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    if seconds < 0:
        return None
    # A server does not get to park a worker for an hour.
    return min(seconds, 120.0)

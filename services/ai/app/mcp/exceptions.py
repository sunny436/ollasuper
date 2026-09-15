"""Connection-lifecycle failures — ONE class, ONE enum.

NOT a parallel error system. Tool EXECUTION keeps using `ToolError` /
`ToolErrorKind` (app/tools/errors.py) because the executor's retry and backoff
key off `retryable` there, and teaching `_run_one` a second vocabulary would buy
nothing. What this file covers is the other half: connect / initialize /
discover / refresh, which never reach the executor at all — they answer an API
route, and a user reads the result.

The brief lists eleven candidate exception classes. Eleven classes is eleven
`except` clauses and one import block per call site, for a distinction that is
already carried perfectly well by an enum member. One class, one enum.

WHY KINDS ARE ASSIGNED FROM `StatusRecorder`, NOT FROM EXCEPTION TEXT: the SDK
collapses every HTTP failure into `MCPError(-32603, 'Server returned an error
response')`, so the text cannot distinguish a rejected credential from a rate
limit. See `app/mcp/status.py`.
"""

from __future__ import annotations

from enum import StrEnum

__all__ = ["McpConnectionError", "McpErrorKind"]


class McpErrorKind(StrEnum):
    # --- refused before a single packet leaves ---------------------------
    UNSUPPORTED_TRANSPORT = "unsupported_transport"
    ENDPOINT_REJECTED = "endpoint_rejected"
    # --- reaching the server ----------------------------------------------
    DNS_FAILED = "dns_failed"
    TLS_FAILED = "tls_failed"
    UNREACHABLE = "unreachable"
    TIMEOUT = "timeout"
    # --- the server answered ----------------------------------------------
    AUTH_REQUIRED = "auth_required"
    AUTH_FAILED = "auth_failed"
    RATE_LIMITED = "rate_limited"
    SERVER_ERROR = "server_error"
    SESSION_EXPIRED = "session_expired"
    # --- the server answered wrongly --------------------------------------
    PROTOCOL_MISMATCH = "protocol_mismatch"
    MALFORMED_INITIALIZE = "malformed_initialize"
    CAPABILITY_ERROR = "capability_error"
    # The response was cut at the transport for exceeding a byte cap, or was
    # compressed (refused: a compressed body's decoded size is unknowable in
    # advance). Not retryable — the same request would be cut again.
    RESPONSE_TOO_LARGE = "response_too_large"


#: Kinds a bounded retry can plausibly fix. Everything else needs a human: a
#: different credential, a different server, or a fixed endpoint.
_RETRYABLE = frozenset(
    {
        McpErrorKind.DNS_FAILED,
        McpErrorKind.UNREACHABLE,
        McpErrorKind.TIMEOUT,
        McpErrorKind.RATE_LIMITED,
        McpErrorKind.SERVER_ERROR,
        McpErrorKind.SESSION_EXPIRED,
    }
)

#: Kinds that must SUPPRESS automatic reconnection entirely (brief §35: "do not
#: reconnect using credentials that are no longer authorized"). Retrying a
#: rejected credential against a third party is indistinguishable from
#: credential stuffing, and it is how an account gets locked.
_NO_RECONNECT = frozenset(
    {
        McpErrorKind.AUTH_REQUIRED,
        McpErrorKind.AUTH_FAILED,
        McpErrorKind.UNSUPPORTED_TRANSPORT,
        McpErrorKind.ENDPOINT_REJECTED,
        McpErrorKind.PROTOCOL_MISMATCH,
    }
)

#: `detail` is built from a remote server's exception text. Bounded, and control
#: characters are stripped, because it is logged and rendered.
_MAX_DETAIL = 400


def _clean(text: str) -> str:
    return "".join(c for c in text if c == "\n" or c >= " ")[:_MAX_DETAIL]


class McpConnectionError(RuntimeError):
    """One connection-lifecycle failure, classified."""

    def __init__(
        self,
        kind: McpErrorKind,
        detail: str,
        *,
        server_slug: str = "",
        status: int | None = None,
        retry_after_s: float | None = None,
        retryable: bool | None = None,
    ) -> None:
        message = _clean(detail)
        super().__init__(f"[{server_slug}] {message}" if server_slug else message)
        self.kind = kind
        self.detail = message
        self.server_slug = server_slug
        self.status = status
        self.retry_after_s = retry_after_s
        self.retryable = retryable if retryable is not None else kind in _RETRYABLE

    @property
    def reconnect_allowed(self) -> bool:
        return self.kind not in _NO_RECONNECT

    @property
    def user_action_required(self) -> bool:
        """Whether a human has to do something — the signal Phase 7's UI needs
        to decide between "retrying..." and "reconnect your account"."""
        return self.kind in (McpErrorKind.AUTH_REQUIRED, McpErrorKind.AUTH_FAILED)

    def as_dict(self) -> dict:
        """Safe, user-facing shape. Carries NO header value, NO payload, and no
        resolved IP — an SSRF rejection that named the address it resolved to
        would turn the error into an internal-network oracle."""
        out: dict = {
            "kind": str(self.kind),
            "detail": self.detail,
            "retryable": self.retryable,
            "user_action_required": self.user_action_required,
        }
        if self.status is not None:
            out["status"] = self.status
        if self.retry_after_s is not None:
            out["retry_after_s"] = self.retry_after_s
        return out

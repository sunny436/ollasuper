"""Normalized internal tool-error model.

Mirrors the codebase convention (small RuntimeError subclasses, cf.
clients/convex.py's ConvexUnavailable/ConvexRejected) rather than inventing a
framework. Raw provider exceptions are mapped to a `ToolError` with a stable
`kind`; the raw text is never surfaced to users.
"""

from __future__ import annotations

from enum import StrEnum


class ToolErrorKind(StrEnum):
    AUTH_FAILED = "auth_failed"
    INVALID_TOOL = "invalid_tool"
    INVALID_INPUT = "invalid_input"
    SCHEMA_VALIDATION = "schema_validation"
    TIMEOUT = "timeout"
    RATE_LIMITED = "rate_limited"
    UPSTREAM_ERROR = "upstream_error"
    UNAVAILABLE = "unavailable"
    MALFORMED_RESPONSE = "malformed_response"


class ToolError(RuntimeError):
    """A normalized tool failure. `retryable` lets a future caller decide
    whether to back off (rate_limited/timeout/upstream) or give up
    (auth/invalid_tool/invalid_input/schema)."""

    def __init__(
        self,
        kind: ToolErrorKind,
        message: str,
        *,
        tool_id: str | None = None,
        status: int | None = None,
        retryable: bool | None = None,
        retry_after_s: float | None = None,
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.tool_id = tool_id
        self.status = status
        # The provider's OWN backoff instruction (RFC 9110 `Retry-After`). A
        # rate-limited caller that ignores this and retries on its own short
        # exponential just spends its remaining attempts inside the same window
        # — every one of them failing. None when the provider did not say.
        self.retry_after_s = retry_after_s
        self.retryable = (
            retryable
            if retryable is not None
            else kind
            in (
                ToolErrorKind.TIMEOUT,
                ToolErrorKind.RATE_LIMITED,
                ToolErrorKind.UPSTREAM_ERROR,
                ToolErrorKind.UNAVAILABLE,
            )
        )

    def as_dict(self) -> dict:
        """Safe, user-facing shape. Never includes provider text/credentials."""
        out = {
            "kind": str(self.kind),
            # Bounded: the message can carry a third party's text (an MCP
            # server's error string), which is the model's to read but not the
            # server's to fill without limit.
            "message": (self.message or "")[:512],
            "tool_id": self.tool_id,
            "retryable": self.retryable,
        }
        # Only present when the provider actually sent one, so every other error
        # payload keeps its existing shape.
        if self.retry_after_s is not None:
            out["retry_after_s"] = self.retry_after_s
        return out

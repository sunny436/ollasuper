"""MCP/protocol failure -> a CLASSIFIED error, for both halves of the system.

Two mappers, because MCP fails in two different places:

  `to_tool_error`       -> `ToolError` for a tool CALL. Feeds the executor's
                           existing retry/backoff, so it must speak the existing
                           `ToolErrorKind` vocabulary and nothing else.
  `to_connection_error` -> `McpConnectionError` for connect / initialize /
                           discover. Never reaches the executor; answers a route.

No MCP-specific error hierarchy is introduced for tool calls: `ToolErrorKind`
already names every failure mode, and `_run_one` keys off `retryable`.

TWO THINGS THIS FILE EXISTS TO GET RIGHT, both found by running a real remote
server rather than by reading the SDK:

1. THE EXCEPTION IS A DOUBLY-NESTED ExceptionGroup. The SDK runs its transport
   inside anyio task groups, so a 401 arrives as
   `ExceptionGroup(ExceptionGroup(MCPError(...)))`. An `isinstance` chain against
   the outer object matches nothing, and every remote failure lands in the
   unclassified bucket. Hence `leaves()`.

2. UNWRAPPING ALONE MAKES IT WORSE. The leaf is
   `MCPError(-32603, 'Server returned an error response')` for 401, 403, 429,
   500 AND 503 alike -- measured, all five identical. Phase 1 matched substrings
   ("401", "rate limit") that are never present, so it returned
   UPSTREAM_ERROR/retryable=False; unwrap it and the generic MCPError branch
   makes that same 401 RETRYABLE, so we would retry a rejected credential
   against a third party. The status must therefore come from the transport
   layer (`StatusRecorder`), and it is consulted BEFORE the leaf type.

THE DISTINCTION THAT MATTERS, and is easy to get backwards:

    is_error=True on a CallToolResult is NOT a failure to raise.

The spec says tool-originated errors "SHOULD be reported inside the result with
`is_error` set to true... so the LLM can see and self-correct". Verified against
a live HTTP session: an unknown tool name returns a result and raises nothing.
So `is_error` is handled in `adapter.py` as a RESULT; only the failures below
raise.
"""

from __future__ import annotations

import socket
import ssl

from app.mcp.exceptions import McpConnectionError, McpErrorKind
from app.mcp.status import StatusRecorder
from app.tools.errors import ToolError, ToolErrorKind

__all__ = ["leaves", "to_connection_error", "to_tool_error"]

# Retained as a LAST resort only. Some servers do put a status into a JSON-RPC
# error message; when the transport recorded nothing, this beats nothing. It is
# never consulted before the recorder.
_AUTH_HINTS = ("401", "403", "unauthorized", "forbidden", "invalid_token")
_RATE_HINTS = ("429", "rate limit", "too many requests")
_MAX_LEAVES = 16
_MAX_DETAIL = 400


def leaves(exc: BaseException, _depth: int = 0) -> list[BaseException]:
    """Flatten nested `ExceptionGroup`s to the real exceptions underneath.

    Bounded on both depth and count: the group is shaped by a remote server's
    behaviour, and a pathological nesting must not cost unbounded work.
    """
    subs = getattr(exc, "exceptions", None)
    if not subs or _depth > 8:
        return [exc]
    out: list[BaseException] = []
    for sub in subs:
        out.extend(leaves(sub, _depth + 1))
        if len(out) >= _MAX_LEAVES:
            break
    return out or [exc]


def _typed(found: list[BaseException]) -> BaseException | None:
    """The most INFORMATIVE leaf, not merely the first.

    A group can carry both a specific cause (an SSL failure) and a generic
    consequence (the session dying). Ordered most- to least-specific so a real
    diagnosis is never lost behind a wrapper.
    """
    for kind in (ssl.SSLError, TimeoutError, ConnectionError, OSError):
        for leaf in found:
            if isinstance(leaf, kind):
                return leaf
    return None


def _looks_like(message: str, hints: tuple[str, ...]) -> bool:
    low = message.lower()
    return any(h in low for h in hints)


def _detail(found: list[BaseException], fallback: BaseException) -> str:
    """Exception text only -- never the request payload, which is where
    credentials and user data would be."""
    best = _typed(found) or (found[0] if found else fallback)
    return (str(best).strip() or best.__class__.__name__)[:_MAX_DETAIL]


def _is_dns(exc: BaseException) -> bool:
    if isinstance(exc, socket.gaierror):
        return True
    text = str(exc).lower()
    return "name or service not known" in text or "nodename nor servname" in text


# --------------------------------------------------------------- tool calls
def to_tool_error(
    exc: BaseException,
    *,
    server_slug: str,
    recorder: StatusRecorder | None = None,
) -> ToolError:
    """Normalize any MCP client failure into a `ToolError`.

    `server_slug` is included so a failure is attributable in logs without
    reaching for the connection object, and it is the ONLY context added.
    `recorder` carries the HTTP status the SDK erased; without it, remote
    failures can only be classified as generic upstream errors -- which is
    exactly what Phase 1 did.
    """
    from mcp.shared.exceptions import MCPError  # noqa: PLC0415
    from pydantic import ValidationError  # noqa: PLC0415

    found = leaves(exc)
    detail = f"[{server_slug}] {_detail(found, exc)}"
    status = recorder.status if recorder else None
    retry_after = recorder.retry_after if recorder else None

    # 1. The transport's own record wins: it is the only source that can tell a
    #    401 from a 429 (see the module docstring).
    if status is not None:
        if status in (401, 403):
            return ToolError(
                ToolErrorKind.AUTH_FAILED, detail, status=status, retryable=False
            )
        if status == 429:
            return ToolError(
                ToolErrorKind.RATE_LIMITED,
                detail,
                status=status,
                retryable=True,
                retry_after_s=retry_after,
            )
        if status == 404:
            # On an established session this is an EXPIRED session id, not a
            # missing tool -- the tool name came from this server's own
            # tools/list. Retryable: the pool reconnects, the executor retries.
            return ToolError(
                ToolErrorKind.UNAVAILABLE, detail, status=status, retryable=True
            )
        if status == 408:
            return ToolError(
                ToolErrorKind.TIMEOUT, detail, status=status, retryable=True
            )
        if 500 <= status < 600:
            return ToolError(
                ToolErrorKind.UPSTREAM_ERROR,
                detail,
                status=status,
                retryable=True,
                retry_after_s=retry_after,
            )
        if 400 <= status < 500:
            # A client-side protocol error. Repeating an identical malformed
            # request cannot fix it.
            return ToolError(
                ToolErrorKind.UPSTREAM_ERROR, detail, status=status, retryable=False
            )

    # 2. Our own transport cut the response (audit H-08). Checked before the
    #    leaf types: a byte cap is neither a timeout nor a connection fault,
    #    and repeating the request would only be cut again.
    for leaf in found:
        if (
            isinstance(leaf, McpConnectionError)
            and leaf.kind is McpErrorKind.RESPONSE_TOO_LARGE
        ):
            return ToolError(
                ToolErrorKind.MALFORMED_RESPONSE,
                f"[{server_slug}] {leaf.detail}",
                retryable=False,
            )

    # 3. Leaf type: a real, specific Python failure.
    typed = _typed(found)
    if isinstance(typed, TimeoutError):
        return ToolError(ToolErrorKind.TIMEOUT, detail, retryable=True)
    if isinstance(typed, ssl.SSLError):
        # NOT retryable, and never worked around: an invalid certificate is the
        # one failure where retrying is actively wrong.
        return ToolError(ToolErrorKind.UNAVAILABLE, detail, retryable=False)
    if isinstance(typed, (ConnectionError, OSError)):
        return ToolError(ToolErrorKind.UNAVAILABLE, detail, retryable=True)

    if any(isinstance(leaf, ValidationError) for leaf in found):
        # The server answered, but not in a shape the negotiated protocol
        # allows. Retrying cannot fix a server that speaks the wrong dialect.
        return ToolError(ToolErrorKind.MALFORMED_RESPONSE, detail, retryable=False)

    if any(isinstance(leaf, MCPError) for leaf in found):
        message = _detail(found, exc)
        if _looks_like(message, _AUTH_HINTS):
            return ToolError(ToolErrorKind.AUTH_FAILED, detail, retryable=False)
        if _looks_like(message, _RATE_HINTS):
            return ToolError(
                ToolErrorKind.RATE_LIMITED,
                detail,
                retryable=True,
                retry_after_s=retry_after,
            )
        # A protocol-level error from the server itself: bad params, internal
        # failure. Retryable -- a transient server fault is the common case and
        # the executor's retry budget is small.
        return ToolError(ToolErrorKind.UPSTREAM_ERROR, detail, retryable=True)

    # Anything else is unclassified. UPSTREAM_ERROR rather than a new kind, and
    # NOT retryable: an unknown failure repeated is usually an unknown failure.
    return ToolError(ToolErrorKind.UPSTREAM_ERROR, detail, retryable=False)


# ------------------------------------------------------ connection lifecycle
def to_connection_error(
    exc: BaseException,
    *,
    server_slug: str,
    recorder: StatusRecorder | None = None,
    credential_presented: bool = False,
    established: bool = False,
) -> McpConnectionError:
    """Normalize a connect / initialize / discover failure.

    `credential_presented` separates AUTH_REQUIRED ("this server needs an
    account you have not connected") from AUTH_FAILED ("the credential you
    connected was rejected"). They are identical on the wire and lead to
    different user actions, so the caller -- which knows whether it sent
    anything -- supplies it rather than the classifier guessing.

    `established` distinguishes a 404 at connect time (there is no MCP endpoint
    at that URL) from a 404 mid-session (the session id expired).
    """
    if isinstance(exc, McpConnectionError):
        return exc  # already classified upstream; never re-wrap

    from mcp.shared.exceptions import MCPError  # noqa: PLC0415
    from pydantic import ValidationError  # noqa: PLC0415

    found = leaves(exc)
    # Already classified, but WRAPPED: the OAuth provider's AUTH_REQUIRED is
    # raised inside the SDK's task groups. Google's MCP servers answer the
    # handshake 200, so no 401 is recorded and it fell through to UNREACHABLE —
    # the UI said "Temporarily unavailable" instead of starting sign-in.
    inner = next((e for e in found if isinstance(e, McpConnectionError)), None)
    if inner is not None:
        return inner

    detail = _detail(found, exc)
    status = recorder.status if recorder else None
    retry_after = recorder.retry_after if recorder else None
    rejected = bool(recorder and recorder.credential_was_rejected)

    def build(kind: McpErrorKind, **kw) -> McpConnectionError:
        return McpConnectionError(
            kind,
            detail,
            server_slug=server_slug,
            status=status,
            retry_after_s=retry_after,
            **kw,
        )

    if status is not None:
        if status == 401:
            # An explicit `invalid_token` means the credential we sent was
            # rejected, even if the caller believed it sent nothing usable.
            if credential_presented or rejected:
                return build(McpErrorKind.AUTH_FAILED)
            return build(McpErrorKind.AUTH_REQUIRED)
        if status == 403:
            return build(McpErrorKind.AUTH_FAILED)
        if status == 429:
            return build(McpErrorKind.RATE_LIMITED)
        if status == 404:
            return build(
                McpErrorKind.SESSION_EXPIRED
                if established
                else McpErrorKind.PROTOCOL_MISMATCH
            )
        if status == 408:
            return build(McpErrorKind.TIMEOUT)
        if 500 <= status < 600:
            return build(McpErrorKind.SERVER_ERROR)
        if 400 <= status < 500:
            # 400/405/406/415: the endpoint answered, but does not speak this.
            return build(McpErrorKind.PROTOCOL_MISMATCH)

    typed = _typed(found)
    if isinstance(typed, ssl.SSLError):
        return build(McpErrorKind.TLS_FAILED)
    if isinstance(typed, TimeoutError):
        return build(McpErrorKind.TIMEOUT)
    if isinstance(typed, OSError) and _is_dns(typed):
        return build(McpErrorKind.DNS_FAILED)
    if isinstance(typed, (ConnectionError, OSError)):
        return build(McpErrorKind.UNREACHABLE)

    if any(isinstance(leaf, ValidationError) for leaf in found):
        return build(McpErrorKind.MALFORMED_INITIALIZE)
    if any(isinstance(leaf, MCPError) for leaf in found):
        # The server spoke JSON-RPC but rejected the handshake. Without a
        # recorded status there is nothing more specific to say, and claiming
        # otherwise is exactly the false precision the brief warns against.
        return build(McpErrorKind.PROTOCOL_MISMATCH)
    return build(McpErrorKind.UNREACHABLE, retryable=False)

"""OAuth failure -> the EXISTING `McpErrorKind` vocabulary.

No new error hierarchy. Phase 3's `McpConnectionError` already carries a kind, a
retryable flag, a `user_action_required` flag and a `reconnect_allowed` rule, and
the routes and the UI already read them. An OAuth-specific parallel would mean a
second vocabulary for the same six states.

THE DISTINCTION THAT DRIVES EVERYTHING: which failures a human must act on.
`access_denied` means the user pressed Deny — retrying is not merely useless, it
is rude. `invalid_grant` means the credential is dead and needs re-authorization.
`temporarily_unavailable` is the provider having a bad minute. Collapsing these
produces a UI that says "try again" to someone who declined on purpose.

RAW PROVIDER TEXT IS NEVER SURFACED. `_handle_token_response` raises
`OAuthTokenError(f"Token exchange failed ({status}): {body}")` with the token
endpoint's RAW BODY in the message, and `_auth_flow` logs it with
`logger.exception`. The body is normally an RFC 6749 error object, but it is
attacker-influenced text from a third party, so only the recognised `error` CODE
is lifted out of it — never the body itself.
"""

from __future__ import annotations

import re
from typing import Any

from app.mcp.errors import leaves
from app.mcp.exceptions import McpConnectionError, McpErrorKind

__all__ = ["oauth_error_code", "to_oauth_error"]

#: RFC 6749 §4.1.2.1 / §5.2 plus the OIDC additions we can actually act on.
#: Anything not listed is deliberately treated as unknown rather than guessed.
_CODE_TO_KIND = {
    # The user said no. Not an error to retry.
    "access_denied": McpErrorKind.AUTH_REQUIRED,
    "consent_required": McpErrorKind.AUTH_REQUIRED,
    "login_required": McpErrorKind.AUTH_REQUIRED,
    "interaction_required": McpErrorKind.AUTH_REQUIRED,
    # The credential is dead; a human must authorize again.
    "invalid_grant": McpErrorKind.AUTH_FAILED,
    "invalid_client": McpErrorKind.AUTH_FAILED,
    "unauthorized_client": McpErrorKind.AUTH_FAILED,
    "invalid_token": McpErrorKind.AUTH_FAILED,
    # We asked for something this server does not do. Retrying is pointless.
    "unsupported_grant_type": McpErrorKind.PROTOCOL_MISMATCH,
    "unsupported_response_type": McpErrorKind.PROTOCOL_MISMATCH,
    "invalid_request": McpErrorKind.PROTOCOL_MISMATCH,
    "invalid_scope": McpErrorKind.PROTOCOL_MISMATCH,
    # The provider is having a bad minute.
    "server_error": McpErrorKind.SERVER_ERROR,
    "temporarily_unavailable": McpErrorKind.SERVER_ERROR,
    "slow_down": McpErrorKind.RATE_LIMITED,
}

#: Pulls the CODE out of an RFC 6749 error body without trusting the rest of it.
_ERROR_CODE = re.compile(r'"error"\s*:\s*"([a-z_]{1,64})"')
_ERROR_QUERY = re.compile(r"(?:^|[?&])error=([a-z_]{1,64})")

#: A user pressing Deny is not a failure to retry, and marking it retryable is
#: how an application ends up re-prompting someone who already declined.
_NEVER_RETRY = frozenset(
    {
        McpErrorKind.AUTH_REQUIRED,
        McpErrorKind.AUTH_FAILED,
        McpErrorKind.PROTOCOL_MISMATCH,
    }
)


def oauth_error_code(text: str) -> str | None:
    """The RFC 6749 `error` code, from a JSON body or a redirect query.

    Deliberately narrow: `[a-z_]{1,64}` matches the specification's registry
    shape and nothing else, so a hostile body cannot smuggle arbitrary text into
    a field a user reads.
    """
    if not text:
        return None
    match = _ERROR_CODE.search(text) or _ERROR_QUERY.search(text)
    return match.group(1) if match else None


def to_oauth_error(
    exc: BaseException | None,
    *,
    server_slug: str,
    detail: str | None = None,
    error_code: str | None = None,
) -> McpConnectionError:
    """Normalize an OAuth failure into the existing connection-error model.

    `error_code` is supplied when the caller already parsed one (the callback
    route reads `?error=` directly). Otherwise the code is lifted out of the
    exception text, which is where the SDK puts the token endpoint's body.
    """
    if isinstance(exc, McpConnectionError):
        return exc  # already classified; never re-wrap

    found = leaves(exc) if exc is not None else []
    raw = detail or (str(found[0]) if found else "")
    code = error_code or oauth_error_code(raw)

    kind = _CODE_TO_KIND.get(code or "", None)
    if kind is None:
        kind = _from_exception_type(found)

    message = _message_for(code, kind, server_slug)
    return McpConnectionError(
        kind,
        message,
        server_slug=server_slug,
        retryable=False if kind in _NEVER_RETRY else None,
    )


def _from_exception_type(found: list[BaseException]) -> McpErrorKind:
    """Classify from the SDK's own exception types when no code was published."""
    from mcp.client.auth import (  # noqa: PLC0415
        OAuthFlowError,
        OAuthRegistrationError,
        OAuthTokenError,
    )

    for leaf in found:
        if isinstance(leaf, OAuthRegistrationError):
            # Registration failing means this deployment cannot obtain a client
            # identity here at all — a configuration problem, not a transient.
            return McpErrorKind.PROTOCOL_MISMATCH
        if isinstance(leaf, OAuthTokenError):
            return McpErrorKind.AUTH_FAILED
        if isinstance(leaf, OAuthFlowError):
            return McpErrorKind.PROTOCOL_MISMATCH
        if isinstance(leaf, TimeoutError):
            return McpErrorKind.TIMEOUT
    return McpErrorKind.PROTOCOL_MISMATCH


def _message_for(code: str | None, kind: McpErrorKind, server_slug: str) -> str:
    """A message a user can act on, built from the CODE — never from the body.

    Each string says what happened and what to do. "OAuth error" tells nobody
    anything, and a raw provider body may carry an internal URL or an echoed
    parameter.
    """
    known: dict[str, str] = {
        "access_denied": "authorization was declined",
        "consent_required": "this server needs your consent before it can be used",
        "login_required": "the provider needs you to sign in again",
        "interaction_required": (
            "the provider needs you to complete a step in its own interface"
        ),
        "invalid_grant": "the stored authorization is no longer valid; connect again",
        "invalid_client": "this deployment's OAuth client was rejected by the provider",
        "unauthorized_client": "this deployment's OAuth client is not permitted here",
        "invalid_token": "the stored credential was rejected; connect again",
        "invalid_scope": "the provider refused the permissions requested",
        "server_error": "the provider reported an internal error",
        "temporarily_unavailable": "the provider is temporarily unavailable",
        "slow_down": "the provider asked us to slow down",
    }
    if code and code in known:
        return f"{known[code]} ({code})"
    if code:
        # An unrecognised but well-shaped code: name it, claim nothing.
        return f"the provider reported {code!r}"
    fallback = {
        McpErrorKind.AUTH_FAILED: "authorization failed; connect the account again",
        McpErrorKind.AUTH_REQUIRED: "this server requires authorization",
        McpErrorKind.TIMEOUT: "the authorization step timed out",
        McpErrorKind.SERVER_ERROR: "the provider reported an error",
    }
    return fallback.get(kind, f"authorization with {server_slug} could not complete")


def is_user_declined(error_code: str | None) -> bool:
    """Whether the human explicitly said no.

    Worth its own predicate: a declined authorization must not be retried, must
    not be reported as a fault, and must not leave a connection looking broken.
    """
    return error_code == "access_denied"


def safe_callback_error(params: dict[str, Any]) -> str | None:
    """Read `error` from callback query parameters, bounded and validated."""
    value = params.get("error")
    if not isinstance(value, str):
        return None
    return value if re.fullmatch(r"[a-z_]{1,64}", value) else "invalid_request"

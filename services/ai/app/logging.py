"""Structured logging with secret redaction.

Three things here are load-bearing:

  * httpx AND httpx2 log full request URLs at INFO. That is how storage URLs and
    any query-string secret end up in journalctl. Both are silenced to WARNING.
    `httpx2` is the MCP SDK's HTTP stack and was NOT covered before Phase 4 —
    the original comment named only `httpx`, so every MCP endpoint URL, and
    every OAuth discovery/registration/token URL, rode out at INFO.
  * The redaction filter scrubs configured secrets and any data: URI or bearer
    token out of formatted records, so a stray f-string cannot leak a key.
  * Redaction is BOTH shape-based and KEY-NAME-based. Shapes alone were not
    enough: an OAuth access token is an opaque string with no `bearer `/`sk-`/
    `ya29.` prefix, so `{"access_token": "<opaque>"}` passed through untouched —
    measured, before Phase 4 fixed it. Since `redact_obj` also scrubs Sentry
    events (including stack-frame locals), that gap reached an external service.

Message content is never logged above DEBUG, and DEBUG content logging is
itself opt-in via AI_LOG_CONTENT.
"""

from __future__ import annotations

import contextvars
import json
import logging
import re
import sys
from typing import Any

_DATA_URI = re.compile(r"data:[a-zA-Z0-9.+/-]+;base64,[A-Za-z0-9+/=]{16,}")
_BEARER = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{12,}")
_SK = re.compile(r"sk-[A-Za-z0-9._\-]{12,}")
# Phase 4 (defense-in-depth): a bare Google OAuth token has no `bearer `/`sk-`
# prefix, so it evades the shapes above. The load-bearing guarantee is that the
# connector token is injected only in the outbound header and never enters
# args/results/events — these catch an accidental leak into a logged string.
_GOOGLE_ACCESS = re.compile(r"ya29\.[A-Za-z0-9._\-]{10,}")
_GOOGLE_REFRESH = re.compile(r"1//[A-Za-z0-9._\-]{10,}")

# Field NAMES whose value is a credential whatever it looks like. OAuth tokens
# are opaque, so a shape regex can never catch them; the name is the only signal.
_SECRET_KEYS = frozenset(
    {
        "access_token",
        "refresh_token",
        "id_token",
        "client_secret",
        "client_assertion",
        "code_verifier",
        "authorization_code",
        "authorization",
        "api_key",
        "apikey",
        # NOTE: stored in NORMALISED form (lowercase, dashes -> underscores),
        # because that is what `_is_secret_key` compares against. An entry
        # written as "x-api-key" here can never match — caught by test.
        "x_api_key",
        "private_key",
        "secret",
        "password",
        "passwd",
        "token",
        "session_token",
    }
)

# Names that are USUALLY not secret. `code` is a JSON-RPC error code, an HTTP
# status code, a country code — and also the OAuth authorization code. Redacting
# every `code` would destroy diagnostics (MCPError carries `code=-32603`), so
# these are redacted only when the value is a string long enough to be a
# credential. An int code is untouched; an opaque authorization code is not.
_SECRET_KEYS_IF_LONG = frozenset({"code", "assertion", "state"})
_LONG_ENOUGH = 8

_JSON_SECRET = re.compile(
    r'(?i)("(?:access_token|refresh_token|id_token|client_secret|code_verifier'
    r'|authorization_code|api_key|apikey|password|secret)"\s*:\s*")[^"]{1,4096}(")'
)
# Form-encoded and query-string shapes: the token endpoint request body and the
# OAuth callback URL both carry secrets this way.
#
# The value character class is written with ']' FIRST (where it is literal) so
# the pattern needs no backslash escape — one was silently mangled here during
# development, and a regex that quietly stops matching is a redaction that
# quietly stops redacting.
_FORM_VALUE = "[^]&\"'), 	}]"

_FORM_SECRET = re.compile(
    "(?i)(?<![A-Za-z0-9_])(access_token|refresh_token|client_secret"
    "|code_verifier|authorization_code|assertion|api_key)=" + _FORM_VALUE + "{4,}"
)

# `code` is length-gated AND must contain a letter. Without the letter check,
# `MCPError(code=-32603)` redacts to `code=***` and a real diagnostic is
# destroyed — measured, not hypothetical.
_FORM_CODE = re.compile(
    "(?i)(?<![A-Za-z0-9_])(code)=(?=[^&; ]*[A-Za-z])" + _FORM_VALUE + "{8,}"
)


_RESERVED = frozenset(
    logging.LogRecord("", 0, "", 0, "", None, None).__dict__.keys()
) | {"message", "asctime", "taskName"}


def redact_text(text: str, secrets: tuple[str, ...] = ()) -> str:
    """Scrub configured secrets, data-URIs, bearer/sk- tokens AND named OAuth
    fields from a string.

    Shared by RedactFilter (logs) and the Sentry before_send hook (main.py), so
    the log stream and any DSN-bound error event get the same redaction."""
    for s in secrets:
        if s and len(s) >= 8:
            text = text.replace(s, "***")
    text = _DATA_URI.sub("data:***", text)
    text = _BEARER.sub(r"\1***", text)
    text = _SK.sub("sk-***", text)
    text = _GOOGLE_ACCESS.sub("ya29.***", text)
    text = _GOOGLE_REFRESH.sub("1//***", text)
    # Named-field shapes, for a secret that reaches a string BEFORE
    # redact_obj can see it as a dict value: a pre-formatted f-string, a
    # serialized token response, or a callback URL query. OAuth tokens are
    # opaque, so the field NAME is the only signal available here.
    text = _JSON_SECRET.sub(r"\1***\2", text)
    text = _FORM_SECRET.sub(r"\1=***", text)
    return _FORM_CODE.sub(r"\1=***", text)


def _is_secret_key(key: Any, value: Any) -> bool:
    """Should this field's value be replaced outright, on the strength of its NAME?

    Shape matching cannot help with OAuth: an access token is an opaque string
    with no `bearer `/`sk-`/`ya29.` prefix. The field name is the only signal, so
    `access_token` and friends are redacted whatever their value looks like.

    `code`/`state`/`assertion` are LENGTH-GATED rather than listed outright,
    because they are overwhelmingly non-secret here — an MCPError carries
    `code=-32603` and every HTTP status is a `code`. Gating on "a string long
    enough to be a credential" keeps those diagnostics intact while still
    catching an OAuth authorization code.
    """
    if not isinstance(key, str):
        return False
    name = key.strip().lower().replace("-", "_")
    if name in _SECRET_KEYS:
        return True
    return (
        name in _SECRET_KEYS_IF_LONG
        and isinstance(value, str)
        and len(value) >= _LONG_ENOUGH
    )


def redact_obj(obj: Any, secrets: tuple[str, ...] = ()) -> Any:
    """Recursively scrub secrets from a dict/list/scalar.

    TWO mechanisms, because either alone leaves a hole:

      * SHAPE (data-URI / bearer / sk- / ya29. / 1//) on every string leaf, so a
        legit arg (query/url/id) is inert and only a secret-LOOKING value is
        masked;
      * NAME (`access_token`, `client_secret`, `code_verifier`, ...), because an
        OAuth credential has no shape at all. Before this, `{"access_token":
        "<opaque>"}` passed through untouched — and since this function also
        scrubs Sentry events INCLUDING stack-frame locals, that gap reached an
        external service.

    Used for tool arguments/results before they cross into the durable ledger,
    and by the Sentry before_send hook.
    """
    if isinstance(obj, str):
        return redact_text(obj, secrets)
    if isinstance(obj, dict):
        return {
            k: ("***" if _is_secret_key(k, v) else redact_obj(v, secrets))
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [redact_obj(v, secrets) for v in obj]
    if isinstance(obj, tuple):
        return tuple(redact_obj(v, secrets) for v in obj)
    return obj


_CONFIGURED_SECRETS: tuple[str, ...] = ()


def configured_secrets() -> tuple[str, ...]:
    """The secrets `configure()` was given.

    An egress point that is initialised SEPARATELY from the log handler — the
    Sentry before_send hook — needs the same values. Without this it fell back
    to shape-matching alone, which never matches a configured key that does not
    look like `sk-`/`bearer `/`data:`."""
    return _CONFIGURED_SECRETS


# Per-generation correlation, task-isolated: contextvars are COPIED per asyncio
# task (run_generation runs inside its own task), so concurrent generations on the
# single event loop never clobber each other's ids. Injected onto every LogRecord by
# ContextFilter so the thin per-tool log lines (agent.tool_cost / agent.tool_retry /
# tool.provider_error / ...), which do NOT themselves hold the ids, stay attributable
# to their run/user without timestamp-guessing.
_stream_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "log_stream_id", default=None
)
_user_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "log_user_id", default=None
)


def bind_log_context(
    stream_id: str | None = None, user_id: str | None = None
) -> None:
    """Bind the current generation's ids to the logging context for THIS asyncio
    task. Every subsequent LogRecord in the task then gains stream_id/user_id via
    ContextFilter. Called once at the top of run_generation; no-ops a None arg."""
    if stream_id is not None:
        _stream_id.set(stream_id)
    if user_id is not None:
        _user_id.set(user_id)


class ContextFilter(logging.Filter):
    """Inject the bound per-generation stream_id/user_id onto every record, without
    overwriting an explicit `extra` of the same name (e.g. generation_finished sets
    stream_id itself — same value, left as-is)."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "stream_id"):
            sid = _stream_id.get()
            if sid is not None:
                record.stream_id = sid
        if not hasattr(record, "user_id"):
            uid = _user_id.get()
            if uid is not None:
                record.user_id = uid
        return True


class RedactFilter(logging.Filter):
    def __init__(self, secrets: tuple[str, ...] = ()) -> None:
        super().__init__()
        self._secrets = tuple(s for s in secrets if s and len(s) >= 8)

    def _scrub(self, text: str) -> str:
        return redact_text(text, self._secrets)

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = self._scrub(record.msg)
        # %-style arguments live in record.args and are merged into the message
        # only at FORMAT time, so scrubbing record.msg alone misses the whole of
        # log.info("key=%s", secret).
        if record.args:
            record.args = redact_obj(record.args, self._secrets)
        for key, value in list(record.__dict__.items()):
            if key not in _RESERVED:
                # redact_obj, not isinstance(str): a secret one level inside an
                # `extra` dict is not a string, and was skipped entirely.
                record.__dict__[key] = redact_obj(value, self._secrets)
        return True


class JsonFormatter(logging.Formatter):
    """One JSON line per record, redacted where the bytes are actually produced.

    Redaction happens HERE as well as in RedactFilter because two of the strings
    that can carry a secret do not exist yet when a filter runs: the
    %-interpolated message, and the traceback rendered from exc_info. The final
    pass over the serialised line catches the third — an `extra` whose repr
    holds a secret, produced by `default=str` after every value-walking redactor
    has already finished."""

    def __init__(self, secrets: tuple[str, ...] = ()) -> None:
        super().__init__()
        self._secrets = tuple(s for s in secrets if s and len(s) >= 8)

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED:
                payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        line = json.dumps(redact_obj(payload, self._secrets), default=str)
        return redact_text(line, self._secrets)


def configure(level: str = "INFO", secrets: tuple[str, ...] = ()) -> None:
    global _CONFIGURED_SECRETS
    _CONFIGURED_SECRETS = tuple(s for s in secrets if s and len(s) >= 8)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(secrets))
    handler.addFilter(RedactFilter(secrets))
    # After redaction: the injected ids are correlation values, not secrets.
    handler.addFilter(ContextFilter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level.upper())

    # httpx logs full URLs at INFO — the classic secret-in-logs vector.
    #
    # `httpx2` is NOT a typo and NOT redundant: it is a separate distribution
    # with its own logger (literally named "httpx2"), and it is the HTTP stack
    # the MCP SDK uses. Silencing only `httpx` left every MCP endpoint URL at
    # INFO, and would have put OAuth discovery, registration and token-endpoint
    # URLs there too.
    for name in ("httpx", "httpcore", "httpx2", "httpcore2"):
        logging.getLogger(name).setLevel(logging.WARNING)
    # The MCP SDK's own loggers print request and response bodies at DEBUG
    # (audit M-09) — tool arguments, results and, on the auth path, token
    # responses. They are clamped to WARNING whatever the service level is;
    # an operator who needs them for one incident lifts this in code, not by
    # turning on DEBUG in production.
    for name in ("mcp", "mcp.client", "mcp.shared", "mcp.server"):
        logging.getLogger(name).setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)

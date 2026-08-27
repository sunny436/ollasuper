"""Structured logging with secret redaction.

Two things here are load-bearing:

  * httpx logs full request URLs at INFO. That is how storage URLs and any
    query-string secret end up in journalctl. It is silenced to WARNING.
  * The redaction filter scrubs configured secrets and any data: URI or bearer
    token out of formatted records, so a stray f-string cannot leak a key.

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

_RESERVED = frozenset(
    logging.LogRecord("", 0, "", 0, "", None, None).__dict__.keys()
) | {"message", "asctime", "taskName"}


def redact_text(text: str, secrets: tuple[str, ...] = ()) -> str:
    """Scrub configured secrets + data-URIs + bearer/sk- tokens from a string.
    Shared by RedactFilter (logs) and the Sentry before_send hook (main.py), so
    both the log stream and any DSN-bound error events get the same redaction."""
    for s in secrets:
        if s and len(s) >= 8:
            text = text.replace(s, "***")
    text = _DATA_URI.sub("data:***", text)
    text = _BEARER.sub(r"\1***", text)
    text = _SK.sub("sk-***", text)
    text = _GOOGLE_ACCESS.sub("ya29.***", text)
    return _GOOGLE_REFRESH.sub("1//***", text)


def redact_obj(obj: Any, secrets: tuple[str, ...] = ()) -> Any:
    """Phase 8: recursively scrub secret SHAPES from the string leaves of a
    dict/list/scalar. Used to redact tool arguments/results before they cross into
    the durable ledger. Shape-based (data-URI/bearer/sk-), so a legit arg
    (query/url/id) is inert; only an accidental secret leak is masked."""
    if isinstance(obj, str):
        return redact_text(obj, secrets)
    if isinstance(obj, dict):
        return {k: redact_obj(v, secrets) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact_obj(v, secrets) for v in obj]
    return obj


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
        for key, value in list(record.__dict__.items()):
            if key not in _RESERVED and isinstance(value, str):
                record.__dict__[key] = self._scrub(value)
        return True


class JsonFormatter(logging.Formatter):
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
        return json.dumps(payload, default=str)


def configure(level: str = "INFO", secrets: tuple[str, ...] = ()) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(RedactFilter(secrets))
    # After redaction: the injected ids are correlation values, not secrets.
    handler.addFilter(ContextFilter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level.upper())

    # httpx logs full URLs at INFO — the classic secret-in-logs vector.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)

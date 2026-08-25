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

import json
import logging
import re
import sys
from typing import Any

_DATA_URI = re.compile(r"data:[a-zA-Z0-9.+/-]+;base64,[A-Za-z0-9+/=]{16,}")
_BEARER = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{12,}")
_SK = re.compile(r"sk-[A-Za-z0-9._\-]{12,}")

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
    return _SK.sub("sk-***", text)


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

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level.upper())

    # httpx logs full URLs at INFO — the classic secret-in-logs vector.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)

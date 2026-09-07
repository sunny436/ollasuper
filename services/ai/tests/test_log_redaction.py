"""Redaction must hold at the EGRESS boundary, not one field short of it.

Three strings only come into existence AFTER a logging.Filter has run:

  * the %-interpolated message — `log.info("k=%s", secret)` leaves `record.msg`
    as the template and the secret in `record.args`, merged in later by
    `record.getMessage()`;
  * the rendered traceback — built by the FORMATTER from `exc_info`;
  * the repr of a non-JSON-serialisable extra — produced by `json.dumps(...,
    default=str)`, after every redactor has already run.

A filter that scrubs `record.msg` and string extras cannot see any of the three,
so a secret carried in any of them reached stdout in clear text. Each test below
fails against that implementation, and they are written against `configure()`
rather than the filter in isolation so a wiring mistake (a formatter that never
receives the secrets) fails too.

The Sentry hook is the same boundary reached by a different road: it redacted
`message` and exception `value` only, and called the redactor with NO configured
secrets, so it caught secret SHAPES and never the actual configured keys.
"""

from __future__ import annotations

import contextlib
import io
import json
import logging

import pytest

import app.logging as app_logging
from app.logging import configure

SECRET = "osk_live_configured_secret_2f9c1e"  # matches no shape regex on purpose


class _Opaque:
    """Not JSON-serialisable, so json.dumps falls back to `default=str`."""

    def __init__(self, token: str) -> None:
        self._token = token

    def __repr__(self) -> str:
        return f"<Opaque token={self._token}>"


@pytest.fixture
def emitted():
    """Wire the REAL handler and hand back what it actually wrote.

    `configure()` builds `StreamHandler(sys.stdout)`, which binds the stream at
    CONSTRUCTION time — so constructing it under `redirect_stdout` captures the
    real pipeline deterministically. pytest's `capsys` is deliberately NOT used:
    it returned an empty string here, which let a `SECRET not in out` assertion
    pass without a single byte being examined.
    """
    root = logging.getLogger()
    saved_handlers, saved_level = root.handlers[:], root.level
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        configure(level="INFO", secrets=(SECRET,))
    log = logging.getLogger("redaction-probe")
    log.propagate = True
    yield log, buf.getvalue
    root.handlers[:] = saved_handlers
    root.setLevel(saved_level)
    app_logging._CONFIGURED_SECRETS = ()


def test_interpolation_arguments_are_redacted(emitted):
    """`record.args` is not `record.msg`; the merge happens at format time."""
    log, read = emitted
    log.info("calling upstream with key=%s", SECRET)
    out = read()
    assert out.strip(), "nothing emitted — the assertion below would be vacuous"
    assert SECRET not in out
    assert "***" in out


def test_nested_extra_values_are_redacted(emitted):
    """A secret one level inside a dict is not a string extra, so the
    isinstance(str) test skipped it entirely."""
    log, read = emitted
    log.info("ctx", extra={"ctx": {"auth": {"api_key": SECRET}}, "n": 1})
    out = read()
    assert out.strip(), "nothing emitted — the assertion below would be vacuous"
    assert SECRET not in out
    # the surrounding structure must survive — redaction, not deletion
    assert json.loads(out.strip())["n"] == 1


def test_exception_text_is_redacted(emitted):
    """The traceback is rendered by the formatter, downstream of every filter."""
    log, read = emitted
    try:
        raise ValueError(f"upstream rejected {SECRET}")
    except ValueError:
        log.exception("generation_failed")
    out = read()
    assert out.strip(), "nothing emitted — the assertion below would be vacuous"
    assert SECRET not in out
    assert "ValueError" in out  # the report itself is still useful


def test_a_non_serialisable_extra_cannot_smuggle_a_secret_through_repr(emitted):
    """`default=str` runs after the object graph has been redacted, so an object
    whose repr holds the secret escapes anything that walks values only."""
    log, read = emitted
    log.info("obj", extra={"client": _Opaque(SECRET)})
    out = read()
    assert out.strip(), "nothing emitted — the assertion below would be vacuous"
    assert SECRET not in out


def test_every_emitted_line_is_still_valid_json(emitted):
    """Redaction must not corrupt the record format the log pipeline parses."""
    log, read = emitted
    log.info("plain %s", SECRET, extra={"nested": {"a": [SECRET, 2]}})
    line = read().strip()
    parsed = json.loads(line)
    assert parsed["level"] == "INFO"
    assert parsed["nested"]["a"][1] == 2


# --- the same boundary, reached through Sentry --------------------------------


def test_sentry_events_are_redacted_recursively():
    """`before_send` scrubbed event['message'] and exception values only, with no
    configured secrets. Breadcrumbs (the default LoggingIntegration turns every
    INFO record into one), `extra`, and stack-frame locals — which the SDK sends
    by default — all rode out untouched."""
    from app.logging import configure
    from app.observability import redact_sentry_event

    configure(level="INFO", secrets=(SECRET,))
    event = {
        "message": f"boom {SECRET}",
        "exception": {
            "values": [
                {
                    "value": f"rejected {SECRET}",
                    "stacktrace": {
                        "frames": [{"vars": {"api_key": SECRET, "n": 3}}]
                    },
                }
            ]
        },
        "breadcrumbs": {"values": [{"message": f"POST with {SECRET}"}]},
        "extra": {"settings": {"key": SECRET}},
        "logentry": {"message": "calling %s", "params": [SECRET]},
    }
    cleaned = redact_sentry_event(event)
    assert SECRET not in json.dumps(cleaned)
    # structure preserved, not blanked
    frame = cleaned["exception"]["values"][0]["stacktrace"]["frames"][0]
    assert frame["vars"]["n"] == 3


# --- the same boundary, reached through the durable ledger --------------------


async def test_the_tool_ledger_redacts_configured_secrets(emitted):
    """`emit_event` bodies are PERSISTED in Convex, and were redacted with the
    shape regexes alone — `redact_obj(body["arguments"])` with no secrets — so a
    configured key that looks like nothing in particular was stored verbatim in
    the tool ledger and rendered back into the UI."""
    from app.models.events import EventType
    from app.runtime.writer import DeltaWriter
    from tests.conftest import make_settings
    from tests.test_writer_events import RecordingConvex

    convex = RecordingConvex()
    writer = DeltaWriter(convex, "s1", make_settings("http://x"))
    await writer.emit_event(
        EventType.TOOL_CALL,
        tool_name="t",
        call_id="c1",
        arguments={"headers": {"x-api-key": SECRET}},
    )
    await writer.emit_event(
        EventType.TOOL_RESULT,
        call_id="c1",
        result={"echo": [SECRET]},
        content=f"upstream said {SECRET}",
    )
    wire = json.dumps(convex.calls)
    assert convex.calls, "nothing reached the wire — the assertion below is vacuous"
    assert SECRET not in wire

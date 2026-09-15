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
                    "stacktrace": {"frames": [{"vars": {"api_key": SECRET, "n": 3}}]},
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


# ===========================================================================
# Phase 4: OAuth secrets are SHAPELESS, so shape matching alone cannot see them
# ===========================================================================
#
# The layer above catches `bearer <tok>`, `sk-…`, `ya29.…`, `1//…` and any
# CONFIGURED secret. An OAuth access token is none of those: it is an opaque
# string issued at runtime, so it is never in `secrets`, and it carries no
# prefix. Measured before this was fixed, every one of these passed through
# untouched — including into the Sentry hook, which scrubs stack-frame locals
# and therefore carried them to an external service.
#
# The counter-risk is over-redaction. `code` is a JSON-RPC error code, an HTTP
# status and a country code far more often than it is an authorization code, so
# the diagnostics tests below are as load-bearing as the secret ones: a
# redactor that eats `code=-32603` will be turned off by the next person who
# needs to debug a protocol error.

OAUTH_SECRET = "ATza-opaque-runtime-issued-1a2b3c4d"


@pytest.mark.parametrize(
    "field",
    [
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
        "x-api-key",
        "private_key",
        "secret",
        "password",
        "token",
        "session_token",
    ],
)
def test_a_shapeless_credential_is_redacted_by_field_name(field):
    from app.logging import redact_obj

    got = redact_obj({field: OAUTH_SECRET}, ())
    assert got[field] == "***", f"{field} leaked a shapeless credential"


def test_field_name_matching_ignores_case_and_dashes():
    from app.logging import redact_obj

    for spelling in ("Access-Token", "ACCESS_TOKEN", "  refresh-token  "):
        assert redact_obj({spelling: OAUTH_SECRET}, ())[spelling] == "***"


def test_an_authorization_code_is_redacted_but_an_error_code_is_not():
    """`code` is length-gated AND must contain a letter.

    Redacting every `code` destroys `MCPError(code=-32603)`, which is the single
    most useful field when an MCP call fails. Keeping both properties is the
    whole point of the gate.
    """
    from app.logging import redact_obj

    assert redact_obj({"code": "AUTHCODEabc123xyz"}, ())["code"] == "***"
    assert redact_obj({"code": -32603}, ())["code"] == -32603
    assert redact_obj({"code": "404"}, ())["code"] == "404"
    assert redact_obj({"status_code": 401}, ())["status_code"] == 401


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("error", "invalid_grant"),
        ("tool_id", "mcp:fake:echo"),
        ("country", "US"),
        ("state", "ok"),
        ("server", "acme.test/server"),
        ("resource", "https://api.example.test/mcp"),
    ],
)
def test_ordinary_diagnostics_survive_redaction(key, value):
    """A redactor that eats diagnostics gets disabled by the next person who
    needs to debug something."""
    from app.logging import redact_obj

    assert redact_obj({key: value}, ())[key] == value


def test_nested_and_listed_credentials_are_reached():
    from app.logging import redact_obj

    got = redact_obj(
        {"outer": {"tokens": [{"access_token": OAUTH_SECRET}]}, "keep": "fine"}, ()
    )
    assert got["outer"]["tokens"][0]["access_token"] == "***"
    assert got["keep"] == "fine"


@pytest.mark.parametrize(
    ("text", "leaked"),
    [
        ('{"access_token": "%s", "token_type": "Bearer"}', True),
        ("grant_type=authorization_code&code_verifier=%s", True),
        ("POST /token client_secret=%s", True),
        ("GET /mcp/oauth/callback?code=%s&state=xyz", True),
    ],
)
def test_a_credential_serialised_into_a_string_is_still_redacted(text, leaked):
    """`redact_obj` sees dict values; this sees what an f-string already flattened.

    The SDK does exactly this: `_handle_token_response` raises
    `OAuthTokenError(f"Token exchange failed …: {body_text}")` with the raw token
    endpoint body, and `_auth_flow` logs it with `logger.exception`.
    """
    from app.logging import redact_text

    out = redact_text(text % OAUTH_SECRET, ())
    assert OAUTH_SECRET not in out
    assert "***" in out


@pytest.mark.parametrize(
    "text",
    [
        "MCPError(code=-32603)",
        "HTTP 401 code=404",
        "tool mcp:fake:echo returned 5",
        "GET https://api.example.test/mcp",
    ],
)
def test_strings_without_credentials_are_left_alone(text):
    from app.logging import redact_text

    assert redact_text(text, ()) == text


def test_an_sdk_traceback_carrying_a_token_is_redacted(emitted):
    """The SDK logs OAuth failures with `logger.exception`, on ITS logger.

    `configure()` installs the handler on the ROOT logger, so a third-party
    logger propagates into the same redaction — but only if the formatter
    scrubs the rendered traceback too, which is the part that is easy to miss.
    """
    _log, read = emitted
    sdk_logger = logging.getLogger("mcp.client.auth.oauth2")
    sdk_logger.propagate = True
    try:
        body = f'{{"access_token": "{OAUTH_SECRET}"}}'
        raise RuntimeError(f"Token exchange failed (400): {body}")
    except RuntimeError:
        sdk_logger.exception("OAuth flow error")
    out = read()
    assert out.strip(), "nothing emitted — the assertion below would be vacuous"
    assert OAUTH_SECRET not in out
    assert "***" in out


def test_the_sentry_hook_redacts_shapeless_credentials_in_stack_locals():
    """The Sentry event is the worst carrier: the SDK sends frame locals, so a
    token held in a local variable anywhere in the traceback rides out to an
    external service. It is the same `redact_obj`, so the field-name rule has to
    cover it."""
    from app.observability import redact_sentry_event

    event = {
        "exception": {
            "values": [
                {
                    "stacktrace": {
                        "frames": [
                            {
                                "function": "_handle_token_response",
                                "vars": {
                                    "access_token": OAUTH_SECRET,
                                    "code_verifier": "vvvvvvvvvvvvvvvvvvvv",
                                    "status": 200,
                                },
                            }
                        ]
                    }
                }
            ]
        }
    }
    blob = json.dumps(redact_sentry_event(event))
    assert OAUTH_SECRET not in blob
    assert "vvvvvvvvvvvvvvvvvvvv" not in blob
    assert '"status": 200' in blob, "redaction ate a diagnostic"


def test_httpx2_is_silenced_exactly_as_httpx_is(emitted):
    """`httpx2` is the MCP SDK's HTTP stack and has its own logger.

    Silencing only `httpx` left every MCP endpoint URL at INFO — visible in
    Phase 3's own test output — and would have put OAuth discovery,
    registration and token-endpoint URLs there too.
    """
    for name in ("httpx", "httpcore", "httpx2", "httpcore2"):
        assert logging.getLogger(name).level == logging.WARNING, name

    _log, read = emitted
    logging.getLogger("httpx2").info("HTTP Request: POST https://as.test/token")
    assert "as.test/token" not in read()


def test_a_scrub_that_fails_drops_the_event_rather_than_leaking_it(monkeypatch):
    """Audit M-10. `before_send` used to return the RAW event when redaction
    raised — the event most likely to carry something unusual, and therefore
    a token. A lost report is a cost; a leaked token is a breach."""
    import types

    import app.observability as obs

    captured: dict = {}

    class FakeSentry:
        @staticmethod
        def init(**kw):
            captured["before_send"] = kw["before_send"]

        @staticmethod
        def set_tag(*_a, **_k):
            return None

    monkeypatch.setitem(__import__("sys").modules, "sentry_sdk", FakeSentry)
    monkeypatch.setattr(
        obs,
        "redact_sentry_event",
        lambda e: (_ for _ in ()).throw(ValueError("cyclic")),
    )
    settings = types.SimpleNamespace(ai_sentry_dsn="https://k@sentry.example/1")
    obs.init_sentry(settings, component="test")
    assert captured["before_send"]({"extra": {"token": "secret"}}, None) is None

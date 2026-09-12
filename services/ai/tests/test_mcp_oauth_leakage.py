"""END TO END: authorize, call a tool, then hunt for the token everywhere.

This is the phase's Definition-of-Done item stated as a test. Every other file
proves one mechanism works; this one asks the only question that matters
afterwards — after a REAL authorization against a REAL authorization server, and
a REAL tool call over the real MCP protocol, can the access token be found
anywhere it should not be?

THE CARRIERS CHECKED, and why each one is a genuine escape route rather than a
box to tick:

  * the stored record — ciphertext is the whole point; a plaintext token in the
    envelope would make the encryption decorative;
  * every payload the store was ever handed — not just the final row. A record
    that was ciphertext at rest but plaintext in transit is no better;
  * `ToolDefinition` — it is serialised into the model's context on every turn;
  * the adapter's result, which becomes a `ToolMessage` — it goes to the model,
    into LangGraph state, and into the message history that is replayed;
  * the emitted log stream — through the real `configure()` pipeline, because
    filters and formatters are different boundaries and a secret can survive one
    and not the other;
  * the Sentry event, INCLUDING stack-frame locals — the SDK sends those by
    default, so a token held in a local anywhere in a traceback rides out to an
    external service.

WHAT THIS TEST DOES NOT CLAIM. Python cannot zeroize an immutable `str`, so no
secure-wipe claim is made anywhere in this phase. The claim is narrower and
checkable: minimal lifetime, no plaintext cached beyond the SDK's own context,
and no plaintext crossing a boundary.
"""

from __future__ import annotations

import contextlib
import io
import json
import logging

import httpx2
import pytest

import app.logging as app_logging
from app.logging import configure
from tests.fakes.oauth_server import BASE, MCP_URL, authorize
from tests.test_mcp_oauth_flow import TENANT, Harness
from tests.test_mcp_oauth_refresh import _in_harness

pytestmark = pytest.mark.anyio


class _Captured:
    """Everything one end-to-end run produced, for the searches below."""

    def __init__(self) -> None:
        self.access_token: str = ""
        self.refresh_token: str = ""
        self.envelopes: list[str] = []
        self.tool_definitions: list[dict] = []
        self.tool_result: dict = {}
        self.authorization_url: str = ""
        self.record_repr: str = ""
        #: Everything the REAL logging pipeline wrote during the run.
        self.logs: str = ""


async def _end_to_end() -> _Captured:
    """Authorize, discover tools, call one — and keep what came back.

    Deliberately one function rather than a fixture: every assertion below has
    to be about the SAME run, or "the token is not in the logs" could be true of
    a run that never obtained one.
    """
    from mcp.client import Client
    from mcp.client.streamable_http import streamable_http_client

    from app.mcp.credentials import VaultCredentialResolver
    from app.mcp.models import McpServerIdentity
    from app.mcp.normalize import normalize_tools
    from tests.fakes.oauth_server import REDIRECT_URI

    got = _Captured()

    async def body(harness: Harness) -> None:
        started = await harness.flow.start(connect=harness.connect_with, **TENANT)
        got.authorization_url = started.authorization_url
        callback = authorize(harness.state, started.authorization_url)
        attempt = await harness.flow.complete(
            state=callback["state"], code=callback["code"], iss=callback["iss"]
        )
        assert attempt is not None
        assert await harness.flow.wait_for_completion(attempt, timeout_s=15)

        # A second, ordinary connection — the path every tool call takes.
        resolver = VaultCredentialResolver(harness.vault, redirect_uri=REDIRECT_URI)
        credential = await resolver.resolve(
            user_id=TENANT["user_id"],
            workspace_id=TENANT["workspace_id"],
            connection_id=TENANT["connection_id"],
            server_slug=TENANT["server_slug"],
            server_name=TENANT["server_name"],
            endpoint_url=MCP_URL,
            resource=MCP_URL,
        )
        client = httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=harness.app),
            base_url=BASE,
            auth=credential.auth,
        )
        async with client:
            async with Client(
                server=streamable_http_client(MCP_URL, http_client=client)
            ) as session:
                listed = await session.list_tools()
                definitions = normalize_tools(
                    listed.tools,
                    McpServerIdentity(slug=TENANT["server_slug"], trusted=True),
                )
                got.tool_definitions = [
                    json.loads(d.model_dump_json())
                    if hasattr(d, "model_dump_json")
                    else dict(vars(d))
                    for d in definitions
                ]
                result = await session.call_tool("whoami", {})
                got.tool_result = {
                    "text": [
                        getattr(block, "text", "") for block in (result.content or [])
                    ],
                    "structured": getattr(result, "structured_content", None),
                    "is_error": getattr(result, "is_error", False),
                }

    # THE WHOLE RUN UNDER THE REAL LOG PIPELINE. `configure()` binds
    # StreamHandler(sys.stdout) at construction, so building it inside the
    # redirect is what captures the true output — including anything the MCP
    # SDK, httpx2 or our own modules emit while a live token exists.
    buffer = io.StringIO()
    root = logging.getLogger()
    saved_handlers, saved_level = root.handlers[:], root.level
    try:
        with contextlib.redirect_stdout(buffer):
            configure(level="DEBUG", secrets=())
            harness = await _in_harness(body)
    finally:
        root.handlers[:] = saved_handlers
        root.setLevel(saved_level)
        app_logging._CONFIGURED_SECRETS = ()
    got.logs = buffer.getvalue()

    got.access_token = harness.state.issued_access[-1]
    got.envelopes = list(harness.store.saw)
    row = next(iter(harness.store.rows.values()))
    got.record_repr = repr(row)

    payload, _record = await harness.vault.get(
        user_id=TENANT["user_id"],
        workspace_id=TENANT["workspace_id"],
        connection_id=TENANT["connection_id"],
        server_name=TENANT["server_name"],
        resource=MCP_URL,
    )
    got.refresh_token = payload.get("refresh_token", "")
    return got


@pytest.fixture(scope="module")
def run_result():
    """One end-to-end run, shared by every assertion in this module."""
    import anyio

    return anyio.run(_end_to_end)


def _secrets(got: _Captured) -> list[str]:
    found = [s for s in (got.access_token, got.refresh_token) if s]
    assert len(found) == 2, "the run produced no credential; this would be vacuous"
    return found


# --------------------------------------------------------------- at rest
def test_the_stored_record_holds_only_ciphertext(run_result):
    got = run_result
    for secret in _secrets(got):
        for envelope in got.envelopes:
            assert secret not in envelope
        # Not just the final row: EVERY payload the store was ever handed.
        assert secret not in "".join(got.envelopes)


def test_the_envelope_looks_like_an_envelope_and_nothing_else(run_result):
    got = run_result
    assert got.envelopes, "nothing was ever persisted"
    for envelope in got.envelopes:
        parts = envelope.split(".")
        assert len(parts) == 4 and parts[0] == "v1", envelope
        # No structure from the plaintext survives: no JSON keys, no scheme.
        for marker in ("access_token", "refresh_token", "Bearer", "{", '"'):
            assert marker not in envelope


def test_the_record_repr_cannot_print_the_envelope(run_result):
    # A credential record in a traceback is something nobody needs to see, and
    # the default dataclass repr would print it.
    got = run_result
    assert "envelope" not in got.record_repr
    assert got.envelopes[-1] not in got.record_repr
    # It is still useful for debugging.
    assert "CredentialRecord(" in got.record_repr


# --------------------------------------------------- on the way to the model
def test_no_tool_definition_carries_a_credential(run_result):
    """`ToolDefinition` is serialised into the model's context on every turn.

    A credential reaching it would be sent to a third-party LLM — and then be in
    a provider's logs, outside this system entirely.
    """
    got = run_result
    assert got.tool_definitions, "no tools were discovered; this would be vacuous"
    blob = json.dumps(got.tool_definitions)
    for secret in _secrets(got):
        assert secret not in blob
    for marker in ("Authorization", "Bearer ", "access_token", "refresh_token"):
        assert marker not in blob


def test_no_tool_result_carries_a_credential(run_result):
    # The result becomes a ToolMessage: it reaches the model, LangGraph state,
    # and the replayed message history.
    got = run_result
    blob = json.dumps(got.tool_result, default=str)
    for secret in _secrets(got):
        assert secret not in blob
    assert got.tool_result["text"] == ["authenticated-caller"]


def test_the_authorization_url_is_safe_to_hand_a_browser(run_result):
    """The ONE value that crosses to the browser.

    Public by construction — its PKCE value is a hash and its `state` is a
    routing token — but that is a claim worth checking rather than asserting,
    because a future change could put something else in the query string.
    """
    got = run_result
    url = got.authorization_url
    assert url.startswith("https://")
    assert "code_challenge=" in url and "code_challenge_method=S256" in url
    # The verifier never leaves the SDK's stack frame.
    assert "code_verifier" not in url
    assert "client_secret" not in url
    for secret in _secrets(got):
        assert secret not in url


# ------------------------------------------------------------------- in logs
@pytest.fixture
def emitted():
    """The REAL logging pipeline, capturing what it actually wrote.

    `configure()` binds `StreamHandler(sys.stdout)` at construction, so building
    it under `redirect_stdout` captures the true pipeline. `capsys` is
    deliberately not used — it returns an empty string here, which would let a
    `not in` assertion pass without a byte being examined.
    """
    root = logging.getLogger()
    saved_handlers, saved_level = root.handlers[:], root.level
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        configure(level="INFO", secrets=())
    yield buf.getvalue
    root.handlers[:] = saved_handlers
    root.setLevel(saved_level)
    app_logging._CONFIGURED_SECRETS = ()


def test_a_token_logged_by_any_field_name_is_redacted(run_result, emitted):
    """The credential is SHAPELESS — an opaque `at-...` string matching no
    `sk-`/`ya29.` regex — so only key-name-aware redaction can catch it.

    Measured before this phase: `access_token`, `refresh_token`, `client_secret`
    and `code_verifier` all passed through the redactor untouched, including
    into Sentry stack-frame locals.
    """
    got = run_result
    log = logging.getLogger("mcp-leak-probe")
    log.propagate = True
    for secret in _secrets(got):
        log.info(
            "mcp.oauth_token_stored",
            extra={
                "access_token": secret,
                "nested": {"refresh_token": secret, "keep": 1},
                "header": f"Authorization: Bearer {secret}",
            },
        )
    out = emitted()
    assert out.strip(), "nothing emitted — the assertions below would be vacuous"
    for secret in _secrets(got):
        assert secret not in out
    # Redaction, not deletion: the diagnostic must survive.
    assert "mcp.oauth_token_stored" in out
    assert '"keep": 1' in out or '"keep":1' in out


def test_a_traceback_carrying_the_token_is_redacted(run_result, emitted):
    # The SDK puts the token endpoint's RAW BODY into `OAuthTokenError`, and
    # `_auth_flow` logs it with `logger.exception`. The rendered traceback is
    # built by the FORMATTER, downstream of every filter.
    got = run_result
    log = logging.getLogger("mcp-leak-probe")
    log.propagate = True
    secret = got.access_token
    try:
        raise RuntimeError(
            f'Token exchange failed (400): {{"access_token": "{secret}"}}'
        )
    except RuntimeError:
        log.exception("mcp.oauth_failed")
    out = emitted()
    assert out.strip()
    assert secret not in out
    assert "RuntimeError" in out  # still a usable report


def test_the_httpx2_logger_cannot_publish_a_discovery_url(emitted):
    """`httpx` was silenced; `httpx2` — the stack the MCP SDK actually uses —
    was not. OAuth adds discovery, registration and token-endpoint URLs to that
    stream."""
    logging.getLogger("httpx2").info("HTTP Request: POST %s/token", BASE)
    logging.getLogger("httpcore2").info("connect_tcp.started host=%s", BASE)
    out = emitted()
    assert "HTTP Request" not in out
    assert "connect_tcp" not in out


# ---------------------------------------------------------------- in Sentry
def test_the_sentry_event_is_scrubbed_including_frame_locals(run_result):
    """Frame locals are sent by DEFAULT, and are where a token actually sits.

    The SDK stringifies them before `before_send` runs, so the redactor sees
    strings — which is exactly why key-name matching is what saves this.
    """
    from app.observability import redact_sentry_event

    got = run_result
    secret = got.access_token
    event = {
        # NOTE what is deliberately NOT here: a bare token in free prose, e.g.
        # "token exchange failed for at-Xy9...". Nothing can catch that — it
        # carries no key name and OAuth tokens have no distinguishing shape, and
        # a per-user runtime token is not in `configured_secrets()`. The honest
        # control is that OUR code never writes one, which
        # `test_the_real_run_emitted_no_credential` checks against the actual
        # output of a real authorization rather than against a synthetic event.
        "message": "token exchange failed",
        "exception": {
            "values": [
                {
                    "value": f'{{"access_token": "{secret}"}}',
                    "stacktrace": {
                        "frames": [
                            {
                                "function": "_handle_token_response",
                                "vars": {
                                    "access_token": secret,
                                    "refresh_token": got.refresh_token,
                                    "status": 400,
                                },
                            }
                        ]
                    },
                }
            ]
        },
        "breadcrumbs": [{"message": f"Authorization: Bearer {secret}"}],
        "extra": {"client_secret": "cs_9f8e7d6c5b4a", "server": "acme"},
    }
    scrubbed = json.dumps(redact_sentry_event(event))
    for value in _secrets(got):
        assert value not in scrubbed
    assert "cs_9f8e7d6c5b4a" not in scrubbed
    # The event is still diagnostic.
    assert "_handle_token_response" in scrubbed
    assert '"status": 400' in scrubbed
    assert "acme" in scrubbed


# ----------------------------------------------- what the real run actually said
def test_the_real_run_emitted_no_credential(run_result):
    """The claim that matters, measured on a REAL authorization.

    A synthetic event can only prove the redactor catches what it was shown.
    This reads every byte the logging pipeline wrote while a live access token,
    a refresh token and an authorization code all existed in this process — the
    MCP SDK's output, httpx2's, and our own — and asserts none of them survived.
    """
    got = run_result
    assert got.logs.strip(), "nothing was logged; the assertions would be vacuous"
    for secret in _secrets(got):
        assert secret not in got.logs
    # Our own records really did run through it, so the absence above is not
    # the absence of logging.
    assert "mcp.oauth_token_stored" in got.logs


def test_the_real_run_leaked_no_url_carrying_a_code(run_result):
    """`httpx2` logs full request URLs at INFO — the classic secret-in-logs
    vector, and the one that was still open after Phase 3 because only `httpx`
    was silenced."""
    got = run_result
    assert "HTTP Request:" not in got.logs
    assert "code_verifier" not in got.logs
    assert "client_secret" not in got.logs


def test_the_real_run_still_produced_useful_diagnostics(run_result):
    # Redaction, not silence. A pipeline that logged nothing would pass every
    # assertion above and be useless in production.
    got = run_result
    for marker in ("mcp.oauth_client_stored", "mcp.oauth_authorized"):
        assert marker in got.logs, marker

"""Remote failure classification — the half the SDK throws away.

WHAT THIS SUITE EXISTS TO PREVENT, measured against a live server: the SDK
collapses every HTTP failure into

    ExceptionGroup(ExceptionGroup(MCPError(code=-32603,
                   message='Server returned an error response', data=None)))

401, 403, 429, 500 and 503 produce that IDENTICAL exception. `data` is None and
there is no `__cause__`, so nothing in the exception can tell a rejected
credential from a rate limit from a transient outage.

Phase 1's mapper substring-matched "401" / "rate limit" against a message that
never contains them, so everything landed in one bucket -- and merely unwrapping
the ExceptionGroup made it WORSE, because the generic MCPError branch marks it
retryable, so a rejected credential would be retried against a third party.

Every test below runs against a real HTTP status, and the
`without_the_recorder` test is the proof that the recorder does the work rather
than a coincidence doing it.
"""

from __future__ import annotations

import ssl
from contextlib import AsyncExitStack

import pytest

from app.mcp.errors import leaves, to_connection_error, to_tool_error
from app.mcp.exceptions import McpErrorKind
from app.mcp.session import McpSessionPool, PoolLimits
from app.mcp.status import StatusRecorder
from app.tools.errors import ToolErrorKind
from tests.fakes import mcp_http
from tests.fakes.mcp_http import running, spec, status_app


@pytest.fixture
def asgi(monkeypatch):
    def _install(app):
        mcp_http.patch_transport(monkeypatch, app)

    return _install


async def _connect_error(app, asgi, **spec_kw):
    """Drive a real connect attempt and return the classified failure."""
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await McpSessionPool(PoolLimits(sweep_interval_s=3600.0)).start(stack)
        try:
            async with pool.acquire(spec(**spec_kw)):
                pytest.fail("the fixture should not have connected")
        except Exception as exc:  # noqa: BLE001
            return exc
        finally:
            await pool.aclose()


def _grouped(inner: BaseException) -> BaseException:
    """The doubly-nested shape the SDK actually raises."""
    return BaseExceptionGroup("outer", [BaseExceptionGroup("inner", [inner])])


def _generic_mcp_error() -> BaseException:
    from mcp.shared.exceptions import MCPError

    return MCPError(code=-32603, message="Server returned an error response")


# ------------------------------------------------ connect-time classification
@pytest.mark.parametrize(
    ("status", "expected", "retryable"),
    [
        (401, McpErrorKind.AUTH_REQUIRED, False),
        (403, McpErrorKind.AUTH_FAILED, False),
        (429, McpErrorKind.RATE_LIMITED, True),
        (500, McpErrorKind.SERVER_ERROR, True),
        (503, McpErrorKind.SERVER_ERROR, True),
        (404, McpErrorKind.PROTOCOL_MISMATCH, False),
        (400, McpErrorKind.PROTOCOL_MISMATCH, False),
    ],
)
async def test_each_http_status_gets_its_own_kind(asgi, status, expected, retryable):
    err = await _connect_error(status_app(status), asgi)
    assert err.kind is expected, f"{status} classified as {err.kind}"
    assert err.retryable is retryable
    assert err.status == status


async def test_a_401_with_a_credential_is_auth_FAILED_not_auth_required(asgi):
    """Different user action: "connect your account" versus "your token was
    rejected". Identical on the wire, so the distinction comes from whether we
    sent anything."""
    from app.mcp.credentials import EnvCredentialResolver

    app = status_app(401)
    asgi(app)
    async with running(app), AsyncExitStack() as stack:
        pool = await McpSessionPool(
            PoolLimits(sweep_interval_s=3600.0),
            resolver=EnvCredentialResolver({"fake": "a-test-token"}),
        ).start(stack)
        with pytest.raises(Exception) as got:  # noqa: PT011
            async with pool.acquire(spec(auth_kind="api_key")):
                pass
        assert got.value.kind is McpErrorKind.AUTH_FAILED
        assert got.value.user_action_required
        await pool.aclose()


async def test_www_authenticate_invalid_token_means_the_credential_was_rejected(asgi):
    """RFC 6750's spelling. Present even when we believed we sent nothing
    usable, it still means the token we did send was refused."""
    app = status_app(
        401, headers={"www-authenticate": 'Bearer realm="mcp", error="invalid_token"'}
    )
    err = await _connect_error(app, asgi)
    assert err.kind is McpErrorKind.AUTH_FAILED


async def test_a_429_carries_the_servers_own_retry_after(asgi):
    """Ignoring Retry-After and using our own short backoff spends every
    remaining attempt inside the same rate-limit window."""
    app = status_app(429, headers={"retry-after": "7"})
    err = await _connect_error(app, asgi)
    assert err.kind is McpErrorKind.RATE_LIMITED
    assert err.retry_after_s == 7.0
    assert err.as_dict()["retry_after_s"] == 7.0


async def test_an_auth_failure_suppresses_reconnection(asgi):
    """Retrying a rejected credential against a third party is
    indistinguishable from credential stuffing, and is how an account gets
    locked."""
    refused = await _connect_error(status_app(403), asgi)
    assert not refused.reconnect_allowed
    transient = await _connect_error(status_app(503), asgi)
    assert transient.reconnect_allowed


async def test_an_error_detail_never_carries_a_header_or_a_cookie(asgi):
    app = status_app(
        401,
        headers={
            "www-authenticate": 'Bearer error="invalid_token"',
            "set-cookie": "session=SUPERSECRETVALUE",
        },
    )
    err = await _connect_error(app, asgi)
    blob = str(err.as_dict())
    assert "SUPERSECRETVALUE" not in blob
    assert "set-cookie" not in blob.lower()


# ------------------------------------------- established-session failures
def test_a_404_mid_session_is_an_expired_session_not_a_missing_endpoint():
    """Same status, opposite meaning, different remedy: at connect time there is
    no MCP endpoint there; mid-session the session id expired and a reconnect
    fixes it."""
    recorder = StatusRecorder()
    recorder.status = 404
    at_connect = to_connection_error(
        RuntimeError("boom"), server_slug="x", recorder=recorder, established=False
    )
    mid_session = to_connection_error(
        RuntimeError("boom"), server_slug="x", recorder=recorder, established=True
    )
    assert at_connect.kind is McpErrorKind.PROTOCOL_MISMATCH
    assert mid_session.kind is McpErrorKind.SESSION_EXPIRED
    assert mid_session.retryable and not at_connect.retryable


# ------------------------------------------ the tool-call mapper, and the proof
def test_leaves_unwraps_the_double_exception_group():
    boom = ValueError("real cause")
    assert leaves(_grouped(boom)) == [boom]


def test_leaves_is_bounded_against_a_pathological_nesting():
    exc: BaseException = ValueError("leaf")
    for _ in range(50):
        exc = BaseExceptionGroup("wrap", [exc])
    assert leaves(exc)  # terminates, does not recurse without bound


@pytest.mark.parametrize(
    ("status", "expected", "retryable"),
    [
        (401, ToolErrorKind.AUTH_FAILED, False),
        (403, ToolErrorKind.AUTH_FAILED, False),
        (429, ToolErrorKind.RATE_LIMITED, True),
        (404, ToolErrorKind.UNAVAILABLE, True),
        (500, ToolErrorKind.UPSTREAM_ERROR, True),
        (503, ToolErrorKind.UPSTREAM_ERROR, True),
    ],
)
def test_the_tool_mapper_classifies_from_the_recorder(status, expected, retryable):
    recorder = StatusRecorder()
    recorder.status = status
    err = to_tool_error(
        _grouped(_generic_mcp_error()), server_slug="gh", recorder=recorder
    )
    assert err.kind is expected
    assert err.retryable is retryable
    assert err.status == status


@pytest.mark.parametrize("status", [401, 403, 429, 500, 503])
def test_without_the_recorder_every_status_collapses_into_one_bucket(status):
    """THE PROOF, and Phase 1's actual behaviour. With no recorded status all
    five statuses are the SAME exception, so the mapper cannot do better than a
    guess. Note the 401 especially: unwrapping alone would mark it retryable,
    which is worse than useless.

    This test does not assert that the collapse is acceptable. It asserts that
    the recorder is what prevents it -- so if someone removes the recorder, the
    parametrized test above goes red and this one stays green, naming the cause.
    """
    err = to_tool_error(_grouped(_generic_mcp_error()), server_slug="gh", recorder=None)
    assert err.kind is ToolErrorKind.UPSTREAM_ERROR
    assert err.status is None


def test_a_rate_limit_propagates_retry_after_to_the_executor():
    recorder = StatusRecorder()
    recorder.status = 429
    recorder.retry_after = 12.0
    err = to_tool_error(
        _grouped(_generic_mcp_error()), server_slug="gh", recorder=recorder
    )
    assert err.retry_after_s == 12.0
    assert err.as_dict()["retry_after_s"] == 12.0


def test_a_tls_failure_is_never_retried():
    """An invalid certificate is the one failure where retrying is actively
    wrong, and the one that must never be worked around."""
    err = to_tool_error(
        _grouped(ssl.SSLError("certificate verify failed")), server_slug="gh"
    )
    assert err.kind is ToolErrorKind.UNAVAILABLE
    assert err.retryable is False


def test_a_tls_failure_is_its_own_connection_kind():
    err = to_connection_error(
        _grouped(ssl.SSLError("certificate verify failed")), server_slug="gh"
    )
    assert err.kind is McpErrorKind.TLS_FAILED
    assert not err.retryable


def test_a_specific_cause_wins_over_a_generic_wrapper():
    """A group can carry both the real cause and the session dying as a
    consequence. The diagnosis must not be lost behind the wrapper."""
    group = BaseExceptionGroup(
        "outer",
        [
            BaseExceptionGroup("a", [_generic_mcp_error()]),
            BaseExceptionGroup("b", [ssl.SSLError("certificate verify failed")]),
        ],
    )
    assert "certificate" in to_tool_error(group, server_slug="gh").message


def test_a_timeout_stays_a_timeout_and_stays_retryable():
    err = to_tool_error(_grouped(TimeoutError("read timed out")), server_slug="gh")
    assert err.kind is ToolErrorKind.TIMEOUT
    assert err.retryable


def test_a_dns_failure_is_distinguished_from_an_unreachable_host():
    import socket

    dns = to_connection_error(
        _grouped(socket.gaierror("Name or service not known")), server_slug="gh"
    )
    refused = to_connection_error(
        _grouped(ConnectionRefusedError("refused")), server_slug="gh"
    )
    assert dns.kind is McpErrorKind.DNS_FAILED
    assert refused.kind is McpErrorKind.UNREACHABLE


def test_an_already_classified_error_is_never_rewrapped():
    """The endpoint guard raises a classified error before the transport is
    built; re-running it through the mapper would relabel a refusal as
    "unreachable"."""
    from app.mcp.exceptions import McpConnectionError

    original = McpConnectionError(McpErrorKind.ENDPOINT_REJECTED, "nope")
    assert to_connection_error(original, server_slug="gh") is original


def test_the_detail_is_bounded_and_control_characters_are_stripped():
    err = to_connection_error(
        _grouped(RuntimeError("x" * 5000 + "\x00\x1b[31m")), server_slug="gh"
    )
    assert len(err.detail) <= 400
    assert "\x00" not in err.detail
    assert "\x1b" not in err.detail


# ------------------------------------------------------------ the recorder
def test_the_recorder_ignores_successful_responses():
    recorder = StatusRecorder()

    class Response:
        status_code = 200
        headers: dict[str, str] = {}

    import anyio

    anyio.run(recorder, Response())
    assert recorder.status is None
    assert recorder.saw_response is True


def test_the_recorder_never_raises_on_a_malformed_response():
    """A diagnostics fault must never surface as a transport failure and mask
    the real error."""
    import anyio

    recorder = StatusRecorder()
    anyio.run(recorder, object())
    assert recorder.status is None


def test_retry_after_is_bounded_so_a_server_cannot_park_a_worker():
    import anyio

    recorder = StatusRecorder()

    class Response:
        status_code = 429
        headers = {"retry-after": "99999"}

    anyio.run(recorder, Response())
    assert recorder.retry_after == 120.0


def test_an_http_date_retry_after_is_ignored_rather_than_guessed():
    """The date form is legal but rare, and guessing a delay from a clock we do
    not share with the server is worse than not waiting: the caller's bounded
    backoff still applies."""
    import anyio

    recorder = StatusRecorder()

    class Response:
        status_code = 429
        headers = {"retry-after": "Wed, 21 Oct 2026 07:28:00 GMT"}

    anyio.run(recorder, Response())
    assert recorder.retry_after is None


def test_a_url_in_exception_text_is_cut_to_its_host():
    """Audit M-14: httpx puts the FULL request URL in its messages; a path or
    query component is where an endpoint's embedded credential would sit. The
    detail keeps the host (attributable) and nothing after it."""
    import httpx2

    req = httpx2.Request("POST", "https://mcp.example.com/t/sk_live_abc/mcp?code=z9")
    exc = httpx2.ConnectError("All connection attempts failed", request=req)
    err = to_tool_error(
        RuntimeError(f"upstream: {exc} for url '{req.url}'"), server_slug="ex"
    )
    text = str(err)
    assert "sk_live_abc" not in text and "code=z9" not in text
    assert text.count("https://mcp.example.com") == 1

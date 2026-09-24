"""Wait minutes for tokens, seconds for a connection.

THE PRODUCTION FAILURE this pins (2026-09-16): `api.ollima.com` stopped
accepting TCP connections while DNS still resolved and the VM's other egress was
healthy. `build_llm` passed a scalar `timeout=180.0`, which httpx applies to
EVERY phase, so each attempt spent 180s in the handshake and `max_retries=2`
made that 540s. The 300s generation deadline fired first, so two different users
watched a spinner for five minutes and were told only "This response took too
long and was stopped" — and because nothing was ever raised, the router's health
bookkeeping never learned the model was unreachable and picked it again.
"""

from __future__ import annotations

import httpx

from app.agent.llm import _with_connect_timeout, build_llm
from tests.conftest import make_settings


def test_a_scalar_budget_is_split_into_connect_and_read():
    s = make_settings("http://x")
    t = _with_connect_timeout(180.0, s)
    assert isinstance(t, httpx.Timeout)
    assert t.connect == s.ai_model_connect_timeout_s
    assert t.read == 180.0, "a generation still gets its full token budget"


def test_the_connect_budget_is_seconds_not_minutes():
    """The whole point: an unreachable provider must fail fast enough that the
    turn can report it, rather than being killed by the deadline."""
    s = make_settings("http://x")
    assert 0 < s.ai_model_connect_timeout_s <= 30
    assert _with_connect_timeout(180.0, s).connect <= 30


def test_a_caller_with_a_shorter_budget_is_never_lengthened():
    """An interactive caller passes a small timeout on purpose."""
    s = make_settings("http://x")
    assert _with_connect_timeout(3.0, s).connect == 3.0


def test_an_explicit_httpx_timeout_is_respected_unchanged():
    s = make_settings("http://x")
    given = httpx.Timeout(20.0, connect=1.5)
    assert _with_connect_timeout(given, s) is given


def test_a_foreign_timeout_class_is_respected_rather_than_crashed():
    """THE PRODUCTION FAILURE this pins (2026-09-24): every scheduled-task parse
    raised TypeError before a socket was opened, on both candidate models, for
    every user — the composer's Create button was permanently disabled.

    `schedule.py` passes `openai.DEFAULT_TIMEOUT` on purpose, so a complex parse
    is not killed by a short deadline. But that object is built by the httpx the
    OPENAI package imports, which here is `httpx2` — a different module object —
    so `isinstance(..., httpx.Timeout)` was False and the scalar branch ran
    `float(<Timeout>)`. The test above passes a REAL httpx.Timeout and therefore
    never went near the bug; this one passes the value production actually uses.
    """
    import openai

    s = make_settings("http://x")
    given = openai.DEFAULT_TIMEOUT
    assert not isinstance(given, httpx.Timeout), (
        "if openai ever shares our httpx this assertion is stale, but the "
        "pass-through below must keep working either way"
    )
    assert _with_connect_timeout(given, s) is given


def test_the_schedule_parser_can_actually_build_its_client():
    """End to end with the parser's OWN constant, which is the thing that broke.
    A unit test of the helper alone would not have caught the call site."""
    from app.routers.schedule import PARSE_TIMEOUT

    s = make_settings("http://x")
    llm = build_llm(
        s,
        model="deepseek-v4-pro",
        base_url="https://api.test/v1",
        api_key="k",
        timeout=PARSE_TIMEOUT,
        max_retries=0,
    )
    assert llm is not None


def test_the_built_client_carries_the_split_timeout():
    """End to end through the real builder, so a refactor that drops the split
    fails here rather than on production."""
    s = make_settings("http://x")
    llm = build_llm(
        s, model="deepseek-v4-pro", base_url="https://api.test/v1", api_key="k"
    )
    timeout = llm.async_client._client.timeout
    assert isinstance(timeout, httpx.Timeout)
    assert timeout.connect == s.ai_model_connect_timeout_s
    assert timeout.read and timeout.read > timeout.connect


# ------------------------------------------------- how long we believe it
def test_unreachable_is_classified_apart_from_a_provider_error():
    """An expired credential does not fix itself; a network outage does. They
    are remembered for very different lengths of time, so they must be told
    apart first."""
    import httpx
    import openai

    from app.agent.llm import is_quota_error, is_unreachable_error

    unreachable = [
        openai.APIConnectionError(
            request=httpx.Request("POST", "https://api.test/v1/chat/completions")
        ),
        httpx.ConnectError("All connection attempts failed"),
        httpx.ConnectTimeout("timed out"),
        RuntimeError("Connection refused"),
        RuntimeError("Name or service not known"),
    ]
    for exc in unreachable:
        assert is_unreachable_error(exc), type(exc).__name__

    # A refusal is not an absence: these say the provider ANSWERED.
    for exc in (
        RuntimeError("Error 429 Too Many Requests: rate limit"),
        RuntimeError("insufficient_quota: you have reached your usage limit"),
        RuntimeError("APIStatusError 500 internal server error"),
        RuntimeError("invalid_api_key"),
    ):
        assert not is_unreachable_error(exc), str(exc)

    quota = RuntimeError("Error 429 Too Many Requests: rate limit")
    assert is_quota_error(quota) and not is_unreachable_error(quota)


def test_an_unreachable_provider_is_believed_briefly_not_for_an_hour():
    """The recovery half of the production bug: every model on the dead host was
    blacklisted for the HARD ttl (3600s), so the outage would have kept costing
    users for an hour after the host came back."""
    s = make_settings("http://x")
    assert s.ai_model_health_unreachable_ttl_s <= 120
    assert s.ai_model_health_unreachable_ttl_s < s.ai_model_health_hard_ttl_s

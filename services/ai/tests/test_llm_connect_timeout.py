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

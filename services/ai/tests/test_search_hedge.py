"""Hedged web search (clients/ollagraph.py).

While search is degraded, the executor's sequential retries are REPLACED by one
parallel round — never added to: at most three attempts per call either way.
Real OllagraphAdapter over httpx.MockTransport; the executor test uses a real
ToolExecContext with production's retry count.
"""

from __future__ import annotations

import asyncio
import time

import httpx
import pytest

from app.agent.executor import ToolExecContext, execute_tool_calls
from app.agent.policy import READ_SCOPE
from app.agent.search_guard import SEARCH_TOOL_IDS
from app.clients import ollagraph
from app.clients.ollagraph import OllagraphAdapter
from app.config import Settings
from app.models.tools import (
    Availability,
    SideEffect,
    ToolDefinition,
    ToolPermissions,
)
from app.runtime.writer import DeltaWriter
from app.tools.errors import ToolError, ToolErrorKind
from app.tools.registry import ToolRegistry
from tests.test_writer_events import RecordingConvex

KEY = "osk_testkey_abcdefgh1234"
SEARCH_ID = next(iter(SEARCH_TOOL_IDS))
SCHEMA = {"properties": {"query": {"type": "string"}}}
ARGS = {"query": "latest news"}


def _tool(tool_id: str = SEARCH_ID, **over) -> ToolDefinition:
    base = dict(
        tool_id=tool_id,
        name="Search",
        path="/v1/search",
        method="post",
        side_effect=SideEffect.READ_ONLY,
        enabled=True,
        availability=Availability.AVAILABLE,
        permissions=ToolPermissions(required_permissions=["ollagraph:read"]),
        input_schema={"type": "object", **SCHEMA},
    )
    base.update(over)
    return ToolDefinition(**base)


@pytest.fixture(autouse=True)
def _fresh_gate():
    # conftest resets the search window for every test; the gate is reset here
    # too, because these tests narrow it.
    ollagraph._gate = None
    yield
    ollagraph._gate = None


def _settings(**over) -> Settings:
    return Settings(
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key=KEY,
        **over,
    )


def _adapter(handler, **over):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return OllagraphAdapter(_settings(**over), client), client


def _degrade(failed: int = 5, ok: int = 0) -> None:
    for _ in range(failed):
        ollagraph._record_search(True)
    for _ in range(ok):
        ollagraph._record_search(False)


def _always(status: int):
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(status, json={"hits": []})

    return handler, calls


async def _call(adapter, tool=None):
    return await adapter.call_tool(tool or _tool(), ARGS, input_schema=SCHEMA)


# --- healthy: exactly the old single request --------------------------------
async def test_healthy_search_sends_exactly_one_request():
    handler, calls = _always(200)
    adapter, client = _adapter(handler)
    try:
        out = await _call(adapter)
    finally:
        await client.aclose()
    assert out["ok"] is True
    assert calls["n"] == 1
    assert [failed for _, failed in ollagraph._search_outcomes] == [False]


async def test_a_single_unhedged_failure_stays_retryable_for_the_executor():
    handler, calls = _always(502)
    adapter, client = _adapter(handler)
    try:
        with pytest.raises(ToolError) as ei:
            await _call(adapter)
    finally:
        await client.aclose()
    assert calls["n"] == 1
    assert ei.value.retryable is True


# --- degraded: one parallel round -------------------------------------------
async def test_degraded_search_races_and_the_first_success_wins():
    _degrade()
    calls = {"n": 0}

    async def handler(req):
        calls["n"] += 1
        k = calls["n"]
        if k == 1:
            return httpx.Response(502, json={})
        await asyncio.sleep(0.02 if k == 2 else 2.0)
        return httpx.Response(200, json={"attempt": k})

    adapter, client = _adapter(handler)
    before = len(asyncio.all_tasks())
    t0 = time.monotonic()
    try:
        out = await _call(adapter)
    finally:
        await client.aclose()
    assert out["data"] == {"attempt": 2}
    assert calls["n"] == 3
    # The slow third attempt was cancelled, not awaited to completion.
    assert time.monotonic() - t0 < 1.0
    assert len(asyncio.all_tasks()) == before, "a hedge task outlived the call"
    assert ollagraph._hedge_extra_in_flight == 0


async def test_a_failed_round_is_non_retryable_after_exactly_three_attempts():
    _degrade()
    handler, calls = _always(502)
    adapter, client = _adapter(handler)
    try:
        with pytest.raises(ToolError) as ei:
            await _call(adapter)
    finally:
        await client.aclose()
    assert calls["n"] == 3
    assert ei.value.kind == ToolErrorKind.UPSTREAM_ERROR
    assert ei.value.status == 502
    assert ei.value.retryable is False
    assert ollagraph._hedge_extra_in_flight == 0


async def test_the_executor_does_not_multiply_a_failed_round():
    # Production retries twice (three attempts). Hedged, the round IS those three
    # attempts: the executor must not run the round again — 3 requests, never 9.
    _degrade()
    handler, calls = _always(502)
    s = _settings()
    reg = ToolRegistry()
    reg.register(_tool())
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    ctx = ToolExecContext(
        registry=reg,
        adapter=OllagraphAdapter(s, client),
        writer=DeltaWriter(RecordingConvex(), "s1", s),
        scope=READ_SCOPE,
        name_to_tool_id={SEARCH_ID: SEARCH_ID},
        result_max_chars=8000,
        default_timeout_s=30.0,
        tool_max_retries=2,
    )
    try:
        msgs = await execute_tool_calls(
            [{"name": SEARCH_ID, "args": ARGS, "id": "c1"}], ctx
        )
    finally:
        await client.aclose()
    assert len(msgs) == 1 and msgs[0].status == "error"
    assert calls["n"] == 3


async def test_a_hung_round_ends_non_retryably_before_the_executor_timeout():
    # The executor's own wait_for uses the same timeout, and ITS TimeoutError is
    # retryable — so the round must end first, or a hang would run it 3 times.
    _degrade()

    async def handler(req):
        await asyncio.sleep(5)
        return httpx.Response(200, json={})

    adapter, client = _adapter(handler)
    t0 = time.monotonic()
    try:
        with pytest.raises(ToolError) as ei:
            await _call(adapter, _tool(timeout=1.2))
    finally:
        await client.aclose()
    assert time.monotonic() - t0 < 1.2
    assert ei.value.kind == ToolErrorKind.TIMEOUT
    assert ei.value.retryable is False


async def test_a_429_is_never_hedged_into():
    _degrade()
    calls = {"n": 0}

    async def handler(req):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, json={})
        await asyncio.sleep(2.0)
        return httpx.Response(200, json={})

    adapter, client = _adapter(handler)
    t0 = time.monotonic()
    try:
        with pytest.raises(ToolError) as ei:
            await _call(adapter)
    finally:
        await client.aclose()
    # Raised as it arrived — retryable, with the provider's own backoff intact —
    # and the rest of the round was cancelled rather than awaited.
    assert ei.value.kind == ToolErrorKind.RATE_LIMITED
    assert ei.value.retryable is True
    assert time.monotonic() - t0 < 1.0


# --- guards ------------------------------------------------------------------
async def test_no_hedging_while_the_gate_is_narrowed():
    _degrade()
    handler, calls = _always(502)
    adapter, client = _adapter(handler)
    ollagraph.tool_gate(_settings())._limit = ollagraph._HEDGE_MIN_GATE - 1
    try:
        with pytest.raises(ToolError):
            await _call(adapter)
    finally:
        await client.aclose()
    assert calls["n"] == 1


async def test_hedging_respects_the_process_wide_cap():
    _degrade()
    handler, calls = _always(502)
    adapter, client = _adapter(handler)
    ollagraph._hedge_extra_in_flight = ollagraph._HEDGE_MAX_EXTRA_IN_FLIGHT - 1
    try:
        with pytest.raises(ToolError):
            await _call(adapter)
    finally:
        await client.aclose()
    assert calls["n"] == 2  # one extra left under the cap
    assert ollagraph._hedge_extra_in_flight == ollagraph._HEDGE_MAX_EXTRA_IN_FLIGHT - 1


async def test_other_tools_are_never_hedged():
    _degrade()
    handler, calls = _always(502)
    adapter, client = _adapter(handler)
    try:
        with pytest.raises(ToolError) as ei:
            await _call(adapter, _tool("scrape", path="/v1/scrape"))
    finally:
        await client.aclose()
    assert calls["n"] == 1
    assert ei.value.retryable is True


async def test_the_flag_turns_hedging_off():
    _degrade()
    handler, calls = _always(502)
    adapter, client = _adapter(handler, ai_search_hedge_enabled=False)
    try:
        with pytest.raises(ToolError):
            await _call(adapter)
    finally:
        await client.aclose()
    assert calls["n"] == 1


def test_degradation_needs_enough_recent_failures():
    assert not ollagraph._search_degraded()
    _degrade(failed=1, ok=3)
    assert not ollagraph._search_degraded()  # too few samples
    _degrade(failed=1, ok=0)
    assert ollagraph._search_degraded()  # 2 of 5 = 40%


def test_stale_failures_do_not_count():
    old = time.monotonic() - ollagraph._SEARCH_MAX_AGE_S - 1
    for _ in range(10):
        ollagraph._search_outcomes.append((old, True))
    assert not ollagraph._search_degraded()


async def test_client_errors_do_not_mark_search_degraded():
    handler, _ = _always(400)
    adapter, client = _adapter(handler)
    try:
        for _ in range(6):
            with pytest.raises(ToolError):
                await _call(adapter)
    finally:
        await client.aclose()
    assert not ollagraph._search_degraded()

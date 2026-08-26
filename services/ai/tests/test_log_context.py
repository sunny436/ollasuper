"""H1 (QA-8 observability): thin per-tool log lines must be attributable to a run.

`agent.tool_cost` / `agent.tool_retry` / `tool.provider_error` are emitted deep in
the executor/adapter, where the stream/user ids aren't in hand — so on prod they
carried only `tool_id`, and a cost/provider-error incident could not be tied to a run
without timestamp-guessing. The fix: a task-isolated logging ContextFilter injects the
bound `stream_id`/`user_id` onto EVERY record, and the executor stamps `execution_id`
on the lines where it holds one. These tests lock both halves in.
"""

from __future__ import annotations

import logging

import httpx
import pytest

from app.agent.executor import execute_tool_calls
from app.logging import (
    ContextFilter,
    _stream_id,
    _user_id,
    bind_log_context,
)
from tests.test_agent_executor import _read_tool, _tc
from tests.test_control import _ctx_resp


def _record(msg: str = "m", **extra: object) -> logging.LogRecord:
    r = logging.LogRecord("t", logging.INFO, __file__, 0, msg, None, None)
    for k, v in extra.items():
        setattr(r, k, v)
    return r


# --- the ContextFilter: inject bound ids onto every record ----------------
def test_context_filter_injects_bound_ids():
    _stream_id.set(None)
    _user_id.set(None)
    bind_log_context("stream-abc", "user-xyz")
    r = _record("agent.tool_cost", tool_id="t")
    assert ContextFilter().filter(r) is True
    assert r.stream_id == "stream-abc"
    assert r.user_id == "user-xyz"


def test_context_filter_does_not_overwrite_explicit_extra():
    # generation_finished sets stream_id itself; the injector must not clobber it.
    bind_log_context("stream-abc", "user-xyz")
    r = _record("generation_finished", stream_id="explicit")
    ContextFilter().filter(r)
    assert r.stream_id == "explicit"


def test_no_ids_bound_leaves_record_unchanged():
    _stream_id.set(None)
    _user_id.set(None)
    r = _record("x")
    ContextFilter().filter(r)
    assert not hasattr(r, "stream_id")
    assert not hasattr(r, "user_id")


# --- the executor stamps execution_id on its thin cost/retry lines --------
@pytest.mark.anyio
async def test_tool_cost_log_carries_execution_id(caplog):
    def handler(req):
        # A read-only 200 with a credit-cost header → the executor logs
        # agent.tool_cost, which must now carry the execution's own id.
        return httpx.Response(
            200, json={"data": {"ok": True}}, headers={"x-credits-cost": "3"}
        )

    ctx, _convex, client = _ctx_resp(handler, [_read_tool()])
    with caplog.at_level(logging.INFO, logger="app.agent.executor"):
        try:
            await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
        finally:
            await client.aclose()
    recs = [r for r in caplog.records if r.getMessage() == "agent.tool_cost"]
    assert recs, "expected an agent.tool_cost log line"
    assert getattr(recs[0], "execution_id", None), "cost line lacks execution_id"

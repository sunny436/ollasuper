"""Phase 8 — the durable approval decision gate in the executor.

Exercises the rewritten NEEDS_APPROVAL branch end-to-end over the real
OllagraphAdapter (httpx.MockTransport) + real DeltaWriter (RecordingConvex):
approved WITH a token executes exactly once; rejected/expired inject a rejection
and never execute; a missing decision suspends (parks) and never executes; and
the staging force-flag promotes a read-only tool to approval-gated.
"""

from __future__ import annotations

import hashlib
import json

import httpx
import pytest

from app.agent.executor import execute_tool_calls
from app.models.tools import SideEffect, ToolPermissions
from tests.test_agent_executor import _ctx, _events, _read_tool, _tc

pytestmark = pytest.mark.anyio


def _approval_id(tool_id: str, args: dict) -> str:
    dedup = json.dumps(args, sort_keys=True, default=str)
    return f"{tool_id}:{hashlib.sha256(dedup.encode()).hexdigest()[:16]}"


def _ok_handler(called: dict):
    def handler(req):
        called["n"] += 1
        return httpx.Response(200, json={"data": {"ok": True}})

    return handler


def _high_tool():
    return _read_tool(
        side_effect=SideEffect.HIGH_IMPACT, permissions=ToolPermissions()
    )


async def test_approved_decision_executes_the_tool_once():
    called = {"n": 0}
    ctx, convex, client = _ctx(_ok_handler(called), [_high_tool()])
    ctx.approvals = {
        _approval_id("search_web", {"q": "x"}): {
            "decision": "approved",
            "token": "tok_1",
        }
    }
    try:
        msgs = await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert called["n"] == 1  # approved WITH a token → executed exactly once
    assert _events(convex, "TOOL_CALL")  # reached the ALLOW/execute path
    assert ctx.writer.suspended is False
    assert msgs[0].tool_call_id == "c1"


@pytest.mark.parametrize("decision", ["rejected", "expired"])
async def test_rejected_or_expired_never_executes(decision: str):
    called = {"n": 0}
    ctx, convex, client = _ctx(_ok_handler(called), [_high_tool()])
    ctx.approvals = {
        _approval_id("search_web", {"q": "x"}): {"decision": decision, "token": None}
    }
    try:
        msgs = await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert called["n"] == 0  # NEVER executes without approval
    assert ctx.writer.suspended is False  # a resolved decision does not suspend
    body = json.loads(msgs[0].content)
    assert body["status"] == decision


async def test_missing_decision_suspends_and_does_not_execute():
    called = {"n": 0}
    ctx, convex, client = _ctx(_ok_handler(called), [_high_tool()])
    ctx.approvals = {}  # no decision yet
    try:
        msgs = await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert called["n"] == 0
    assert ctx.writer.suspended is True  # parked, not executed
    assert [c for c in convex.calls if c.get("op") == "approval"]
    body = json.loads(msgs[0].content)
    assert body["status"] == "awaiting_approval"


async def test_approved_without_token_is_not_accepted():
    # A decision missing its server-minted token is NOT a valid capability.
    called = {"n": 0}
    ctx, convex, client = _ctx(_ok_handler(called), [_high_tool()])
    ctx.approvals = {
        _approval_id("search_web", {"q": "x"}): {"decision": "approved", "token": None}
    }
    try:
        await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert called["n"] == 0  # missing token → falls through to park, never runs
    assert ctx.writer.suspended is True


async def test_force_flag_promotes_a_read_only_tool_to_approval_gated():
    # The staging trigger: a benign READ_ONLY tool, promoted, still suspends
    # rather than executing — so the round-trip is verifiable with no real
    # high-impact tool.
    called = {"n": 0}
    ctx, convex, client = _ctx(_ok_handler(called), [_read_tool()])
    ctx.force_approval_ids = frozenset({"search_web"})
    ctx.approvals = {}
    try:
        await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()
    assert called["n"] == 0
    assert ctx.writer.suspended is True
    assert [c for c in convex.calls if c.get("op") == "approval"]

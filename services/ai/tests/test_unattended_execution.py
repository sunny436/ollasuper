"""Phase 2 — the two security properties of UNATTENDED (scheduled) execution.

Both exist because nobody is present to approve anything:

  * an approval-gated tool is REFUSED with a durable reason instead of parking
    the turn (a parked unattended turn would hang until the approval reaper
    expired it, burning the occurrence for nothing);
  * the agent is pinned to READ_ONLY scope EVEN IF an operator has turned on
    `ai_agent_side_effect_enabled` for interactive chat — that flag is global,
    and background jobs must not inherit an elevation meant for a human who is
    watching and clicking approve.
"""

from __future__ import annotations

import httpx
import pytest
from langchain_core.messages import AIMessage

from app.agent.executor import execute_tool_calls
from app.agent.policy import PolicyDecision, check_tool_policy
from app.models.tools import SideEffect, ToolPermissions
from app.runtime.runner import run_generation
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.conftest import make_settings
from tests.test_agent_executor import _ctx, _events, _read_tool, _tc
from tests.test_agent_runner import FakeLLM, RecordingConvex, _req

pytestmark = pytest.mark.anyio


def _side_effecting_tool():
    """A tool the default read-only scope cannot run without approval."""
    return _read_tool(
        side_effect=SideEffect.EXTERNAL_SIDE_EFFECT, permissions=ToolPermissions()
    )


def _never_called(called: dict):
    def handler(req):
        called["n"] += 1
        return httpx.Response(200, json={"data": {"ok": True}})

    return handler


# ── the refusal ─────────────────────────────────────────────────────────────


async def test_an_approval_gated_tool_is_refused_not_parked():
    called = {"n": 0}
    ctx, convex, client = _ctx(_never_called(called), [_side_effecting_tool()])
    ctx.unattended = True
    try:
        msgs = await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()

    # The tool never ran…
    assert called["n"] == 0
    # …the turn was NOT parked (that is the hang this exists to prevent)…
    assert ctx.writer.suspended is False
    # …and the model got a durable, self-explaining refusal it can answer around.
    assert "approval_required_for_unattended_execution" in msgs[0].content
    # The ledger stays honest: a real terminal TOOL_RESULT was emitted.
    results = _events(convex, "TOOL_RESULT")
    assert results, "an unattended refusal must still record a tool result"
    # And no approval request was ever raised to a human who is not there.
    assert not [c for c in convex.calls if c.get("op") == "approval"]


async def test_an_ATTENDED_turn_still_parks_exactly_as_before():
    """Regression guard: interactive chat behaviour must be untouched."""
    called = {"n": 0}
    ctx, convex, client = _ctx(_never_called(called), [_side_effecting_tool()])
    assert ctx.unattended is False  # the default
    try:
        msgs = await execute_tool_calls([_tc("search_web", {"q": "x"}, "c1")], ctx)
    finally:
        await client.aclose()

    assert called["n"] == 0
    assert ctx.writer.suspended is True  # parked, awaiting a human
    assert "awaiting_approval" in msgs[0].content


async def test_a_batch_of_approval_gated_calls_is_refused_individually():
    """The batch pre-scan must not divert an unattended turn into parking."""
    called = {"n": 0}
    ctx, convex, client = _ctx(_never_called(called), [_side_effecting_tool()])
    ctx.unattended = True
    try:
        msgs = await execute_tool_calls(
            [
                _tc("search_web", {"q": "a"}, "c1"),
                _tc("search_web", {"q": "b"}, "c2"),
            ],
            ctx,
        )
    finally:
        await client.aclose()

    assert called["n"] == 0
    assert ctx.writer.suspended is False
    assert len(msgs) == 2
    for m in msgs:
        assert "approval_required_for_unattended_execution" in m.content


def test_the_default_scope_already_refuses_side_effects():
    """The conservative unattended policy is INHERITED, not invented.

    `READ_SCOPE` — what every turn gets unless an operator elevates — already
    resolves a side-effecting tool to NEEDS_APPROVAL and hard-denies an
    admin-scoped one. Unattended execution simply never leaves that scope.
    """
    from app.agent.policy import READ_SCOPE

    assert (
        check_tool_policy(_side_effecting_tool(), READ_SCOPE).decision
        is PolicyDecision.NEEDS_APPROVAL
    )
    admin = _read_tool(required_auth="AdminToken")
    assert check_tool_policy(admin, READ_SCOPE).decision is PolicyDecision.DENY


# ── the scope pin (C2) ──────────────────────────────────────────────────────


class _Capture:
    """Records the ToolExecContext the runner builds for a turn."""

    def __init__(self) -> None:
        self.seen: list = []

    def install(self, monkeypatch):
        import app.runtime.runner as runner_mod

        real = runner_mod.ToolExecContext
        seen = self.seen

        def spy(*args, **kwargs):
            ctx = real(*args, **kwargs)
            seen.append(ctx)
            return ctx

        monkeypatch.setattr(runner_mod, "ToolExecContext", spy)


async def _run_with_side_effects_enabled(monkeypatch, *, unattended: bool):
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: FakeLLM(AIMessage(content="done"), [AIMessage(content="done")]),
    )
    settings = make_settings(
        "http://x",
        ai_agent_enabled=True,
        # The operator has turned side effects ON for interactive chat.
        ai_agent_side_effect_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
    )
    reg = ToolRegistry()
    reg.register(_read_tool())
    cap = _Capture()
    cap.install(monkeypatch)

    http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={}))
    )
    req = _req("do something")
    req = req.model_copy(update={"unattended": unattended})
    try:
        await run_generation(
            req,
            settings,
            RecordingConvex(),
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    assert cap.seen, "the runner did not build a tool context"
    return cap.seen[-1]


async def test_an_unattended_turn_stays_read_only_even_when_side_effects_are_on(
    monkeypatch,
):
    ctx = await _run_with_side_effects_enabled(monkeypatch, unattended=True)
    # THE security property: a global operator flag must not silently elevate
    # a background job that has nobody watching it.
    assert ctx.scope.max_side_effect is SideEffect.READ_ONLY
    assert "ollagraph:write" not in ctx.scope.granted_permissions
    assert ctx.unattended is True


async def test_an_interactive_turn_still_gets_the_elevated_scope(monkeypatch):
    """The operator's flag must keep working for the case it was meant for."""
    ctx = await _run_with_side_effects_enabled(monkeypatch, unattended=False)
    assert ctx.scope.max_side_effect is SideEffect.EXTERNAL_SIDE_EFFECT
    assert "ollagraph:write" in ctx.scope.granted_permissions
    assert ctx.unattended is False


def test_unattended_defaults_off_so_chat_is_unchanged():
    assert _req("hi").unattended is False

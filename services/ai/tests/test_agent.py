"""Phase 9 — the reusable AGENT abstraction.

One shared fake LLM class drives several distinct `AgentSpec`s (proving "same
model, many agents"). Every test runs the agent through the EXISTING Phase 1-8
engine (executor -> strict allowlist -> check_tool_policy -> write-ahead ->
adapter) via `Agent.run`, and asserts the agent adds no execution path and can
only NARROW: identity, agent-specific instructions, shared / restricted tools,
unauthorized-tool refusal (both gates), cancellation, retry, resume-honoring,
the structured output contract, and the observability identity — plus a grounding
test that `build_context(DEFAULT_AGENT)` reproduces the runner's assembly.
"""

from __future__ import annotations

import json
from dataclasses import replace

import pytest
from langchain_core.messages import AIMessage, SystemMessage

from app.agent.base import Agent, AgentEnv
from app.agent.spec import (
    DEFAULT_AGENT,
    AgentOutcome,
    AgentSpec,
    CapabilityPolicy,
    ExecutionPolicy,
    OutputContract,
)
from app.models.tools import SideEffect, ToolCandidate, ToolPermissions
from app.runtime.writer import DeltaWriter
from app.tools.errors import ToolError, ToolErrorKind
from app.tools.registry import ToolRegistry
from tests.test_agent_executor import _read_tool, _settings
from tests.test_agent_graph import FakeAdapter, ScriptedLLM, _tc
from tests.test_writer_events import RecordingConvex

pytestmark = pytest.mark.anyio


def _cands(tools):
    return [ToolCandidate(tool=t, score=1.0) for t in tools]


def _env(tools, script, *, adapter=None, resp=None, run_id="run_1", candidates=None):
    reg = ToolRegistry()
    for t in tools:
        reg.register(t)
    convex = RecordingConvex(resp)
    writer = DeltaWriter(convex, "s1", _settings())
    adapter = adapter or FakeAdapter()
    tools_llm = ScriptedLLM(list(script))
    env = AgentEnv(
        writer=writer,
        llm=ScriptedLLM(list(script)),  # plain path (no-tool agents + budget-0)
        run_id=run_id,
        registry=reg,
        adapter=adapter,
        candidates=candidates if candidates is not None else _cands(tools),
        bind=lambda specs: tools_llm,
    )
    return env, convex, adapter


def _events(convex, etype):
    out = []
    for c in convex.calls:
        if c.get("op") == "event":
            for e in c["events"]:
                if e["type"] == etype:
                    out.append(json.loads(e["payload"]))
    return out


# 1 — identity ---------------------------------------------------------------
async def test_agent_identity_on_result_scope_and_trace():
    env, convex, _ = _env(
        [_read_tool()],
        [AIMessage(content="", tool_calls=[_tc("c1")]), AIMessage(content="done")],
    )
    spec = AgentSpec(agent_id="researcher", role="research")
    res = await Agent.run(spec, "find X", env)
    assert res.agent_id == "researcher"
    scope = Agent.build_scope(spec, user_id="u1", workspace_id="w1")
    assert scope.agent_id == "researcher" and scope.user_id == "u1"
    mc = _events(convex, "MODEL_CALL")
    assert mc and all(m.get("agent_id") == "researcher" for m in mc)


# 2 — agent-specific instructions -------------------------------------------
class _RecordingLLM:
    def __init__(self, responses):
        self._r = responses
        self.calls = 0
        self.seen: list = []

    async def ainvoke(self, messages, *a, **k):
        self.seen.append(list(messages))
        self.calls += 1
        return self._r[min(self.calls - 1, len(self._r) - 1)]


async def test_agent_specific_instructions_reach_the_model():
    reg = ToolRegistry()
    reg.register(_read_tool())
    writer = DeltaWriter(RecordingConvex(), "s1", _settings())
    rec = _RecordingLLM([AIMessage(content="ok")])
    env = AgentEnv(
        writer=writer, llm=rec, run_id="run_1", registry=reg,
        adapter=FakeAdapter(), candidates=_cands([_read_tool()]),
    )
    # A no-tool agent -> plain graph -> env.llm receives the composed system prompt.
    spec = AgentSpec(
        agent_id="a1", instructions="PERSONA_ALPHA",
        capability=CapabilityPolicy(tool_ids=frozenset()),
    )
    await Agent.run(spec, "hi", env)
    first = rec.seen[0]
    assert any(
        isinstance(m, SystemMessage) and "PERSONA_ALPHA" in m.content for m in first
    )


# 3 — shared tools -----------------------------------------------------------
async def test_shared_tools_run_through_the_engine():
    env, convex, adapter = _env(
        [_read_tool()],
        [AIMessage(content="", tool_calls=[_tc("c1")]), AIMessage(content="done")],
    )
    res = await Agent.run(AgentSpec(agent_id="a1"), "q", env)
    assert adapter.calls == 1
    assert res.outcome == AgentOutcome.FINAL_ANSWER and res.text == "done"
    types = [
        e["type"]
        for c in convex.calls
        if c.get("op") == "event"
        for e in c["events"]
    ]
    assert "TOOL_CALL" in types and "TOOL_RESULT" in types


# 4 — restricted tools -------------------------------------------------------
async def test_restricted_tools_are_not_bound():
    a = _read_tool(tool_id="alpha", name="alpha", path="/v1/alpha")
    b = _read_tool(tool_id="beta", name="beta", path="/v1/beta")
    env, _, _ = _env([a, b], [AIMessage(content="x")])
    spec = AgentSpec(
        agent_id="a1", capability=CapabilityPolicy(tool_ids=frozenset({"alpha"}))
    )
    ctx, specs = Agent.build_context(spec, env)
    assert set(ctx.name_to_tool_id.values()) == {"alpha"}  # beta excluded
    assert len(specs) == 1


# 5 — unauthorized tool attempt (both gates) --------------------------------
async def test_unauthorized_unbound_tool_is_refused():
    # (a) a hallucinated / unbound name -> strict-allowlist unknown-tool refusal.
    alpha = _read_tool(tool_id="alpha", name="alpha", path="/v1/alpha")
    env, _, adapter = _env(
        [alpha],
        [
            AIMessage(content="", tool_calls=[_tc("c1", name="ghost", args={})]),
            AIMessage(content="fallback"),
        ],
    )
    spec = AgentSpec(
        agent_id="a1", capability=CapabilityPolicy(tool_ids=frozenset({"alpha"}))
    )
    res = await Agent.run(spec, "q", env)
    assert adapter.calls == 0
    assert res.outcome == AgentOutcome.NEEDS_CAPABILITY


async def test_policy_denied_tool_is_refused():
    # (b) a BOUND tool denied by check_tool_policy (missing required permission).
    danger = _read_tool(
        tool_id="danger", name="danger", path="/v1/danger",
        side_effect=SideEffect.EXTERNAL_SIDE_EFFECT,
        permissions=ToolPermissions(required_permissions=["ollagraph:admin"]),
    )
    env, _, adapter = _env(
        [danger],
        [
            AIMessage(content="", tool_calls=[_tc("c1", name="danger", args={})]),
            AIMessage(content="fallback"),
        ],
    )
    # A side-effect agent (WRITE_SCOPE grants read+write, NOT admin) still cannot
    # run an admin-scoped tool.
    spec = AgentSpec(
        agent_id="a2", capability=CapabilityPolicy(side_effects_allowed=True)
    )
    res = await Agent.run(spec, "q", env)
    assert adapter.calls == 0
    assert res.outcome == AgentOutcome.NEEDS_CAPABILITY


# 6 — cancellation -----------------------------------------------------------
async def test_agent_cancellation_yields_failure():
    env, _, adapter = _env(
        [_read_tool()],
        [AIMessage(content="", tool_calls=[_tc("c1")]), AIMessage(content="done")],
    )
    env.writer._cancel_requested = True  # a stop landed before the tool ran
    res = await Agent.run(AgentSpec(agent_id="a1"), "q", env)
    assert res.outcome == AgentOutcome.FAILURE
    assert res.error == {"status": "cancelled"}
    assert adapter.calls == 0


# 7 — retry ------------------------------------------------------------------
class _FlakyAdapter:
    def __init__(self, fail_times):
        self.calls = 0
        self._fail = fail_times

    async def call_tool(
        self, tool, payload, *, input_schema=None, idempotency_key=None,
        user_id="", workspace_id="",
    ):
        self.calls += 1
        if self.calls <= self._fail:
            raise ToolError(ToolErrorKind.RATE_LIMITED, "slow down")
        return {"ok": True, "tool_id": tool.tool_id, "data": {"ok": True}}


async def test_agent_retry_then_success():
    adapter = _FlakyAdapter(fail_times=1)
    env, _, _ = _env(
        [_read_tool()],
        [AIMessage(content="", tool_calls=[_tc("c1")]), AIMessage(content="answered")],
        adapter=adapter,
    )
    spec = AgentSpec(
        agent_id="a1",
        execution=ExecutionPolicy(tool_max_retries=2, tool_retry_base_s=0.0),
    )
    res = await Agent.run(spec, "q", env)
    assert adapter.calls == 2  # 1 failure + 1 retry-success
    assert res.outcome == AgentOutcome.FINAL_ANSWER and res.text == "answered"


# 8 — crash recovery HONORED (not orchestrated) ------------------------------
async def test_agent_honors_resume_state_no_reexecute():
    # search_web(args) keyed as resume leaves it
    dedup_key = json.dumps({"q": "x"}, sort_keys=True)
    env, _, adapter = _env(
        [_read_tool()],
        [AIMessage(content="", tool_calls=[_tc("c1")]), AIMessage(content="done")],
    )
    env2 = replace(env, resume_seen={"search_web": dedup_key})
    res = await Agent.run(AgentSpec(agent_id="a1"), "q", env2)
    assert adapter.calls == 0  # the completed execution is deduped, never re-run
    assert res.outcome == AgentOutcome.FINAL_ANSWER


# 9 — output contract (same model, many agents) -----------------------------
async def test_output_contract_structured_result():
    env, _, _ = _env([_read_tool()], [AIMessage(content='{"answer": 42}')])
    spec = AgentSpec(
        agent_id="a1",
        capability=CapabilityPolicy(tool_ids=frozenset()),  # no tools -> plain graph
        output=OutputContract(schema={"type": "object"}),
    )
    res = await Agent.run(spec, "q", env)
    assert res.outcome == AgentOutcome.STRUCTURED_RESULT and res.data == {"answer": 42}


async def test_output_contract_findings_vs_final_answer():
    env_f, _, _ = _env([_read_tool()], [AIMessage(content="here are findings")])
    find = AgentSpec(
        agent_id="finder", capability=CapabilityPolicy(tool_ids=frozenset()),
        output=OutputContract(role_hint="find"),
    )
    assert (await Agent.run(find, "q", env_f)).outcome == AgentOutcome.FINDINGS

    env_a, _, _ = _env([_read_tool()], [AIMessage(content="the answer")])
    ans = AgentSpec(
        agent_id="answerer", capability=CapabilityPolicy(tool_ids=frozenset())
    )
    res_a = await Agent.run(ans, "q", env_a)
    assert res_a.outcome == AgentOutcome.FINAL_ANSWER and res_a.text == "the answer"


async def test_output_contract_approval_is_next_action():
    env, _, adapter = _env(
        [_read_tool()],
        [AIMessage(content="", tool_calls=[_tc("c1")]), AIMessage(content="done")],
    )
    spec = AgentSpec(
        agent_id="a1",
        execution=ExecutionPolicy(force_approval_ids=frozenset({"search_web"})),
    )
    res = await Agent.run(spec, "q", env)
    assert res.outcome == AgentOutcome.NEXT_ACTION
    assert adapter.calls == 0  # parked, not executed


# 10 — observability ---------------------------------------------------------
async def test_agent_observability_trace_and_run_id():
    env, convex, _ = _env(
        [_read_tool()],
        [AIMessage(content="", tool_calls=[_tc("c1")]), AIMessage(content="done")],
        run_id="run_OBS",
    )
    res = await Agent.run(AgentSpec(agent_id="obs_agent"), "q", env)
    assert res.run_id == "run_OBS"
    mc = _events(convex, "MODEL_CALL")
    assert mc and all(
        m["agent_id"] == "obs_agent" and m["run_id"] == "run_OBS" for m in mc
    )
    tc = _events(convex, "TOOL_CALL")
    assert tc and all(e["run_id"] == "run_OBS" for e in tc)  # tool events share the run


# grounding — DEFAULT_AGENT reproduces the runner's assembly -----------------
async def test_grounding_default_agent_reproduces_runner_assembly():
    reg = ToolRegistry()
    reg.register(_read_tool())
    writer = DeltaWriter(RecordingConvex(), "s1", _settings())
    env = AgentEnv(
        writer=writer, llm=ScriptedLLM([AIMessage(content="x")]), run_id="run_1",
        user_id="u1", workspace_id="w1", registry=reg, adapter=FakeAdapter(),
        candidates=_cands([_read_tool()]),
    )
    ctx, specs = Agent.build_context(DEFAULT_AGENT, env)
    assert ctx is not None
    s = _settings()
    assert ctx.max_concurrent_tools == s.ai_agent_max_concurrent_tools == 4
    assert ctx.max_tool_calls_per_step == s.ai_agent_max_tool_calls_per_step == 8
    assert ctx.tool_max_retries == s.ai_agent_tool_max_retries == 2
    assert ctx.result_max_chars == s.ai_agent_tool_result_max_chars == 8000
    assert ctx.run_id == "run_1" and ctx.run_attempt == 0
    assert ctx.scope.agent_id == "assistant"
    assert ctx.scope.user_id == "u1" and ctx.scope.workspace_id == "w1"
    assert ctx.scope.granted_permissions == frozenset({"ollagraph:read"})
    assert set(ctx.name_to_tool_id.values()) == {"search_web"}

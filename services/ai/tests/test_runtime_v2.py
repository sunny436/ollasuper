"""Phase 1 (v2) — provider-neutral registry, execution lineage, OutputContract
validation + bounded repair, and structured delegation. All in-process/fakes."""

from __future__ import annotations

from langchain_core.messages import AIMessage

from app.agent.base import Agent, AgentEnv
from app.agent.executor import ToolExecContext, _step_id
from app.agent.policy import READ_SCOPE
from app.agent.spec import AgentOutcome, AgentSpec, OutputContract
from app.models.tools import Availability, SideEffect, ToolDefinition, ToolPermissions
from app.orchestrator.capabilities import CapabilityResolver
from app.orchestrator.orchestrator import AgentRegistry, Orchestrator
from app.runtime.writer import DeltaWriter
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.test_agent_executor import _settings
from tests.test_agent_graph import FakeAdapter, ScriptedLLM
from tests.test_writer_events import RecordingConvex


def _tool(tid, name, path, provider="ollagraph"):
    return ToolDefinition(
        tool_id=tid, name=name, path=path, method="post", provider=provider,
        side_effect=SideEffect.READ_ONLY, enabled=True,
        availability=Availability.AVAILABLE,
        permissions=ToolPermissions(required_permissions=["ollagraph:read"]),
        input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
    )


# --- provider-neutral registry (item 11) -----------------------------------
def test_replace_provider_never_wipes_another_provider():
    reg = ToolRegistry()
    reg.replace_provider(
        "ollagraph", [_tool("a", "A", "/a")], {"S": {"type": "object"}}
    )
    reg.replace_provider(
        "provB", [_tool("b", "B", "/b", "provB")], {"S": {"type": "string"}}
    )
    assert reg.count == 2
    # Refresh ONE provider — the other's tools + components survive.
    reg.replace_provider("ollagraph", [_tool("a2", "A2", "/a2")], {})
    assert reg.get("b") is not None  # provB untouched
    assert reg.get("a") is None and reg.get("a2") is not None
    assert reg.components_for("provB") == {"S": {"type": "string"}}


def test_components_are_provider_scoped_no_collision():
    reg = ToolRegistry()
    reg.replace_provider(
        "p1", [_tool("t1", "T1", "/t1", "p1")], {"Opt": {"type": "object"}}
    )
    reg.replace_provider(
        "p2", [_tool("t2", "T2", "/t2", "p2")], {"Opt": {"type": "string"}}
    )
    # Same schema NAME, different providers -> no collision.
    assert reg.components_for("p1") == {"Opt": {"type": "object"}}
    assert reg.components_for("p2") == {"Opt": {"type": "string"}}


def test_replace_all_single_provider_is_byte_identical_views():
    reg = ToolRegistry()
    reg.replace_all([_tool("a", "A", "/a")], {"S": {"x": 1}}, {"registered": 1})
    assert reg.components == {"S": {"x": 1}}  # global view == the one provider's
    assert reg.report == {"registered": 1}


# --- execution lineage (item 6/8) -------------------------------------------
def _ctx(**over):
    base = dict(
        registry=None, adapter=None, writer=None, scope=READ_SCOPE,
        name_to_tool_id={}, result_max_chars=8000, default_timeout_s=30.0,
        run_id="run1", run_attempt=0, step_counter=2,
    )
    base.update(over)
    return ToolExecContext(**base)


def test_step_key_top_level_is_unchanged():
    assert _step_id(_ctx()) == "run1:a0:s2"


def test_step_key_delegated_adds_segment_and_never_collides():
    top = _step_id(_ctx())
    sub_a = _step_id(_ctx(delegation_id="aaa"))
    sub_b = _step_id(_ctx(delegation_id="bbb"))
    assert sub_a == "run1:a0:daaa:s2"
    assert top != sub_a != sub_b and top != sub_b


# --- OutputContract validation + bounded repair (item 7) --------------------
_SCHEMA = {
    "type": "object",
    "required": ["ok"],
    "properties": {"ok": {"type": "boolean"}},
    "additionalProperties": False,
}


def _agent_env(plain):
    convex = RecordingConvex()
    writer = DeltaWriter(convex, "s1", _settings())
    return AgentEnv(
        writer=writer, llm=plain, run_id="run1",
        registry=ToolRegistry(), adapter=FakeAdapter(),
        bind=lambda specs: None,  # no tools -> plain graph
    )


async def test_schema_valid_structured_result():
    spec = AgentSpec(agent_id="s", output=OutputContract(schema=_SCHEMA))
    env = _agent_env(ScriptedLLM([AIMessage(content='{"ok": true}')]))
    res = await Agent.run(spec, "emit json", env)
    assert res.outcome == AgentOutcome.STRUCTURED_RESULT
    assert res.data == {"ok": True}


async def test_schema_invalid_then_repaired_once():
    spec = AgentSpec(agent_id="s", output=OutputContract(schema=_SCHEMA))
    # 1st reply invalid (missing required 'ok'), 2nd (the repair) valid.
    env = _agent_env(
        ScriptedLLM(
            [AIMessage(content='{"nope": 1}'), AIMessage(content='{"ok": false}')]
        )
    )
    res = await Agent.run(spec, "emit json", env)
    assert res.outcome == AgentOutcome.STRUCTURED_RESULT
    assert res.data == {"ok": False}


async def test_schema_invalid_fails_honestly_after_repair():
    spec = AgentSpec(agent_id="s", output=OutputContract(schema=_SCHEMA))
    env = _agent_env(
        ScriptedLLM(
            [AIMessage(content="not json"), AIMessage(content="still not json")]
        )
    )
    res = await Agent.run(spec, "emit json", env)
    assert res.outcome == AgentOutcome.FAILURE
    assert res.error and res.error.get("code") == "schema_invalid"


# --- structured delegation under v2 (items 5/9) -----------------------------
async def test_v2_delegation_returns_structured_handoff_with_metrics():
    reg = ToolRegistry()
    for t in (_tool("search_web", "Search Web", "/v1/search"),):
        reg.register(t)
    orch = Orchestrator(
        resolver=CapabilityResolver(reg, ToolSelector(reg)),
        registry=AgentRegistry([AgentSpec(agent_id="researcher")]),
        settings=_settings(ai_runtime_v2_enabled=True),
    )
    convex = RecordingConvex()
    writer = DeltaWriter(convex, "s1", _settings())
    env = AgentEnv(
        writer=writer, llm=ScriptedLLM([AIMessage(content="sub answer")]),
        run_id="run1", registry=reg, adapter=FakeAdapter(),
        bind=lambda specs: None,
    )
    delegate = orch.make_delegator(env)
    out = await delegate("researcher", "investigate X")
    # v2 returns the HandoffResult superset: ok/outcome/text PLUS metrics.
    assert set(out) >= {"ok", "outcome", "text", "metrics"}
    assert out["ok"] is True
    assert "tokens" in out["metrics"]


def test_build_live_agent_env_is_rich():
    from types import SimpleNamespace

    from app.runtime.env_factory import build_live_agent_env

    req = SimpleNamespace(streamId="run1", userId="u", workspaceId="w", attempt=2)
    env = build_live_agent_env(
        writer="W", llm="L", req=req,
        approvals={"a1": {"decision": "approved"}},
        rag="RAG", memory="MEM", fit_budget=999,
        resume_seen={"t": "args"}, resume_seen_set=frozenset({"t:1"}),
    )
    assert env.run_id == "run1" and env.attempt == 2 and env.workflow_id == "run1"
    assert env.approvals == {"a1": {"decision": "approved"}}
    assert env.rag == "RAG" and env.memory == "MEM" and env.fit_budget == 999
    assert env.resume_seen == {"t": "args"} and "t:1" in env.resume_seen_set


async def test_v2_delegation_preserves_parent_context(monkeypatch):
    # A rich parent env => the sub-agent env inherits approvals/RAG/memory/resume
    # (blocker 6) and gains lineage. Capture the env Agent.run receives.
    captured: dict = {}

    async def fake_run(spec, task, env, **k):
        from app.agent.base import AgentResult
        captured["env"] = env
        return AgentResult(
            spec.agent_id, env.run_id, AgentOutcome.FINAL_ANSWER, text="ok"
        )

    monkeypatch.setattr(Agent, "run", staticmethod(fake_run))
    reg = ToolRegistry()
    reg.register(_tool("search_web", "Search Web", "/v1/search"))
    orch = Orchestrator(
        resolver=CapabilityResolver(reg, ToolSelector(reg)),
        registry=AgentRegistry([AgentSpec(agent_id="researcher")]),
        settings=_settings(ai_runtime_v2_enabled=True),
    )
    convex = RecordingConvex()
    writer = DeltaWriter(convex, "s1", _settings())
    parent = AgentEnv(
        writer=writer, llm=ScriptedLLM([AIMessage("x")]), run_id="run1",
        registry=reg, adapter=FakeAdapter(), bind=lambda s: None,
        approvals={"a1": {"decision": "approved"}}, rag="RAG", memory="MEM",
        resume_seen={"t": "args"}, resume_seen_set=frozenset({"t:1"}),
    )
    await orch.make_delegator(parent)("researcher", "task")
    sub = captured["env"]
    assert sub.approvals == {"a1": {"decision": "approved"}}
    assert sub.rag == "RAG" and sub.memory == "MEM"
    assert sub.resume_seen == {"t": "args"}
    assert sub.delegation_id  # lineage set under v2

"""Phase 11 — the scalable skill system.

Proves skills scale (5 -> 50 -> 500) without giant prompts, if/else routers, or
per-skill agents, and that skill guidance NEVER bypasses the Phase 1-8 gates.
Reuses the Phase-10 orchestrator fakes; adds a SkillRegistry.
"""

from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, SystemMessage

from app.agent.base import AgentEnv
from app.agent.orchestration_tools import DELEGATE_TOOL_NAME
from app.agent.spec import AgentOutcome, AgentSpec
from app.models.tools import SideEffect
from app.orchestrator.capabilities import CapabilityResolver
from app.orchestrator.orchestrator import (
    AgentRegistry,
    Orchestrator,
    OrchestratorRoute,
)
from app.runtime.writer import DeltaWriter
from app.skills.manifest import SkillManifest
from app.skills.registry import SkillRegistry, render_skills_block
from app.tools.selection import ToolSelector
from tests.test_agent_executor import _settings
from tests.test_agent_graph import FakeAdapter, ScriptedLLM
from tests.test_orchestrator import (
    _call,
    _RecordingAdapter,
    _registry,
    _tool,
    _web_tools,
)
from tests.test_writer_events import RecordingConvex

pytestmark = pytest.mark.anyio


def _skill(sid, name, *, tags, when="", purpose="", instructions="body",
           version="1.0.0", caps=(), approvals=()):
    return SkillManifest(
        skill_id=sid, name=name, version=version, purpose=purpose, when_to_use=when,
        tags=frozenset(tags), instructions=instructions,
        preferred_capabilities=frozenset(caps), require_approval=frozenset(approvals),
    )


class _RecordingLLM:
    def __init__(self, responses):
        self._r = responses
        self.calls = 0
        self.seen: list = []

    async def ainvoke(self, messages, *a, **k):
        self.seen.append(list(messages))
        self.calls += 1
        return self._r[min(self.calls - 1, len(self._r) - 1)]


def _env(tool_reg, *, tools_llm, plain=None, adapter=None):
    convex = RecordingConvex()
    writer = DeltaWriter(convex, "s1", _settings())
    env = AgentEnv(
        writer=writer, llm=plain or ScriptedLLM([AIMessage(content="direct")]),
        run_id="run_1", registry=tool_reg, adapter=adapter or FakeAdapter(),
        bind=lambda specs: tools_llm,
    )
    return env, convex


def _orch(tool_reg, skreg, *, roles=None, working_set=8, skill_budget=6000):
    specs = roles or [AgentSpec(agent_id="assistant"), AgentSpec(agent_id="researcher")]
    return Orchestrator(
        resolver=CapabilityResolver(tool_reg, ToolSelector(tool_reg)),
        registry=AgentRegistry(specs),
        settings=_settings(),
        working_set=working_set,
        skills=skreg,
        skill_budget_chars=skill_budget,
    )


def _sys(rec):
    return [m for m in rec.seen[0] if isinstance(m, SystemMessage)]


# --- discovery / activation -------------------------------------------------
async def test_one_skill_discovered_and_activated_in_prompt():
    skreg = SkillRegistry([
        _skill("seo", "SEO Audit", tags=["seo", "audit"],
               instructions="Check meta tags and broken links.")
    ])
    tool_reg = _registry(_web_tools())
    rec = _RecordingLLM([AIMessage(content="answered")])
    env, _ = _env(tool_reg, tools_llm=ScriptedLLM([AIMessage("x")]), plain=rec)
    res = await _orch(tool_reg, skreg).run("do an seo audit of my copy", env)
    # full instructions are loaded on activation and reach the (trusted) system prompt
    assert _sys(rec) and "Check meta tags and broken links." in _sys(rec)[0].content
    assert "<skill_guidance>" in _sys(rec)[0].content
    assert res.active_skills == [{"id": "seo", "version": "1.0.0"}]


async def test_irrelevant_skill_not_activated():
    skreg = SkillRegistry([_skill("seo", "SEO Audit", tags=["seo", "audit"])])
    tool_reg = _registry(_web_tools())
    rec = _RecordingLLM([AIMessage(content="Paris")])
    env, _ = _env(tool_reg, tools_llm=ScriptedLLM([AIMessage("x")]), plain=rec)
    res = await _orch(tool_reg, skreg).run("what is the capital of france", env)
    assert res.active_skills == []
    assert not _sys(rec)  # no skill guidance composed


async def test_composition_multiple_skills_active():
    skreg = SkillRegistry([
        _skill("research", "Research", tags=["research", "competitor"],
               instructions="Gather sources."),
        _skill("data", "Data Analysis", tags=["data", "statistics"],
               instructions="Compute stats."),
        _skill("report", "Report", tags=["report", "summary"],
               instructions="Write a report."),
    ])
    tool_reg = _registry(_web_tools())
    rec = _RecordingLLM([AIMessage(content="done")])
    env, _ = _env(tool_reg, tools_llm=ScriptedLLM([AIMessage("x")]), plain=rec)
    res = await _orch(tool_reg, skreg).run(
        "research competitor data statistics and write a report summary", env
    )
    ids = {s["id"] for s in res.active_skills}
    assert {"research", "data", "report"} <= ids
    block = _sys(rec)[0].content
    assert "Gather sources." in block and "Write a report." in block


async def test_versioning_recorded():
    skreg = SkillRegistry([
        _skill("seo", "SEO", tags=["seo"], version="2.3.1", instructions="x")
    ])
    tool_reg = _registry(_web_tools())
    env, _ = _env(tool_reg, tools_llm=ScriptedLLM([AIMessage("x")]),
                  plain=ScriptedLLM([AIMessage("done")]))
    res = await _orch(tool_reg, skreg).run("seo help please", env)
    assert res.active_skills == [{"id": "seo", "version": "2.3.1"}]


# --- skill -> tools (never bypasses the gates) ------------------------------
async def test_skill_recommends_capability_agent_runs_it():
    tool_reg = _registry(_web_tools())
    skreg = SkillRegistry([
        _skill("webres", "Web Research", tags=["research"], caps=["search_web"],
               instructions="Search thoroughly.")
    ])
    adapter = _RecordingAdapter()
    tools_llm = ScriptedLLM(
        [AIMessage(content="", tool_calls=[_call("search_web", "c1")]),
         AIMessage(content="done")]
    )
    env, _ = _env(tool_reg, tools_llm=tools_llm, adapter=adapter)
    res = await _orch(tool_reg, skreg).run("research the topic", env)
    assert res.route == OrchestratorRoute.AGENT  # skill exposed a capability
    assert adapter.called == ["search_web"]
    assert {"id": "webres", "version": "1.0.0"} in res.active_skills


async def test_skill_recommended_denied_tool_still_not_executed():
    danger = _tool("danger", "Danger", "/v1/danger",
                   se=SideEffect.EXTERNAL_SIDE_EFFECT, perms=("ollagraph:admin",))
    tool_reg = _registry([*_web_tools(), danger])
    skreg = SkillRegistry([
        _skill("risky", "Risky", tags=["risky"], caps=["danger"], instructions="x")
    ])
    adapter = _RecordingAdapter()
    tools_llm = ScriptedLLM(
        [AIMessage(content="", tool_calls=[_call("danger", "c1", {})]),
         AIMessage(content="cannot")]
    )
    env, _ = _env(tool_reg, tools_llm=tools_llm, adapter=adapter)
    res = await _orch(tool_reg, skreg).run("do the risky thing", env)
    # the skill EXPOSED danger, but check_tool_policy still DENIES it.
    assert "danger" not in adapter.called
    assert res.outcome == AgentOutcome.NEEDS_CAPABILITY


async def test_skill_require_approval_tightens_gate():
    tool_reg = _registry(_web_tools())  # search_web is READ_ONLY (no approval normally)
    skreg = SkillRegistry([
        _skill("careful", "Careful", tags=["careful"], caps=["search_web"],
               approvals=["search_web"], instructions="x")
    ])
    adapter = _RecordingAdapter()
    tools_llm = ScriptedLLM(
        [AIMessage(content="", tool_calls=[_call("search_web", "c1")]),
         AIMessage(content="done")]
    )
    env, _ = _env(tool_reg, tools_llm=tools_llm, adapter=adapter)
    res = await _orch(tool_reg, skreg).run("be careful here", env)
    # the skill's require_approval promotes the read-only tool to approval-gated.
    assert res.outcome == AgentOutcome.NEXT_ACTION
    assert adapter.called == []  # parked, not executed


# --- skill + agent, composed through delegation -----------------------------
async def test_multiple_skills_multiple_agents():
    tool_reg = _registry(_web_tools())
    skreg = SkillRegistry([
        _skill("coord", "Coordinator", tags=["research"], instructions="Delegate."),
        _skill("digging", "Digging", tags=["search"], instructions="Dig deep."),
    ])
    adapter = _RecordingAdapter()
    tools_llm = ScriptedLLM(
        [
            AIMessage(content="", tool_calls=[_call(
                DELEGATE_TOOL_NAME, "c1",
                {"role": "researcher", "task": "search the web for data"},
            )]),
            AIMessage(content="sub answer"),
            AIMessage(content="final"),
        ]
    )
    env, _ = _env(tool_reg, tools_llm=tools_llm, adapter=adapter)
    res = await _orch(tool_reg, skreg).run("research and search", env)
    assert res.text == "final"
    assert res.active_skills  # the top request activated skills


# --- scale ------------------------------------------------------------------
async def test_fifty_skills_only_relevant_activated():
    skills = [_skill(f"s{i}", f"Skill {i}", tags=[f"xtopic{i}"]) for i in range(50)]
    skills.append(_skill("seo", "SEO", tags=["seo", "audit"], instructions="SEO body"))
    skreg = SkillRegistry(skills)
    active = skreg.discover("run an seo audit")
    assert [a.manifest.skill_id for a in active] == ["seo"]
    assert skreg.discover("the weather is nice") == []


async def test_small_context_drops_whole_skills():
    skills = [
        _skill(f"s{i}", f"Skill {i}", tags=[f"tag{i}", "common"],
               instructions="X" * 500)
        for i in range(3)
    ]
    active = SkillRegistry(skills).discover("common tag0 tag1 tag2")
    assert len(active) == 3
    block = render_skills_block(active, char_budget=700)  # ~1 skill body fits
    assert block.count("## Skill:") <= 1  # whole skills dropped, not truncated
    assert len(block) < 700 + 400  # header/footer overhead only


async def test_MOST_IMPORTANT_50_skills_20_requests():
    skills = [
        _skill(f"filler{i}", f"Filler {i}", tags=[f"xtopic{i}"]) for i in range(50)
    ]
    skills += [
        _skill("seo", "SEO", tags=["seo", "links"], instructions="A" * 300),
        _skill("research", "Research", tags=["research", "competitor"],
               instructions="B" * 300),
        _skill("data", "Data", tags=["data", "statistics"], instructions="C" * 300),
    ]
    skreg = SkillRegistry(skills)
    unrelated = [
        "what is the capital of france", "tell me a joke", "how tall is everest",
        "define photosynthesis", "who wrote hamlet", "convert miles to km",
        "name a primary color", "recommend a movie", "how do birds fly",
        "explain gravity briefly", "spell accommodation", "who painted mona lisa",
        "how far is the moon", "what is a haiku", "boil an egg", "history of rome",
        "translate hola",
    ]
    targeted = {
        "run an seo audit of links": "seo",
        "research the competitor": "research",
        "analyze the data statistics": "data",
    }
    for req in unrelated:  # 17 unrelated
        assert skreg.discover(req) == [], f"irrelevant skill activated for: {req}"
    for req, sid in targeted.items():  # 3 targeted
        active = skreg.discover(req)
        assert sid in {a.manifest.skill_id for a in active}, f"missing skill: {req}"
        assert len(active) <= 3  # bounded by max_active regardless of the 53 registered
    # No giant prompt: the block carries only ACTIVE skills, never the 50 filler.
    block = render_skills_block(skreg.discover("run an seo audit of links"))
    assert "Filler" not in block
    assert len(block) < 6500

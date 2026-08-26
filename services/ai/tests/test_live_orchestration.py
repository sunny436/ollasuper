"""Phase 13 — the orchestrated runtime wired into the LIVE streaming path.

Flag OFF (the prod default) is covered by test_agent_runner (byte-identical). These
prove that with `ai_orchestrated_runtime_enabled=True` the runner additionally:
  * binds delegate_to_agent + find_capabilities (they ride the bound_specs re-bind),
  * composes the matching skill's TRUSTED guidance into the system prompt,
  * still streams (the sub-agent is a batch tool observation, not the final answer),
and that the production roster + delegator are well-formed.
"""

from __future__ import annotations

import httpx
from langchain_core.messages import AIMessage, SystemMessage

from app.agent.spec import DEFAULT_AGENT
from app.orchestrator.capabilities import CapabilityResolver
from app.runtime.roster import (
    PRODUCTION_AGENTS,
    PRODUCTION_SKILLS,
    build_live_runtime,
)
from app.runtime.runner import run_generation
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.conftest import make_settings
from tests.test_agent_runner import RecordingConvex, _read_tool, _req


class _CapTools:
    def __init__(self, responses: list[AIMessage]) -> None:
        self._r = responses
        self.calls = 0
        self.seen: list[list] = []

    async def ainvoke(self, messages, *a, **k) -> AIMessage:
        self.seen.append(list(messages))
        self.calls += 1
        return self._r[min(self.calls - 1, len(self._r) - 1)]


class _CapLLM:
    """Records the specs it was last bound with + every message list it saw."""

    def __init__(self, plain: AIMessage, tool_responses: list[AIMessage]) -> None:
        self._plain = plain
        self.tools = _CapTools(tool_responses)
        self.bound_specs: list | None = None

    def bind_tools(self, specs):
        self.bound_specs = specs
        return self.tools

    async def ainvoke(self, messages, *a, **k) -> AIMessage:
        return self._plain


def _orch_settings():
    return make_settings(
        "http://x",
        ai_agent_enabled=True,
        ai_orchestrated_runtime_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
    )


async def test_flag_on_binds_delegation_discovery_and_composes_skill(monkeypatch):
    llms: list[_CapLLM] = []

    def _build(*a, **k):
        llm = _CapLLM(AIMessage(content="plain"), [AIMessage(content="answer")])
        llms.append(llm)
        return llm

    monkeypatch.setattr("app.runtime.runner.build_llm", _build)
    reg = ToolRegistry()
    reg.register(_read_tool())

    def handler(req):
        return httpx.Response(200, json={})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    convex = RecordingConvex()
    try:
        await run_generation(
            _req("Research the latest sources and verify these claims."),
            _orch_settings(),
            convex,
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()

    # The tool-bound client's LAST bind is the graph's per-step re-bind from
    # bound_specs, which now includes the two orchestration built-ins.
    bound = next((lm.bound_specs for lm in llms if lm.bound_specs), None)
    names = [s["function"]["name"] for s in (bound or [])]
    assert "delegate_to_agent" in names, names
    assert "find_capabilities" in names, names

    # The research skill's TRUSTED guidance was composed into the system prompt.
    sys_text = ""
    for lm in llms:
        for msgs in lm.tools.seen:
            for m in msgs:
                if isinstance(m, SystemMessage):
                    sys_text += str(m.content)
    low = sys_text.lower()
    assert "skill_guidance" in low, "skill guidance frame not composed into system"
    assert "research methodology" in low, "the research skill did not activate"


async def test_flag_on_no_skill_match_still_binds_delegation(monkeypatch):
    # A prompt matching NO production skill still gets delegation/discovery, and the
    # system carries NO skill block (skills are precise, not always-on).
    llms: list[_CapLLM] = []
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: llms.append(
            _CapLLM(AIMessage(content="plain"), [AIMessage(content="answer")])
        )
        or llms[-1],
    )
    reg = ToolRegistry()
    reg.register(_read_tool())
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={}))
    )
    try:
        await run_generation(
            _req("Say hello to me."),
            _orch_settings(),
            convex := RecordingConvex(),
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    assert convex.calls  # ran
    sys_text = "".join(
        str(m.content)
        for lm in llms
        for msgs in lm.tools.seen
        for m in msgs
        if isinstance(m, SystemMessage)
    )
    assert "skill_guidance" not in sys_text.lower()  # no spurious skill activation


# --- the production roster is well-formed ---------------------------------
def test_live_roster_and_delegator():
    reg = ToolRegistry()
    reg.register(_read_tool())
    resolver = CapabilityResolver(reg, ToolSelector(reg))
    orch, skill_reg = build_live_runtime(_orch_settings(), resolver)
    # roster: the default assistant + the specialists, addressable by role.
    roles = set(orch._registry.roles())
    assert DEFAULT_AGENT.agent_id in roles
    for spec in PRODUCTION_AGENTS:
        assert spec.agent_id in roles
        # SAFETY: every specialist is read-only (delegation carries no side effect).
        assert spec.capability.side_effects_allowed is False
    # skills discover precisely.
    assert len(PRODUCTION_SKILLS) >= 4
    top = skill_reg.discover("analyze this data and compute the statistics")
    assert top and top[0].manifest.skill_id == "data-analysis"
    # the public delegator entry returns a callable.
    from app.agent.base import AgentEnv
    from app.runtime.writer import DeltaWriter

    env = AgentEnv(
        writer=DeltaWriter(RecordingConvex(), "s1", _orch_settings()),
        llm=None,
        run_id="s1",
        registry=reg,
    )
    assert callable(orch.make_delegator(env))

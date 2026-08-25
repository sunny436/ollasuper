"""Phase 10 — orchestrator + dynamic capability routing.

Proves the routing architecture and, above all, that a capability OUTSIDE the
initial top-K is still reachable (via find_capabilities + dynamic loading). All
fakes, no network: ScriptedLLM / FakeAdapter / RecordingConvex + a real
CapabilityResolver over a real ToolSelector/ToolRegistry.
"""

from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage

from app.agent.base import AgentEnv
from app.agent.orchestration_tools import (
    CLARIFY_TOOL_NAME,
    DELEGATE_TOOL_NAME,
    FIND_CAPABILITIES_TOOL_NAME,
)
from app.agent.spec import AgentOutcome, AgentSpec
from app.models.tools import (
    Availability,
    SideEffect,
    ToolDefinition,
    ToolPermissions,
)
from app.orchestrator.capabilities import CapabilityResolver
from app.orchestrator.orchestrator import (
    AgentRegistry,
    Orchestrator,
    OrchestratorRoute,
)
from app.runtime.writer import DeltaWriter
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.test_agent_executor import _settings
from tests.test_agent_graph import FakeAdapter, ScriptedLLM
from tests.test_writer_events import RecordingConvex

pytestmark = pytest.mark.anyio


# --- fixtures ---------------------------------------------------------------
def _tool(tid, name, path, *, se=SideEffect.READ_ONLY, perms=("ollagraph:read",)):
    return ToolDefinition(
        tool_id=tid, name=name, path=path, method="post", side_effect=se,
        enabled=True, availability=Availability.AVAILABLE,
        permissions=ToolPermissions(required_permissions=list(perms)),
        input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
    )


def _registry(tools):
    r = ToolRegistry()
    for t in tools:
        r.register(t)
    return r


def _resolver(registry):
    return CapabilityResolver(registry, ToolSelector(registry))


class _RecordingAdapter:
    def __init__(self):
        self.called: list[str] = []

    async def call_tool(
        self, tool, payload, *, input_schema=None, idempotency_key=None,
        user_id="", workspace_id="",
    ):
        self.called.append(tool.tool_id)
        return {"ok": True, "tool_id": tool.tool_id, "data": {"ok": True}}


class _ConstLLM:
    """Order-independent fake (for concurrent branches): always the same answer."""

    def __init__(self, text):
        self._text = text
        self.calls = 0

    async def ainvoke(self, messages, *a, **k):
        self.calls += 1
        return AIMessage(content=self._text)


def _env(registry, *, tools_llm, plain=None, adapter=None, resp=None, run_id="run_1"):
    convex = RecordingConvex(resp)
    writer = DeltaWriter(convex, "s1", _settings())
    env = AgentEnv(
        writer=writer,
        llm=plain or ScriptedLLM([AIMessage(content="direct")]),
        run_id=run_id, registry=registry, adapter=adapter or FakeAdapter(),
        bind=lambda specs: tools_llm,
    )
    return env, convex


def _orch(registry, *, specs=None, working_set=8):
    return Orchestrator(
        resolver=_resolver(registry),
        registry=AgentRegistry(specs or [AgentSpec(agent_id="assistant")]),
        settings=_settings(),
        working_set=working_set,
    )


def _call(name, cid, args=None):
    return {"name": name, "args": args or {"q": "x"}, "id": cid}


def _web_tools():
    return [
        _tool("search_web", "Search Web", "/v1/search"),
        _tool("scrape_page", "Scrape Page", "/v1/scrape"),
    ]


# --- routing ----------------------------------------------------------------
async def test_simple_task_routes_to_direct_answer_no_agent():
    env, convex = _env(
        _registry(_web_tools()),
        tools_llm=ScriptedLLM([AIMessage(content="unused")]),
        plain=ScriptedLLM([AIMessage(content="Paris")]),
        adapter=_RecordingAdapter(),
    )
    orch = _orch(_registry(_web_tools()))
    res = await orch.run("What is the capital of France?", env)
    assert res.route == OrchestratorRoute.DIRECT_ANSWER
    assert res.text == "Paris"
    # No agent, no tools: nothing executed, no MODEL_CALL/TOOL events emitted.
    assert env.adapter.called == []
    assert not any(c.get("op") == "event" for c in convex.calls)


async def test_direct_tool_routes_to_agent_and_runs_it():
    reg = _registry(_web_tools())
    adapter = _RecordingAdapter()
    tools_llm = ScriptedLLM(
        [AIMessage(content="", tool_calls=[_call("search_web", "c1")]),
         AIMessage(content="here it is")]
    )
    env, _ = _env(reg, tools_llm=tools_llm, adapter=adapter)
    res = await _orch(reg).run("search the web for cats", env)
    assert res.route == OrchestratorRoute.AGENT
    assert res.outcome == AgentOutcome.FINAL_ANSWER and res.text == "here it is"
    assert adapter.called == ["search_web"]


async def test_two_sequential_tools():
    reg = _registry(_web_tools())
    adapter = _RecordingAdapter()
    tools_llm = ScriptedLLM(
        [
            AIMessage(content="", tool_calls=[_call("search_web", "c1")]),
            AIMessage(content="", tool_calls=[_call("scrape_page", "c2")]),
            AIMessage(content="synthesized"),
        ]
    )
    env, _ = _env(reg, tools_llm=tools_llm, adapter=adapter)
    res = await _orch(reg).run("search then scrape the page", env)
    assert adapter.called == ["search_web", "scrape_page"]
    assert res.text == "synthesized"


async def test_tool_failure_then_alternate_tool():
    reg = _registry(_web_tools())

    class _FailFirst:
        def __init__(self):
            self.called = []

        async def call_tool(self, tool, payload, **k):
            self.called.append(tool.tool_id)
            if tool.tool_id == "search_web":
                from app.tools.errors import ToolError, ToolErrorKind
                raise ToolError(ToolErrorKind.INVALID_INPUT, "bad query")
            return {"ok": True, "tool_id": tool.tool_id, "data": {"ok": True}}

    adapter = _FailFirst()
    tools_llm = ScriptedLLM(
        [
            AIMessage(content="", tool_calls=[_call("search_web", "c1")]),  # fails
            AIMessage(content="", tool_calls=[_call("scrape_page", "c2")]),  # alternate
            AIMessage(content="recovered"),
        ]
    )
    env, _ = _env(reg, tools_llm=tools_llm, adapter=adapter)
    res = await _orch(reg).run("search and scrape the page", env)
    assert adapter.called == ["search_web", "scrape_page"]  # switched to alternate
    assert res.text == "recovered"


# --- dynamic capability resolution (the crux) -------------------------------
def _big_registry():
    """5 tools matching 'research competitor pricing' + the SEO target + 34 filler
    tools that match neither. The target is NOT in the initial candidate set."""
    tools = [
        _tool("research_competitors", "Research Competitors", "/v1/research/comp"),
        _tool("pricing_compare", "Pricing Compare", "/v1/pricing/compare"),
        _tool("market_analysis", "Market Analysis", "/v1/market/analysis"),
        _tool("competitor_intel", "Competitor Intel", "/v1/competitor/intel"),
        _tool("price_tracker", "Price Tracker", "/v1/pricing/tracker"),
        _tool("broken_links_audit", "Broken Links Audit", "/v1/seo/broken-links-audit"),
    ]
    tools += [_tool(f"misc_{i}", f"Misc {i}", f"/v1/misc/{i}") for i in range(34)]
    return _registry(tools)


async def test_MOST_IMPORTANT_tool_not_in_top5_is_still_reached():
    reg = _big_registry()
    resolver = _resolver(reg)
    # PROVE the target is NOT in the initial candidate set for the request.
    initial = resolver.resolve("research competitor pricing", limit=8)
    assert "broken_links_audit" not in {r.tool.tool_id for r in initial}

    adapter = _RecordingAdapter()
    tools_llm = ScriptedLLM(
        [
            # step 1: the model realizes it needs a capability it wasn't offered.
            AIMessage(content="", tool_calls=[
                _call(
                    FIND_CAPABILITIES_TOOL_NAME, "c1",
                    {"query": "broken links audit"},
                )
            ]),
            # step 2: after dynamic loading, the target is now callable.
            AIMessage(content="", tool_calls=[_call("broken_links_audit", "c2")]),
            AIMessage(content="audit complete"),
        ]
    )
    env, _ = _env(reg, tools_llm=tools_llm, adapter=adapter)
    res = await _orch(reg).run("research competitor pricing", env)
    # The correct tool executed even though it was NOT in the top-5 initial set.
    assert "broken_links_audit" in adapter.called
    assert res.text == "audit complete"


async def test_capability_discovered_mid_run_updates_allowlist():
    reg = _big_registry()
    adapter = _RecordingAdapter()
    tools_llm = ScriptedLLM(
        [
            AIMessage(content="", tool_calls=[
                _call(
                    FIND_CAPABILITIES_TOOL_NAME, "c1",
                    {"query": "broken links audit"},
                )
            ]),
            AIMessage(content="", tool_calls=[_call("broken_links_audit", "c2")]),
            AIMessage(content="done"),
        ]
    )
    env, _ = _env(reg, tools_llm=tools_llm, adapter=adapter)
    # Before the run the agent's working set does not include the target; the
    # find_capabilities handler must add it to the executor's strict allowlist.
    await _orch(reg).run("research competitor pricing", env)
    assert "broken_links_audit" in adapter.called


async def test_large_registry_resolver_is_bounded():
    tools = [_tool(f"t{i}", f"Tool {i}", f"/v1/x/{i}") for i in range(100)]
    tools.append(
        _tool("broken_links_audit", "Broken Links Audit", "/v1/seo/broken-links-audit")
    )
    reg = _registry(tools)
    resolver = _resolver(reg)
    resolved = resolver.resolve("broken links audit", limit=5)
    assert len(resolved) <= 5  # bounded — not all 101 schemas inlined
    assert "broken_links_audit" in {r.tool.tool_id for r in resolved}


# --- authorization separated from discovery ---------------------------------
async def test_unauthorized_capability_discovered_but_not_executed():
    admin = _tool(
        "danger", "Danger", "/v1/danger",
        se=SideEffect.EXTERNAL_SIDE_EFFECT, perms=("ollagraph:admin",),
    )
    reg = _registry([*_web_tools(), admin])
    resolver = _resolver(reg)
    from app.agent.policy import READ_SCOPE
    resolved = resolver.resolve("danger", limit=5, scope=READ_SCOPE)
    # DISCOVERY surfaces it, ANNOTATED as not allowed (discovery != authorization).
    match = next(r for r in resolved if r.tool.tool_id == "danger")
    assert match.auth_status == "deny"

    adapter = _RecordingAdapter()
    tools_llm = ScriptedLLM(
        [
            AIMessage(content="", tool_calls=[
                _call(FIND_CAPABILITIES_TOOL_NAME, "c1", {"query": "danger"})
            ]),
            AIMessage(content="", tool_calls=[_call("danger", "c2", {})]),
            AIMessage(content="cannot"),
        ]
    )
    env, _ = _env(reg, tools_llm=tools_llm, adapter=adapter)
    res = await _orch(reg).run("search for dangerous content", env)
    # EXECUTION still enforces authorization: the denied tool never ran.
    assert "danger" not in adapter.called
    assert res.outcome == AgentOutcome.NEEDS_CAPABILITY


# --- delegation (multi-agent) ----------------------------------------------
def _coordinator_and_specialists():
    return [
        AgentSpec(agent_id="assistant"),
        AgentSpec(agent_id="researcher", role="research"),
        AgentSpec(agent_id="coder", role="coding"),
    ]


async def test_delegation_agent_to_agent():
    reg = _registry(_web_tools())
    adapter = _RecordingAdapter()
    # parent delegates -> sub answers -> parent finalizes (deterministic call order).
    tools_llm = ScriptedLLM(
        [
            AIMessage(content="", tool_calls=[
                _call(DELEGATE_TOOL_NAME, "c1", {"role": "researcher", "task": "dig"})
            ]),
            AIMessage(content="research findings"),  # sub-agent answer
            AIMessage(content="final report"),        # parent finalize
        ]
    )
    env, _ = _env(reg, tools_llm=tools_llm, adapter=adapter)
    orch = _orch(reg, specs=_coordinator_and_specialists())
    res = await orch.run("search then hand off to research", env)
    assert res.route == OrchestratorRoute.AGENT
    assert res.text == "final report"


async def test_delegation_agent_tool_agent():
    reg = _registry(_web_tools())
    adapter = _RecordingAdapter()
    tools_llm = ScriptedLLM(
        [
            AIMessage(content="", tool_calls=[
                _call(DELEGATE_TOOL_NAME, "c1",
                      {"role": "researcher", "task": "search the web for data"})
            ]),
            # sub-agent runs a tool, then answers.
            AIMessage(content="", tool_calls=[_call("search_web", "c2")]),
            AIMessage(content="sub done"),
            AIMessage(content="final"),  # parent finalize
        ]
    )
    env, _ = _env(reg, tools_llm=tools_llm, adapter=adapter)
    orch = _orch(reg, specs=_coordinator_and_specialists())
    res = await orch.run("search using a research agent", env)
    assert adapter.called == ["search_web"]  # the sub-agent's tool ran
    assert res.text == "final"


async def test_unknown_delegation_role_is_surfaced_not_crashed():
    reg = _registry(_web_tools())
    tools_llm = ScriptedLLM(
        [
            AIMessage(content="", tool_calls=[
                _call(DELEGATE_TOOL_NAME, "c1", {"role": "ghost", "task": "x"})
            ]),
            AIMessage(content="handled"),
        ]
    )
    env, _ = _env(reg, tools_llm=tools_llm)
    orch = _orch(reg, specs=_coordinator_and_specialists())
    res = await orch.run("search then delegate to a role", env)
    assert res.text == "handled"  # the parent observed the failure and finished


# --- parallel branch -> synthesis -------------------------------------------
async def test_parallel_branches_synthesized():
    reg = _registry(_web_tools())
    const = _ConstLLM("branch done")  # order-independent for concurrency
    env, _ = _env(reg, tools_llm=const)
    orch = _orch(reg, specs=_coordinator_and_specialists())
    res = await orch.run_parallel(
        ["task a", "task b", "task c"],
        env,
        roles=["researcher", "researcher", "researcher"],
    )
    assert res.data is not None and len(res.data["branches"]) == 3
    assert res.text.count("branch done") == 3


# --- stop conditions --------------------------------------------------------
async def test_stop_on_cancellation():
    reg = _registry(_web_tools())
    tools_llm = ScriptedLLM(
        [AIMessage(content="", tool_calls=[_call("search_web", "c1")])]
    )
    env, _ = _env(reg, tools_llm=tools_llm)
    env.writer._cancel_requested = True
    res = await _orch(reg).run("search", env)
    assert res.outcome == AgentOutcome.FAILURE and res.error == {"status": "cancelled"}


async def test_stop_on_clarification():
    reg = _registry(_web_tools())
    tools_llm = ScriptedLLM(
        [AIMessage(content="", tool_calls=[
            _call(CLARIFY_TOOL_NAME, "c1", {"question": "Which site?"})
        ])]
    )
    env, _ = _env(reg, tools_llm=tools_llm)
    res = await _orch(reg).run("search my site", env)
    assert res.outcome == AgentOutcome.NEEDS_CLARIFICATION
    assert "Which site?" in res.text


async def test_stop_on_budget_exhaustion():
    reg = _registry(_web_tools())
    adapter = _RecordingAdapter()
    # The model keeps calling a tool; max_steps=1 forces a text answer after 1 step.
    tools_llm = ScriptedLLM(
        [AIMessage(content="", tool_calls=[_call("search_web", "c1")]),
         AIMessage(content="forced to answer")]
    )
    env, _ = _env(reg, tools_llm=tools_llm, adapter=adapter)
    spec = AgentSpec(agent_id="assistant")
    spec = AgentSpec(
        agent_id="assistant",
        context=type(spec.context)(max_steps=1),
    )
    orch = _orch(reg, specs=[spec])
    res = await orch.run("search repeatedly", env)
    assert adapter.called == ["search_web"]  # bounded to one step
    assert res.text == "forced to answer"

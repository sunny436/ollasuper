"""Every combination of Skill / Ollagraph tool / MCP tool, on every routed brain.

Requirement: which model the router picks may change HOW WELL a capability is
used, never WHETHER it exists. So each combination runs through the real
`run_generation` once per routed model, against a REAL in-process MCP server
(real SDK, real session pool, real executor) plus a native Ollagraph tool, and
the brains must receive exactly the same system instructions, skills, tool
names + schemas, permission scope, approval set, loop limits and budgets — and
the tools the model calls must actually execute.

Only the LLM is scripted: it is the brain deciding what to use, which is exactly
what must not change the layer it is given.
"""

from __future__ import annotations

import json

import pytest
from langchain_core.messages import AIMessage, SystemMessage

import app.runtime.runner as runner_mod
from app.agent import health
from app.agent.budget import ContextBudget
from app.models.chat import GenerateRequest, HistoryMessage, ModelCandidate
from app.runtime.runner import run_generation
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.conftest import make_settings
from tests.fakes.mcp_http import build_mcp_app, running
from tests.test_agent_runner import RecordingConvex, _ok_http, _ops
from tests.test_mcp_turn_integration import REF, _native_tool, _pool_for, _Target

pytestmark = pytest.mark.anyio

# The original, pinned at import so a spy never wraps a previous turn's spy.
_REAL_BUILD_GRAPH = runner_mod.build_graph

MODELS = ["gemini-3.7-flash-high", "deepseek-v4-flash", "gemini-3.8-flash-high"]
CANDIDATES = [
    ModelCandidate(id="gemini-3.7-flash-high", contextWindow=0),
    ModelCandidate(id="deepseek-v4-flash", contextWindow=131_072),
    ModelCandidate(id="gemini-3.8-flash-high", contextWindow=0),
]
SEARCH = {"name": "search_web", "args": {"q": "cats"}, "id": "t1"}
ECHO = {"name": "mcp_fake_echo", "args": {"text": "cats"}, "id": "t2"}

# (skill?, calls) — prompts chosen so skill activation is deterministic.
COMBOS = {
    "skill": (True, [], "Research and verify sources about cats"),
    "tool": (False, [SEARCH], "search the web for cats"),
    "mcp": (False, [ECHO], "echo cats through the fake server"),
    "skill+tool": (
        True,
        [SEARCH],
        "Research and verify sources about cats and search the web",
    ),
    "skill+mcp": (
        True,
        [ECHO],
        "Research and verify sources about cats and echo them through the fake server",
    ),
    "tool+mcp": (
        False,
        [SEARCH, ECHO],
        "search the web for cats and echo the result through the fake server",
    ),
    "skill+tool+mcp": (
        True,
        [SEARCH, ECHO],
        "Research and verify sources about cats: search the web and echo them "
        "through the fake server",
    ),
}


@pytest.fixture(autouse=True)
def _clean_health():
    health.reset()
    yield
    health.reset()


def _profiles(fastest: str) -> str:
    """Same tier for all three, so TTFT alone decides which brain wins."""
    return json.dumps(
        {
            m: {"ttft_s": 1.0 if m == fastest else 9.0, "reasoning_tier": 2}
            for m in MODELS
        }
    )


class _Brain:
    """Records the tool specs of the client ACTUALLY invoked; scripted decisions."""

    def __init__(self, rec: dict, model: str, calls: list[dict], specs=None) -> None:
        self.rec, self.model, self.calls, self.specs = rec, model, calls, specs

    def bind_tools(self, specs):
        bound = json.loads(json.dumps(specs, default=str))
        return _Brain(self.rec, self.model, self.calls, bound)

    async def ainvoke(self, messages, *a, **k):
        if self.rec["system"] is None:
            self.rec["system"] = "".join(
                str(m.content) for m in messages if isinstance(m, SystemMessage)
            )
        self.rec["binds"].append(self.specs or [])
        self.rec["called"].append(self.model)
        if self.calls and not any(
            getattr(m, "tool_calls", None) for m in messages if isinstance(m, AIMessage)
        ):
            return AIMessage(content="", tool_calls=self.calls)
        return AIMessage(content="done")


async def _turn(
    monkeypatch, pool, prompt: str, fastest: str, calls: list[dict]
) -> dict:
    rec: dict = {"binds": [], "called": [], "system": None, "graph": [], "budget": []}
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, model, **k: _Brain(rec, model, calls),
    )

    def spy_graph(*a, **k):
        ctx = k.get("tools_ctx")
        rec["graph"].append(
            {
                "model_name": k.get("model_name"),
                "scope": repr(getattr(ctx, "scope", None)),
                "force_approval_ids": sorted(
                    getattr(ctx, "force_approval_ids", ()) or ()
                ),
                "max_tool_calls_per_step": getattr(
                    ctx, "max_tool_calls_per_step", None
                ),
                "max_stall_steps": getattr(ctx, "max_stall_steps", None),
                "result_max_chars": getattr(ctx, "result_max_chars", None),
            }
        )
        return _REAL_BUILD_GRAPH(*a, **k)

    def spy_budget(**k):
        rec["budget"].append(k["context_window"])
        return ContextBudget(**k)

    monkeypatch.setattr(runner_mod, "build_graph", spy_graph)
    monkeypatch.setattr(runner_mod, "ContextBudget", spy_budget)

    settings = make_settings(
        "http://x",
        ai_agent_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
        mcp_connections_enabled=True,
        ai_orchestrated_runtime_enabled=True,
        ai_router_enabled=True,
        ai_router_profiles=_profiles(fastest),
        ai_quota_fallback_model="",
    )
    registry = ToolRegistry()
    registry.register(_native_tool())
    convex = RecordingConvex()
    ollagraph = _ok_http()  # the native tool answers; nothing leaves the process
    await run_generation(
        GenerateRequest(
            streamId="s1",
            threadId="t1",
            messageId="m1",
            userId="u1",
            workspaceId="w1",
            model="deepseek-v4-flash",
            contextWindow=131_072,
            modelCandidates=CANDIDATES,
            history=[HistoryMessage(role="user", content=prompt, seq=1)],
            mcpConnections=[REF],
        ),
        settings,
        convex,
        engine=object(),
        tool_registry=registry,
        tool_selector=ToolSelector(registry),
        ollagraph_http=ollagraph,
        mcp_pool=pool,
    )
    await ollagraph.aclose()
    first_bind = rec["binds"][0] if rec["binds"] else []
    # A tool counts as EXECUTED only when its result came back successfully.
    call_tool: dict[str, str] = {}
    executed = set()
    for c in _ops(convex, "event"):
        for ev in c["events"]:
            payload = json.loads(ev["payload"])
            if ev["type"] == "TOOL_CALL":
                call_tool[payload.get("call_id")] = payload.get("tool_id")
            elif ev["type"] == "TOOL_RESULT" and payload.get("status") == "success":
                executed.add(call_tool.get(payload.get("call_id")))
    finals = _ops(convex, "finalize")
    return {
        "called": set(rec["called"]),
        "system": rec["system"] or "",
        "tools": sorted(
            (
                s["function"]["name"],
                json.dumps(s["function"]["parameters"], sort_keys=True),
            )
            for s in first_bind
        ),
        "graph": rec["graph"],
        "budget": rec["budget"],
        "executed": executed,
        "final": finals[0] if finals else {},
    }


@pytest.mark.parametrize("combo", list(COMBOS))
async def test_every_capability_combination_is_identical_on_every_routed_brain(
    monkeypatch, combo
):
    wants_skill, calls, prompt = COMBOS[combo]
    app, _traffic = build_mcp_app()
    from app.mcp.registry import curated

    async def resolve(_engine, _name):
        return _Target()

    monkeypatch.setattr(curated, "resolve", resolve)

    runs = {}
    async with running(app), _pool_for(app) as pool:
        for model in MODELS:
            runs[model] = await _turn(monkeypatch, pool, prompt, model, calls)

    first = runs[MODELS[0]]
    for model, r in runs.items():
        # The router really chose this brain, and the graph runs THAT brain.
        assert r["called"] == {model}, (combo, model, r["called"])
        assert [g["model_name"] for g in r["graph"]] == [model]
        assert r["final"].get("status") == "done" and r["final"].get("model") == model
        # The capability layer is byte-identical across brains.
        assert r["system"] == first["system"], (combo, model)
        assert r["tools"] == first["tools"], (combo, model)
        assert [
            {k: v for k, v in g.items() if k != "model_name"} for g in r["graph"]
        ] == [{k: v for k, v in g.items() if k != "model_name"} for g in first["graph"]]
        assert r["budget"] == first["budget"] == [131_072]
        # Skills: present exactly when the request calls for them.
        assert ("## Skill: " in r["system"]) is wants_skill, (combo, model)
        # The WHOLE catalogue (Ollagraph + MCP) stays reachable for every brain
        # through dynamic discovery, and what this request needs is bound directly.
        names = {n for n, _ in r["tools"]}
        assert "find_capabilities" in names, (combo, model, names)
        assert {c["name"] for c in calls} <= names, (combo, model, names)
        # What the brain chose actually ran.
        expected = {
            "search_web" if c["name"] == "search_web" else "mcp:fake:echo"
            for c in calls
        }
        assert expected <= r["executed"], (combo, model, r["executed"])

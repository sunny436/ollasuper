"""The router chooses the brain; every brain gets the same capability layer.

Driven through the REAL run_generation with the real router, health state and
graph — only the provider clients are fakes, one per model id, so each test can
say exactly which model was called and which tools each client was bound with.

The P0 these guard (reproduced on prod state, 2026-09-16): health was checked and
recorded under `req.model` — the thread's DEFAULT model — instead of the model
the router chose. With the default model out of capacity, a turn routed to a
healthy Gemini never called Gemini: it went to the failover, which was refusing
on the same upstream limit, and the runner then marked the healthy GEMINI
exhausted. Two turns later every routed model was believed down.
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
from tests.test_agent_runner import (
    RecordingConvex,
    _agent_settings,
    _ok_http,
    _ops,
    _read_tool,
    _seo_tool,
    _tool_call_ids,
)

DEFAULT = "deepseek-v4-flash"  # req.model — the thread's default, as Convex sends it
GEMINI = "gemini-3.7-flash-high"
FALLBACK = "gpt-oss-120b"
LIMIT = (
    'Error code: 429 - {"error":{"message":"you have reached your session usage '
    'limit"}}'
)


@pytest.fixture(autouse=True)
def _clean_health():
    health.reset()
    yield
    health.reset()


class Rec:
    """Every provider call, in order: (model, streaming, bound tool names)."""

    def __init__(self, script) -> None:
        self.script = script
        self.calls: list[tuple[str, bool, list[str] | None]] = []
        self.first_messages: list | None = None

    def n(self, model: str) -> int:
        return sum(1 for m, *_ in self.calls if m == model)


class Client:
    def __init__(self, rec: Rec, model: str, streaming: bool, names) -> None:
        self.rec, self.model, self.streaming, self.names = rec, model, streaming, names

    async def ainvoke(self, messages, *a, **k):
        if self.rec.first_messages is None:
            self.rec.first_messages = list(messages)
        self.rec.calls.append((self.model, self.streaming, self.names))
        out = self.rec.script(self.model, self.streaming, self.rec.n(self.model))
        if isinstance(out, BaseException):
            raise out
        return out


class Model:
    def __init__(self, rec: Rec, model: str, streaming: bool) -> None:
        self.rec, self.model, self.streaming = rec, model, streaming

    def bind_tools(self, specs):
        names = [s["function"]["name"] for s in specs]
        return Client(self.rec, self.model, self.streaming, names)

    async def ainvoke(self, messages, *a, **k):
        return await Client(self.rec, self.model, self.streaming, None).ainvoke(
            messages
        )


def _patch_models(monkeypatch, script) -> Rec:
    rec = Rec(script)

    def fake_build_llm(*a, model, streaming=True, **k):
        return Model(rec, model, streaming)

    monkeypatch.setattr("app.runtime.runner.build_llm", fake_build_llm)
    return rec


def _req(text: str, candidates: list[ModelCandidate]) -> GenerateRequest:
    return GenerateRequest(
        streamId="s1",
        threadId="t1",
        messageId="m1",
        userId="u1",
        workspaceId="w1",
        model=DEFAULT,
        contextWindow=131_072,
        modelCandidates=candidates,
        history=[HistoryMessage(role="user", content=text, seq=1)],
    )


def _final(convex: RecordingConvex) -> dict:
    finals = _ops(convex, "finalize")
    assert len(finals) == 1
    return finals[0]


def _routed_settings(**over):
    return _agent_settings(
        ai_router_enabled=True, ai_quota_fallback_model=FALLBACK, **over
    )


def _answer_or_limit(answer: AIMessage):
    def script(model, streaming, n):
        return RuntimeError(LIMIT) if model == FALLBACK else answer

    return script


# ---- P0: health follows the ROUTED model -------------------------------------


async def test_default_model_exhausted_routed_healthy_model_answers_plain(monkeypatch):
    health.mark_exhausted(DEFAULT, 600)
    rec = _patch_models(monkeypatch, _answer_or_limit(AIMessage(content="gemini")))
    convex = RecordingConvex()

    await run_generation(
        _req("What is a mutex?", [ModelCandidate(id=GEMINI, contextWindow=0)]),
        _routed_settings(),
        convex,
    )

    final = _final(convex)
    assert final["status"] == "done"
    assert [m for m, *_ in rec.calls] == [GEMINI], "the routed model must answer"
    assert not health.is_exhausted(GEMINI), "a model never called was marked down"


async def test_default_model_exhausted_routed_healthy_model_answers_with_tools(
    monkeypatch,
):
    health.mark_exhausted(DEFAULT, 600)
    rec = _patch_models(monkeypatch, _answer_or_limit(AIMessage(content="gemini")))
    reg = ToolRegistry()
    reg.register(_read_tool())
    http = _ok_http()
    convex = RecordingConvex()
    try:
        await run_generation(
            _req(
                "search the web for cats", [ModelCandidate(id=GEMINI, contextWindow=0)]
            ),
            _routed_settings(),
            convex,
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()

    assert _final(convex)["status"] == "done"
    assert {m for m, *_ in rec.calls} == {GEMINI}
    assert rec.calls[0][2], "the routed model was called WITH its tools"
    assert not health.is_exhausted(GEMINI)


async def test_no_capacity_gate_checks_the_routed_model(monkeypatch):
    """No failover configured: the gate used to refuse on the DEFAULT model's
    health alone — prod refused 6 turns routed to a different model this way."""
    health.mark_exhausted(DEFAULT, 600)
    rec = _patch_models(monkeypatch, _answer_or_limit(AIMessage(content="gemini")))
    convex = RecordingConvex()

    await run_generation(
        _req("What is a mutex?", [ModelCandidate(id=GEMINI, contextWindow=0)]),
        _agent_settings(ai_router_enabled=True, ai_quota_fallback_model=""),
        convex,
    )

    assert _final(convex)["status"] == "done"
    assert [m for m, *_ in rec.calls] == [GEMINI]


async def test_routed_model_refusing_is_still_refused_honestly(monkeypatch):
    """The gate still works for the model that actually runs."""
    health.mark_exhausted(GEMINI, 600)
    rec = _patch_models(monkeypatch, _answer_or_limit(AIMessage(content="x")))
    convex = RecordingConvex()

    # Only candidate is exhausted -> router falls back to req.model, which is
    # exhausted too; no failover -> immediate honest refusal, no model call.
    health.mark_exhausted(DEFAULT, 600)
    await run_generation(
        _req("What is a mutex?", [ModelCandidate(id=GEMINI, contextWindow=0)]),
        _agent_settings(ai_router_enabled=True, ai_quota_fallback_model=""),
        convex,
    )

    assert _final(convex)["status"] == "error"
    assert rec.calls == []


async def test_stream_break_is_recorded_under_the_routed_model(monkeypatch):
    def script(model, streaming, n):
        if streaming:
            return IndexError("Tool call index out of bounds")
        return AIMessage(content="answer")

    rec = _patch_models(monkeypatch, script)
    reg = ToolRegistry()
    reg.register(_read_tool())
    http = _ok_http()
    convex = RecordingConvex()
    try:
        await run_generation(
            _req(
                "search the web for cats", [ModelCandidate(id=GEMINI, contextWindow=0)]
            ),
            _routed_settings(),
            convex,
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()

    assert _final(convex)["status"] == "done"
    assert {m for m, *_ in rec.calls} == {GEMINI}
    assert not health.streams_tool_calls_cleanly(GEMINI)
    assert health.streams_tool_calls_cleanly(DEFAULT), "blamed the thread default"


# ---- R3: a failover keeps the tools the turn already discovered --------------


async def test_capacity_failover_is_bound_with_dynamically_discovered_tools(
    monkeypatch,
):
    find = {
        "name": "find_capabilities",
        "args": {"query": "broken links audit"},
        "id": "c1",
    }
    target = {"name": "broken_links_audit", "args": {"q": "x"}, "id": "c2"}

    def script(model, streaming, n):
        if model == GEMINI:
            # step 1 discovers a tool; step 2 the routed model runs out of capacity
            return (
                AIMessage(content="", tool_calls=[find])
                if n == 1
                else RuntimeError(LIMIT)
            )
        return (
            AIMessage(content="", tool_calls=[target])
            if n == 1
            else AIMessage(content="audited")
        )

    rec = _patch_models(monkeypatch, script)
    reg = ToolRegistry()
    reg.register(_read_tool())
    reg.register(_seo_tool())
    http = _ok_http()
    convex = RecordingConvex()
    try:
        await run_generation(
            _req(
                "search the web for cats", [ModelCandidate(id=GEMINI, contextWindow=0)]
            ),
            _routed_settings(ai_orchestrated_runtime_enabled=True),
            convex,
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()

    fallback_binds = [names for m, _, names in rec.calls if m == FALLBACK]
    assert fallback_binds, "the failover never ran"
    assert all("broken_links_audit" in (names or []) for names in fallback_binds), (
        f"failover lost the discovered tool: {fallback_binds}"
    )
    assert "broken_links_audit" in _tool_call_ids(convex)
    final = _final(convex)
    assert final["status"] == "done"
    # the turn is credited to the model that ANSWERED, and says why
    assert final["model"] == FALLBACK
    assert f"quota_fallback_from:{GEMINI}" in final["routedReason"]
    # health blames the model that refused, and only that one
    assert health.is_exhausted(GEMINI) and not health.is_exhausted(DEFAULT)
    assert not health.is_exhausted(FALLBACK)


# ---- the layer itself: identical whichever brain the router picks -------------

PROMPTS = {
    "easy": "What is a mutex?",
    "medium": "Write a product launch email for our new analytics feature",
    "complex": (
        "Do an ultra deep SEO audit of https://example.com and audit broken links, "
        "then recommend prioritised fixes with evidence"
    ),
}
# The original, pinned at import: a second capture in the same test must not wrap
# the first capture's spy.
_REAL_BUILD_GRAPH = runner_mod.build_graph
CANDIDATES = [
    ModelCandidate(id=GEMINI, contextWindow=0),  # unmeasured window
    ModelCandidate(id=DEFAULT, contextWindow=131_072),  # measured window
]


def _profiles(fastest: str) -> str:
    slow = DEFAULT if fastest == GEMINI else GEMINI
    return json.dumps(
        {
            fastest: {"ttft_s": 1.0, "tok_per_s": 100, "reasoning_tier": 2},
            slow: {"ttft_s": 9.0, "tok_per_s": 100, "reasoning_tier": 2},
        }
    )


async def _capture(monkeypatch, prompt: str, fastest: str) -> dict:
    rec = _patch_models(monkeypatch, lambda m, s, n: AIMessage(content="done"))
    budgets: list[int] = []
    graphs: list[str] = []

    def spy_budget(**k):
        budgets.append(k["context_window"])
        return ContextBudget(**k)

    def spy_graph(*a, **k):
        graphs.append(k.get("model_name"))
        return _REAL_BUILD_GRAPH(*a, **k)

    monkeypatch.setattr(runner_mod, "ContextBudget", spy_budget)
    monkeypatch.setattr(runner_mod, "build_graph", spy_graph)
    reg = ToolRegistry()
    reg.register(_read_tool())
    reg.register(_seo_tool())
    http = _ok_http()
    convex = RecordingConvex()
    try:
        await run_generation(
            _req(prompt, CANDIDATES),
            _routed_settings(
                ai_router_profiles=_profiles(fastest),
                ai_orchestrated_runtime_enabled=True,
            ),
            convex,
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    system = "".join(
        str(m.content) for m in rec.first_messages or [] if isinstance(m, SystemMessage)
    )
    return {
        "final": _final(convex),
        "called": {m for m, *_ in rec.calls},
        "system": system,
        "tools": rec.calls[0][2] if rec.calls else None,
        "budget_window": budgets,
        "graph_model": graphs,
    }


@pytest.mark.parametrize("level", list(PROMPTS))
async def test_every_routed_model_gets_the_same_capability_layer(monkeypatch, level):
    a = await _capture(monkeypatch, PROMPTS[level], GEMINI)
    b = await _capture(monkeypatch, PROMPTS[level], DEFAULT)

    # the router really chose two different brains ...
    assert a["called"] == {GEMINI} and b["called"] == {DEFAULT}
    assert a["graph_model"] == [GEMINI] and b["graph_model"] == [DEFAULT]
    assert a["final"]["status"] == b["final"]["status"] == "done"
    # ... and both got exactly the same layer and the same budgets
    assert a["system"] and a["system"] == b["system"]
    assert a["tools"] == b["tools"]
    assert a["budget_window"] == b["budget_window"] == [131_072]

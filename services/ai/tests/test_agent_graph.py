"""Phase 4 — the bounded model<->executor loop, driven through graph.ainvoke.

Scripted duck-typed LLMs (plain + tools) let us exercise every control-flow path
without streaming or a real model: direct answer, single tool, multi-step,
max-steps cap, approval, and cancel.
"""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage

from app.agent.executor import ToolExecContext
from app.agent.graph import build_graph
from app.agent.policy import READ_SCOPE
from app.config import Settings
from app.models.tools import (
    Availability,
    SideEffect,
    ToolDefinition,
    ToolPermissions,
)
from app.runtime.writer import DeltaWriter
from app.tools.registry import ToolRegistry
from tests.test_writer_events import RecordingConvex


class ScriptedLLM:
    """Duck-typed chat model: returns queued AIMessages, one per ainvoke. The
    last one repeats if the script runs dry (keeps a runaway test terminating)."""

    def __init__(self, responses: list[AIMessage]) -> None:
        self._responses = responses
        self.calls = 0

    async def ainvoke(self, messages, *a, **k) -> AIMessage:
        self.calls += 1
        i = min(self.calls - 1, len(self._responses) - 1)
        return self._responses[i]


class FakeAdapter:
    def __init__(self, data=None) -> None:
        self.calls = 0
        self._data = data if data is not None else {"ok": True}

    async def call_tool(
        self,
        tool,
        payload,
        *,
        input_schema=None,
        idempotency_key=None,
        user_id="",
        workspace_id="",
    ) -> dict:
        self.calls += 1
        return {"ok": True, "tool_id": tool.tool_id, "data": self._data}


def _read_tool(**over) -> ToolDefinition:
    base = dict(
        tool_id="search_web",
        name="Search Web",
        path="/v1/search",
        method="post",
        side_effect=SideEffect.READ_ONLY,
        enabled=True,
        availability=Availability.AVAILABLE,
        permissions=ToolPermissions(required_permissions=["ollagraph:read"]),
    )
    base.update(over)
    return ToolDefinition(**base)


def _tc(cid: str, name: str = "search_web", args=None) -> dict:
    return {"name": name, "args": args or {"q": "x"}, "id": cid}


def _setup(tools, *, cancel=False):
    s = Settings(ollagraph_base_url="https://x.test", ollagraph_api_key="osk_x")
    reg = ToolRegistry()
    for t in tools:
        reg.register(t)
    resp = {"ok": True, "cancel": True} if cancel else {"ok": True}
    convex = RecordingConvex(resp)
    writer = DeltaWriter(convex, "s1", s)
    adapter = FakeAdapter()
    ctx = ToolExecContext(
        registry=reg,
        adapter=adapter,
        writer=writer,
        scope=READ_SCOPE,
        name_to_tool_id={t.tool_id: t.tool_id for t in tools},
        result_max_chars=8000,
        default_timeout_s=30.0,
    )
    return ctx, adapter, convex, writer


async def _invoke(plain, tools_llm, ctx, budget):
    graph = build_graph(plain, llm_tools=tools_llm, tools_ctx=ctx)
    state = {
        "messages": [HumanMessage(content="hello")],
        "system_prompt": "sys",
        "tool_budget": budget,
    }
    return await graph.ainvoke(state)


def _event_types(convex: RecordingConvex) -> list[str]:
    out = []
    for c in convex.calls:
        if c.get("op") == "event":
            out += [e["type"] for e in c["events"]]
    return out


async def test_direct_answer_no_tools():
    ctx, adapter, convex, _ = _setup([_read_tool()])
    tools_llm = ScriptedLLM([AIMessage(content="just an answer")])
    plain = ScriptedLLM([AIMessage(content="unused")])
    out = await _invoke(plain, tools_llm, ctx, budget=4)
    assert adapter.calls == 0
    assert out["messages"][-1].content == "just an answer"


async def test_single_tool_then_answer():
    ctx, adapter, convex, _ = _setup([_read_tool()])
    tools_llm = ScriptedLLM(
        [
            AIMessage(content="", tool_calls=[_tc("c1")]),
            AIMessage(content="final answer"),
        ]
    )
    plain = ScriptedLLM([AIMessage(content="unused")])
    out = await _invoke(plain, tools_llm, ctx, budget=4)
    assert adapter.calls == 1
    assert out["messages"][-1].content == "final answer"
    types = _event_types(convex)
    assert "TOOL_CALL" in types and "TOOL_RESULT" in types


async def test_multi_step_two_tools():
    ctx, adapter, convex, _ = _setup([_read_tool()])
    tools_llm = ScriptedLLM(
        [
            AIMessage(content="", tool_calls=[_tc("c1", args={"q": "a"})]),
            AIMessage(content="", tool_calls=[_tc("c2", args={"q": "b"})]),
            AIMessage(content="done"),
        ]
    )
    plain = ScriptedLLM([AIMessage(content="unused")])
    out = await _invoke(plain, tools_llm, ctx, budget=4)
    assert adapter.calls == 2
    assert out["messages"][-1].content == "done"


async def test_max_steps_forces_plain_final():
    ctx, adapter, convex, _ = _setup([_read_tool()])
    # tools_llm ALWAYS wants a tool; the cap must stop it.
    tools_llm = ScriptedLLM([AIMessage(content="", tool_calls=[_tc("c1")])])
    plain = ScriptedLLM([AIMessage(content="forced final")])
    out = await _invoke(plain, tools_llm, ctx, budget=1)
    assert adapter.calls == 1  # exactly one round, not unbounded
    assert plain.calls == 1  # plain LLM produced the final answer
    assert out["messages"][-1].content == "forced final"


async def test_approval_required_parks_and_suspends():
    # Phase 8: an approval-gated tool parks a durable approval and suspends the
    # turn (routes to END) instead of looping on to a text answer.
    high = _read_tool(side_effect=SideEffect.HIGH_IMPACT, permissions=ToolPermissions())
    ctx, adapter, convex, writer = _setup([high])
    tools_llm = ScriptedLLM([AIMessage(content="", tool_calls=[_tc("c1")])])
    plain = ScriptedLLM([AIMessage(content="unused")])
    out = await _invoke(plain, tools_llm, ctx, budget=4)
    assert adapter.calls == 0  # high-impact never silently executed
    assert writer.suspended is True  # parked, the loop does NOT continue
    assert [c for c in convex.calls if c.get("op") == "approval"]
    # The turn ends on the awaiting-approval observation.
    assert out["messages"][-1].tool_call_id == "c1"


async def test_cancel_mid_loop_stops_before_next_model_step():
    ctx, adapter, convex, writer = _setup([_read_tool()], cancel=True)
    tools_llm = ScriptedLLM(
        [
            AIMessage(content="", tool_calls=[_tc("c1")]),
            AIMessage(content="should not be reached"),
        ]
    )
    plain = ScriptedLLM([AIMessage(content="unused")])
    out = await _invoke(plain, tools_llm, ctx, budget=4)
    # First model call produced the tool_call; cancel arrived on the executor's
    # TOOL_CALL emit, so the model is NOT invoked a second time.
    assert tools_llm.calls == 1
    assert writer.cancel_requested is True
    assert out["messages"][-1].content != "should not be reached"


async def test_no_tools_graph_is_unchanged():
    # build_graph with neither llm_tools nor tools_ctx == the original 3-node
    # graph: prepare -> model -> END, the plain LLM answers directly.
    plain = ScriptedLLM([AIMessage(content="plain path")])
    graph = build_graph(plain)
    out = await graph.ainvoke(
        {"messages": [HumanMessage(content="hi")], "system_prompt": "s"}
    )
    assert out["messages"][-1].content == "plain path"


# ---- Phase 5: multi-source (RAG + web tool) in one bounded loop --------------
async def test_rag_and_web_tool_in_one_loop(monkeypatch):
    from app.agent.executor import RagContext
    from app.ingest import retrieve

    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        return [
            {
                "file_id": "f1",
                "content": "Our internal price is $9.",
                "source_metadata": {"source": "pricing.pdf"},
                "page": 1,
                "section": None,
                "distance": 0.2,
            }
        ]

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)

    ctx, adapter, convex, _ = _setup([_read_tool()])
    # Attach a RAG context so the same ctx serves both tool families.
    ctx.rag = RagContext(
        engine=object(),
        user_id="u",
        settings=Settings(
            ollagraph_base_url="https://x.test", ollagraph_api_key="osk_x"
        ),
    )
    tools_llm = ScriptedLLM(
        [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "search_knowledge",
                        "args": {"query": "our price"},
                        "id": "c1",
                    },
                    _tc("c2"),  # the Ollagraph web tool
                ],
            ),
            AIMessage(content="compared"),
        ]
    )
    plain = ScriptedLLM([AIMessage(content="unused")])
    out = await _invoke(plain, tools_llm, ctx, budget=4)
    assert adapter.calls == 1  # web tool ran
    assert "CITATION" in _event_types(convex)  # RAG ran
    assert out["messages"][-1].content == "compared"


# ---- capacity (quota) failover -----------------------------------------------
#
# The provider refusing for CAPACITY is a different failure from the streaming
# tool-call accumulator break, and both arrive from this gateway as a 502 — so
# they are told apart by message text, not exception type. Confusing them would
# send an accumulator bug to a different model, and a quota refusal to a client
# that will refuse identically.


class BoomLLM:
    """Duck-typed model that always raises the given exception."""

    def __init__(self, exc: Exception) -> None:
        self._exc = exc
        self.calls = 0

    async def ainvoke(self, messages, *a, **k):
        self.calls += 1
        raise self._exc


# The real body Ollima returns, verified against production on 2026-09-03.
QUOTA_TEXT = (
    "Error code: 502 - All variants failed with errors: deepseek-v4-pro: All "
    "model providers failed to infer with errors: ollama1: Error 429 Too Many "
    "Requests from openai client: you (eager_jepsen_160) have reached your "
    "weekly usage limit"
)


def test_quota_detector_matches_the_real_provider_body():
    from app.agent.llm import is_quota_error

    assert is_quota_error(RuntimeError(QUOTA_TEXT))
    # The accumulator break must NOT look like a capacity problem, or a code bug
    # would silently start routing to a different model.
    assert not is_quota_error(IndexError("Tool call index out of bounds"))
    assert not is_quota_error(ValueError("invalid schema"))


async def test_a_capacity_refusal_fails_over_to_the_alternate_model():
    primary = BoomLLM(RuntimeError(QUOTA_TEXT))
    alternate = ScriptedLLM([AIMessage(content="answered by the alternate")])
    told = {"n": 0}

    async def note() -> None:
        told["n"] += 1

    graph = build_graph(primary, quota_fallback=alternate, on_quota_fallback=note)
    out = await graph.ainvoke(
        {"messages": [HumanMessage(content="hi")], "system_prompt": "s"}
    )
    assert out["messages"][-1].content == "answered by the alternate"
    assert primary.calls == 1 and alternate.calls == 1
    # Not silent: a user whose answer came from another model is told, or the
    # model picker is lying to them.
    assert told["n"] == 1


async def test_a_non_capacity_failure_is_not_re_routed():
    """Only a capacity refusal may change models. Anything else must surface."""
    primary = BoomLLM(ValueError("something else entirely"))
    alternate = ScriptedLLM([AIMessage(content="should never be reached")])
    graph = build_graph(primary, quota_fallback=alternate)
    try:
        await graph.ainvoke(
            {"messages": [HumanMessage(content="hi")], "system_prompt": "s"}
        )
    except ValueError:
        pass
    else:  # pragma: no cover
        raise AssertionError("a non-capacity error must not be swallowed")
    assert alternate.calls == 0


async def test_without_a_configured_alternate_the_error_still_surfaces():
    """`ai_quota_fallback_model` empty => byte-identical to before."""
    primary = BoomLLM(RuntimeError(QUOTA_TEXT))
    graph = build_graph(primary)
    try:
        await graph.ainvoke(
            {"messages": [HumanMessage(content="hi")], "system_prompt": "s"}
        )
    except RuntimeError:
        pass
    else:  # pragma: no cover
        raise AssertionError("must not silently succeed with no alternate")


# ---- health latches: learn once, not once per step ---------------------------


def _fresh_health():
    from app.agent import health

    health.reset()
    return health


async def test_a_known_refusing_model_is_not_re_called_on_later_steps():
    """The first cut re-paid the doomed call on EVERY model step, and each
    payment is three attempts inside openai-python. One turn, five steps, five
    wasted calls — the recovery cost more than the failure."""
    _fresh_health()
    primary = BoomLLM(RuntimeError(QUOTA_TEXT))
    alternate = ScriptedLLM([AIMessage(content="a"), AIMessage(content="b")])
    graph = build_graph(
        primary, quota_fallback=alternate, model_name="dead-model", health_ttl_s=600
    )
    st = {"messages": [HumanMessage(content="hi")], "system_prompt": "s"}
    await graph.ainvoke(st)
    assert primary.calls == 1  # learned
    await graph.ainvoke(st)
    assert primary.calls == 1, "second turn must not re-pay the doomed call"
    assert alternate.calls == 2


async def test_the_refusal_belief_expires_so_a_recovered_model_returns():
    """TTL'd on purpose: a weekly quota resets, and nothing should require a
    restart to notice. A non-positive ttl is clamped to a 1s floor by design, so
    expiry is exercised by ageing the deadline rather than passing a negative.

    Since the health registry, an expired belief is KEPT as history (the
    registry reports it) but no longer believed, and the next real success
    clears it."""
    import time as _t

    health = _fresh_health()
    health.mark_exhausted("m", ttl_s=600)
    assert health.is_exhausted("m")
    health._models["m"].retry_at = _t.monotonic() - 1  # deadline already passed
    assert not health.is_exhausted("m"), "an expired cooldown must let the model back"
    health.record_success("m")
    assert health._models["m"].state == health.HEALTHY


async def test_a_stream_break_is_latched_without_losing_the_preamble():
    """Once a model's tool-call deltas are known unaccumulatable, later calls go
    straight to the non-streaming twin. The content-clear must NOT fire there:
    it exists to de-duplicate text that already streamed, and on this path
    nothing did — clearing would silently drop the answer."""
    health = _fresh_health()
    health.mark_stream_broken("m")

    streaming = BoomLLM(IndexError("Tool call index out of bounds"))
    nonstreaming = ScriptedLLM([AIMessage(content="preamble kept")])

    ctx, _adapter, _convex, _writer = _setup([_read_tool()])
    graph = build_graph(
        streaming,
        llm_tools=streaming,
        llm_tools_fallback=nonstreaming,
        tools_ctx=ctx,
        model_name="m",
    )
    out = await graph.ainvoke(
        {
            "messages": [HumanMessage(content="hi")],
            "system_prompt": "s",
            "tool_budget": 2,
        }
    )
    assert streaming.calls == 0, "the doomed streaming attempt must be skipped"
    assert out["messages"][-1].content == "preamble kept"

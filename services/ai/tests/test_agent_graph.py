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

    async def call_tool(self, tool, payload, *, input_schema=None) -> dict:
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


async def test_approval_required_not_executed_but_loop_completes():
    high = _read_tool(side_effect=SideEffect.HIGH_IMPACT, permissions=ToolPermissions())
    ctx, adapter, convex, _ = _setup([high])
    tools_llm = ScriptedLLM(
        [
            AIMessage(content="", tool_calls=[_tc("c1")]),
            AIMessage(content="cannot do that without approval"),
        ]
    )
    plain = ScriptedLLM([AIMessage(content="unused")])
    out = await _invoke(plain, tools_llm, ctx, budget=4)
    assert adapter.calls == 0  # high-impact never silently executed
    assert "APPROVAL_REQUEST" in _event_types(convex)
    assert out["messages"][-1].content == "cannot do that without approval"


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

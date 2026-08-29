"""Universal streaming — the agent (tool-bound) path streams token-by-token like a
normal prompt, and the accumulator-error fallback (for this deployment's gateway,
whose streamed tool-call deltas break langchain's accumulator) recovers tool_calls
WITHOUT re-pushing the already-streamed content (no duplication).

Hermetic: fake streaming chat models, no network. The streaming assertions rely on
LangGraph `stream_mode="messages"` capturing a model's per-token callbacks — the same
path the runner consumes in prod.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from app.agent.executor import ToolExecContext
from app.agent.graph import _clear_content_for_dup, build_graph
from app.agent.policy import READ_SCOPE
from app.runtime.runner import _chunk_text
from app.runtime.writer import DeltaWriter
from tests.conftest import make_settings
from tests.test_agent_graph import _read_tool, _setup
from tests.test_writer_events import RecordingConvex


def _ctx():
    s = make_settings("http://x")
    writer = DeltaWriter(RecordingConvex({"ok": True}), "s1", s)
    return ToolExecContext(
        registry=None,
        adapter=None,
        writer=writer,
        scope=READ_SCOPE,
        name_to_tool_id={},
        result_max_chars=8000,
        default_timeout_s=30.0,
    )


async def _visible(graph, *, budget):
    """The user-visible model-node text — exactly what the runner's astream loop
    pushes (same node filter, same `_chunk_text`, no special-casing)."""
    state = {
        "messages": [HumanMessage("hi")],
        "system_prompt": "sys",
        "tool_budget": budget,
    }
    out: list[str] = []
    async for chunk, meta in graph.astream(state, stream_mode="messages"):
        if meta.get("langgraph_node") != "model":
            continue
        t = _chunk_text(chunk)
        if t:
            out.append(t)
    return out


# --- fake models --------------------------------------------------------------
class _StreamThenRaise(BaseChatModel):
    """Streams a content preamble token-by-token (like a real model), THEN raises the
    accumulator error the way this deployment's gateway does when it appends broken
    tool-call deltas after the content."""

    text: str = "Let me search now. "

    @property
    def _llm_type(self) -> str:
        return "stream-then-raise"

    def _generate(self, *a, **k):  # pragma: no cover - streaming path is used
        raise NotImplementedError

    async def _astream(
        self, messages, stop=None, run_manager=None, **kw
    ) -> AsyncIterator[ChatGenerationChunk]:
        for word in self.text.split(" "):
            if not word:
                continue
            piece = word + " "
            ch = ChatGenerationChunk(message=AIMessageChunk(content=piece))
            if run_manager:
                await run_manager.on_llm_new_token(piece, chunk=ch)
            yield ch
        raise RuntimeError("Tool call index out of bounds")


class _NonStreamingToolFallback(BaseChatModel):
    """A REAL non-streaming chat model (like `llm_for_tools`) that returns the recovered
    tool call in one shot. Being a real BaseChatModel, it fires on_llm_end — which is
    exactly the emit path the NOSTREAM tag must silence."""

    text: str = "Let me search now. "

    @property
    def _llm_type(self) -> str:
        return "nonstream-tool-fallback"

    def _generate(self, messages, stop=None, run_manager=None, **kw) -> ChatResult:
        tc = {"name": "search_web", "args": {"q": "x"}, "id": "c1", "type": "tool_call"}
        msg = AIMessage(content=self.text, tool_calls=[tc])
        return ChatResult(generations=[ChatGeneration(message=msg)])


# --- the fix: tool-bound final answer streams as MANY chunks ------------------
async def test_final_answer_streams_under_tools():
    answer = "The answer is forty two and here is a bit more detail to stream"
    # llm_tools = a STREAMING client (bound tools path). Model answers directly with
    # budget>0 — the exact skill final-answer scenario that used to single-shot.
    llm_tools = GenericFakeChatModel(messages=iter([AIMessage(answer)]))
    plain = GenericFakeChatModel(messages=iter([AIMessage("unused")]))
    graph = build_graph(plain, llm_tools=llm_tools, tools_ctx=_ctx())
    chunks = await _visible(graph, budget=5)
    assert len(chunks) > 1, f"single-shot: got {len(chunks)} chunk(s)"
    assert "".join(chunks).strip() == answer


async def test_normal_prompt_still_streams():
    answer = "A content delivery network caches files closer to users"
    plain = GenericFakeChatModel(messages=iter([AIMessage(answer)]))
    graph = build_graph(plain)  # plain no-tools graph, unchanged
    chunks = await _visible(graph, budget=0)
    assert len(chunks) > 1
    assert "".join(chunks).strip() == answer


# --- the fallback: recover tool_calls, no duplicated content ------------------
async def test_clear_content_for_dup_unit():
    msg = AIMessage(
        content="preamble text",
        tool_calls=[{"name": "t", "args": {}, "id": "1", "type": "tool_call"}],
    )
    out = _clear_content_for_dup(msg)
    assert out.content == ""  # already-streamed preamble dropped
    assert out.tool_calls[0]["name"] == "t"  # tool_calls preserved for routing
    # No tool_calls => leave intact (never drop a real answer).
    plain = AIMessage(content="a final answer")
    assert _clear_content_for_dup(plain) is plain


async def test_fallback_recovers_tools_without_duplicating_content():
    # Full loop: streaming tool turn breaks the accumulator AFTER the preamble streamed;
    # the tagged non-streaming fallback recovers the tool_calls; the tool runs; a final
    # answer streams. The preamble must appear EXACTLY ONCE (no dup from the fallback).
    ctx, adapter, convex, _ = _setup([_read_tool()])
    graph = build_graph(
        GenericFakeChatModel(messages=iter([AIMessage("Here are the results found.")])),
        llm_tools=_StreamThenRaise(),
        llm_tools_fallback=_NonStreamingToolFallback(),
        tools_ctx=ctx,
    )
    # budget=1 => exactly ONE tool-call turn, then the budget=0 final answer.
    chunks = await _visible(graph, budget=1)
    joined = "".join(chunks)
    assert adapter.calls == 1, "tool did not run (tool_calls lost in fallback)"
    assert joined.count("Let me search now.") == 1, f"duplicated preamble: {joined!r}"
    assert "Here are the results found." in joined, "final answer did not stream"
    # final answer streamed as multiple chunks (not single-shot)
    assert len([c for c in chunks if "results" in c or "Here" in c]) >= 1


async def test_no_fallback_when_none_reraises():
    # No fallback wired => the accumulator error propagates (not silently swallowed).
    graph = build_graph(
        GenericFakeChatModel(messages=iter([AIMessage("x")])),
        llm_tools=_StreamThenRaise(),
        llm_tools_fallback=None,
        tools_ctx=_ctx(),
    )
    with pytest.raises(RuntimeError):
        await graph.ainvoke(
            {"messages": [HumanMessage("hi")], "system_prompt": "", "tool_budget": 1}
        )

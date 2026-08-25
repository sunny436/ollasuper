"""The LangGraph agent.

    START -> prepare -> model -> END

Minimal now, but shaped so tools slot in without touching the streaming path:

    builder.add_node("tools", ToolNode(TOOLS))
    builder.add_conditional_edges(
        "model", tools_condition, {"tools": "tools", END: END}
    )
    builder.add_edge("tools", "model")

The runner already filters on metadata["langgraph_node"] == "model", so tool
output never leaks into the user-visible stream. That filter is written on day
one precisely so adding tools later is a two-line change rather than a rewrite.

There is deliberately NO checkpointer. Convex is the source of truth for
messages; a checkpointer would create a second durable copy with a
reconciliation problem every turn, a second stateful dependency that
deploy/backup.sh does not know about, and no multi-tenant scoping. State is
rebuilt from the pushed history each turn.
"""

from __future__ import annotations

import time
import uuid
from typing import TYPE_CHECKING, Annotated, NotRequired, TypedDict

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AnyMessage, SystemMessage
from langchain_core.runnables import Runnable
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from app.agent.budget import fit_messages
from app.agent.executor import execute_tool_calls
from app.models.events import EventType

if TYPE_CHECKING:
    from app.agent.executor import ToolExecContext


class ChatState(TypedDict):
    """A TypedDict with add_messages, not a Pydantic model.

    Pydantic belongs at the HTTP edge, where it already validates the request.
    Inside the graph it would re-validate on every token-producing superstep
    for no benefit.
    """

    messages: Annotated[list[AnyMessage], add_messages]
    system_prompt: str
    # Declared now so adding a node later is not a state migration.
    retrieved: NotRequired[list[dict]]
    tool_budget: NotRequired[int]
    # Phase 6: token budget for the in-graph message list, so each model call is
    # re-fit (accumulated tool results compacted) before it is sent.
    fit_budget: NotRequired[int]
    # Phase 10: the model's current bound tool specs. When dynamic capability
    # loading is active, the executor node GROWS this (find_capabilities discoveries)
    # and the model node RE-BINDS from it, so a just-discovered tool is callable.
    bound_specs: NotRequired[list]


async def _prepare(state: ChatState) -> dict:
    """Pure: assemble the final message list. No LLM call.

    This is the seam where RAG lands later (prepare -> retrieve -> model),
    merging `retrieved` into the system block.
    """
    messages = state["messages"]
    system = state.get("system_prompt") or ""
    if system and not (messages and isinstance(messages[0], SystemMessage)):
        return {"messages": [SystemMessage(content=system), *messages]}
    return {}


def build_graph(
    llm: BaseChatModel,
    *,
    llm_tools: Runnable | None = None,
    tools_ctx: ToolExecContext | None = None,
):
    """Compile the generation graph.

    `llm_tools`/`tools_ctx` both absent (the default, and the prod default while
    the agent is off) => the original START -> prepare -> model -> END graph,
    byte-identical to before Phase 4. When both are present the graph gains a
    bounded model<->executor loop; the runner's `langgraph_node == "model"`
    filter keeps executor output off the user-visible stream unchanged.
    """
    if llm_tools is None or tools_ctx is None:
        async def model(state: ChatState) -> dict:
            response = await llm.ainvoke(state["messages"])
            return {"messages": [response]}

        builder = StateGraph(ChatState)
        builder.add_node("prepare", _prepare)
        builder.add_node("model", model)
        builder.add_edge(START, "prepare")
        builder.add_edge("prepare", "model")
        builder.add_edge("model", END)
        return builder.compile(checkpointer=None)

    return _build_agent_graph(llm, llm_tools, tools_ctx)


async def _emit_model_call(
    tools_ctx: ToolExecContext, response: object, dur_s: float
) -> None:
    """Phase 8: record the MODEL's decision at one step (post-hoc, after ainvoke,
    so NO TTFT impact). Best-effort observability — the model call is re-derived on
    resume, so this is not a recovery record. Agent graph only; the plain graph
    (simple answer) leaves its trace on the finalized chatMessages record."""
    tool_calls = getattr(response, "tool_calls", None) or []
    usage = getattr(response, "usage_metadata", None) or {}
    meta = getattr(response, "response_metadata", None) or {}
    # Phase 9: attribute the decision to its agent (the reserved PolicyScope
    # .agent_id, now live). None for the default assistant — serialized as
    # `agent_id: null`, an additive optional field the UI/fold already ignore.
    await tools_ctx.writer.emit_event(
        EventType.MODEL_CALL,
        model_call_id=str(uuid.uuid4()),
        run_id=tools_ctx.run_id,
        model=meta.get("model_name") or "",
        attempt=tools_ctx.run_attempt,
        decision=f"tools:{len(tool_calls)}" if tool_calls else "text",
        duration_ms=int(dur_s * 1000),
        input_tokens=usage.get("input_tokens"),
        output_tokens=usage.get("output_tokens"),
        provider_request_id=meta.get("id") or getattr(response, "id", None),
        finish_reason=meta.get("finish_reason"),
        agent_id=getattr(tools_ctx.scope, "agent_id", None),
    )


def _build_agent_graph(
    llm: BaseChatModel, llm_tools: Runnable, tools_ctx: ToolExecContext
):
    async def model(state: ChatState) -> dict:
        # With budget left, offer tools; at the cap fall back to the plain LLM so
        # the model MUST answer in text and cannot emit a dangling tool_call.
        budget = state.get("tool_budget", 0)
        # Phase 10: when dynamic capability loading is active, RE-BIND from the
        # (possibly expanded) working set each step so a just-discovered tool is
        # callable. With no resolver attached, the fixed bind is used unchanged.
        if tools_ctx.capabilities is not None and tools_ctx.rebind is not None:
            specs = state.get("bound_specs") or []
            client = tools_ctx.rebind(specs) if (budget > 0 and specs) else llm
        else:
            client = llm_tools if budget > 0 else llm
        # Phase 6 (B3): re-fit the accumulated messages to the per-turn budget
        # before EACH model call, so multi-step tool results can't overrun the
        # window — old raw results compact to references (pairing preserved).
        fit_budget = state.get("fit_budget")
        messages = (
            fit_messages(state["messages"], fit_budget)
            if fit_budget
            else state["messages"]
        )
        t0 = time.monotonic()
        response = await client.ainvoke(messages)
        # Phase 8: the model-decision half of the trace (post-hoc, no TTFT hit).
        await _emit_model_call(tools_ctx, response, time.monotonic() - t0)
        return {"messages": [response]}

    async def executor(state: ChatState) -> dict:
        last = state["messages"][-1]
        tool_calls = list(getattr(last, "tool_calls", None) or [])
        messages = await execute_tool_calls(tool_calls, tools_ctx)
        # One executor pass = one step consumed, regardless of how many tools it
        # ran in parallel. Never below zero.
        out: dict = {
            "messages": messages,
            "tool_budget": max(0, state.get("tool_budget", 0) - 1),
        }
        # Phase 10: drain any capabilities the model discovered this step into the
        # bound working set so the next model step can call them (progressive
        # disclosure). The executor already updated the strict allowlist in-place.
        if tools_ctx.capabilities is not None and tools_ctx.pending_capabilities:
            out["bound_specs"] = (state.get("bound_specs") or []) + list(
                tools_ctx.pending_capabilities
            )
            tools_ctx.pending_capabilities = []
        return out

    def route_after_model(state: ChatState) -> str:
        # Superset of langgraph's tools_condition: also honours the step budget
        # and a cancel arriving mid-turn.
        if tools_ctx.writer.cancel_requested or tools_ctx.writer.suspended:
            return END
        last = state["messages"][-1]
        has_calls = bool(getattr(last, "tool_calls", None))
        if has_calls and state.get("tool_budget", 0) > 0:
            return "executor"
        return END

    def route_after_executor(state: ChatState) -> str:
        # Back to the model to observe the results, unless the user cancelled, a
        # tool parked awaiting approval (Phase 8), or the model requested user
        # clarification (Phase 10 — the turn ends here to surface the question).
        if (
            tools_ctx.writer.cancel_requested
            or tools_ctx.writer.suspended
            or tools_ctx.clarification is not None
        ):
            return END
        return "model"

    builder = StateGraph(ChatState)
    builder.add_node("prepare", _prepare)
    builder.add_node("model", model)
    builder.add_node("executor", executor)
    builder.add_edge(START, "prepare")
    builder.add_edge("prepare", "model")
    builder.add_conditional_edges(
        "model", route_after_model, {"executor": "executor", END: END}
    )
    builder.add_conditional_edges(
        "executor", route_after_executor, {"model": "model", END: END}
    )
    return builder.compile(checkpointer=None)

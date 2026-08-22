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

from typing import TYPE_CHECKING, Annotated, NotRequired, TypedDict

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AnyMessage, SystemMessage
from langchain_core.runnables import Runnable
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from app.agent.executor import execute_tool_calls

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


def _build_agent_graph(
    llm: BaseChatModel, llm_tools: Runnable, tools_ctx: ToolExecContext
):
    async def model(state: ChatState) -> dict:
        # With budget left, offer tools; at the cap fall back to the plain LLM so
        # the model MUST answer in text and cannot emit a dangling tool_call.
        budget = state.get("tool_budget", 0)
        client = llm_tools if budget > 0 else llm
        response = await client.ainvoke(state["messages"])
        return {"messages": [response]}

    async def executor(state: ChatState) -> dict:
        last = state["messages"][-1]
        tool_calls = list(getattr(last, "tool_calls", None) or [])
        messages = await execute_tool_calls(tool_calls, tools_ctx)
        # One executor pass = one step consumed, regardless of how many tools it
        # ran in parallel. Never below zero.
        return {
            "messages": messages,
            "tool_budget": max(0, state.get("tool_budget", 0) - 1),
        }

    def route_after_model(state: ChatState) -> str:
        # Superset of langgraph's tools_condition: also honours the step budget
        # and a cancel arriving mid-turn.
        if tools_ctx.writer.cancel_requested:
            return END
        last = state["messages"][-1]
        has_calls = bool(getattr(last, "tool_calls", None))
        if has_calls and state.get("tool_budget", 0) > 0:
            return "executor"
        return END

    def route_after_executor(state: ChatState) -> str:
        # Back to the model to observe the results, unless the user cancelled.
        return END if tools_ctx.writer.cancel_requested else "model"

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

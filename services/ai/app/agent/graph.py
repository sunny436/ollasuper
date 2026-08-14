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

from typing import Annotated, NotRequired, TypedDict

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AnyMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages


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


def build_graph(llm: BaseChatModel):
    async def prepare(state: ChatState) -> dict:
        """Pure: assemble the final message list. No LLM call.

        This is the seam where RAG lands later (prepare -> retrieve -> model),
        merging `retrieved` into the system block.
        """
        messages = state["messages"]
        system = state.get("system_prompt") or ""
        if system and not (messages and isinstance(messages[0], SystemMessage)):
            return {"messages": [SystemMessage(content=system), *messages]}
        return {}

    async def model(state: ChatState) -> dict:
        response = await llm.ainvoke(state["messages"])
        return {"messages": [response]}

    builder = StateGraph(ChatState)
    builder.add_node("prepare", prepare)
    builder.add_node("model", model)
    builder.add_edge(START, "prepare")
    builder.add_edge("prepare", "model")
    builder.add_edge("model", END)
    return builder.compile(checkpointer=None)

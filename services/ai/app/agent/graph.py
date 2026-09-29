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
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Annotated, NotRequired, TypedDict

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AnyMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.runnables import Runnable
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from app.agent import health
from app.agent.budget import fit_messages
from app.agent.executor import execute_tool_calls
from app.agent.harmony import recover_into_message
from app.humanizer.stage import MIN_WORDS, word_count
from app.logging import get_logger
from app.models.events import EventType

if TYPE_CHECKING:
    from app.agent.executor import ToolExecContext

log = get_logger(__name__)

# Never-empty floor (see route_after_model). Fires only when the turn has no
# ANSWER — neither a final message with text nor a deliverable-sized block. Both
# failure shapes are measured on production (2026-09-29): 21 of the 23 near-empty
# answers after tool work were exactly 0 characters, all after provider errors;
# and skill turns whose searches all failed ended on narration alone ("I'll
# research X first… Search backend hiccuped. Retrying.", 12-13 words) with the
# deliverable never written. A short FINAL answer ("391", "Yes.") is an answer.
ANSWER_FLOOR_PROMPT = (
    "The tool work for this request is finished. Now write the final answer for "
    "the user, directly and completely, using the tool results above. If some "
    "tools failed or returned nothing useful, say plainly what could not be "
    "verified, then give the best answer you can from reliable knowledge. Do not "
    "call tools and do not leave the answer empty."
)


def _message_text(message: object) -> str:
    """The visible text of a model message: plain content, or the text parts
    of a structured content list."""
    content = getattr(message, "content", "") or ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "") if isinstance(part, dict) else str(part)
            for part in content
        )
    return ""


# After a tool FAILED this turn, a final message this short is a retry that
# never happened, not an answer: "The document tool rejected that schema — let
# me try the simpler section format." (13 words) ended a one-page-report turn on
# production (2026-09-29). Short answers after SUCCESSFUL tools ("391") are real;
# the shortest web answer after failed searches on the benchmark was ~50 words.
FAILED_TURN_MIN_WORDS = 25


def _turn_has_answer(messages: list, writer: object) -> bool:
    """Whether this turn has already produced an answer, not just narration.

    A final message (no tool calls) counts with any text — unless a tool failed
    this turn, when it must reach FAILED_TURN_MIN_WORDS. Text that rode along
    with a tool call is narration unless it reaches deliverable size — the
    humanizer's MIN_WORDS, the line the runner already draws between narration
    and a deliverable. Both sources are read because each has a blind spot: the
    messages hold a draft the humanizer is keeping back from the writer, and the
    writer holds streamed text whose message copy the stream-break recovery
    cleared.
    """
    if word_count(getattr(writer, "text", "") or "") >= MIN_WORDS:
        return True
    turn: list = []
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            break
        turn.append(message)
    failed = any(
        isinstance(m, ToolMessage) and getattr(m, "status", "") == "error"
        for m in turn
    )
    for message in turn:
        if not isinstance(message, AIMessage):
            continue
        text = _message_text(message)
        if not text.strip():
            continue
        words = word_count(text)
        if getattr(message, "tool_calls", None):
            if words >= MIN_WORDS:
                return True
        elif not failed or words >= FAILED_TURN_MIN_WORDS:
            return True
    return False


# LangGraph's messages-mode drops a chat-model run tagged with this from BOTH its
# streamed tokens and its on_llm_end: StreamMessagesHandler.on_chat_model_start skips
# registering a run whose tags contain it (langgraph's own TAG_NOSTREAM convention).
# The non-streaming fallback below is invoked with this tag so its OWN emit of the
# recovered message is silenced. The node-return path (on_chain_end) ignores the tag,
# so the returned message ALSO has its content cleared (_clear_content_for_dup). Both
# together keep the already-streamed preamble from being re-pushed (duplicated).
NOSTREAM_TAG = "nostream"


def _clear_content_for_dup(response: object) -> object:
    """After a streaming tool-call turn broke the accumulator and was recovered by the
    non-streaming fallback, the turn's content has ALREADY streamed to the user. Return
    a tool_calls-only copy so messages-mode does not re-push (duplicate) that content.

    Only fires when tool_calls are present (this branch is always a tool-call turn); a
    fallback that somehow produced pure text is left intact rather than dropped. The id
    is preserved so history/routing are stable."""
    content = getattr(response, "content", "")
    tool_calls = list(getattr(response, "tool_calls", None) or [])
    if not content or not tool_calls:
        return response
    return AIMessage(
        content="",
        tool_calls=tool_calls,
        id=getattr(response, "id", None),
        additional_kwargs=getattr(response, "additional_kwargs", None) or {},
    )


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
    # Remaining step BACKSTOP. `None` = no count ceiling (the default): the loop is
    # bounded by PROGRESS (`tool_stalls`), by the no-progress deadline, and by the
    # context budget — never by a fixed number of round-trips.
    tool_budget: NotRequired[int | None]
    # Consecutive steps that produced no successful, non-duplicate tool result.
    # A productive step resets it, so useful work is unbounded and a loop is not.
    tool_stalls: NotRequired[int]
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
    llm_tools_fallback: Runnable | None = None,
    tools_ctx: ToolExecContext | None = None,
    quota_fallback: Runnable | None = None,
    quota_fallback_tools: Runnable | None = None,
    on_quota_fallback: Callable[[], Awaitable[None]] | None = None,
    model_name: str = "",
    health_ttl_s: float = 600.0,
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
            # Already known to be refusing: go straight to the alternate rather
            # than re-paying a call that cannot succeed.
            if quota_fallback is not None and health.is_exhausted(model_name):
                if on_quota_fallback is not None:
                    await on_quota_fallback()
                return {"messages": [await quota_fallback.ainvoke(state["messages"])]}
            try:
                response = await llm.ainvoke(state["messages"])
            except Exception as e:  # noqa: BLE001 — model-level refusal, see below
                # The provider refused THIS MODEL before answering (quota, provider
                # error, unreachable, request timeout), not anything in this turn.
                # One hop to an independent model recovers it; without this the
                # turn just fails, which is what made a provider-side weekly quota
                # outage look like an application fault. Anything else — including
                # a failure that may have streamed text already — re-raises.
                failure = health.classify(e)
                if failure is None or not failure.pre_stream:
                    raise
                health.record_exception(model_name, e, base_s=health_ttl_s)
                if quota_fallback is None:
                    raise
                log.warning(
                    "model_quota_fallback",
                    extra={"node": "plain", "kind": failure.kind},
                )
                if on_quota_fallback is not None:
                    await on_quota_fallback()
                response = await quota_fallback.ainvoke(state["messages"])
            return {"messages": [response]}

        builder = StateGraph(ChatState)
        builder.add_node("prepare", _prepare)
        builder.add_node("model", model)
        builder.add_edge(START, "prepare")
        builder.add_edge("prepare", "model")
        builder.add_edge("model", END)
        return builder.compile(checkpointer=None)

    return _build_agent_graph(
        llm,
        llm_tools,
        llm_tools_fallback,
        tools_ctx,
        quota_fallback,
        quota_fallback_tools,
        on_quota_fallback,
        model_name,
        health_ttl_s,
    )


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
    llm: BaseChatModel,
    llm_tools: Runnable,
    llm_tools_fallback: Runnable | None,
    tools_ctx: ToolExecContext,
    quota_fallback: Runnable | None = None,
    quota_fallback_tools: Runnable | None = None,
    on_quota_fallback: Callable[[], Awaitable[None]] | None = None,
    model_name: str = "",
    health_ttl_s: float = 600.0,
):
    async def model(state: ChatState) -> dict:
        # With budget left, offer tools; at the cap fall back to the plain LLM so
        # the model MUST answer in text and cannot emit a dangling tool_call.
        budget = state.get("tool_budget", 0)
        has_budget = budget is None or budget > 0
        # Phase 10: when dynamic capability loading is active, RE-BIND from the
        # (possibly expanded) working set each step so a just-discovered tool is
        # callable. With no resolver attached, the fixed bind is used unchanged.
        #
        # STREAMING: the tool-bound client is now STREAMING so the final answer (and
        # any narration) streams token-by-token exactly like a normal prompt —
        # skill-agnostic, one place. `fallback_client` is the NON-streaming twin: this
        # deployment's gateway streams proper tool-call DELTAS in a shape that breaks
        # langchain's accumulator ("Tool call index out of bounds"). That error fires
        # only AFTER the content preamble has fully streamed (the tool-call deltas come
        # last), so the visible text is already on the stream; we then recover valid
        # tool_calls from the non-streaming twin and CLEAR its content so neither
        # messages-mode emit path re-pushes (duplicates) the preamble. When budget is
        # exhausted / no tools, both clients are the plain streaming `llm` (no tools),
        # so the try always succeeds → byte-identical to the pre-streaming behaviour.
        quota_tools = quota_fallback_tools
        if tools_ctx.capabilities is not None and tools_ctx.rebind is not None:
            specs = state.get("bound_specs") or []
            use_tools = has_budget and bool(specs)
            client = tools_ctx.rebind(specs) if use_tools else llm
            fb = tools_ctx.rebind_fallback
            fallback_client = fb(specs) if (use_tools and fb is not None) else None
            # The capacity failover sees the SAME working set as the primary,
            # including tools find_capabilities loaded on earlier steps.
            qrb = tools_ctx.rebind_quota_fallback
            if use_tools and qrb is not None:
                quota_tools = qrb(specs)
        else:
            use_tools = has_budget
            client = llm_tools if use_tools else llm
            fallback_client = llm_tools_fallback if use_tools else None
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
        stream_broke = False
        qfb = quota_tools if use_tools else quota_fallback

        # KNOWN REFUSING: skip the doomed call. Without this every step of a
        # multi-step turn re-pays it, and each payment is three attempts inside
        # openai-python (it retries the gateway's 502) — so the recovery cost
        # more than the failure it was recovering from.
        if qfb is not None and health.is_exhausted(model_name):
            if on_quota_fallback is not None:
                await on_quota_fallback()
            response = await qfb.ainvoke(messages)
            recover_into_message(response)
            await _emit_model_call(tools_ctx, response, time.monotonic() - t0)
            return {"messages": [response]}

        # KNOWN TO BREAK THE ACCUMULATOR: go straight to the non-streaming twin.
        # `stream_broke` stays FALSE here on purpose — it drives the content
        # clear below, which is only correct when the text has ALREADY streamed.
        # Nothing streamed on this path, so clearing would silently drop the
        # preamble instead of de-duplicating it.
        skip_stream = (
            use_tools
            and fallback_client is not None
            and not health.streams_tool_calls_cleanly(model_name)
        )
        primary = fallback_client if skip_stream else client
        try:
            response = await primary.ainvoke(messages)
        except Exception as e:  # noqa: BLE001 — DIFFERENT failures, see below
            # A MODEL-LEVEL refusal is checked first and is a different thing from
            # the accumulator break below: it needs a different MODEL, whereas
            # the break needs the same model without streaming. Collapsing them
            # would send an accumulator bug to another model and a quota refusal to
            # a client that will refuse identically. Only refusals raised BEFORE a
            # token (status / connect / request timeout) fail over: an error from
            # stream iteration may follow text the user already saw.
            failure = health.classify(e)
            if failure is not None and failure.pre_stream:
                health.record_exception(model_name, e, base_s=health_ttl_s)
                if qfb is None:
                    raise
                log.warning(
                    "model_quota_fallback",
                    extra={"node": "agent", "kind": failure.kind},
                )
                if on_quota_fallback is not None:
                    await on_quota_fallback()
                response = await qfb.ainvoke(messages)
                await _emit_model_call(tools_ctx, response, time.monotonic() - t0)
                return {"messages": [response]}
            if fallback_client is None or skip_stream:
                raise
            # One observation is enough: this model's tool-call deltas cannot be
            # accumulated, so later steps and later turns skip the attempt. Only an
            # UNCLASSIFIED error is that break; a recognised transport error takes
            # the same recovery without latching the model as broken for hours.
            if failure is None:
                health.mark_stream_broken(model_name)
            log.warning("model_stream_fallback", extra={"run_id": tools_ctx.run_id})
            # Tag the recovery call NOSTREAM so messages-mode silences the fallback's
            # OWN emit (its content already streamed via the primary above); the node
            # return is separately silenced by clearing the content after recovery.
            fb_client = fallback_client
            if hasattr(fb_client, "with_config"):
                fb_client = fb_client.with_config(tags=[NOSTREAM_TAG])
            response = await fb_client.ainvoke(messages)
            stream_broke = True
        # Recover gpt-5.6-luna "harmony" tool-call leaks: the gateway sometimes
        # serializes tool calls into `.content` as text instead of `.tool_calls`,
        # so route_after_model would end the step and the calls would never run
        # (breaking multi-step audits). Parse them back into real tool_calls and
        # clean the content so the leak neither drops calls nor pollutes history.
        # NO-OP on any content without a harmony marker.
        recover_into_message(response)
        if stream_broke:
            # The streaming attempt already streamed this turn's content (the preamble
            # precedes the tool-call deltas that broke the accumulator), so the visible
            # text is complete. Drop the fallback's copy of it — otherwise messages-mode
            # (on_llm_end AND the node-return path on_chain_end) would push it again and
            # DUPLICATE it. tool_calls are kept for routing; this branch is only ever a
            # tool-call turn, never the final answer, so no user-facing text is lost.
            response = _clear_content_for_dup(response)
        # Phase 8: the model-decision half of the trace (post-hoc, no TTFT hit).
        await _emit_model_call(tools_ctx, response, time.monotonic() - t0)
        return {"messages": [response]}

    async def executor(state: ChatState) -> dict:
        last = state["messages"][-1]
        tool_calls = list(getattr(last, "tool_calls", None) or [])
        messages = await execute_tool_calls(tool_calls, tools_ctx)
        # A step is PRODUCTIVE if it returned at least one non-error tool result.
        # Errors, duplicates, refusals and cancellations all carry status "error",
        # so a step that only produced those advanced nothing. Counting consecutive
        # unproductive steps is what bounds the loop now that there is no count
        # ceiling: real work resets it, a spin does not.
        productive = any(
            getattr(m, "status", "success") != "error" for m in messages
        )
        budget = state.get("tool_budget", 0)
        stalls = 0 if productive else state.get("tool_stalls", 0) + 1
        cap = tools_ctx.max_stall_steps
        stalled = bool(cap) and stalls >= cap
        if stalled:
            log.info(
                "agent.tool_loop_stalled",
                extra={"run_id": tools_ctx.run_id, "stalls": stalls},
            )
        # One executor pass = one step consumed, regardless of how many tools it
        # ran in parallel. None = no ceiling; never below zero. A stalled loop
        # zeroes the budget HERE (a node return is the only thing that updates
        # state — a router cannot), so the next model call has no tools bound and
        # must answer in text rather than emit another dangling call.
        out: dict = {
            "messages": messages,
            "tool_budget": (
                0 if stalled else None if budget is None else max(0, budget - 1)
            ),
            "tool_stalls": stalls,
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
        budget = state.get("tool_budget", 0)
        if has_calls and (budget is None or budget > 0):
            return "executor"
        # Security audit FINALIZATION: a turn that did audit work but ended
        # without submitting its findings gets exactly one more step to do so
        # (see SecurityTurn.checkpoint_due). Every other turn ends as before.
        if tools_ctx.security is not None and tools_ctx.security.checkpoint_due():
            return "security_checkpoint"
        # NEVER-EMPTY FLOOR: tool work happened, yet the turn is about to end with
        # no answer for the user — typically the tools failed and the model gave
        # up, leaving nothing or only narration. One more step, tools unbound, to
        # answer from what exists. Not after an unanswerable tool call (a history
        # with a dangling call is a provider 400), and never twice.
        if (
            tools_ctx.answer_floor
            and not tools_ctx.answer_floor_used
            and tools_ctx.security is None
            and tools_ctx.step_counter > 0
            and not has_calls
            and not _turn_has_answer(state["messages"], tools_ctx.writer)
        ):
            return "answer_nudge"
        return END

    async def answer_nudge(state: ChatState) -> dict:
        tools_ctx.answer_floor_used = True
        log.info(
            "agent.answer_floor",
            extra={"run_id": tools_ctx.run_id, "steps": tools_ctx.step_counter},
        )
        # Budget 0: the model node binds NO tools, so this step can only write.
        return {
            "messages": [HumanMessage(content=ANSWER_FLOOR_PROMPT)],
            "tool_budget": 0,
            "tool_stalls": 0,
        }

    async def security_checkpoint(state: ChatState) -> dict:
        from app.secaudit.report import CHECKPOINT_PROMPT

        tools_ctx.security.checkpoint_used = True
        log.info("secaudit.checkpoint", extra={"run_id": tools_ctx.run_id})
        # One step of budget: enough to call security_report, after which the
        # model answers in text with no tools (the loop cannot resume).
        return {
            "messages": [HumanMessage(content=CHECKPOINT_PROMPT)],
            "tool_budget": 1,
            "tool_stalls": 0,
        }

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
    builder.add_node("security_checkpoint", security_checkpoint)
    builder.add_node("answer_nudge", answer_nudge)
    builder.add_edge("security_checkpoint", "model")
    builder.add_edge("answer_nudge", "model")
    builder.add_edge(START, "prepare")
    builder.add_edge("prepare", "model")
    builder.add_conditional_edges(
        "model",
        route_after_model,
        {
            "executor": "executor",
            "security_checkpoint": "security_checkpoint",
            "answer_nudge": "answer_nudge",
            END: END,
        },
    )
    builder.add_conditional_edges(
        "executor", route_after_executor, {"model": "model", END: END}
    )
    return builder.compile(checkpointer=None)

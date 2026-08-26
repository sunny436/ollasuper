"""Drives one generation: graph -> writer -> Convex."""

from __future__ import annotations

import asyncio
import json
import time
from contextlib import aclosing
from dataclasses import replace

import httpx
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from sqlalchemy.ext.asyncio import AsyncEngine

from app.agent.budget import (
    ContextBudget,
    content_tokens,
    fit_messages,
    spec_tokens,
    tokens,
)
from app.agent.context import (
    build_system_prompt,
    to_lc_messages,
    trim,
)
from app.agent.executor import (
    MemoryContext,
    RagContext,
    ToolExecContext,
    build_tool_specs,
    execute_tool_calls,
)
from app.agent.graph import build_graph
from app.agent.knowledge import KNOWLEDGE_TOOL_NAME, KNOWLEDGE_TOOL_SPEC
from app.agent.llm import build_llm
from app.agent.memory import (
    FORGET_TOOL_NAME,
    FORGET_TOOL_SPEC,
    MEMORY_SEARCH_TOOL_NAME,
    MEMORY_SEARCH_TOOL_SPEC,
    REMEMBER_TOOL_NAME,
    REMEMBER_TOOL_SPEC,
)
from app.agent.orchestration_tools import FIND_CAPABILITIES_TOOL_SPEC
from app.agent.policy import READ_SCOPE, WRITE_SCOPE
from app.clients.attachments import AttachmentError, build_user_content
from app.clients.convex import ConvexClient, ConvexUnavailable
from app.clients.ollagraph import OllagraphAdapter
from app.config import Settings
from app.ingest.retrieve import render_rag_block, retrieve_context
from app.logging import bind_log_context, get_logger
from app.models.chat import GenerateRequest
from app.models.execution import hash_args
from app.models.tools import SideEffect, ToolFilters
from app.orchestrator.capabilities import CapabilityResolver
from app.runtime.writer import DeltaWriter
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector

log = get_logger(__name__)

# Error codes the UI can branch on. Raw exception text is never surfaced.
ERR_PROVIDER = "provider_error"
ERR_TIMEOUT = "provider_timeout"
ERR_ATTACHMENT = "attachment_failed"
ERR_INGRESS = "ingress_unavailable"
ERR_INTERNAL = "internal"
ERR_DEADLINE = "deadline_exceeded"  # Phase 7: total execution deadline hit


async def _background_heartbeat(
    writer: DeltaWriter,
    interval_ms: int,
    deadline_mono: float,
    main_task: asyncio.Task,
    deadline_flag: dict,
) -> None:
    """Phase 7: node-independent liveness beat + hard total-deadline guard.

    The inline heartbeat only fires on model chunks, so a slow first token or a
    long tool call would otherwise trip the 90s Convex reaper on a LIVE worker
    (→ spurious resume/double-run). This keeps heartbeatAt fresh regardless of
    token flow. It also enforces the total-execution deadline even for a turn
    that produces no tokens (a hang the inline check can't see): on deadline it
    marks the flag and cancels the main task, which the CancelledError handler
    converts to a clean TIMED_OUT. Cancelled in finally."""
    try:
        while True:
            await asyncio.sleep(max(0.01, interval_ms / 1000))
            if time.monotonic() > deadline_mono:
                deadline_flag["hit"] = True
                main_task.cancel()
                return
            await writer.heartbeat()
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 — a heartbeat failure must never break the turn
        return


async def run_generation(
    req: GenerateRequest,
    settings: Settings,
    convex: ConvexClient,
    engine: AsyncEngine | None = None,
    *,
    tool_registry: ToolRegistry | None = None,
    tool_selector: ToolSelector | None = None,
    ollagraph_http: httpx.AsyncClient | None = None,
) -> None:
    """Run one turn to completion.

    The finalize lives in `finally:` under asyncio.shield so it fires on
    success, on exception, AND on CancelledError — the shield is what stops the
    cancellation that triggered the unwind from also killing the write that
    records it.
    """
    # Bind the run/user ids to this task's logging context so every log line in the
    # generation — including the thin per-tool ones emitted deep in the executor /
    # adapter, which don't hold these ids — is attributable to its run without
    # timestamp-guessing. Task-isolated (see app/logging.bind_log_context).
    bind_log_context(req.streamId, req.userId)
    writer = DeltaWriter(convex, req.streamId, settings)
    status = "error"
    usage: dict | None = None
    finish_reason: str | None = None
    error: dict | None = None
    started = time.monotonic()
    hb_task: asyncio.Task | None = None
    deadline_flag = {"hit": False}

    try:
        # --- assemble ------------------------------------------------------
        history = list(req.history)
        latest = history.pop() if history and history[-1].role == "user" else None
        if latest is None:
            raise ValueError("no user message to respond to")

        # Phase 6: the central per-turn window accounting. Every component below
        # is measured against this so the assembled input never exceeds the model's
        # REAL window (req.contextWindow from Convex).
        cb = ContextBudget(
            model=req.model,
            context_window=req.contextWindow,
            max_output=settings.ai_max_output_tokens,
            safety_factor=settings.ai_token_safety_factor,
            base_history_budget=settings.ai_context_budget_tokens,
        )
        # Bound the newest turn's message text to a WINDOW-AWARE cap: the flat
        # ai_max_turn_chars on a large window, but shrunk on a small one so the
        # latest turn cannot alone overrun the window. trim() below bounds only
        # `prior`, so the latest turn must be capped here.
        latest_char_cap = min(settings.ai_max_turn_chars, cb.latest_char_budget())
        if len(latest.content) > latest_char_cap:
            # HEAD+TAIL, not head-only: the user's actual ask is often a short
            # instruction/question placed AFTER a large pasted document — head-only
            # truncation silently dropped it and the model answered the wrong thing
            # (QA-6). Keep the leading content AND the trailing turn, and make the
            # cut VISIBLE so neither the model nor the user is misled into thinking
            # the whole message was seen.
            marker = "\n\n[… middle of this message truncated to fit the limit …]\n\n"
            keep = max(0, latest_char_cap - len(marker))
            head = (keep * 3) // 4
            tail = keep - head
            latest = latest.model_copy(
                update={
                    "content": (
                        latest.content[:head] + marker + latest.content[-tail:]
                        if tail
                        else latest.content[:latest_char_cap]
                    )
                }
            )

        # Phase 5: when the RAG tool is enabled AND the user has files, the AGENT
        # decides whether to retrieve (via the `search_knowledge` tool below), so
        # the always-on pre-run is skipped entirely. Off by default → this stays
        # False and the pre-run path runs byte-identically.
        rag_as_tool = (
            settings.ai_agent_rag_tool_enabled
            and engine is not None
            and req.ragFileCount > 0
        )
        # Phase 6: bind the memory tools when enabled globally AND for this user.
        # `remember` is bound whenever memory is on (to create the first memory);
        # `search_memory` only when the user actually has memories to recall.
        memory_as_tool = settings.ai_agent_memory_tool_enabled and req.memoryEnabled

        # Account-knowledge retrieval, launched concurrently so its embedding +
        # DB round-trip mostly hides behind the attachment work below. Gated by
        # ragFileCount (computed in Convex) so users with no files pay nothing.
        rag_task = None
        if engine is not None and req.ragFileCount > 0 and not rag_as_tool:
            rag_task = asyncio.create_task(
                retrieve_context(
                    settings, engine, user_id=req.userId, query=latest.content
                )
            )

        try:
            content, n_images = await build_user_content(
                latest,
                convex,
                settings,
                model=req.model,
                stream_id=req.streamId,
                # Phase 6: window-aware — on a small window the shared document
                # budget shrinks so the whole latest turn fits (48k on a large one).
                doc_budget=min(
                    settings.ai_max_turn_chars,
                    max(0, latest_char_cap - len(latest.content)),
                ),
            )
        except AttachmentError as e:
            error = {"code": ERR_ATTACHMENT, "message": str(e), "retryable": False}
            raise

        # Bounded wait; RAG must never delay or break chat. On timeout/any error
        # we proceed with no retrieved context.
        rag_text, rag_tokens = "", 0
        if rag_task is not None:
            try:
                chunks = await asyncio.wait_for(
                    rag_task, settings.ai_rag_deadline_ms / 1000
                )
                rag_text, rag_tokens = render_rag_block(chunks, settings)
                # Observability: the ONLY signal that retrieval fired and what it
                # found. No chunk content is logged (safe for journalctl); this is
                # how "why didn't it remember my file" becomes diagnosable and how
                # ai_rag_min_similarity gets tuned from real distances.
                if chunks:
                    dists = [
                        c["distance"] for c in chunks if c.get("distance") is not None
                    ]
                    log.info(
                        "rag_used",
                        extra={
                            "stream_id": req.streamId,
                            "n_chunks": len(chunks),
                            "min_distance": round(min(dists), 4) if dists else None,
                        },
                    )
                else:
                    log.info("rag_empty", extra={"stream_id": req.streamId})
            except Exception:  # noqa: BLE001 - retrieval is non-critical
                log.warning("rag_skipped", extra={"stream": req.streamId})

        # Phase 6: the history trim MOVED below (after the system prompt + tool
        # schemas + latest turn are assembled and measured), so it can be sized
        # against the TRUE remaining window. `rag_tokens` no longer displaces
        # history via a hack — the RAG block is part of the system prompt and is
        # counted directly in `system_tokens`.
        _ = rag_tokens  # (kept for the observability log above)

        # The agentic capability orientation is included whenever the model will
        # actually have a capability this turn (web tools, RAG tool, or memory
        # tools) — so it can autonomously choose the right source and the user
        # never has to say "search the web" / "use my PDF".
        agentic = settings.agent_enabled or rag_as_tool or memory_as_tool
        system = build_system_prompt(
            custom=req.systemPrompt,
            about=req.customInstructionsAbout,
            style=req.customInstructionsStyle,
            summary=req.summary,
            summary_through_seq=req.summaryThroughSeq,
            rag=rag_text,
            agentic=agentic,
        )

        # User chat -> Ollima (title-gen + OCR keep build_llm's OpenRouter default).
        llm = build_llm(
            settings,
            model=req.model,
            context_window=req.contextWindow,
            base_url=settings.ollima_base_url,
            api_key=settings.ollima_api_key,
        )
        # A DEDICATED non-streaming client for tool-bound calls. Ollima streams
        # tool-call deltas in a shape langchain-openai's accumulator rejects
        # ("Tool call index out of bounds"), so the model node must NOT stream
        # when tools are bound. A `streaming=False` client returns the tool call
        # as one complete message; `llm` above keeps streaming for the final
        # answer. Built lazily below only if tools are actually bound.
        llm_for_tools = build_llm(
            settings,
            model=req.model,
            context_window=req.contextWindow,
            streaming=False,
            base_url=settings.ollima_base_url,
            api_key=settings.ollima_api_key,
        )

        # --- agent tools (Phase 4 web tools + Phase 5 knowledge tool) ------
        # Two INDEPENDENT tool sources feed one bind_tools: Ollagraph web tools
        # (agent_enabled) and the RAG `search_knowledge` tool (rag_as_tool).
        # Either alone builds the agent graph. Degrades safely: a web-spec
        # problem never drops the knowledge tool (knowledge-only retry-bind), and
        # a total failure falls back to the plain graph — chat never breaks.
        specs: list[dict] = []
        name_to_id: dict[str, str] = {}
        adapter = None
        rag_ctx = None
        mem_ctx = None
        # Phase 5: the per-turn authorization scope — the shared READ_SCOPE/
        # WRITE_SCOPE permission template stamped with the AUTHORITATIVE caller
        # identity from the authenticated request (never the model). Single source
        # for the selection permission prefilter (F) AND the execution scope /
        # outbound tenant headers (B).
        agent_scope = replace(
            WRITE_SCOPE if settings.ai_agent_side_effect_enabled else READ_SCOPE,
            user_id=req.userId,
            workspace_id=req.workspaceId,
            tenant_id=req.workspaceId,
        )
        web_active = (
            settings.agent_enabled
            and tool_registry is not None
            and tool_selector is not None
            and ollagraph_http is not None
            and tool_registry.count > 0
        )
        if web_active:
            try:
                # Read-only tools only, unless side-effect tools are enabled — in
                # which case scrape/analyze tools are surfaced too and gated by
                # the approval round-trip (never auto-run). HIGH_IMPACT is always
                # above the ceiling and never surfaced.
                se_ceiling = (
                    SideEffect.EXTERNAL_SIDE_EFFECT
                    if settings.ai_agent_side_effect_enabled
                    else SideEffect.READ_ONLY
                )
                _filters = ToolFilters(
                    max_side_effect=se_ceiling,
                    # Phase 5 (F): don't even rank a tool the caller can't run.
                    granted_permissions=agent_scope.granted_permissions,
                )
                candidates = tool_selector.select(
                    latest.content,
                    top_k=settings.ai_agent_discovery_top_k,
                    filters=_filters,
                    min_score=settings.tool_discovery_min_score,
                ).candidates
                # F2: ALWAYS seed the universal core capabilities (e.g. web search)
                # regardless of whether the user's WORDING lexically matched — the
                # fix for "what is the current price of X" surfacing no web tool
                # (n_scored=0) so the user had to say "search on web". Each canonical
                # intent's top hit is unioned in (deduped), under the SAME
                # scope/side-effect filters, then re-sorted by score so a real match
                # still wins and the seed survives the schema-budget trim below.
                _seen_ids = {c.tool.tool_id for c in candidates}
                for _q in settings.ai_agent_core_capability_queries:
                    _hit = tool_selector.select(
                        _q, top_k=1, filters=_filters,
                        min_score=settings.tool_discovery_min_score,
                    ).candidates
                    if _hit and _hit[0].tool.tool_id not in _seen_ids:
                        candidates.append(_hit[0])
                        _seen_ids.add(_hit[0].tool.tool_id)
                candidates.sort(key=lambda c: -c.score)
                if candidates:
                    _reserved = {
                        KNOWLEDGE_TOOL_NAME,
                        MEMORY_SEARCH_TOOL_NAME,
                        REMEMBER_TOOL_NAME,
                        FORGET_TOOL_NAME,
                    }
                    web_specs, name_to_id = build_tool_specs(
                        candidates, tool_registry, reserved=_reserved
                    )
                    # Phase 6 (B2): bound the bound-schema TOKEN cost. Candidates
                    # are score-sorted, so drop the lowest-ranked until the specs
                    # fit the schema budget — a few verbose nested schemas can't
                    # blow the window, and this is the seam that keeps a 40-50-skill
                    # future from loading every schema. (Schemas are also counted
                    # in fixed_tokens by B1; this caps them at the source.)
                    _schema_budget = cb.input_ceiling // 4
                    while (
                        len(candidates) > 1
                        and spec_tokens(web_specs) > _schema_budget
                    ):
                        candidates = candidates[:-1]
                        web_specs, name_to_id = build_tool_specs(
                            candidates, tool_registry, reserved=_reserved
                        )
                    specs += web_specs
                    adapter = OllagraphAdapter(settings, ollagraph_http)
            except Exception:  # noqa: BLE001 — web tools are optional
                log.warning(
                    "agent_web_tools_disabled", extra={"stream_id": req.streamId}
                )
                specs, name_to_id, adapter = [], {}, None
        if rag_as_tool:
            specs.append(KNOWLEDGE_TOOL_SPEC)
            rag_ctx = RagContext(
                engine=engine, user_id=req.userId, settings=settings
            )
        if memory_as_tool:
            specs.append(REMEMBER_TOOL_SPEC)
            if req.memories:  # only bind recall/forget when there is something there
                specs.append(MEMORY_SEARCH_TOOL_SPEC)
                specs.append(FORGET_TOOL_SPEC)
            mem_ctx = MemoryContext(memories=req.memories, settings=settings)

        # The reserved (non-Ollagraph) specs, used to keep RAG/memory alive if a
        # bad web spec breaks the combined bind.
        reserved_specs: list[dict] = []
        if rag_as_tool:
            reserved_specs.append(KNOWLEDGE_TOOL_SPEC)
        if memory_as_tool:
            reserved_specs.append(REMEMBER_TOOL_SPEC)
            if req.memories:
                reserved_specs.append(MEMORY_SEARCH_TOOL_SPEC)
                reserved_specs.append(FORGET_TOOL_SPEC)

        llm_tools = None
        tools_ctx = None
        if specs:
            try:
                llm_tools = llm_for_tools.bind_tools(specs)
            except Exception:  # noqa: BLE001 — a bad web spec must not kill RAG/memory
                log.warning(
                    "agent_tools_bind_failed", extra={"stream_id": req.streamId}
                )
                llm_tools = None
                if reserved_specs:
                    try:
                        llm_tools = llm_for_tools.bind_tools(reserved_specs)
                        name_to_id, adapter = {}, None
                    except Exception:  # noqa: BLE001
                        llm_tools = None
            if llm_tools is not None:
                tools_ctx = ToolExecContext(
                    registry=tool_registry,
                    adapter=adapter,
                    writer=writer,
                    # Phase 5: the per-turn scope carries the authoritative caller
                    # identity (built above), feeding check_tool_policy + the
                    # outbound Ollagraph tenant/user headers. Never the model.
                    scope=agent_scope,
                    name_to_tool_id=name_to_id,
                    result_max_chars=settings.ai_agent_tool_result_max_chars,
                    default_timeout_s=settings.ollagraph_default_tool_timeout_s,
                    tool_max_retries=settings.ai_agent_tool_max_retries,
                    tool_retry_base_s=settings.ai_agent_tool_retry_base_s,
                    max_tool_calls_per_step=settings.ai_agent_max_tool_calls_per_step,
                    max_concurrent_tools=settings.ai_agent_max_concurrent_tools,
                    rag=rag_ctx,
                    memory=mem_ctx,
                    approvals={
                        a.approvalId: {"decision": a.decision, "token": a.token}
                        for a in req.approvals
                    },
                    force_approval_ids=settings.ai_agent_approval_test_tool_ids,
                    approval_ttl_ms=int(settings.ai_agent_approval_ttl_s * 1000),
                    # Phase 1: durable execution identity. run_id = streamId;
                    # run_attempt = the resume attempt so a resumed run's step ids
                    # don't collide with the original attempt's.
                    run_id=req.streamId,
                    run_attempt=req.attempt,
                    # Phase 2: at-most-once policy for ambiguous side-effect outcomes.
                    retry_ambiguous_side_effects=(
                        settings.ai_agent_retry_ambiguous_side_effects
                    ),
                )
                # Phase 12b (Stage 1): attach DYNAMIC CAPABILITY DISCOVERY to the
                # live agent path. The model gains `find_capabilities` to reach ANY
                # registered tool (no Top-K reachability ceiling); matches are
                # dynamically loaded by the Phase-10 executor/graph (which update
                # BOTH the allowlist + bound specs, authorization still enforced per
                # call). `rebind` targets the NON-streaming `llm_for_tools`, so the
                # final answer still streams via `llm`. OFF by default → skipped, and
                # the runner is byte-identical (top-K stays the initial inline set).
                if (
                    settings.ai_orchestrated_runtime_enabled
                    and tool_registry is not None
                    and tool_selector is not None
                ):
                    specs.append(FIND_CAPABILITIES_TOOL_SPEC)
                    tools_ctx.capabilities = CapabilityResolver(
                        tool_registry, tool_selector
                    )
                    tools_ctx.rebind = llm_for_tools.bind_tools
                    tools_ctx.pending_capabilities = []

        # Phase 6 (B1): measure the FIXED costs (system prompt + bound tool schemas
        # + latest turn) now that all are assembled, and trim PRIOR history against
        # the TRUE remaining window — replacing the old flat-4k system reservation.
        system_tokens = tokens(system)
        schema_tokens = spec_tokens(specs)
        latest_tokens = content_tokens(content)
        prior = trim(
            to_lc_messages(history),
            model=req.model,
            n_images=n_images,
            max_output=settings.ai_max_output_tokens,
            base_budget=settings.ai_context_budget_tokens,
            safety_factor=settings.ai_token_safety_factor,
            context_window=req.contextWindow,
            fixed_tokens=system_tokens + schema_tokens + latest_tokens,
        )
        fit_budget = cb.message_fit_budget(
            system_tokens=system_tokens, schema_tokens=schema_tokens
        )

        graph = build_graph(llm, llm_tools=llm_tools, tools_ctx=tools_ctx)

        # Phase 7 resume: rebuild the already-completed tool steps from the durable
        # event log (Convex pushed them in `completedTools`) so side-effecting
        # tools are NOT re-executed, seed the step budget with the completed count
        # (durable — a crash can't reset it), re-seed the idempotency guard, and
        # continue the typed-event seq space so resumed events don't collide.
        messages: list = [*prior, HumanMessage(content=content)]
        completed_steps = 0
        # Reconstruct completed tool steps on ANY resume — a crash-resume
        # (attempt > 0) OR an approval-resume (attempt stays 0 but pre-approval
        # tools ran). Gated on completedTools, NOT attempt, and mirrored in
        # Convex dispatchPayload, so an approved tool's turn rebuilds correctly.
        if req.completedTools:
            for i, ct in enumerate(req.completedTools):
                cid = f"resume_{i}"
                messages.append(
                    AIMessage(
                        content="",
                        tool_calls=[{"name": ct.toolId, "args": ct.args, "id": cid}],
                    )
                )
                messages.append(
                    ToolMessage(content=ct.resultContent, tool_call_id=cid)
                )
                if tools_ctx is not None:
                    tools_ctx.seen_calls[ct.toolId] = json.dumps(
                        ct.args, sort_keys=True, default=str
                    )
                    tools_ctx.seen_call_set.add(f"{ct.toolId}:{hash_args(ct.args)}")
            completed_steps = len(req.completedTools)
        # Phase 2: side-effecting tools ATTEMPTED with an UNKNOWN outcome (crash /
        # INDETERMINATE). Inject an "outcome unknown; not retried" observation and
        # seed BOTH dedup guards so a re-emit is DEDUPED and never re-executed — the
        # seed is load-bearing: dedup precedes the approval gate, so it also stops an
        # approved tool's token from re-authorizing the same call on resume.
        if req.attemptedTools:
            for j, at in enumerate(req.attemptedTools):
                cid = f"resume_attempt_{j}"
                messages.append(
                    AIMessage(
                        content="",
                        tool_calls=[{"name": at.toolId, "args": at.args, "id": cid}],
                    )
                )
                messages.append(
                    ToolMessage(
                        content=json.dumps(
                            {
                                "status": "indeterminate",
                                "message": "Outcome unknown; not retried.",
                            }
                        ),
                        tool_call_id=cid,
                    )
                )
                if tools_ctx is not None:
                    tools_ctx.seen_calls[at.toolId] = json.dumps(
                        at.args, sort_keys=True, default=str
                    )
                    tools_ctx.seen_call_set.add(f"{at.toolId}:{hash_args(at.args)}")
            completed_steps += len(req.attemptedTools)
        # Continue the typed-event seq space whenever events survived (a parked
        # approval with no prior tool still has a surviving APPROVAL_REQUEST), so
        # resumed events don't collide on the (messageId, seq) probe. Independent
        # of completedTools for exactly that case.
        if req.eventSeqBaseline:
            writer.set_event_seq(req.eventSeqBaseline)
        # Phase 3: DIRECTLY execute approved-but-not-yet-run parked tools from their
        # DURABLE args — deterministic continuation, no model re-emission. Reuses the
        # full _run_one (write-ahead, terminal record, dedup seed), so the token is
        # single-use by the state machine and a later model re-emit of the same call
        # is DEDUPED (no double-fire). Needs tools_ctx (adapter + full registry); if
        # it could not be rebuilt (rare discovery failure), the tool cannot run here
        # and the turn continues in text (degraded but safe).
        if req.approvedPending and tools_ctx is not None:
            for j, ap in enumerate(req.approvedPending):
                tools_ctx.approvals[ap.approvalId] = {
                    "decision": "approved",
                    "token": ap.token,
                }
                cid = f"approved_{j}"
                out = await execute_tool_calls(
                    [{"name": ap.toolId, "args": ap.args, "id": cid}], tools_ctx
                )
                messages.append(
                    AIMessage(
                        content="",
                        tool_calls=[{"name": ap.toolId, "args": ap.args, "id": cid}],
                    )
                )
                messages.extend(out)
            completed_steps += len(req.approvedPending)
        elif req.approvedPending:
            log.warning(
                "approved_pending_unrunnable",
                extra={"stream_id": req.streamId, "n": len(req.approvedPending)},
            )
        if (
            req.completedTools
            or req.attemptedTools
            or req.approvedPending
            or req.eventSeqBaseline
        ):
            log.info(
                "generation_resumed",
                extra={
                    "stream_id": req.streamId,
                    "attempt": req.attempt,
                    "completed_steps": completed_steps,
                },
            )

        # Phase 6 (B4): re-fit the assembled list (latest + prior + resumed
        # completed/attempted/approved tool messages) so a resume with many large
        # results cannot overrun the window — the oldest raw results compact to
        # references (the durable checkpoint is untouched, only the in-context copy).
        messages = fit_messages(messages, fit_budget)

        state = {"messages": messages, "system_prompt": system}
        if tools_ctx is not None:
            state["tool_budget"] = max(
                0, settings.ai_agent_max_steps - completed_steps
            )
            # Phase 6 (B3): the per-step re-fit budget for the in-graph model node.
            state["fit_budget"] = fit_budget
            # Phase 12b (Stage 1): seed the dynamic working set so the model node
            # re-binds (from bound_specs) + the executor node drains discoveries into
            # it. Only when dynamic discovery is attached (flag on); else untouched.
            if tools_ctx.capabilities is not None:
                state["bound_specs"] = specs

        # Phase 7: the total-execution deadline (durable across resume). Convex's
        # `deadlineAt` (epoch ms) is authoritative when present so a crash-loop
        # can't extend it; else fall back to now + the configured budget.
        if req.deadlineAt > 0:
            deadline_mono = time.monotonic() + max(
                0.0, req.deadlineAt / 1000 - time.time()
            )
        else:
            deadline_mono = started + settings.ai_agent_total_deadline_s

        # --- stream --------------------------------------------------------
        #
        # aclosing() is load-bearing, not decoration. Breaking out of (or being
        # cancelled inside) `async for` leaves the underlying httpx SSE
        # generator suspended; without an explicit aclose it is finalised by the
        # GC on an arbitrary loop and raises
        # "RuntimeError: generator didn't stop after athrow()".
        # Observed against the real OpenRouter endpoint. Every early exit below
        # is exactly that case, so this wraps the whole iteration.
        last_beat = time.monotonic()
        hb_task = asyncio.create_task(
            _background_heartbeat(
                writer,
                settings.ai_heartbeat_ms,
                deadline_mono,
                asyncio.current_task(),
                deadline_flag,
            )
        )
        async with aclosing(graph.astream(state, stream_mode="messages")) as stream:
            async for chunk, metadata in stream:
                # Only the model node's output is user-visible. Tool nodes added
                # later stream through here too and must not reach the transcript.
                if metadata.get("langgraph_node") != "model":
                    continue

                text = _chunk_text(chunk)
                if text:
                    await writer.push(text)

                # Sum token usage ACROSS the multi-step loop (each model call
                # reports its own usage on its final chunk) — the old code kept
                # only the last call's, understating a multi-tool turn.
                meta_usage = getattr(chunk, "usage_metadata", None)
                if meta_usage:
                    usage = usage or {"promptTokens": 0, "completionTokens": 0}
                    usage["promptTokens"] += meta_usage.get("input_tokens") or 0
                    usage["completionTokens"] += meta_usage.get("output_tokens") or 0
                resp_meta = getattr(chunk, "response_metadata", None) or {}
                if resp_meta.get("finish_reason"):
                    finish_reason = resp_meta["finish_reason"]

                # Cancellation arrives on the ingress response, so it is picked
                # up within one flush (<=700ms) without polling anything.
                if writer.cancel_requested:
                    status = "cancelled"
                    return

                now = time.monotonic()
                if (now - last_beat) * 1000 >= settings.ai_heartbeat_ms:
                    await writer.heartbeat()
                    last_beat = now
                    if writer.cancel_requested:
                        status = "cancelled"
                        return

        await writer.flush(force=True)
        # Phase 8: a tool parked awaiting approval routed the graph to END. The
        # durable approval + suspend is already recorded in Convex; do NOT
        # finalize (that would drive waiting_approval -> done and destroy the
        # parked approval). The turn resumes when the user resolves it.
        if writer.suspended:
            status = "suspended"
            return
        status = "done"

    except asyncio.CancelledError:
        if deadline_flag["hit"]:
            # OUR OWN cancel: the total-execution deadline fired. Convert to a
            # clean TIMED_OUT and let the shielded finalize record it (do NOT
            # re-raise — this is not a user stop).
            status = "error"
            error = {
                "code": ERR_DEADLINE,
                "message": "The response exceeded the time limit",
                "retryable": False,
            }
        else:
            # The fast cancel path: registry.cancel() -> task.cancel().
            status = "cancelled"
            raise
    except ConvexUnavailable:
        status = "error"
        error = error or {
            "code": ERR_INGRESS,
            "message": "Could not reach the conversation store",
            "retryable": True,
        }
    except TimeoutError:
        status = "error"
        error = {
            "code": ERR_TIMEOUT,
            "message": "The model took too long to respond",
            "retryable": True,
        }
    except Exception as e:  # noqa: BLE001
        status = "error"
        # Never surface raw exception text: it can carry prompt fragments,
        # provider internals, or a key in a URL.
        log.exception("generation_failed", extra={"stream_id": req.streamId})
        error = error or {
            "code": ERR_PROVIDER if _is_provider_error(e) else ERR_INTERNAL,
            "message": "The model could not complete this response",
            "retryable": True,
        }
    finally:
        if hb_task is not None:
            hb_task.cancel()
        log.info(
            "generation_finished",
            extra={
                "stream_id": req.streamId,
                "thread_id": req.threadId,
                "user_id": req.userId,
                "model": req.model,
                "status": status,
                "attempt": req.attempt,
                "chars_out": writer.stats.chars,
                "flushes": writer.stats.flushes,
                "dropped": writer.stats.dropped,
                "ttft_ms": writer.stats.first_flush_ms,
                "total_ms": round((time.monotonic() - started) * 1000),
            },
        )
        # Phase 8: a suspended turn's durable park is already recorded; a
        # finalize here would drive waiting_approval -> done and destroy it. Skip
        # the terminal write. (Guarded, not `return`-in-finally, which would
        # silence an in-flight exception.)
        if status != "suspended":
            # shield: the CancelledError that got us here must not also cancel the
            # write that records the cancellation.
            await asyncio.shield(
                writer.finalize(
                    "error" if status == "error" else status,
                    usage=usage,
                    finish_reason=finish_reason,
                    error=error,
                )
            )


def _chunk_text(chunk: object) -> str:
    """Extract text from an AIMessageChunk.

    `.text` is a property in langchain-core 1.x (calling it as a method is
    deprecated), but stay tolerant of both so a minor bump cannot silently
    produce empty replies.
    """
    text = getattr(chunk, "text", None)
    # isinstance BEFORE callable: in langchain-core 1.5 `.text` is a str-like
    # shim that is also callable, and invoking it emits a DeprecationWarning
    # per chunk — thousands of lines of log noise per conversation.
    if isinstance(text, str):
        return text
    if callable(text):
        result = text()
        if isinstance(result, str):
            return result
    content = getattr(chunk, "content", "")
    return content if isinstance(content, str) else ""


def _is_provider_error(e: Exception) -> bool:
    name = type(e).__name__.lower()
    return any(k in name for k in ("api", "openai", "http", "rate", "connection"))

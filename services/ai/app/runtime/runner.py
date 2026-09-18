"""Drives one generation: graph -> writer -> Convex."""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from contextlib import AsyncExitStack, aclosing
from dataclasses import replace
from typing import Any

import httpx
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from sqlalchemy.ext.asyncio import AsyncEngine

from app.agent import health as model_health
from app.agent.base import AgentEnv
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
    bound_name_for_tool_id,
    build_tool_specs,
    execute_tool_calls,
)
from app.agent.filegen_tool import GENERATE_FILE_TOOL_SPEC
from app.agent.graph import build_graph
from app.agent.harmony import HarmonyStreamFilter
from app.agent.knowledge import KNOWLEDGE_TOOL_NAME, KNOWLEDGE_TOOL_SPEC
from app.agent.llm import build_llm, is_quota_error
from app.agent.memory import (
    FORGET_TOOL_NAME,
    FORGET_TOOL_SPEC,
    MEMORY_SEARCH_TOOL_NAME,
    MEMORY_SEARCH_TOOL_SPEC,
    REMEMBER_TOOL_NAME,
    REMEMBER_TOOL_SPEC,
)
from app.agent.orchestration_tools import (
    DELEGATE_TOOL_NAME,
    FIND_CAPABILITIES_TOOL_SPEC,
)
from app.agent.personalization import compile_personalization
from app.agent.policy import READ_SCOPE, WRITE_SCOPE
from app.agent.taint import REJECTED_EARLIER, source_of_id
from app.clients.attachments import AttachmentError, build_user_content
from app.clients.convex import ConvexClient, ConvexUnavailable
from app.clients.ollagraph import OllagraphAdapter
from app.config import Settings
from app.data.loader import DatasetRef, sanitize_table_name
from app.data.tool import DATA_TOOL_NAMES, DATA_TOOL_SPECS, DataContext
from app.documents.context import DocumentRef, DocumentsContext, document_kind
from app.documents.tool import DOCUMENT_OPS_TOOL_SPEC
from app.finance.tool import (
    FINANCE_CALC_TOOL_SPEC,
    FINANCE_REFERENCE_TOOL_SPEC,
)
from app.humanizer import stage as humanize_stage
from app.ingest.retrieve import render_rag_block, retrieve_context
from app.logging import bind_log_context, get_logger
from app.marketing.tool import (
    MARKETING_CALC_TOOL_SPEC,
    MARKETING_REFERENCE_TOOL_SPEC,
)
from app.mcp.resource_tool import MCP_READ_RESOURCE_TOOL_SPEC
from app.mcp.turn import TurnCapabilities, mcp_for_turn
from app.models.chat import GenerateRequest
from app.models.execution import hash_args
from app.models.tools import SideEffect, ToolCandidate, ToolFilters
from app.orchestrator.capabilities import CapabilityResolver
from app.orchestrator.prepare import ProviderReadiness
from app.research.run_state import build_research_context, render_research_seed
from app.research.tool import RECORD_RESEARCH_TOOL_NAME, RECORD_RESEARCH_TOOL_SPEC
from app.routing import Candidate as RouteCandidate
from app.routing import Decision, RouterConfig, select_failover
from app.routing import Signals as RouteSignals
from app.routing import select as route_select
from app.runtime import compaction, suggestions
from app.runtime.capabilities import render_capability_overview
from app.runtime.claims import render_correction as render_claim_correction
from app.runtime.context_manager import (
    ANSWER,
    classify_operation,
    compile_context,
    derive_artifact,
)
from app.runtime.context_tool import (
    RECORD_CONTEXT_TOOL_SPEC,
    ContextToolState,
)
from app.runtime.env_factory import build_live_agent_env
from app.runtime.ledger import build_ledger, render_standalone_notices
from app.runtime.roster import (
    build_delegate_spec,
    build_live_runtime,
    effective_skills,
)
from app.runtime.writer import DeltaWriter
from app.sales.tool import SALES_FORECAST_TOOL_SPEC
from app.secaudit import intent as sec_intent
from app.secaudit.local import LocalAccess
from app.secaudit.report import GITHUB_PROVIDER, SecurityTurn
from app.secaudit.skill import SECURITY_SKILL
from app.secaudit.tool import (
    FIX_PROVIDER,
    FIX_TOOL_ID,
    SECURITY_TOOL_NAMES,
    SECURITY_TOOL_SPECS,
    SecurityFixAdapter,
    fix_tool_definition,
    layered_registry,
)
from app.seo.mutations import (
    SeoWriteAdapter,
    StubSeoWriteProvider,
    register_seo_mutation_provider,
)
from app.skills.capability_binding import EMPTY_CAPABILITIES, resolve_capabilities
from app.skills.registry import pack_skills, render_skills_block
from app.skills.user_skills import EMPTY_SELECTION, select_user_skills
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector, _passes

log = get_logger(__name__)

# Error codes the UI can branch on. Raw exception text is never surfaced.
ERR_PROVIDER = "provider_error"
ERR_TIMEOUT = "provider_timeout"
ERR_ATTACHMENT = "attachment_failed"
ERR_INGRESS = "ingress_unavailable"
ERR_INTERNAL = "internal"
ERR_DEADLINE = "deadline_exceeded"  # Phase 7: total execution deadline hit


def reserve_skill_tools(
    candidates: list[ToolCandidate],
    declared: set[str],
    registry: ToolRegistry,
    filters: ToolFilters,
) -> tuple[list[ToolCandidate], int]:
    """Guarantee an active skill's DECLARED tools survive discovery and trimming.

    The schema-budget trim keeps a score-ordered PREFIX, and lexical score is a
    poor proxy for "this methodology names this tool". Measured on the real blog
    thread: the blog skill declares 34 `blog.*` capabilities, discovery scored a
    single unrelated tool at 0.202, and the turn fell back to 12 generic web
    searches having bound none of them.

    So: add any declared tool discovery missed, then sort declared tools to the
    front — the trim cuts from the tail, so it can only ever reach undeclared
    ones. Returns (candidates, added).

    AUTHORIZATION IS UNCHANGED. Seeding runs through `_passes`, the selector's
    own predicate, so the side-effect ceiling and granted permissions apply
    exactly as they do to a discovered tool. A skill can widen what is RELEVANT;
    it can never widen what is ALLOWED.
    """
    have = {c.tool.tool_id for c in candidates}
    added = 0
    for tool_id in sorted(declared - have):
        tool = registry.get(tool_id)
        if tool is not None and _passes(tool, filters):
            candidates.append(
                ToolCandidate(
                    tool=tool, score=0.0, reason="declared by an active skill"
                )
            )
            added += 1
    candidates.sort(key=lambda c: (c.tool.tool_id not in declared, -c.score))
    return candidates, added


# The model PROVIDER refused for capacity/quota reasons, not because anything in
# this turn was wrong. Distinct from ERR_PROVIDER because the user's action is
# different and knowable: pick another model, or add capacity. Folding it into
# "The model could not complete this response" is what made a provider-side
# weekly-quota outage look like an application bug (measured 2026-09-03: 7 of 8
# catalogue models returning 429 "reached your weekly usage limit").
ERR_QUOTA = "provider_quota"


def _compute_deadline_mono(
    req: GenerateRequest, started: float, settings: Settings
) -> float:
    """The total-execution deadline as a monotonic timestamp. Convex `deadlineAt`
    (epoch ms) is authoritative when present so a crash-loop can't extend it; else
    fall back to `started + ai_agent_total_deadline_s`."""
    if req.deadlineAt > 0:
        return time.monotonic() + max(0.0, req.deadlineAt / 1000 - time.time())
    return started + settings.ai_agent_total_deadline_s


async def _background_heartbeat(
    writer: DeltaWriter,
    interval_ms: int,
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
    converts to a clean TIMED_OUT. Cancelled in finally.

    `deadline_flag["mono"]` is READ each tick (not captured once) so a turn that is
    actively running tools can roll it forward via `writer.on_tool_activity` — a
    deep audit is bounded by tool INACTIVITY, not a fixed wall-clock, while a plain
    no-tool turn keeps the original hard deadline."""
    try:
        while True:
            await asyncio.sleep(max(0.01, interval_ms / 1000))
            if time.monotonic() > deadline_flag["mono"]:
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
    mcp_pool: Any = None,
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
    # Context layer. Initialised HERE, before the try, because the post-finalize
    # persist runs in the finally and must not NameError on a turn that failed
    # before the compile.
    compiled = None
    turn_operation: str | None = None
    # Enrichment accumulator for record_context. Initialised before the try so
    # the post-finalize persist in the finally cannot NameError.
    conversation_state = ContextToolState()
    started = time.monotonic()
    # Splits ttft_ms into OUR time and THEIRS. Everything before the graph starts
    # — attachments, RAG, discovery, skills, memory, history assembly — was one
    # opaque block, so a 45s p90 time-to-first-token could not be attributed to
    # the app or to the provider, and every latency discussion was guesswork.
    prep_ms: float | None = None
    hb_task: asyncio.Task | None = None
    # `mono` is the LIVE total-execution deadline (monotonic seconds), read every
    # heartbeat tick. ANY forward progress rolls it forward (below) — a tool event
    # OR streamed text — so the turn is bounded by INACTIVITY rather than a fixed
    # wall-clock. A turn that produces neither for the full window is genuinely
    # stuck and is still cancelled.
    deadline_flag = {"hit": False, "mono": 0.0}

    def _extend_deadline() -> None:
        deadline_flag["mono"] = max(
            deadline_flag["mono"],
            time.monotonic() + settings.ai_agent_total_deadline_s,
        )

    # The shared writer is reused by every delegated sub-agent, so a sub-agent's
    # tool events roll the parent turn's deadline too (the deep-audit case).
    writer.on_tool_activity = _extend_deadline
    # Streamed TEXT is forward progress too. Tool events alone left the final
    # long-form answer — which emits no tool events, and runs precisely when the
    # step budget is spent so none is even possible — under a deadline frozen at
    # the last tool call. That is what killed long deliverables mid-generation.
    writer.on_progress = _extend_deadline
    tools_ctx: ToolExecContext | None = None  # defined pre-try for the finally
    # The capacity failover that ANSWERED, when one did — so the turn records the
    # brain that produced the answer, not the routed one that refused.
    failover: dict = {"model": None}
    # The humanize stage's verdict on what gets SAVED: the draft, when a
    # rewrite that already streamed failed verification. None = the text
    # the user watched stream is the text that is kept.
    humanized: dict = {"final_text": None}
    # Security audit: the turn's recorded state (None on every other turn).
    sec_state: SecurityTurn | None = None
    # Phase 5: MCP sessions live for the whole turn. Entered here and closed in
    # the `finally` below — the same task both ways, which is the anyio rule that
    # makes every pooled session an actor in `app/mcp/session.py`.
    mcp_stack = AsyncExitStack()
    await mcp_stack.__aenter__()

    try:
        # Phase 1 (v2): arm the total-execution deadline BEFORE preparation, so a
        # hang during attachment/RAG/discovery/skill prep is also cancelled (the
        # function-level try above already converts that CancelledError to
        # ERR_DEADLINE). v2-OFF leaves this None -> armed just before the stream
        # exactly as before (byte-identical).
        if settings.ai_runtime_v2_enabled:
            deadline_flag["mono"] = _compute_deadline_mono(req, started, settings)
            hb_task = asyncio.create_task(
                _background_heartbeat(
                    writer,
                    settings.ai_heartbeat_ms,
                    asyncio.current_task(),
                    deadline_flag,
                )
            )

        # --- assemble ------------------------------------------------------
        history = list(req.history)
        latest = history.pop() if history and history[-1].role == "user" else None
        if latest is None:
            raise ValueError("no user message to respond to")

        # MASTER MODEL ROUTER. Runs HERE — immediately after `latest`, before the
        # per-turn ContextBudget and before user content is built — because both
        # of those are MODEL-DEPENDENT: budgeting against req.contextWindow and
        # then routing to a different model would size the whole turn for a model
        # that never runs. This is the earliest point at which every input the
        # router needs exists, and the last at which its answer is still free.
        # A pure in-process function (app/routing.py) — no I/O, no lock, no model
        # call — so it adds no measurable pre-first-token latency.
        #
        # It runs BEFORE skill selection and tool binding, so it cannot know WHICH
        # tools will run — but it does not need to. It answers a different and
        # answerable question: does this turn need data it does not already hold?
        # That matters because time-to-first-token is paid once PER STEP
        # (measured on prod: 0 steps -> 1.6s, 5 steps -> 46.4s), so grounding is
        # a cost axis of its own, not a flavour of difficulty.
        #
        # Any failure returns req.model, so routing can change WHICH model
        # answers but can never stop one from answering.
        route = Decision(req.model, "disabled")
        router_cfg = RouterConfig(enabled=False)
        ctx_state = req.conversationContext
        # The health registry learns which models the router can choose, so the
        # background probe keeps exactly those fresh. Not the thread's default:
        # old threads carry retired ids that would only waste probes.
        model_health.observe([c.id for c in req.modelCandidates] or [req.model])
        # The window the CAPABILITY budgets are sized from: the smallest KNOWN
        # window among the models the router could pick. Sized from the routed
        # model's own window, the same turn got a different tool-schema budget and
        # compacted tool evidence sooner or later depending on which brain won
        # (131k measured vs the 200k unknown-window default). One window for every
        # candidate keeps the capability layer identical, and it is safe for the
        # smallest. 0 = none known. Output tokens stay per model (build_llm).
        candidates_window = min(
            (c.contextWindow for c in req.modelCandidates if c.contextWindow > 0),
            default=0,
        )
        try:
            router_cfg = RouterConfig.from_settings(
                settings.ai_router_enabled, settings.ai_router_profiles
            )
            if router_cfg.enabled:
                router_cfg = replace(
                    router_cfg, heavy_token_threshold=settings.ai_router_heavy_tokens
                )
                t_route = time.perf_counter()
                route = route_select(
                    cfg=router_cfg,
                    candidates=[
                        RouteCandidate(id=c.id, context_window=c.contextWindow)
                        for c in req.modelCandidates
                    ],
                    fallback=req.model,
                    # `latest` is this turn's user message (popped from history
                    # at assembly); `history` is everything before it. Using the
                    # locals rather than req.history avoids double-counting the
                    # current turn and reflects any truncation already applied.
                    #
                    # The STRUCTURAL fields matter as much as the text: they are
                    # facts about the request rather than guesses about its
                    # wording, so they survive any paraphrase.
                    signals=RouteSignals(
                        text=(latest.content or "") if latest else "",
                        history_chars=sum(len(h.content or "") for h in history),
                        history_turns=len(history),
                        has_document=any(
                            a.kind in ("document", "text")
                            for a in (latest.attachments if latest else [])
                        ),
                        has_image=any(
                            a.kind == "image"
                            for a in (latest.attachments if latest else [])
                        ),
                        rag_files=req.ragFileCount,
                        open_loops=len(ctx_state.openLoops) if ctx_state else 0,
                        artifacts=len(ctx_state.artifacts) if ctx_state else 0,
                        response_speed=(
                            req.personalization.responseSpeed
                            if req.personalization
                            else "balanced"
                        ),
                    ),
                )
                select_us = (time.perf_counter() - t_route) * 1e6
                log.info(
                    "router.selected",
                    extra={
                        "model": route.model,
                        "requested": req.model,
                        "reason": route.reason,
                        "select_us": round(select_us, 1),
                        "candidates": len(req.modelCandidates),
                        "budget_window": candidates_window,
                        # What the health registry took out of rotation.
                        "excluded": [
                            c.id
                            for c in req.modelCandidates
                            if model_health.is_exhausted(c.id)
                        ],
                    },
                )
        except Exception as e:  # never let routing fail a turn
            log.warning("router.failed", extra={"error": str(e)[:200]})
            route = Decision(req.model, "error")

        model_id = route.model
        # Report it on the terminal write so `chatMessages.model` records what
        # actually ran rather than the pre-dispatch fallback.
        try:
            writer.set_routed_model(model_id, route.reason)
        except AttributeError:  # older writer in a partial rollback
            pass
        # The chosen model's OWN window. Falls back to the payload's value only
        # when the router did not move off the model Convex costed it for.
        model_window = req.contextWindow
        if model_id != req.model:
            model_window = next(
                (c.contextWindow for c in req.modelCandidates if c.id == model_id),
                0,
            )

        # Phase 6: the central per-turn window accounting. Every component below
        # is measured against this so the assembled input never exceeds the model's
        # REAL window (req.contextWindow from Convex).
        cb = ContextBudget(
            model=model_id,
            context_window=candidates_window or model_window,
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
        # SCHEDULED RUNS READ MEMORY BUT DO NOT WRITE IT.
        #
        # `remember`/`forget` mutate state that outlives the turn, and an
        # unattended run has nobody to notice a bad write or correct a wrong
        # forget — a daily task would accumulate memories forever, and with
        # Project scope it would do so inside someone else's working context.
        #
        # Enforced by NOT BINDING the tools, the same way `elevated` gates
        # side-effect scope below, rather than by asking the model not to. A
        # capability the model cannot see is one it cannot be argued into using.
        memory_write_allowed = memory_as_tool and not req.unattended
        # File Generation System — bind `generate_file` when the flag is on. Off by
        # default → the tool is not offered and the runner is byte-identical.
        file_gen = settings.ai_file_generation_enabled
        # Phase 7 — bind the approval-gated SEO write tools ONLY on this interactive
        # turn when the flag is on. Off by default => not registered, not offered,
        # byte-identical; the read-only audit agent + monitoring worker never see them.
        seo_mutations = settings.ai_seo_mutations_enabled
        # Deep Research — bind the `record_research` durable-checkpoint tool when the
        # flag is on. Off by default => not registered, byte-identical. The model only
        # calls it when the deep-research skill engages; binding is harmless otherwise.
        research_as_tool = settings.ai_research_enabled
        # Data Analysis — bind the compute tools only when the flag is on AND the
        # thread actually has a dataset (Convex listed them in req.datasets). Off/no
        # dataset => not registered, byte-identical.
        data_as_tool = settings.ai_data_analysis_enabled and bool(req.datasets)
        # Sales — bind the DETERMINISTIC forecast tool when the sales flag is on. It is
        # stateless (computes from the deals the model passes), so it needs no dataset;
        # the model calls it only when a FORECAST/coverage number is required. Off =>
        # not registered, byte-identical.
        sales_as_tool = settings.ai_sales_enabled
        # Finance — bind the DETERMINISTIC finance_calc + on-demand finance_reference
        # tools when the finance flag is on. Both are stateless (compute from the
        # model's args / serve bundled data), so they need no dataset; the model uses
        # when the Finance/Equity skills engage. Off => not registered, byte-identical.
        finance_as_tool = settings.ai_finance_enabled
        # Marketing — bind marketing_calc + on-demand marketing_reference when the
        # marketing flag is on. Stateless; the model calls them only when the Marketing
        # skill engages. Off => not registered, byte-identical.
        marketing_as_tool = settings.ai_marketing_enabled
        # Documents — bind `document_ops` only when the flag is on AND the conversation
        # has an uploaded PPTX/PDF to operate on. Off/no document => not registered,
        # byte-identical. Creating a NEW document stays with generate_file.
        documents_as_tool = settings.ai_documents_enabled

        # Account-knowledge retrieval, launched concurrently so its embedding +
        # DB round-trip mostly hides behind the attachment work below. Gated by
        # ragFileCount (computed in Convex) so users with no files pay nothing.
        rag_task = None
        if engine is not None and req.ragFileCount > 0 and not rag_as_tool:
            rag_task = asyncio.create_task(
                retrieve_context(
                    settings,
                    engine,
                    user_id=req.userId,
                    query=latest.content,
                    # Project scope. None for an ordinary chat (whole corpus, as
                    # before); a list for a Project chat, possibly EMPTY, which
                    # retrieves nothing rather than widening. Never client-supplied.
                    file_ids=req.ragFileIds,
                )
            )

        try:
            content, n_images = await build_user_content(
                latest,
                convex,
                settings,
                model=model_id,
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
        agentic = (
            settings.agent_enabled
            or rag_as_tool
            or memory_as_tool
            or file_gen
            or research_as_tool
            or data_as_tool
        )
        # CANONICAL personalization -> one coherent style block + a real output
        # ceiling. `legacy_style` is the pre-canonical prose string and is used
        # ONLY when no canonical object arrived, so an older Convex deploy or a
        # rollback behaves exactly as it did before.
        personal = compile_personalization(
            req.personalization,
            default_output_tokens=settings.ai_max_output_tokens,
            legacy_style=req.customInstructionsStyle,
        )
        # Enough to debug "my style is not being applied" in production, and
        # deliberately no more: the shape of the settings, never the custom
        # instructions or the persona text, which are private user content.
        log.info(
            "personalization.compiled",
            extra={
                "canonical": req.personalization is not None,
                "enabled": bool(
                    req.personalization.enabled if req.personalization else False
                ),
                "base_style": (
                    req.personalization.baseStyle if req.personalization else None
                ),
                "speed": (
                    req.personalization.responseSpeed if req.personalization else None
                ),
                "traits": (
                    len(req.personalization.characteristics)
                    if req.personalization
                    else 0
                ),
                "styled": personal.style_block is not None,
                "out_cap": personal.max_output_tokens,
            },
        )
        system = build_system_prompt(
            custom=req.systemPrompt,
            about=req.customInstructionsAbout,
            style=personal.style_block,
            summary=req.summary,
            summary_through_seq=req.summaryThroughSeq,
            rag=rag_text,
            agentic=agentic,
            # Server-authored by Convex from the thread's Project. None for an
            # ordinary chat, so the prompt is byte-identical to before Projects.
            project_instructions=req.projectInstructions,
        )
        # THE REQUIREMENT LEDGER. Built deterministically from what the user
        # enumerated, so a ten-part task is tracked by OllaSuper rather than by a
        # flash-tier model's working memory. `build_ledger` returns None for
        # anything not enumerable — which is nearly every request — and a None
        # ledger makes this whole path a no-op, so ordinary chat is unchanged.
        #
        # The requirement list goes into the system prompt because the answer
        # STREAMS: a check placed after synthesis cannot retract a claim already
        # on the user's screen. The counts of what actually failed are not known
        # yet; those ride the deterministic report appended at the end of the
        # turn, which is computed from recorded state and therefore cannot be
        # overridden by a model that would rather say "done".
        ledger = build_ledger(latest.content) if latest is not None else None
        if ledger is not None:
            system = f"{system}\n\n{ledger.render_status()}"
            writer.ledger = ledger
            log.info(
                "agent.ledger_open",
                extra={
                    "stream_id": req.streamId,
                    "requirements": len(ledger.requirements),
                },
            )
        # Capability self-awareness: an always-on, compact catalogue of what OllaSuper
        # can ACTUALLY do this turn, derived live from the enabled skills + platform
        # flags + context — so "what can you do?" is answered from runtime state, not a
        # static list. Independent of the discover() path (which only surfaces skills
        # matching the query's tags). Agentic-only ⇒ off-path is byte-identical.
        # THE PLATFORM CONTEXT LAYER. One seam, every skill.
        #
        # This sits with the research seed and the dataset map below because it
        # is the generalisation of them: those two give ONE skill each a memory
        # of what it was doing, and this gives every skill — present and future
        # — the same thing, without any of them containing context logic.
        #
        # The resolved artifact is pinned INTO the system prompt, deliberately.
        # trim_messages trims history oldest-first, so an artifact left in
        # history is the first thing dropped exactly when a follow-up needs it;
        # here it cannot be trimmed at all, and its cost is measured into
        # system_tokens below so the window is still respected.
        turn_operation = classify_operation(latest.content)
        compiled = compile_context(
            user_text=latest.content,
            ctx=req.conversationContext,
            history=req.history,
            artifact_reserve_tokens=settings.ai_context_artifact_reserve_tokens,
        )
        if compiled is not None:
            system = f"{system}\n\n{compiled.block}"
            log.info(
                "context_compiled",
                extra={
                    "stream_id": req.streamId,
                    "thread_id": req.threadId,
                    "operation": compiled.operation,
                    "active_artifact_id": (
                        req.conversationContext.activeArtifactId
                        if req.conversationContext
                        else None
                    ),
                    "resolved_artifact_id": compiled.resolution.artifact_id,
                    "resolved_version": compiled.resolution.version,
                    "resolution_rung": compiled.resolution.rung,
                    "resolution_confidence": round(compiled.resolution.confidence, 2),
                    "pinned_artifact_id": compiled.pinned_artifact_id,
                    "pinned_tokens": compiled.pinned_tokens,
                    "pinned_clipped": compiled.pinned_clipped,
                },
            )

        if agentic:
            overview = render_capability_overview(
                effective_skills(settings),
                settings,
                has_datasets=bool(req.datasets),
                has_files=req.ragFileCount > 0,
                memory_enabled=req.memoryEnabled,
            )
            if overview:
                system = f"{system}\n\n{overview}"
        # Deep Research resume: seed the model with the thread's incomplete run so it
        # continues OPEN sub-questions and never re-researches completed ones. Empty
        # (no active run) => system prompt unchanged.
        research_ctx = None
        if research_as_tool:
            research_ctx = build_research_context(settings, req.activeResearchRun)
            seed = render_research_seed(req.activeResearchRun)
            if seed:
                system = f"{system}\n\n{seed}"
        # Data Analysis: build the per-turn dataset map (name→ref; storageId stays
        # server-side) and tell the model which datasets are available THIS turn — so
        # a follow-up with no new upload still analyses the same data.
        data_ctx = None
        if data_as_tool:
            ds_map = {
                d.name: DatasetRef(name=d.name, storage_id=d.storageId, mime=d.mime)
                for d in req.datasets
                if d.name and d.storageId
            }
            if ds_map:
                data_ctx = DataContext(
                    settings=settings,
                    convex=convex,
                    stream_id=req.streamId,
                    datasets=ds_map,
                )
                listing = "\n".join(
                    f"- {name} (SQL table: {sanitize_table_name(name)})"
                    for name in ds_map
                )
                system = (
                    f"{system}\n\n<datasets>\nStructured datasets available in this "
                    f"conversation (analyse them with the data tools; do NOT ask the "
                    f"user to re-upload):\n{listing}\n</datasets>"
                )
            else:
                data_as_tool = False

        # Documents: build the per-turn PPTX/PDF map (name→ref; storageId stays server-
        # side) from THIS conversation's document attachments, and tell the model which
        # files it can operate on with document_ops.
        documents_ctx = None
        if documents_as_tool:
            doc_map: dict[str, DocumentRef] = {}
            for msg in [*history, latest]:
                if msg is None or msg.role != "user":
                    continue
                for att in msg.attachments:
                    if att.kind != "document" or not att.storageId:
                        continue
                    kind = document_kind(att.name, att.contentType)
                    if kind:
                        doc_map[att.name] = DocumentRef(
                            name=att.name,
                            storage_id=att.storageId,
                            mime=att.contentType,
                            kind=kind,
                        )
            if doc_map:
                documents_ctx = DocumentsContext(
                    settings=settings,
                    convex=convex,
                    stream_id=req.streamId,
                    documents=doc_map,
                )
                listing = "\n".join(
                    f"- {name} ({r.kind.upper()})" for name, r in doc_map.items()
                )
                system = (
                    f"{system}\n\n<documents>\nPowerPoint/PDF files available in this "
                    f"conversation (read/edit/process them with document_ops; "
                    f"do NOT ask the user to re-upload):\n{listing}\n"
                    f"</documents>"
                )
            else:
                documents_as_tool = False

        # User chat -> Ollima (title-gen + OCR keep build_llm's OpenRouter default).
        llm = build_llm(
            settings,
            model=model_id,
            context_window=model_window,
            # The one model PARAMETER personalization may touch. None leaves the
            # caller default; a value is still clamped by _clamp_output against
            # this model's measured window, so a small-window model is never
            # asked for an output it cannot produce.
            max_tokens=personal.max_output_tokens,
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
            model=model_id,
            context_window=model_window,
            max_tokens=personal.max_output_tokens,
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
        candidates: list = []  # web candidates; stays [] when web tools are inactive
        adapter = None
        rag_ctx = None
        mem_ctx = None
        # Phase 5: the per-turn authorization scope — the shared READ_SCOPE/
        # WRITE_SCOPE permission template stamped with the AUTHORITATIVE caller
        # identity from the authenticated request (never the model). Single source
        # for the selection permission prefilter (F) AND the execution scope /
        # outbound tenant headers (B).
        # `and not req.unattended` is LOAD-BEARING. ai_agent_side_effect_enabled
        # is a GLOBAL flag: without this clause, an operator turning side effects
        # on for interactive chat — where a human approves each one — would
        # silently grant the same elevated scope to unattended scheduled runs,
        # which have nobody to approve anything. Background jobs stay read-only.
        elevated = settings.ai_agent_side_effect_enabled and not req.unattended
        # Security audit: classified from the same text the router read. An
        # audit WITHOUT an explicit fix request is READ-ONLY by construction: the
        # read scope + read-only ceiling mean no write tool is even bound (the
        # executor's guard refuses one that arrives mid-turn).
        sec = (
            sec_intent.detect(latest.content if latest else "")
            if settings.ai_security_enabled
            else sec_intent.NONE
        )
        if sec.audit and not sec.fix:
            elevated = False
        agent_scope = replace(
            WRITE_SCOPE if elevated else READ_SCOPE,
            user_id=req.userId,
            workspace_id=req.workspaceId,
            tenant_id=req.workspaceId,
        )
        # Phase 4/6: the user's own skills. SELECTED here, but COMPOSED into the
        # prompt much further down (see "Phase 4 (Custom Skills)").
        #
        # The split is deliberate and the ordering is the reason for it. What
        # the user declared has to be known BEFORE tools are chosen, because a
        # declaration is only meaningful if it can reach the candidate set. What
        # they wrote has to be appended AFTER the built-in skill block, and
        # unconditionally, for the reasons Phase 4 records. One selection,
        # therefore, read at two points — rather than two selections that could
        # disagree about which skills were active on the same turn.
        #
        # Placed immediately after `agent_scope` on purpose: the scope stamped
        # with the authenticated caller is what every capability decision below
        # is judged against, and nothing here may be evaluated before it exists.
        user_sel = EMPTY_SELECTION
        if settings.ai_user_skills_enabled and req.customSkills:
            # Never fatal. Composing a user's guidance is an enhancement to the
            # turn, not the turn itself, so a defect here must not be the reason
            # someone cannot get an answer — the same call the built-in
            # discovery below makes with its own `contextlib.suppress`. Logged at
            # exception level rather than swallowed, so it is loud in the logs
            # while the user still gets their reply.
            try:
                user_sel = select_user_skills(
                    req.customSkills,
                    latest.content,
                    # The AUTHORITATIVE caller, from the authenticated request —
                    # the same value that stamps `agent_scope`. Never from the
                    # model, never from the snapshot itself.
                    user_id=req.userId,
                    stream_id=req.streamId,
                    max_active=settings.ai_user_skill_max_active,
                    min_score=settings.ai_user_skill_min_score,
                    char_budget=settings.ai_user_skill_budget_chars,
                )
            except Exception as exc:  # noqa: BLE001 — see above
                # The TYPE, not the traceback. Everything this function touches
                # is private user prose, and a traceback happily renders the
                # argument that caused the failure — which would put a skill
                # body into the logs on exactly the path where nobody is
                # watching for it. The type plus the stream id is enough to find
                # and reproduce the fault.
                log.error(
                    "agent.user_skills_failed",
                    extra={
                        "stream_id": req.streamId,
                        "error_type": type(exc).__name__,
                    },
                )
            # Logged whenever the user HAS skills, including the no-match case:
            # "my skill did not fire" is the question this feature will actually
            # generate, and `considered` vs `included` is what answers it.
            log.info(
                "agent.user_skills",
                extra={
                    "stream_id": req.streamId,
                    "considered": user_sel.considered,
                    "skills": user_sel.included,
                    "compacted": user_sel.compacted,
                    "dropped": user_sel.dropped,
                    "declared": user_sel.capabilities,
                },
            )
        # Phase 1 (v2): SKILL activation DECOUPLED from tool availability — a
        # knowledge-only skill activates even with Ollagraph off/empty. Run the ONE
        # shared prepare() here (before tools bind) and compose its guidance into the
        # system prompt; the tools block below REUSES these objects for
        # find_capabilities/delegation. v2-OFF: skipped entirely (byte-identical).
        # ------------------------------------------------------------ Phase 5
        # The user's connected MCP servers become ordinary tools for this turn.
        #
        # `mcp_for_turn` acquires one pooled session per connection, discovers
        # resources/prompts into an index, and layers the discovered tools OVER
        # the shared Ollagraph catalogue into a PER-REQUEST registry. Rebinding
        # `tool_registry` here is what makes every downstream consumer — the
        # selector, `build_tool_specs`, the executor's registry lookups — see MCP
        # tools with no change of their own.
        #
        # The stack is exited in the `finally` at the end of the turn, so the
        # sessions outlive tool binding and every tool call that follows.
        mcp_caps = TurnCapabilities()
        if mcp_pool is not None and req.mcpConnections:
            mcp_caps = await mcp_stack.enter_async_context(
                mcp_for_turn(
                    mcp_pool,
                    req.mcpConnections,
                    # TRUSTED IDENTITY, from the authenticated request. Never
                    # from the connection list and never from the model.
                    user_id=req.userId,
                    workspace_id=req.workspaceId,
                    base=tool_registry,
                    engine=engine,
                    settings=settings,
                    # The control plane, for the durable hourly call window.
                    convex=convex,
                )
            )
            if mcp_caps.registry is not None:
                tool_registry = mcp_caps.registry
                tool_selector = ToolSelector(tool_registry)

        # Security audit: the per-turn state every security tool, guard and the
        # final report are written from. Seeded from `completedTools`, so an
        # approval resume keeps what the first attempt read.
        sec_reserved: set[str] = set()
        if sec.audit:
            _sec_access = LocalAccess.from_settings(settings)
            _gh_tools = [
                t
                for t in (tool_registry.list() if tool_registry is not None else [])
                if t.provider == GITHUB_PROVIDER
            ]
            sec_state = SecurityTurn(
                intent=sec,
                user_id=req.userId,
                local=_sec_access,
                read_only=not sec.fix,
                user_text=latest.content if latest else "",
                github_connected=bool(_gh_tools),
                github_connection_failed=not _gh_tools
                and any(c.slug == "github" for c in req.mcpConnections),
                model=model_id,
                route_reason=route.reason,
                osv_enabled=settings.ai_security_osv_enabled,
                scanner_timeout_s=settings.ai_security_scanner_timeout_s,
                scanners=tuple(
                    n.strip()
                    for n in settings.ai_security_scanners.split(",")
                    if n.strip()
                ),
                scanner_bin_dir=settings.ai_security_scanner_bin_dir,
                opengrep_rules=settings.ai_security_opengrep_rules,
            )
            sec_state.seed_from_completed(req.completedTools)
            # The GitHub connection's declared READS are guaranteed a binding;
            # on a fix request, the branch/file/PR writes too (approval-gated, and
            # the executor refuses a write outside a branch made this turn).
            _gh_fix = {
                "create_branch",
                "create_or_update_file",
                "push_files",
                "create_pull_request",
            }
            sec_reserved = {
                t.tool_id
                for t in _gh_tools
                if t.side_effect is SideEffect.READ_ONLY
                or (sec.fix and t.name in _gh_fix)
            }
            if (
                sec.fix
                and elevated
                and not req.unattended
                and _sec_access.names_for(req.userId)
            ):
                # Per-request registry: the shared catalogue is never mutated.
                tool_registry = layered_registry(tool_registry, [fix_tool_definition()])
                tool_selector = ToolSelector(tool_registry)
                sec_reserved.add(FIX_TOOL_ID)
            log.info(
                "secaudit.turn",
                extra={
                    "stream_id": req.streamId,
                    "read_only": not sec.fix,
                    "fix": sec.fix,
                    "diff": sec.diff,
                    "model": model_id,
                    "local_roots": len(_sec_access.names_for(req.userId)),
                    "github_connected": bool(_gh_tools),
                    "github_reserved": len(sec_reserved - {FIX_TOOL_ID}),
                    "fix_tool": FIX_TOOL_ID in sec_reserved,
                    "resumed_tools": len(req.completedTools),
                },
            )

        # Skill ids that actually reached the prompt this turn (both runtime
        # paths). The humanize stage keys on the writing skills among them.
        active_skill_ids: set[str] = set()
        candidates: list = []
        prepared_v2 = None
        orchestrator_v2 = None
        resolver_v2 = None
        if (
            settings.ai_runtime_v2_enabled
            and settings.ai_orchestrated_runtime_enabled
            and latest is not None
        ):
            _reg = tool_registry if tool_registry is not None else ToolRegistry()
            _sel = tool_selector if tool_selector is not None else ToolSelector(_reg)
            resolver_v2 = CapabilityResolver(_reg, _sel)
            orchestrator_v2, _ = build_live_runtime(settings, resolver_v2)
            prepared_v2 = orchestrator_v2.prepare(
                latest.content,
                scope=agent_scope,
                readiness=(
                    ProviderReadiness(
                        provider="ollagraph",
                        available=bool(tool_registry and tool_registry.count),
                        user_ready=settings.agent_enabled,
                    ),
                ),
            )
            if prepared_v2.rendered_skills:
                system = f"{system}\n\n{prepared_v2.rendered_skills}"
                log.info(
                    "agent.skills_active",
                    extra={
                        "stream_id": req.streamId,
                        "skills": [r["id"] for r in prepared_v2.skill_records],
                    },
                )
                active_skill_ids.update(r["id"] for r in prepared_v2.skill_records)
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
                    if elevated
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
                        _q,
                        top_k=1,
                        filters=_filters,
                        min_score=settings.tool_discovery_min_score,
                    ).candidates
                    if _hit and _hit[0].tool.tool_id not in _seen_ids:
                        candidates.append(_hit[0])
                        _seen_ids.add(_hit[0].tool.tool_id)
                candidates.sort(key=lambda c: -c.score)
                # A skill that DECLARES a tool must not lose it to the trim.
                # The trim keeps a score-ordered PREFIX, and lexical score is a
                # poor proxy for "this methodology names this tool": the blog
                # skill declares 34 blog.* capabilities and the real blog turn
                # bound NONE of them — discovery scored one unrelated tool at
                # 0.202 — so it fell back to 12 generic web searches.
                #
                # Seed the declared ones under the SAME filters (`_passes` is the
                # selector's own predicate, so scope and side-effect ceilings are
                # applied exactly as they are to a discovered tool — a skill can
                # widen relevance, never authorization), then sort them to the
                # front so the cut below can only ever reach undeclared tools.
                _declared: set[str] = set()
                if latest is not None:
                    with contextlib.suppress(Exception):  # discovery is optional
                        _, _sk_reg = build_live_runtime(
                            settings,
                            CapabilityResolver(tool_registry, tool_selector),
                        )
                        for _a in _sk_reg.discover(
                            latest.content,
                            limit=settings.ai_skill_max_active,
                            min_score=settings.ai_skill_min_score,
                        ):
                            _declared |= set(_a.manifest.preferred_capabilities)
                # Phase 6: RESOLVE the declarations before reserving them.
                #
                # This used to hand `_declared` straight to `reserve_skill_tools`,
                # which resolves a name with `registry.get(name)` — a literal
                # tool-id lookup. Skills do not declare tool ids. They declare
                # INTENTS, which is the entire purpose of `orchestrator/intents.py`
                # ("a thin, stable naming layer OVER the existing tool metadata,
                # so a skill references `page.fetch` rather than an unstable
                # provider tool_id"), and the real ids are provider operation ids:
                #
                #     intent  blog.serp_research
                #     tool    search_endpoint_v1_search_post
                #
                # Measured against the shipped catalogue: of everything the blog
                # and SEO skills declare, 100% are intents and 0% are registered
                # tool ids. So every lookup returned None and `added` was always
                # zero — the fix written because "the real blog turn bound NONE of
                # them" bound none of them, and said so in its own telemetry.
                #
                # AUTHORIZATION IS UNCHANGED. Resolution only decides which tools
                # a name refers to; `_filters` (the caller's scope, side-effect
                # ceiling and granted permissions) still gates every one, and
                # `check_tool_policy` still re-decides per call at execution.
                #
                # USER declarations join here under `intents_only`, so a user can
                # name a stable platform capability but never a raw provider id.
                # Flagged SEPARATELY from user skills: this branch is BUILT-IN
                # skill behaviour and changes what every user's SEO/blog turn
                # binds, on by default, regardless of `ai_user_skills_enabled`.
                # OFF restores the pre-Phase-6 behaviour exactly (declarations
                # resolved as literal tool ids, which matched nothing).
                _bound = (
                    resolve_capabilities(
                        _declared,
                        registry=tool_registry,
                        selector=tool_selector,
                        filters=_filters,
                        scope=agent_scope,
                    )
                    if settings.ai_skill_capability_resolution_enabled
                    else EMPTY_CAPABILITIES
                )
                _user_bound = (
                    resolve_capabilities(
                        user_sel.capabilities,
                        registry=tool_registry,
                        selector=tool_selector,
                        filters=_filters,
                        scope=agent_scope,
                        intents_only=True,
                    )
                    if user_sel.capabilities
                    else EMPTY_CAPABILITIES
                )
                # Phase 7: an APPROVED tool stays bound on resume.
                #
                # `_run_one` resolves against `name_to_tool_id` — the strict
                # allowlist of what was bound THIS turn — so a tool that is not
                # re-bound takes the unknown-tool path. That is correct for a
                # model naming something it was never offered, and wrong for a
                # tool a human already approved.
                #
                # The race is real and Phase 6 widened it. A skill declares a
                # capability, the tool binds only because of that declaration,
                # the model calls it, it parks for approval. The user approves,
                # then edits the skill, disables it, or removes the capability —
                # an approval can sit for as long as the reaper allows, which is
                # ample time. On resume the declaration is gone, discovery never
                # surfaced the tool (that was the point of declaring it), and the
                # action the user explicitly approved fails as "unknown tool".
                #
                # `approvedPending` is server-authored, reconstructed from the
                # durable toolExecutions table, and carries a single-use token.
                # Seeding it here only makes the tool BINDABLE — it goes through
                # the same `_passes` gate as everything else, and
                # `check_tool_policy` still decides at execution. So an approval
                # cannot resurrect a tool that has since been disabled or that
                # the caller may no longer run; it only stops an unrelated
                # settings edit from silently discarding consent.
                _approved_ids = {ap.toolId for ap in req.approvedPending}
                _resolved = {
                    *_bound.tool_ids,
                    *_user_bound.tool_ids,
                    *_approved_ids,
                    *sec_reserved,
                }
                if _resolved:
                    candidates, _added = reserve_skill_tools(
                        candidates, _resolved, tool_registry, _filters
                    )
                    log.info(
                        "agent.skill_tools_reserved",
                        extra={
                            "stream_id": req.streamId,
                            "declared": len(_declared),
                            "resolved": len(_resolved),
                            "added": _added,
                        },
                    )
                if user_sel.capabilities:
                    # Reported per outcome, because "my skill said it needs web
                    # search and it did not get it" needs an answer, and the
                    # three answers are different: the name is not a capability
                    # here, this deployment has no tool for it, or you are not
                    # allowed to use it.
                    log.info(
                        "agent.user_skill_capabilities",
                        extra={
                            "stream_id": req.streamId,
                            "declared": user_sel.capabilities,
                            "bound": _user_bound.tool_ids,
                            "unknown": _user_bound.unknown,
                            "unresolved": _user_bound.unresolved,
                            "unauthorized": _user_bound.unauthorized,
                            "unavailable": _user_bound.unavailable,
                        },
                    )
                if candidates:
                    _reserved = {
                        KNOWLEDGE_TOOL_NAME,
                        MEMORY_SEARCH_TOOL_NAME,
                        REMEMBER_TOOL_NAME,
                        FORGET_TOOL_NAME,
                        RECORD_RESEARCH_TOOL_NAME,
                        *DATA_TOOL_NAMES,
                        *SECURITY_TOOL_NAMES,
                    }
                    web_specs, name_to_id = build_tool_specs(
                        candidates, tool_registry, reserved=_reserved
                    )
                    # Phase 6 (B2): bound the bound-schema TOKEN cost. This is the
                    # REAL limit on how many tools bind (the count cap is off), so
                    # it must stay cheap: candidates are score-sorted, so take the
                    # longest prefix whose cumulative cost fits, in ONE pass.
                    #
                    # The previous loop dropped one candidate at a time and
                    # RE-SERIALIZED every remaining spec each time — O(n^2) JSON on
                    # the single event loop, which was tolerable at 5 candidates and
                    # is not at 200.
                    _schema_budget = cb.input_ceiling // 4
                    if spec_tokens(web_specs) > _schema_budget:
                        # Binary-search the largest score-sorted PREFIX that fits.
                        # Every probe rebuilds from `candidates`, so specs and
                        # name_to_id stay consistent — build_tool_specs may skip a
                        # candidate whose name cannot be sanitized, which makes any
                        # spec-index -> candidate-index mapping wrong. ~8 probes
                        # replaces up to N full re-serializations.
                        _lo, _hi, _best = 1, len(candidates), None
                        while _lo <= _hi:
                            _mid = (_lo + _hi) // 2
                            _ps, _pm = build_tool_specs(
                                candidates[:_mid], tool_registry, reserved=_reserved
                            )
                            if spec_tokens(_ps) <= _schema_budget:
                                _best = (_mid, _ps, _pm)
                                _lo = _mid + 1
                            else:
                                _hi = _mid - 1
                        if _best is None:  # even one spec overruns: keep exactly one
                            _ps, _pm = build_tool_specs(
                                candidates[:1], tool_registry, reserved=_reserved
                            )
                            _best = (1, _ps, _pm)
                        _keep, web_specs, name_to_id = _best
                        # A dropped tool used to vanish without a trace. The cut is
                        # a SCORE-ORDERED PREFIX, so what is lost is whatever ranked
                        # lowest lexically — which is not the same as what the task
                        # needs at step 7. Record it rather than infer it later.
                        log.info(
                            "agent.tools_trimmed",
                            extra={
                                "stream_id": req.streamId,
                                "kept": _keep,
                                "dropped": len(candidates) - _keep,
                                "budget_tokens": _schema_budget,
                            },
                        )
                        candidates = candidates[:_keep]
                    specs += web_specs
                    adapter = OllagraphAdapter(settings, ollagraph_http)
            except Exception:  # noqa: BLE001 — web tools are optional
                log.warning(
                    "agent_web_tools_disabled", extra={"stream_id": req.streamId}
                )
                specs, name_to_id, adapter = [], {}, None
        if rag_as_tool:
            specs.append(KNOWLEDGE_TOOL_SPEC)
            # The SAME scope the pre-fetch uses. This one also reaches every
            # DELEGATED agent: AgentEnv.rag is passed straight through to the
            # sub-agent ToolExecContext (agent/base.py), so scoping it here scopes
            # delegation too — and forgetting it would make search_knowledge the
            # bypass for the boundary the pre-fetch path enforces.
            rag_ctx = RagContext(
                engine=engine,
                user_id=req.userId,
                settings=settings,
                file_ids=req.ragFileIds,
            )
        if memory_as_tool:
            if memory_write_allowed:
                specs.append(REMEMBER_TOOL_SPEC)
            if req.memories:  # only bind recall when there is something there
                specs.append(MEMORY_SEARCH_TOOL_SPEC)
                if memory_write_allowed:
                    specs.append(FORGET_TOOL_SPEC)
            mem_ctx = MemoryContext(memories=req.memories, settings=settings)
        if file_gen:
            specs.append(GENERATE_FILE_TOOL_SPEC)
        # Bound once the thread HAS state worth enriching, and never on an
        # unattended run. Binding it on every turn instead was tried and reverted:
        # it changes the tool set of a plain turn, which broke the
        # finalize-without-tools contract, and it did not actually help — the
        # model declined to call this across ten production scenarios either way.
        # See the honest note in the commit; the FLOOR is unaffected by any of it.
        if compiled is not None and not req.unattended:
            specs.append(RECORD_CONTEXT_TOOL_SPEC)
        if research_as_tool:
            specs.append(RECORD_RESEARCH_TOOL_SPEC)
        if data_as_tool:
            specs.extend(DATA_TOOL_SPECS)
        if sales_as_tool:
            specs.append(SALES_FORECAST_TOOL_SPEC)
        if finance_as_tool:
            specs.append(FINANCE_CALC_TOOL_SPEC)
            specs.append(FINANCE_REFERENCE_TOOL_SPEC)
        if marketing_as_tool:
            specs.append(MARKETING_CALC_TOOL_SPEC)
            specs.append(MARKETING_REFERENCE_TOOL_SPEC)
        if documents_as_tool:
            specs.append(DOCUMENT_OPS_TOOL_SPEC)
        if sec_state is not None:
            specs.extend(SECURITY_TOOL_SPECS)

        # The reserved (non-Ollagraph) specs, used to keep RAG/memory alive if a
        # bad web spec breaks the combined bind.
        reserved_specs: list[dict] = []
        if rag_as_tool:
            reserved_specs.append(KNOWLEDGE_TOOL_SPEC)
        if memory_as_tool:
            if memory_write_allowed:
                reserved_specs.append(REMEMBER_TOOL_SPEC)
            if req.memories:
                reserved_specs.append(MEMORY_SEARCH_TOOL_SPEC)
                if memory_write_allowed:
                    reserved_specs.append(FORGET_TOOL_SPEC)
        if file_gen:
            reserved_specs.append(GENERATE_FILE_TOOL_SPEC)
        if research_as_tool:
            reserved_specs.append(RECORD_RESEARCH_TOOL_SPEC)
        if data_as_tool:
            reserved_specs.extend(DATA_TOOL_SPECS)
        if sales_as_tool:
            reserved_specs.append(SALES_FORECAST_TOOL_SPEC)
        if finance_as_tool:
            reserved_specs.append(FINANCE_CALC_TOOL_SPEC)
            reserved_specs.append(FINANCE_REFERENCE_TOOL_SPEC)
        if marketing_as_tool:
            reserved_specs.append(MARKETING_CALC_TOOL_SPEC)
            reserved_specs.append(MARKETING_REFERENCE_TOOL_SPEC)
        if documents_as_tool:
            reserved_specs.append(DOCUMENT_OPS_TOOL_SPEC)
        if sec_state is not None:
            reserved_specs.extend(SECURITY_TOOL_SPECS)
        # Phase 5: ONE generic resource reader, bound only when a connected server
        # actually advertises resources. A user with no resource-bearing server
        # never sees it, so it costs nothing in the context budget of every turn
        # that could not have used it.
        mcp_resources_bound = mcp_caps.index.has_resources
        if mcp_resources_bound:
            reserved_specs.append(MCP_READ_RESOURCE_TOOL_SPEC)

        llm_tools = None
        llm_tools_fallback = None
        tools_ctx = None
        if specs:
            try:
                # STREAMING primary so the final answer streams token-by-token like a
                # normal prompt; NON-streaming fallback (identical specs) used only
                # when a model's streamed tool-call deltas break the accumulator.
                llm_tools = llm.bind_tools(specs)
                llm_tools_fallback = llm_for_tools.bind_tools(specs)
            except Exception:  # noqa: BLE001 — a bad web spec must not kill RAG/memory
                log.warning(
                    "agent_tools_bind_failed", extra={"stream_id": req.streamId}
                )
                llm_tools = None
                llm_tools_fallback = None
                if reserved_specs:
                    try:
                        llm_tools = llm.bind_tools(reserved_specs)
                        llm_tools_fallback = llm_for_tools.bind_tools(reserved_specs)
                        name_to_id, adapter = {}, None
                    except Exception:  # noqa: BLE001
                        llm_tools = None
                        llm_tools_fallback = None
            # Per-request adapters keyed by tool.provider for the executor dispatch map.
            connector_adapters: dict = {}
            # Phase 5: one adapter per connected MCP server, keyed by
            # `mcp:<slug>` — exactly what `ctx.adapters.get(tool.provider)`
            # already reads, so the executor needs no change at all.
            connector_adapters.update(mcp_caps.adapters)
            if sec_state is not None:
                connector_adapters[FIX_PROVIDER] = SecurityFixAdapter(sec_state)
            # Phase 7: register the SEO write provider + its adapter (keyed by provider
            # "seo_write" for the executor dispatch map). The real site-write is an
            # injected seam — StubSeoWriteProvider until a GSC/CMS provider is dropped
            # in. The adapter posts the result to Convex seoMutations via ingress.
            if seo_mutations and tool_registry is not None:
                register_seo_mutation_provider(tool_registry)
                connector_adapters["seo_write"] = SeoWriteAdapter(
                    StubSeoWriteProvider(),
                    stream_id=req.streamId,
                    post_result=convex.ingress,
                )
            if llm_tools is not None:
                tools_ctx = ToolExecContext(
                    registry=tool_registry,
                    adapter=adapter,
                    adapters=connector_adapters,
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
                    # Fills web search's `lang` when the model omits it. The
                    # user's stated preference only — never a guessed locale.
                    response_language=(
                        req.personalization.responseLanguage
                        if req.personalization
                        and req.personalization.responseLanguage
                        else ""
                    ),
                    max_tool_calls_per_step=settings.ai_agent_max_tool_calls_per_step,
                    max_stall_steps=settings.ai_agent_max_stall_steps,
                    max_concurrent_tools=settings.ai_agent_max_concurrent_tools,
                    rag=rag_ctx,
                    memory=mem_ctx,
                    research=research_ctx,
                    # Phase 5: the capability index, set only when the reserved
                    # resource tool was actually bound. The executor's branch is
                    # gated on this being non-None, so a turn that did not bind
                    # the tool cannot reach the read path at all.
                    mcp_index=mcp_caps.index if mcp_resources_bound else None,
                    mcp_resource_max_bytes=settings.mcp_resource_max_bytes,
                    data=data_ctx,
                    conversation=(None if req.unattended else conversation_state),
                    approvals={
                        a.approvalId: {"decision": a.decision, "token": a.token}
                        for a in req.approvals
                    },
                    force_approval_ids=settings.ai_agent_approval_test_tool_ids,
                    unattended=req.unattended,
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
                    # File Generation System — the `generate_file` handler's config.
                    file_gen_enabled=file_gen,
                    file_max_bytes=settings.ai_file_max_bytes,
                    file_gen_timeout_s=settings.ai_file_gen_timeout_s,
                    file_gen_pool_workers=settings.ai_ocr_render_workers,
                    # Documents capability — the per-turn file map + preview render
                    # bounds.
                    documents=documents_ctx,
                    documents_enabled=documents_as_tool,
                    doc_preview_max_pages=settings.ai_documents_preview_max_pages,
                    doc_preview_scale=settings.ai_documents_preview_scale,
                    doc_soffice_enabled=settings.ai_documents_soffice_enabled,
                    doc_soffice_timeout_s=settings.ai_documents_soffice_timeout_s,
                    doc_soffice_concurrency=settings.ai_documents_soffice_concurrency,
                )
                if sec_state is not None:
                    # Redaction, the read-only/GitHub guards and the security
                    # built-ins all key on this being set.
                    tools_ctx.security = sec_state
                    if FIX_TOOL_ID in sec_reserved:
                        tools_ctx.force_approval_ids = (
                            tools_ctx.force_approval_ids | frozenset({FIX_TOOL_ID})
                        )
                # Phase 12b (Stage 1): attach DYNAMIC CAPABILITY DISCOVERY to the
                # live agent path. The model gains `find_capabilities` to reach ANY
                # registered tool (no Top-K reachability ceiling); matches are
                # dynamically loaded by the Phase-10 executor/graph (which update
                # BOTH the allowlist + bound specs, authorization still enforced per
                # call). `rebind` targets the STREAMING `llm` so the final answer (and
                # narration) streams like a normal prompt; `rebind_fallback` (the
                # non-streaming twin) recovers tool_calls when a model's streamed
                # tool-call deltas break the accumulator. OFF by default → skipped, and
                # the runner is byte-identical (top-K stays the initial inline set).
                if (
                    settings.ai_orchestrated_runtime_enabled
                    and tool_registry is not None
                    and tool_selector is not None
                ):
                    if settings.ai_runtime_v2_enabled and orchestrator_v2 is not None:
                        # v2: reuse the resolver + skills already prepared above
                        # (decoupled from tools). The delegator env is built AFTER
                        # resume/budget state is known (below) so sub-agents inherit
                        # approvals/RAG/memory/resume/budget — not just role+task.
                        resolver = resolver_v2
                        specs.append(FIND_CAPABILITIES_TOOL_SPEC)
                        tools_ctx.capabilities = resolver
                        tools_ctx.rebind = llm.bind_tools
                        tools_ctx.rebind_fallback = llm_for_tools.bind_tools
                        tools_ctx.pending_capabilities = []
                        if prepared_v2 is not None and prepared_v2.force_approval_ids:
                            tools_ctx.force_approval_ids = (
                                tools_ctx.force_approval_ids
                                | prepared_v2.force_approval_ids
                            )
                        specs.append(build_delegate_spec(settings))
                    else:
                        # Phase 13 (v2-OFF): byte-identical wiring. Skills + delegation
                        # into the SAME streaming path; delegate_to_agent rides the
                        # bound_specs re-bind, sub-agent runs as a batch observation.
                        resolver = CapabilityResolver(tool_registry, tool_selector)
                        specs.append(FIND_CAPABILITIES_TOOL_SPEC)
                        tools_ctx.capabilities = resolver
                        tools_ctx.rebind = llm.bind_tools
                        tools_ctx.rebind_fallback = llm_for_tools.bind_tools
                        tools_ctx.pending_capabilities = []
                        orchestrator, skill_reg = build_live_runtime(settings, resolver)
                        if latest is not None:
                            active_skills = skill_reg.discover(
                                latest.content,
                                limit=settings.ai_skill_max_active,
                                min_score=settings.ai_skill_min_score,
                            )
                            if active_skills:
                                _budget = settings.ai_skill_instructions_budget_chars
                                # What discovery SELECTED is not what the model
                                # SEES: skill bodies range from 278 to 17,617
                                # chars, so a second substantial skill routinely
                                # does not fit. This used to log the selected set,
                                # which meant telemetry asserted a skill was
                                # active when it never reached the prompt.
                                included, dropped, compacted = pack_skills(
                                    active_skills, char_budget=_budget
                                )
                                system = f"{system}\n\n" + render_skills_block(
                                    active_skills, char_budget=_budget
                                )
                                # Deliberately over ALL discovered skills, not just
                                # the included ones: a dropped skill's approval
                                # requirements still bind. Erring toward MORE
                                # approval is the safe direction.
                                skill_approvals: set[str] = set()
                                for a in active_skills:
                                    skill_approvals |= set(a.manifest.require_approval)
                                if skill_approvals:
                                    tools_ctx.force_approval_ids = (
                                        tools_ctx.force_approval_ids
                                        | frozenset(skill_approvals)
                                    )
                                active_skill_ids.update(
                                    a.manifest.skill_id for a in included
                                )
                                log.info(
                                    "agent.skills_active",
                                    extra={
                                        "stream_id": req.streamId,
                                        "skills": [
                                            a.manifest.skill_id for a in included
                                        ],
                                        # A SUBSET of `skills`: contributed
                                        # constraints + output shape, not their
                                        # full procedure.
                                        "compacted": [
                                            a.manifest.skill_id for a in compacted
                                        ],
                                    },
                                )
                                if dropped:
                                    log.warning(
                                        "agent.skills_dropped",
                                        extra={
                                            "stream_id": req.streamId,
                                            "skills": [
                                                a.manifest.skill_id for a in dropped
                                            ],
                                            "budget_chars": _budget,
                                        },
                                    )
                        specs.append(build_delegate_spec(settings))
                        tools_ctx.delegator = orchestrator.make_delegator(
                            AgentEnv(
                                writer=writer,
                                llm=llm,
                                run_id=req.streamId,
                                user_id=req.userId,
                                workspace_id=req.workspaceId,
                                registry=tool_registry,
                                adapter=adapter,
                                adapters=connector_adapters,
                                candidates=candidates,
                                bind=llm_for_tools.bind_tools,
                                capabilities=resolver,
                            )
                        )

        # Security audit: no delegation (a sub-agent's context carries neither the
        # redaction nor the read-only guard), and the audit method + sources are
        # stated deterministically rather than left to lexical skill discovery.
        if sec_state is not None:
            if tools_ctx is not None:
                tools_ctx.delegator = None
            specs[:] = [
                sp
                for sp in specs
                if (sp.get("function") or {}).get("name") != DELEGATE_TOOL_NAME
            ]
            if SECURITY_SKILL.skill_id not in active_skill_ids:
                system = f"{system}\n\n{SECURITY_SKILL.render()}"
                active_skill_ids.add(SECURITY_SKILL.skill_id)
            _roots = sec_state.local.names_for(req.userId)
            system = (
                f"{system}\n\n<security_audit>\n"
                + (
                    "Mode: FIX REQUESTED - each change is shown to the user and "
                    "runs only after they approve it.\n"
                    if sec.fix
                    else "Mode: READ-ONLY audit - nothing may be modified.\n"
                )
                + "Local repositories (security_repo): "
                + (
                    ", ".join(_roots)
                    if _roots
                    else "none - local repositories are not enabled for this account"
                )
                + "\nGitHub: "
                + (
                    "connected - use its read tools for GitHub repositories"
                    if sec_state.github_connected
                    else "not connected - a GitHub repository cannot be audited "
                    "until the user connects GitHub"
                )
                + "\n</security_audit>"
            )

        # Phase 4 (Custom Skills): the user's OWN guidance, composed LAST.
        #
        # WHY HERE AND NOWHERE ELSE. This is the first point after `if specs:`
        # closes, and that placement is the whole design:
        #
        #   * UNCONDITIONAL. The built-in skill block above lives four levels
        #     deep — inside `if specs:`, inside its `try:`, inside
        #     `ai_orchestrated_runtime_enabled and tool_registry and
        #     tool_selector`. Built-in skills are all tool-adjacent so that has
        #     never mattered to them, but a user skill is usually pure prose
        #     ("read the contract end to end before commenting"), and gating it
        #     on tools would mean it silently stops applying on exactly the
        #     plain conversational turns it was written for. A user cannot debug
        #     that, and would reasonably conclude the feature is broken.
        #   * AFTER the built-in block, so trusted guidance is established before
        #     user preference qualifies it.
        #   * BEFORE `tokens(system)` below, so the block is measured into the
        #     window like every other part of the prompt instead of quietly
        #     pushing the turn over it.
        #
        # Flag OFF => nothing runs and the prompt is byte-identical. Snapshot
        # empty (everyone who has written no skills) => same.
        # Selected far above, next to `agent_scope`, because the capabilities it
        # declares had to be known before tools were chosen. Only the APPEND
        # happens here, and it happens here for the reasons above.
        if user_sel.block:
            system = f"{system}\n\n{user_sel.block}"

        # Phase 6 (B1): measure the FIXED costs (system prompt + bound tool schemas
        # + latest turn) now that all are assembled, and trim PRIOR history against
        # the TRUE remaining window — replacing the old flat-4k system reservation.
        system_tokens = tokens(system)
        schema_tokens = spec_tokens(specs)
        latest_tokens = content_tokens(content)
        prior_all = to_lc_messages(history)
        prior = trim(
            prior_all,
            model=req.model,
            n_images=n_images,
            max_output=settings.ai_max_output_tokens,
            base_budget=settings.ai_context_budget_tokens,
            safety_factor=settings.ai_token_safety_factor,
            context_window=req.contextWindow,
            fixed_tokens=system_tokens + schema_tokens + latest_tokens,
        )
        if len(prior) < len(prior_all):
            log.info(
                "agent.history_trimmed",
                extra={
                    "stream_id": req.streamId,
                    "kept": len(prior),
                    "dropped": len(prior_all) - len(prior),
                    "fixed_tokens": system_tokens + schema_tokens + latest_tokens,
                },
            )
        fit_budget = cb.message_fit_budget(
            system_tokens=system_tokens, schema_tokens=schema_tokens
        )

        # CAPACITY FAILOVER. One hop to a different model when the selected one
        # refuses before answering (quota, provider error, unreachable, request
        # timeout). The target is chosen per turn from the health registry — a
        # usable model on an INDEPENDENT upstream that still meets the turn's
        # reasoning floor — not from one configured id, which today shared the
        # primary's quota and failed for the same reason. `ai_quota_fallback_model`
        # is only a tie-break preference now.
        quota_fb = None
        quota_fb_tools = None
        fb_model = select_failover(
            cfg=router_cfg,
            candidates=[
                RouteCandidate(id=c.id, context_window=c.contextWindow)
                for c in req.modelCandidates
            ],
            primary=model_id,
            floor=route.floor,
            upstream_of=model_health.upstream_of,
            is_available=lambda m: not model_health.is_exhausted(m),
            preferred=settings.ai_quota_fallback_model,
            needs_vision=any(
                a.kind == "image" for a in (latest.attachments if latest else [])
            ),
        )
        log.info(
            "router.failover_candidate",
            extra={
                "stream_id": req.streamId,
                "model": model_id,
                "model_upstream": model_health.upstream_of(model_id) or None,
                "failover": fb_model or None,
                "failover_upstream": model_health.upstream_of(fb_model) or None,
            },
        )
        if fb_model:
            # The FALLBACK's own window, not the primary's. This used to pass
            # req.contextWindow — the window of the model being replaced — so a
            # failover onto a smaller model was budgeted as if it were the
            # larger one. 0 means unknown and build_llm applies its conservative
            # default, which is the safe direction to be wrong in.
            fb_window = next(
                (c.contextWindow for c in req.modelCandidates if c.id == fb_model), 0
            )
            quota_fb = build_llm(
                settings,
                model=fb_model,
                context_window=fb_window,
                base_url=settings.ollima_base_url,
                api_key=settings.ollima_api_key,
            )
            quota_fb_tools = (
                quota_fb.bind_tools(specs)
                if specs
                else build_llm(
                    settings,
                    model=fb_model,
                    context_window=fb_window,
                    streaming=False,
                    base_url=settings.ollima_base_url,
                    api_key=settings.ollima_api_key,
                )
            )
            # Dynamic capability loading re-binds the primary every step; the
            # failover must re-bind the same way or it answers without the tools
            # the turn has already loaded.
            if tools_ctx is not None and tools_ctx.rebind is not None:
                tools_ctx.rebind_quota_fallback = quota_fb.bind_tools

        # NOT silent. A user whose answer came from a different model than the one
        # in their picker must be told, or the picker is lying to them. One line,
        # pushed ahead of the answer through the existing delta channel.
        notified = {"done": False}

        async def _note_quota_fallback() -> None:
            if notified["done"]:
                return
            notified["done"] = True
            failover["model"] = fb_model
            log.warning(
                "generation_quota_fallback",
                extra={"stream_id": req.streamId, "from": model_id, "to": fb_model},
            )
            with contextlib.suppress(Exception):  # never break a recovering turn
                # chatMessages.model must name the model that answered; it
                # named the refusing one, so a failover turn was credited to
                # a model that produced none of it.
                writer.set_routed_model(
                    fb_model, f"{route.reason}|quota_fallback_from:{model_id}"
                )
                await writer.push(
                    f"_{model_id} is out of capacity — answered with "
                    f"{fb_model} instead._\n\n"
                )

        # EVERY option refusing: say so NOW. Starting the graph would spend two
        # full doomed model calls (three attempts each inside openai-python) to
        # reach the same answer, which is the "waited minutes for nothing" the
        # user reported. One cheap check turns that into an immediate, honest
        # message. `is_exhausted` self-expires, so a recovered provider is
        # retried without a restart.
        #
        # Health is keyed on the ROUTED model, never req.model (the thread's
        # default). Keyed on the default, one model's quota refusal refused turns
        # the router had sent to a healthy model — prod, 6 turns routed to
        # deepseek-v4-flash refused as "deepseek-v4-pro has no capacity".
        if model_health.is_exhausted(model_id) and (
            quota_fb is None or model_health.is_exhausted(fb_model)
        ):
            log.warning(
                "generation_no_capacity",
                extra={"stream_id": req.streamId, "model": model_id},
            )
            status = "error"
            error = {
                "code": ERR_QUOTA,
                "message": "The model could not complete this response",
                "retryable": False,
            }
            return

        graph = build_graph(
            llm,
            llm_tools=llm_tools,
            llm_tools_fallback=llm_tools_fallback,
            tools_ctx=tools_ctx,
            quota_fallback=quota_fb,
            quota_fallback_tools=quota_fb_tools,
            on_quota_fallback=_note_quota_fallback,
            model_name=model_id,
            health_ttl_s=settings.ai_model_health_ttl_s,
        )

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
                messages.append(ToolMessage(content=ct.resultContent, tool_call_id=cid))
                if tools_ctx is not None:
                    tools_ctx.seen_calls[ct.toolId] = json.dumps(
                        ct.args, sort_keys=True, default=str
                    )
                    tools_ctx.seen_call_set.add(f"{ct.toolId}:{hash_args(ct.args)}")
                    # H-06: the taint ledger is per-context, and an approval
                    # resume is a NEW context. Rebuild it from what already ran,
                    # or the connector content read before the pause would
                    # flow freely after it (measured on production: the Drive
                    # search re-issued after a rejection ran unasked).
                    tools_ctx.taint.record(
                        source_of_id(ct.toolId, tools_ctx.registry), ct.resultContent
                    )
            completed_steps = len(req.completedTools)
        if tools_ctx is not None:
            # And the sticky half: a destination the user REJECTED a call to
            # keeps asking for the rest of the turn, across the resume.
            for a in req.approvals:
                dest = source_of_id(a.toolId, tools_ctx.registry)
                if a.decision == "rejected" and dest:
                    tools_ctx.taint.flag(dest, {REJECTED_EARLIER})
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
                # By the BOUND name, not the id: an MCP id binds under a
                # sanitised spelling, and `_run_one` resolves bound names.
                bound = bound_name_for_tool_id(tools_ctx.name_to_tool_id, ap.toolId)
                out = await execute_tool_calls(
                    [{"name": bound, "args": ap.args, "id": cid}], tools_ctx
                )
                messages.append(
                    AIMessage(
                        content="",
                        tool_calls=[{"name": bound, "args": ap.args, "id": cid}],
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

        # Phase 1 (v2): build the delegator env HERE — after approvals + resume
        # state are populated on tools_ctx — via the ONE env factory, so a delegated
        # sub-agent inherits approvals/RAG/memory/resume/budget (not just role+task).
        # The delegate spec was already bound above; attaching the callable before
        # the graph runs is sufficient. v2-OFF used the thin env in the block above.
        if (
            settings.ai_runtime_v2_enabled
            and orchestrator_v2 is not None
            and tools_ctx is not None
            and sec_state is None
        ):
            tools_ctx.delegator = orchestrator_v2.make_delegator(
                build_live_agent_env(
                    writer=writer,
                    llm=llm,
                    req=req,
                    registry=tool_registry,
                    adapter=adapter,
                    adapters=connector_adapters,
                    candidates=candidates,
                    bind=llm_for_tools.bind_tools,
                    capabilities=resolver_v2,
                    rag=rag_ctx,
                    memory=mem_ctx,
                    fit_budget=fit_budget,
                    approvals=dict(tools_ctx.approvals),
                    resume_seen=dict(tools_ctx.seen_calls),
                    resume_seen_set=frozenset(tools_ctx.seen_call_set),
                )
            )

        # Phase 6 (B4): re-fit the assembled list (latest + prior + resumed
        # completed/attempted/approved tool messages) so a resume with many large
        # results cannot overrun the window — the oldest raw results compact to
        # references (the durable checkpoint is untouched, only the in-context copy).
        messages = fit_messages(messages, fit_budget)

        state = {"messages": messages, "system_prompt": system}
        if tools_ctx is not None:
            # Spend the budget in the SAME unit the graph spends it in: one per
            # executor PASS. `req.completedSteps` is the distinct-stepId count from
            # the durable ledger; `completed_steps` (a count of individual tool
            # CALLS) is only the fallback for a Convex that predates the field, and
            # over-counting there is safe-but-conservative, never unbounded.
            already = req.completedSteps or completed_steps
            # None = NO count ceiling (the default). The loop is bounded by
            # PROGRESS (ai_agent_max_stall_steps), by the no-progress deadline, and
            # by the context budget. A configured backstop still applies, and a
            # resume subtracts what earlier attempts already spent.
            state["tool_budget"] = (
                None
                if settings.ai_agent_max_steps <= 0
                else max(0, settings.ai_agent_max_steps - already)
            )
            # Phase 6 (B3): the per-step re-fit budget for the in-graph model node.
            state["fit_budget"] = fit_budget
            # Phase 12b (Stage 1): seed the dynamic working set so the model node
            # re-binds (from bound_specs) + the executor node drains discoveries into
            # it. Only when dynamic discovery is attached (flag on); else untouched.
            if tools_ctx.capabilities is not None:
                state["bound_specs"] = specs

        # Phase 7: the total-execution deadline (durable across resume). Under v2
        # it was already computed + armed before prep (so a prep-time hang is
        # guarded); here it stands in for the v2-off path (armed just before the
        # stream, byte-identical to before).
        deadline_mono = _compute_deadline_mono(req, started, settings)

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
        if hb_task is None:  # v2 arms it earlier (before prep); else arm it here.
            deadline_flag["mono"] = deadline_mono
            hb_task = asyncio.create_task(
                _background_heartbeat(
                    writer,
                    settings.ai_heartbeat_ms,
                    asyncio.current_task(),
                    deadline_flag,
                )
            )
        # Strip gpt-5.6-luna "harmony" tool-call leaks out of the visible stream
        # (recovery into real tool_calls happens in the graph's model node). The
        # filter is a pass-through until a `to=functions.`/`multi_tool_use.parallel`
        # marker appears, so normal text streams byte-for-byte with no added latency.
        harmony_filter = HarmonyStreamFilter()
        # HUMANIZER (app/humanizer/stage.py) — run by code, not by the model.
        # On a writing deliverable (the router classified the turn as `produce`
        # and a writing skill reached the prompt) the model's draft is
        # BUFFERED instead of streamed; once the graph finishes, the stage
        # detects, streams a rewrite if the draft needs one, and verifies it.
        humanize_register = (
            humanize_stage.gate(active_skill_ids, latest.content)
            if settings.ai_humanizer_enabled and route.work == "produce"
            else None
        )
        # One model call = one segment. The deliverable is the largest; short
        # text before it is narration between tool steps and is shown as soon
        # as its step ends (measured on prod: a 19-step blog turn sent its
        # SERP narration to the rewrite, which changed quoted search terms).
        draft_parts: list[str] = []
        held_segments: list[str] = []
        draft_step: object = None

        async def _close_draft_segment() -> None:
            segment = "".join(draft_parts)
            draft_parts.clear()
            if (
                not held_segments
                and humanize_stage.word_count(segment) < humanize_stage.MIN_WORDS
            ):
                await writer.push(segment)
            else:
                # From the first long segment on, everything is held so the
                # answer keeps its order.
                held_segments.append(segment)

        prep_ms = (time.monotonic() - started) * 1000
        async with aclosing(graph.astream(state, stream_mode="messages")) as stream:
            async for chunk, metadata in stream:
                # Only the model node's output is user-visible. Tool nodes added
                # later stream through here too and must not reach the transcript.
                if metadata.get("langgraph_node") != "model":
                    continue
                # A tool-call turn whose streamed tool-call deltas broke the accumulator
                # is recovered by the graph's non-streaming fallback, which CLEARS the
                # (already-streamed) content on that message — so the fallback's own
                # emit contributes no text here and the preamble is not duplicated. No
                # extra guard is needed in this loop.
                raw = _chunk_text(chunk)
                if raw:
                    text = harmony_filter.feed(raw)
                    if text and humanize_register is not None:
                        step = metadata.get("langgraph_step")
                        if step != draft_step and draft_parts:
                            await _close_draft_segment()
                        draft_step = step
                        draft_parts.append(text)
                        _extend_deadline()  # a hidden draft is still progress
                    elif text:
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

        # Release any text the harmony filter was holding (an unterminated marker
        # at the very end resolves to nothing; real trailing prose is emitted).
        tail = harmony_filter.flush()
        if tail and humanize_register is not None:
            draft_parts.append(tail)
        elif tail:
            await writer.push(tail)
        if humanize_register is not None:
            held_segments.append("".join(draft_parts))  # the last call is held
            draft_parts.clear()
            if writer.suspended or not any(s.strip() for s in held_segments):
                # Parked on an approval (the turn resumes later) or nothing
                # was written: deliver what exists, unchanged.
                await writer.push("".join(held_segments))
            else:
                pick = max(
                    range(len(held_segments)), key=lambda k: len(held_segments[k])
                )
                before = "".join(held_segments[:pick])
                after = "".join(held_segments[pick + 1 :])
                if before:
                    await writer.push(before)
                shown_before = writer.text
                # A voice edit needs no reasoning tier: the rewrite goes to the
                # fastest healthy routed model (prod: the reasoning model spent
                # 36-83s on it), else the model that wrote the draft.
                rewrite_model = _fastest_healthy_model(
                    router_cfg, req.modelCandidates
                ) or (failover["model"] or model_id)
                kept, extra_usage = await _deliver_writing(
                    writer,
                    settings,
                    draft=held_segments[pick],
                    register=humanize_register,
                    request=latest.content,
                    model=rewrite_model,
                    context_window=next(
                        (
                            c.contextWindow
                            for c in req.modelCandidates
                            if c.id == rewrite_model
                        ),
                        0,
                    ),
                    stream_id=req.streamId,
                )
                if extra_usage:
                    usage = usage or {"promptTokens": 0, "completionTokens": 0}
                    usage["promptTokens"] += extra_usage[0]
                    usage["completionTokens"] += extra_usage[1]
                if writer.cancel_requested:
                    status = "cancelled"
                    return
                if after:
                    await writer.push(after)
                if kept is not None:
                    humanized["final_text"] = shown_before + kept + after
        await writer.flush(force=True)
        # Phase 8: a tool parked awaiting approval routed the graph to END. The
        # durable approval + suspend is already recorded in Convex; do NOT
        # finalize (that would drive waiting_approval -> done and destroy the
        # parked approval). The turn resumes when the user resolves it.
        if writer.suspended:
            status = "suspended"
            return
        status = "done"
        # Deep Research: on NORMAL completion, deterministically CLOSE a research run
        # the model opened, so it never lingers as "researching" (which would keep
        # re-seeding future turns). Only here — an interrupt/suspend/deadline returned
        # earlier and deliberately leaves the run resumable. research_checkpoint never
        # raises (it swallows Convex errors), so this cannot fail the finished turn.
        if research_ctx is not None and research_ctx.plan_recorded:
            await writer.research_checkpoint(
                run_id=research_ctx.run_id, kind="complete", payload={}
            )

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
        # Feed the failure back into health so the ROUTER stops choosing this
        # model. Without this the router learns nothing from a hard provider
        # failure and re-picks the same dead model for the next user. Guarded:
        # health bookkeeping must never mask the original error.
        #
        # Recorded against the model that actually RAISED: after a failover every
        # later call goes to the failover model. Classification decides the state
        # and cooldown (a 400 marks nothing), and an error the graph already
        # recorded is not counted twice.
        try:
            model_health.record_exception(failover["model"] or model_id, e)
        except Exception as he:  # bookkeeping must never shadow the real failure
            log.warning("router.health_feedback_failed", extra={"error": str(he)[:120]})
        error = error or {
            "code": (
                ERR_QUOTA
                if is_quota_error(e)
                else ERR_PROVIDER
                if _is_provider_error(e)
                else ERR_INTERNAL
            ),
            "message": "The model could not complete this response",
            "retryable": True,
        }
    finally:
        if hb_task is not None:
            hb_task.cancel()
        # Phase 5: release the turn's MCP sessions back to the pool. Shielded the
        # same way the finalize is — a cancellation that unwound the turn must not
        # also skip the release, or the pool leaks a borrow per cancelled turn.
        # Exiting here means the SAME TASK that entered the stack exits it, which
        # is the anyio cancel-scope rule the whole session-actor design exists for.
        with contextlib.suppress(Exception):
            await asyncio.shield(mcp_stack.aclose())
        if status == "done":
            # A real answer is the strongest health evidence there is, and it
            # spares the background probe a request.
            with contextlib.suppress(Exception):
                model_health.record_success(failover["model"] or model_id)
        log.info(
            "generation_finished",
            extra={
                "stream_id": req.streamId,
                "thread_id": req.threadId,
                "user_id": req.userId,
                # The model that ACTUALLY ran, not the pre-dispatch fallback.
                # This line is the per-turn telemetry every latency question is
                # answered from, so reporting req.model here made per-model
                # analysis quietly wrong once the router could move off it.
                # On a capacity failover that is the failover model;
                # `routed_model` keeps the router's choice.
                "model": failover["model"] or model_id,
                "routed_model": model_id,
                "requested_model": req.model,
                "routed_reason": route.reason,
                "status": status,
                "attempt": req.attempt,
                "chars_out": writer.stats.chars,
                "flushes": writer.stats.flushes,
                "events": writer.stats.events,
                "event_posts": writer.stats.event_posts,
                # prep_ms is OURS (everything before the first model call);
                # ttft_ms - prep_ms is the provider's plus any tool work. `steps`
                # is model<->executor round-trips, the serial cost of a turn and
                # the thing to watch now that the step ceiling is off.
                "prep_ms": round(prep_ms) if prep_ms is not None else None,
                "steps": tools_ctx.step_counter if tools_ctx is not None else 0,
                "dropped": writer.stats.dropped,
                "ttft_ms": writer.stats.first_flush_ms,
                "total_ms": round((time.monotonic() - started) * 1000),
            },
        )
        # Phase 1 (v2): fold batch sub-agent tokens into the turn's reported usage
        # (they never pass through the top model stream that fills `usage`).
        if (
            settings.ai_runtime_v2_enabled
            and tools_ctx is not None
            and tools_ctx.delegated_usage.get("tokens")
        ):
            usage = usage or {"promptTokens": 0, "completionTokens": 0}
            usage["completionTokens"] += int(tools_ctx.delegated_usage["tokens"])
        # Phase 8: a suspended turn's durable park is already recorded; a
        # finalize here would drive waiting_approval -> done and destroy it. Skip
        # the terminal write. (Guarded, not `return`-in-finally, which would
        # silence an in-flight exception.)
        # THE BACKSTOP. Assess the answer that was actually produced against the
        # requirements that were actually asked for, and append the shortfall.
        # System-authored from recorded state, so a model claiming "all ten are
        # complete" changes nothing. Pushed BEFORE finalize so it lands in the
        # same message; a clean turn renders nothing at all.
        # Also runs on a DEADLINE. `deadline_exceeded` is already in Convex's
        # RESUMABLE_ERROR_CODES, so completed executions survive and a retry
        # continues rather than restarting — but the user was told only "took too
        # long". Reporting which requirements are still outstanding is what turns
        # that from a dead end into a checkpoint.
        _deadline_hit = status == "error" and (error or {}).get("code") == ERR_DEADLINE
        if ledger is not None and (status == "done" or _deadline_hit):
            with contextlib.suppress(Exception):  # never fail a finished turn
                ledger.stopped_early = _deadline_hit
                ledger.note_output_truncated(finish_reason)
                ledger.assess(writer.text or "")
                report = ledger.render_report()
                if report:
                    await writer.push(report)
                log.info(
                    "agent.ledger_closed",
                    extra={
                        "stream_id": req.streamId,
                        "requirements": len(ledger.requirements),
                        "unaddressed": len(ledger.unaddressed),
                        "unverified": len(ledger.unverified),
                        "tools_failed": ledger.tools_failed,
                        "tools_truncated": ledger.tools_truncated,
                        "output_truncated": ledger.output_truncated,
                        "reported": bool(report),
                    },
                )
        elif status == "done" or _deadline_hit:
            # No ledger — a single-requirement turn, which is most of them. The two
            # facts that must never be silent still are: the answer was CUT OFF, or
            # retrieval came back empty. Measured: "write a 2,000-word article" is
            # one requirement, so it built no ledger and truncated mid-sentence
            # with nothing said about it.
            with contextlib.suppress(Exception):  # never fail a finished turn
                notice = render_standalone_notices(
                    output_truncated=(finish_reason or "").lower() == "length",
                    no_evidence=bool(getattr(writer, "search_returned_nothing", False)),
                )
                if notice:
                    await writer.push(notice)
        # CLAIM CHECK. Deliberately NOT gated on the ledger: "here is your
        # report.pdf" with no file behind it happens on the simplest turn there
        # is. System-authored from recorded state (ARTIFACT events, side-effecting
        # executions), appended before finalize so it lands in the same message.
        if status == "done" or _deadline_hit:
            with contextlib.suppress(Exception):  # never fail a finished turn
                correction = render_claim_correction(
                    writer.text or "",
                    artifacts=list(getattr(writer, "artifacts", []) or []),
                    external_tool_succeeded=bool(
                        getattr(writer, "external_action_succeeded", False)
                    ),
                )
                if correction:
                    await writer.push(correction)
                    log.info(
                        "agent.claim_corrected",
                        extra={
                            "stream_id": req.streamId,
                            "artifacts": len(getattr(writer, "artifacts", []) or []),
                        },
                    )
        if sec_state is not None and (status == "done" or _deadline_hit):
            with contextlib.suppress(Exception):  # never fail a finished turn
                _answered = failover["model"] or model_id
                _profile = router_cfg.profiles.get(_answered)
                await writer.push(
                    sec_state.render(
                        deadline=_deadline_hit,
                        answered_by=_answered,
                        tier=_profile.reasoning_tier if _profile else None,
                    )
                )
                _verdict, _why = sec_state.verdict(deadline=_deadline_hit)
                log.info(
                    "secaudit.report",
                    extra={
                        "stream_id": req.streamId,
                        "verdict": _verdict,
                        "why": _why[:5],
                        "model": _answered,
                        "local_access": sec_state.local_access,
                        "github_access": sec_state.github_access,
                        "files_read": sum(1 for r in sec_state.reads if r.path),
                        "stages": {
                            k: v.get("status") for k, v in sec_state.stages.items()
                        },
                        "findings": len(sec_state.findings),
                        "secrets": len(sec_state.secret_hits),
                        "denied": len(sec_state.denied_calls),
                        "fixes": [f.get("status") for f in sec_state.fixes],
                    },
                )
        if status != "suspended":
            # shield: the CancelledError that got us here must not also cancel the
            # write that records the cancellation.
            await asyncio.shield(
                writer.finalize(
                    "error" if status == "error" else status,
                    usage=usage,
                    finish_reason=finish_reason,
                    error=error,
                    # The humanize stage's rejected rewrite: save the draft.
                    text=humanized["final_text"],
                )
            )
            # Rolling summary — the compaction half of context management, and
            # the producer that was never built for the `op: "summary"` route
            # that has always existed. AFTER finalize and fire-and-forget, so it
            # cannot delay a reply; it swallows its own failures, so it cannot
            # fail a turn that already succeeded. Only on a completed turn: a
            # cancelled or errored turn has no new state worth recording.
            # An UNATTENDED run carries exactly its own prompt by design (history
            # is capped at 1) and dispatch sends it no conversationContext, so
            # anything registered here could never be read back. Skip it rather
            # than accumulate rows nothing will ever resolve against.
            if status == "done" and not req.unattended:
                # Composer chips. FIRST in this block on purpose: it is a
                # create_task, so starting it here lets the model call overlap
                # the awaited context_state write below instead of queueing
                # behind it — the only latency the user actually waits on.
                # Unattended runs are already excluded: nobody is watching a
                # scheduled run's composer.
                suggestions.schedule(
                    settings=settings,
                    convex=convex,
                    stream_id=req.streamId,
                    history=req.history,
                    final_text=writer.text,
                )
                # THE ARTIFACT FLOOR. Derived from the turn the application
                # just produced, and written whether or not the model called
                # anything — because a registration that depended on model
                # cooperation would leave the NEXT turn with nothing to
                # resolve against, which is the original bug in a new hat.
                #
                # Swallowed on failure: context is worth degrading, never
                # worth failing a turn that already succeeded.
                try:
                    derived = derive_artifact(
                        operation=(turn_operation or ANSWER),
                        final_text=writer.text,
                        ctx=req.conversationContext,
                        resolution=compiled.resolution if compiled else None,
                        fallback_subject=latest.content[:120],
                    )
                    if derived is not None:
                        await convex.register_artifact(
                            stream_id=req.streamId,
                            kind=derived.kind,
                            subject=derived.subject,
                            supersedes_artifact_id=derived.supersedes_artifact_id,
                        )
                    # Enrichment rides the SAME write as the floor. Each list is
                    # sent only when the model actually contributed something —
                    # an absent field leaves the stored value standing, so a turn
                    # that says nothing cannot erase a constraint set earlier.
                    await convex.context_state(
                        stream_id=req.streamId,
                        through_seq=max((h.seq for h in req.history), default=0),
                        operation=(turn_operation or ANSWER),
                        active_subject=(
                            derived.subject if derived is not None else None
                        ),
                        user_constraints=(
                            conversation_state.constraints
                            if conversation_state.constraints
                            else None
                        ),
                        user_decisions=(
                            conversation_state.decisions
                            if conversation_state.decisions
                            else None
                        ),
                        open_loops=(
                            conversation_state.open_loops
                            if conversation_state.open_loops
                            else None
                        ),
                    )
                except Exception:  # noqa: BLE001 - never fail a finished turn
                    log.warning(
                        "context_persist_skipped",
                        extra={"stream_id": req.streamId},
                    )
                compaction.schedule(
                    settings=settings,
                    convex=convex,
                    stream_id=req.streamId,
                    history=req.history,
                    final_text=writer.text,
                    summary_through_seq=req.summaryThroughSeq,
                )


async def _deliver_writing(
    writer: DeltaWriter,
    settings: Settings,
    *,
    draft: str,
    register: str,
    request: str,
    model: str,
    context_window: int,
    stream_id: str,
) -> tuple[str | None, tuple[int, int] | None]:
    """Run the humanize stage on a buffered writing deliverable and stream the
    result. Returns (text to SAVE instead of the stream, or None; rewrite usage).

    The user always receives an answer: every failure path delivers the draft.
    """
    t0 = time.monotonic()
    record: dict = {"stream_id": stream_id, "model": model, "register": register}
    sample = humanize_stage.writing_sample(request)
    keywords = humanize_stage.required_keywords(request)
    try:
        assessment = await asyncio.to_thread(
            humanize_stage.assess, draft, register=register, sample=sample
        )
    except Exception as e:  # noqa: BLE001 — never lose the answer to a measurement
        record.update(decision="assess_failed", error=type(e).__name__)
        log.warning("writing.humanize", extra=record)
        await writer.push(draft)
        return None, None
    record.update(
        decision=assessment.decision,
        words=assessment.words,
        score_before=assessment.score,
        findings=len(assessment.findings),
        keywords=len(keywords),
        sample=bool(sample),
    )
    # A rewrite must fit the output ceiling or it is cut off mid-article.
    budget = int(settings.ai_max_output_tokens)
    if assessment.revise and assessment.words * 1.5 > budget * 0.8:
        record["decision"] = "too_long"
    if record["decision"] != "revise":
        await writer.push(draft)
        log.info("writing.humanize", extra=record)
        return None, None
    # Nothing has streamed during the hidden draft, so a Stop pressed then is only
    # learned from a heartbeat. Ask once before paying for a rewrite.
    with contextlib.suppress(Exception):
        await writer.heartbeat()
    if writer.cancel_requested:
        record["decision"] = "cancelled"
        log.info("writing.humanize", extra=record)
        return None, None

    rewriter = build_llm(
        settings,
        model=model,
        context_window=context_window,
        max_tokens=budget,
        base_url=settings.ollima_base_url,
        api_key=settings.ollima_api_key,
    )
    messages = humanize_stage.rewrite_messages(
        assessment, keywords=keywords, sample=sample
    )
    parts: list[str] = []  # as the model wrote it, protected-span tokens included
    shown = humanize_stage.PlaceholderStream(assessment.slots)
    usage = [0, 0]
    truncated = False
    try:
        async with aclosing(rewriter.astream(messages)) as stream:
            async for chunk in stream:
                text = _chunk_text(chunk)
                if text:
                    parts.append(text)
                    visible = shown.feed(text)
                    if visible:
                        await writer.push(visible)
                meta = getattr(chunk, "usage_metadata", None) or {}
                usage[0] += meta.get("input_tokens") or 0
                usage[1] += meta.get("output_tokens") or 0
                resp = getattr(chunk, "response_metadata", None) or {}
                if resp.get("finish_reason") == "length":
                    truncated = True
                if writer.cancel_requested:
                    record["decision"] = "cancelled"
                    log.info("writing.humanize", extra=record)
                    return None, (usage[0], usage[1])
    except Exception as e:  # noqa: BLE001 — the draft is always deliverable
        with contextlib.suppress(Exception):
            model_health.record_exception(model, e)
        record.update(
            decision="rewrite_failed",
            error=type(e).__name__,
            rewrite_ms=round((time.monotonic() - t0) * 1000),
        )
        log.warning("writing.humanize", extra=record)
        if not parts:
            await writer.push(draft)
            return None, (usage[0], usage[1])
        return draft, (usage[0], usage[1])

    rest = shown.flush()
    if rest:
        await writer.push(rest)
    rewrite = "".join(parts)
    acceptance = await asyncio.to_thread(
        humanize_stage.accept,
        assessment,
        rewrite,
        keywords=keywords,
        sample=sample,
        truncated=truncated,
    )
    record.update(
        decision="rewritten" if acceptance.ok else "rejected",
        reason=acceptance.reason,
        score_after=acceptance.score_after,
        lost={k: len(v) for k, v in acceptance.lost.items()},
        added=len(acceptance.added),
        rewrite_ms=round((time.monotonic() - t0) * 1000),
    )
    log.info("writing.humanize", extra=record)
    return (None if acceptance.ok else draft), (usage[0], usage[1])


def _fastest_healthy_model(cfg: RouterConfig, candidates) -> str:
    """The profiled candidate with the lowest time-to-first-token that the health
    registry currently allows, or "" when there is none."""
    live = [
        c.id
        for c in candidates
        if c.id in cfg.profiles and not model_health.is_exhausted(c.id)
    ]
    return min(live, key=lambda m: cfg.profiles[m].ttft_s) if live else ""


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

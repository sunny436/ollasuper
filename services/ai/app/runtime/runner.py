"""Drives one generation: graph -> writer -> Convex."""

from __future__ import annotations

import asyncio
import time
from contextlib import aclosing

import httpx
from langchain_core.messages import HumanMessage
from sqlalchemy.ext.asyncio import AsyncEngine

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
)
from app.agent.graph import build_graph
from app.agent.knowledge import KNOWLEDGE_TOOL_NAME, KNOWLEDGE_TOOL_SPEC
from app.agent.llm import build_llm
from app.agent.memory import (
    MEMORY_SEARCH_TOOL_NAME,
    MEMORY_SEARCH_TOOL_SPEC,
    REMEMBER_TOOL_NAME,
    REMEMBER_TOOL_SPEC,
)
from app.agent.policy import READ_SCOPE
from app.clients.attachments import AttachmentError, build_user_content
from app.clients.convex import ConvexClient, ConvexUnavailable
from app.clients.ollagraph import OllagraphAdapter
from app.config import Settings
from app.ingest.retrieve import render_rag_block, retrieve_context
from app.logging import get_logger
from app.models.chat import GenerateRequest
from app.models.tools import SideEffect, ToolFilters
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
    writer = DeltaWriter(convex, req.streamId, settings)
    status = "error"
    usage: dict | None = None
    finish_reason: str | None = None
    error: dict | None = None
    started = time.monotonic()

    try:
        # --- assemble ------------------------------------------------------
        history = list(req.history)
        latest = history.pop() if history and history[-1].role == "user" else None
        if latest is None:
            raise ValueError("no user message to respond to")

        # Bound the newest turn BEFORE assembling it. trim() below only bounds
        # `prior`; the latest turn is where every user-controlled byte lives, so
        # leaving it unbounded means the token budget controls the wrong half of
        # the request. See Settings.ai_max_turn_chars.
        if len(latest.content) > settings.ai_max_turn_chars:
            latest = latest.model_copy(
                update={"content": latest.content[: settings.ai_max_turn_chars]}
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
                latest, convex, settings, model=req.model, stream_id=req.streamId
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

        # RAG DISPLACES history 1:1 against the budget (it does not add on top),
        # so the per-turn cost ceiling and the rolling summary both hold.
        rag_reserve = int(rag_tokens * settings.ai_token_safety_factor)
        prior = trim(
            to_lc_messages(history),
            model=req.model,
            n_images=n_images,
            max_output=settings.ai_max_output_tokens,
            base_budget=settings.ai_context_budget_tokens - rag_reserve,
            safety_factor=settings.ai_token_safety_factor,
            context_window=req.contextWindow,
        )

        system = build_system_prompt(
            custom=req.systemPrompt,
            about=req.customInstructionsAbout,
            style=req.customInstructionsStyle,
            summary=req.summary,
            summary_through_seq=req.summaryThroughSeq,
            rag=rag_text,
        )

        # User chat -> Ollima (title-gen + OCR keep build_llm's OpenRouter default).
        llm = build_llm(
            settings,
            model=req.model,
            context_window=req.contextWindow,
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
        web_active = (
            settings.agent_enabled
            and tool_registry is not None
            and tool_selector is not None
            and ollagraph_http is not None
            and tool_registry.count > 0
        )
        if web_active:
            try:
                candidates = tool_selector.select(
                    latest.content,
                    top_k=settings.ai_agent_discovery_top_k,
                    filters=ToolFilters(max_side_effect=SideEffect.READ_ONLY),
                    min_score=settings.tool_discovery_min_score,
                ).candidates
                if candidates:
                    web_specs, name_to_id = build_tool_specs(
                        candidates,
                        tool_registry,
                        reserved={
                            KNOWLEDGE_TOOL_NAME,
                            MEMORY_SEARCH_TOOL_NAME,
                            REMEMBER_TOOL_NAME,
                        },
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
            if req.memories:  # only bind recall when there is something to recall
                specs.append(MEMORY_SEARCH_TOOL_SPEC)
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

        llm_tools = None
        tools_ctx = None
        if specs:
            try:
                llm_tools = llm.bind_tools(specs)
            except Exception:  # noqa: BLE001 — a bad web spec must not kill RAG/memory
                log.warning(
                    "agent_tools_bind_failed", extra={"stream_id": req.streamId}
                )
                llm_tools = None
                if reserved_specs:
                    try:
                        llm_tools = llm.bind_tools(reserved_specs)
                        name_to_id, adapter = {}, None
                    except Exception:  # noqa: BLE001
                        llm_tools = None
            if llm_tools is not None:
                tools_ctx = ToolExecContext(
                    registry=tool_registry,
                    adapter=adapter,
                    writer=writer,
                    scope=READ_SCOPE,
                    name_to_tool_id=name_to_id,
                    result_max_chars=settings.ai_agent_tool_result_max_chars,
                    default_timeout_s=settings.ollagraph_default_tool_timeout_s,
                    rag=rag_ctx,
                    memory=mem_ctx,
                )

        graph = build_graph(llm, llm_tools=llm_tools, tools_ctx=tools_ctx)

        state = {
            "messages": [*prior, HumanMessage(content=content)],
            "system_prompt": system,
        }
        if tools_ctx is not None:
            state["tool_budget"] = settings.ai_agent_max_steps

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
        async with aclosing(graph.astream(state, stream_mode="messages")) as stream:
            async for chunk, metadata in stream:
                # Only the model node's output is user-visible. Tool nodes added
                # later stream through here too and must not reach the transcript.
                if metadata.get("langgraph_node") != "model":
                    continue

                text = _chunk_text(chunk)
                if text:
                    await writer.push(text)

                meta_usage = getattr(chunk, "usage_metadata", None)
                if meta_usage:
                    usage = {
                        "promptTokens": meta_usage.get("input_tokens"),
                        "completionTokens": meta_usage.get("output_tokens"),
                    }
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
        status = "done"

    except asyncio.CancelledError:
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
        log.info(
            "generation_finished",
            extra={
                "stream_id": req.streamId,
                "thread_id": req.threadId,
                "user_id": req.userId,
                "model": req.model,
                "status": status,
                "chars_out": writer.stats.chars,
                "flushes": writer.stats.flushes,
                "dropped": writer.stats.dropped,
                "ttft_ms": writer.stats.first_flush_ms,
                "total_ms": round((time.monotonic() - started) * 1000),
            },
        )
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

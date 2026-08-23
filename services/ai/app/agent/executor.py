"""Policy-gated tool executor (Phase 4).

The ONE place a discovered tool actually runs. It sits between the model's
tool_call and the Phase-1 adapter, and it is where every Phase-4 safety
invariant is enforced OUTSIDE the model:

  * every tool_call is re-resolved against the registry (a hallucinated name
    that the model invented is unknown -> safe error, never a blind HTTP call);
  * `check_tool_policy` decides allow / needs-approval / deny from metadata;
  * only ALLOW reaches `OllagraphAdapter.call_tool` (the sole path to Ollagraph),
    with a per-tool timeout and cancellation checked before each call;
  * results are bounded before they re-enter the context;
  * Phase-3 events (TOOL_CALL / TOOL_RESULT / APPROVAL_REQUEST) narrate it.

Pairing lock (load-bearing): OpenAI 400s if the assistant tool_calls message is
followed by the model WITHOUT a tool response for EVERY tool_call id. So this
returns exactly one ToolMessage per tool_call, with a matching `tool_call_id`,
on every branch — deny, approval, duplicate, unknown, validation-fail, error,
success. Nothing here streams as user-visible text (the runner only forwards the
`model` node), so no chain-of-thought is exposed.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from langchain_core.messages import ToolMessage

from app.agent.knowledge import KNOWLEDGE_TOOL_NAME, retrieve_knowledge
from app.agent.memory import (
    MEMORY_SEARCH_TOOL_NAME,
    REMEMBER_TOOL_NAME,
    clean_remember_args,
    select_memories,
)
from app.agent.policy import PolicyScope, check_tool_policy
from app.clients.ollagraph import OllagraphAdapter
from app.logging import get_logger
from app.models.events import EventType
from app.models.tools import ToolCandidate
from app.runtime.writer import DeltaWriter
from app.tools.errors import ToolError
from app.tools.registry import ToolRegistry

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncEngine

    from app.config import Settings

log = get_logger(__name__)

# OpenAI function names must match this; sanitize tool_ids into it.
_NAME_OK = re.compile(r"[^a-zA-Z0-9_-]")


@dataclass(slots=True)
class RagContext:
    """Phase 5: the authenticated scope + engine for the `search_knowledge` tool.
    `user_id` is the HARD retrieval boundary and comes from the authenticated
    request, never the model. No `workspace_id`: `file_chunks` has no such column,
    so it would be inert (workspace scoping is deferred)."""

    engine: AsyncEngine
    user_id: str
    settings: Settings
    file_ids: list[str] | None = None


@dataclass(slots=True)
class MemoryContext:
    """Phase 6: the pre-loaded, scope-authorized memory pool + settings for the
    `search_memory`/`remember` tools. `memories` was derived server-side from the
    stream's userId (dispatchPayload), so the tools never read identity from the
    model — search only ranks this pool; the write's ownership is enforced by
    Convex from the streamId capability."""

    memories: list  # list[MemoryItem]
    settings: Settings


@dataclass(slots=True)
class ToolExecContext:
    """Everything the executor node needs, captured per generation. Built in the
    runner only when the agent is enabled and candidates exist."""

    # Optional so a RAG-only turn (no Ollagraph configured) still works: the
    # Ollagraph path is guarded on `registry is None`.
    registry: ToolRegistry | None
    adapter: OllagraphAdapter | None
    writer: DeltaWriter
    scope: PolicyScope
    # OpenAI-legal bound name -> real tool_id (the model calls by bound name).
    name_to_tool_id: dict[str, str]
    result_max_chars: int
    default_timeout_s: float
    # Per-generation duplicate guard: (tool_id, canonical-args) already executed.
    seen_calls: dict[str, str] = field(default_factory=dict)
    # Phase 5: set when the `search_knowledge` RAG tool is bound this turn.
    rag: RagContext | None = None
    # Phase 6: set when the memory tools (search_memory/remember) are bound.
    memory: MemoryContext | None = None


# --- OpenAI function-spec construction (runner-side) ----------------------
def _sanitize_name(tool_id: str, used: set[str]) -> str | None:
    name = _NAME_OK.sub("_", tool_id)[:64].strip("_")
    if not name:
        return None
    if name in used:
        for i in range(2, 100):
            cand = f"{name[:60]}_{i}"
            if cand not in used:
                name = cand
                break
        else:
            return None
    used.add(name)
    return name


def _deref_schema(
    schema: object, components: dict, seen: frozenset[str] = frozenset()
) -> object:
    """Fully dereference `#/components/schemas/*` refs (nested included), cycle-
    guarded. `registry.resolve_schema` only follows the TOP-LEVEL ref; the model
    needs a self-contained schema, so a leftover nested ref would be a dangling
    pointer. On a cycle collapse to a bare object rather than loop."""
    if isinstance(schema, dict):
        ref = schema.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
            name = ref.rsplit("/", 1)[-1]
            if name in seen:
                return {"type": "object"}
            return _deref_schema(components.get(name, {}), components, seen | {name})
        return {
            k: _deref_schema(v, components, seen)
            for k, v in schema.items()
            if k != "$ref"
        }
    if isinstance(schema, list):
        return [_deref_schema(v, components, seen) for v in schema]
    return schema


def build_tool_specs(
    candidates: list[ToolCandidate],
    registry: ToolRegistry,
    *,
    reserved: set[str] | None = None,
) -> tuple[list[dict], dict[str, str]]:
    """Turn discovered candidates into OpenAI function specs + a name->tool_id
    map. Never raises: a tool whose schema will not dereference degrades to an
    empty object schema rather than dropping the tool. `reserved` seeds the used
    names so a discovered tool can never claim a reserved name (e.g. the Phase-5
    `search_knowledge` RAG tool) — a collider is renamed instead."""
    specs: list[dict] = []
    name_to_tool_id: dict[str, str] = {}
    used: set[str] = set(reserved or ())
    components = registry.components or {}
    for cand in candidates:
        tool = cand.tool
        name = _sanitize_name(tool.tool_id, used)
        if name is None:
            continue
        try:
            resolved = _deref_schema(tool.input_schema or {}, components)
        except Exception:  # noqa: BLE001 — a bad schema must not break the turn
            resolved = {"type": "object"}
        if not isinstance(resolved, dict) or resolved.get("type") != "object":
            resolved = {"type": "object", "properties": {}}
        specs.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": (tool.description or tool.name)[:1024],
                    "parameters": resolved,
                },
            }
        )
        name_to_tool_id[name] = tool.tool_id
    return specs, name_to_tool_id


# --- execution ------------------------------------------------------------
def _bounded(data: object, cap: int) -> tuple[dict, bool]:
    """Serialize + bound a tool result for re-entry into the context. Returns
    (payload, truncated). The payload is always a dict so ToolResult.result and
    the ToolMessage carry a stable shape."""
    try:
        text = json.dumps(data, ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001
        text = str(data)
    if len(text) > cap:
        return {"result": text[:cap], "truncated": True}, True
    return {"result": data if isinstance(data, (dict, list)) else text}, False


def _tool_message(call_id: str, body: dict, *, status: str) -> ToolMessage:
    return ToolMessage(
        content=json.dumps(body, ensure_ascii=False, default=str),
        tool_call_id=call_id,
        status=status,
    )


async def _run_one(tc: dict, ctx: ToolExecContext, index: int) -> ToolMessage:
    """Process ONE tool_call end-to-end and ALWAYS return a paired ToolMessage."""
    call_id = tc.get("id") or f"call_{index}"
    bound_name = tc.get("name") or ""
    args = tc.get("args") if isinstance(tc.get("args"), dict) else {}

    # Phase 5: the reserved knowledge tool is not a registry tool — route it
    # BEFORE registry.get (which would report it as "unknown").
    if ctx.rag is not None and bound_name == KNOWLEDGE_TOOL_NAME:
        return await _run_knowledge(ctx, call_id, args)

    # Phase 6: the reserved memory tools, likewise routed before registry.get.
    if ctx.memory is not None and bound_name == MEMORY_SEARCH_TOOL_NAME:
        return await _run_memory_search(ctx, call_id, args)
    if ctx.memory is not None and bound_name == REMEMBER_TOOL_NAME:
        return await _run_remember(ctx, call_id, args)

    # Tools-only turn (no registry/Ollagraph): any unmatched tool is unknown.
    if ctx.registry is None:
        await ctx.writer.emit_event(
            EventType.TOOL_RESULT,
            call_id=call_id,
            status="error",
            result={"error": "unknown tool"},
        )
        return _tool_message(
            call_id, {"error": f"unknown tool: {bound_name}"}, status="error"
        )

    tool_id = ctx.name_to_tool_id.get(bound_name, bound_name)

    tool = ctx.registry.get(tool_id)
    if tool is None:
        await ctx.writer.emit_event(
            EventType.TOOL_RESULT,
            call_id=call_id,
            status="error",
            result={"error": "unknown tool"},
        )
        return _tool_message(
            call_id, {"error": f"unknown tool: {bound_name}"}, status="error"
        )

    # Duplicate (tool, args) within this turn: do not re-execute (a cheap loop
    # guard on top of the step cap). Still pairs the tool_call.
    dedup_key = json.dumps(args, sort_keys=True, default=str)
    if ctx.seen_calls.get(tool_id) == dedup_key:
        return _tool_message(
            call_id,
            {"note": "duplicate call skipped; see the previous result"},
            status="error",
        )
    ctx.seen_calls[tool_id] = dedup_key

    decision = check_tool_policy(tool, ctx.scope)
    if decision.needs_approval:
        await ctx.writer.emit_event(
            EventType.APPROVAL_REQUEST,
            approval_id=call_id,
            tool_name=tool.name,
            reason=decision.reason,
            status="pending",
        )
        return _tool_message(
            call_id,
            {"status": "approval_required", "reason": decision.reason},
            status="error",
        )
    if decision.denied:
        return _tool_message(
            call_id,
            {"error": "not permitted", "reason": decision.reason},
            status="error",
        )

    # ALLOW. Resolve the schema (top-level ref) for shallow validation, announce
    # the call, then execute through the sole adapter path with a bounded timeout.
    input_schema = ctx.registry.resolve_schema(tool.input_schema or {})
    await ctx.writer.emit_event(
        EventType.TOOL_CALL,
        tool_name=tool.name,
        call_id=call_id,
        arguments=args,
        status="running",
    )
    timeout = tool.timeout or ctx.default_timeout_s
    try:
        result = await asyncio.wait_for(
            ctx.adapter.call_tool(tool, args, input_schema=input_schema),
            timeout=timeout,
        )
    except TimeoutError:
        await ctx.writer.emit_event(
            EventType.TOOL_RESULT,
            call_id=call_id,
            status="error",
            result={"error": "timeout"},
        )
        return _tool_message(call_id, {"error": "tool timed out"}, status="error")
    except ToolError as e:
        # Safe, provider-text-free failure shape (ToolError.as_dict()).
        await ctx.writer.emit_event(
            EventType.TOOL_RESULT, call_id=call_id, status="error", result=e.as_dict()
        )
        return _tool_message(call_id, e.as_dict(), status="error")

    body, truncated = _bounded(result.get("data"), ctx.result_max_chars)
    await ctx.writer.emit_event(
        EventType.TOOL_RESULT, call_id=call_id, status="success", result=body
    )
    if truncated:
        log.info(
            "agent.tool_result_truncated",
            extra={"tool_id": tool_id, "cap": ctx.result_max_chars},
        )
    return _tool_message(call_id, body, status="success")


async def _run_knowledge(ctx: ToolExecContext, call_id: str, args: dict) -> ToolMessage:
    """The Phase-5 RAG branch: reuse the EXISTING retrieval as an agent-decided
    capability. Security: `user_id` comes from `ctx.rag` (authenticated), never
    from `args`, so a model-supplied user_id/workspace cannot change scope."""
    rag = ctx.rag
    assert rag is not None  # guarded by the caller
    query = args.get("query")
    if not isinstance(query, str) or not query.strip():
        return _tool_message(
            call_id, {"status": "error", "message": "query is required"}, status="error"
        )

    # Duplicate guard on the shared seen_calls, keyed on the reserved name.
    dedup_key = json.dumps({"query": query}, sort_keys=True, default=str)
    if ctx.seen_calls.get(KNOWLEDGE_TOOL_NAME) == dedup_key:
        return _tool_message(
            call_id,
            {"note": "duplicate call skipped; see the previous result"},
            status="error",
        )
    ctx.seen_calls[KNOWLEDGE_TOOL_NAME] = dedup_key

    await ctx.writer.emit_event(
        EventType.TOOL_CALL,
        tool_name=KNOWLEDGE_TOOL_NAME,
        call_id=call_id,
        arguments={"query": query},
        status="running",
    )
    try:
        result = await asyncio.wait_for(
            retrieve_knowledge(
                rag.settings,
                rag.engine,
                user_id=rag.user_id,
                query=query,
                file_ids=rag.file_ids,
            ),
            timeout=rag.settings.ai_rag_deadline_ms / 1000,
        )
    except TimeoutError:
        await ctx.writer.emit_event(
            EventType.TOOL_RESULT,
            call_id=call_id,
            status="error",
            result={"error": "timeout"},
        )
        return _tool_message(
            call_id,
            {"status": "timeout", "message": "Knowledge search timed out."},
            status="error",
        )
    except Exception:  # noqa: BLE001 — never surface raw DB/provider text
        log.exception("agent.knowledge_failed")
        await ctx.writer.emit_event(
            EventType.TOOL_RESULT,
            call_id=call_id,
            status="error",
            result={"error": "unavailable"},
        )
        return _tool_message(
            call_id,
            {
                "status": "error",
                "message": "Knowledge search is temporarily unavailable.",
            },
            status="error",
        )

    if result.status == "no_results":
        # Authoritative "not in your files" (success, NOT error) so the model does
        # not retry and does not fabricate a source. No CITATION on empty.
        await ctx.writer.emit_event(
            EventType.TOOL_RESULT,
            call_id=call_id,
            status="success",
            result={"n_results": 0},
        )
        return _tool_message(
            call_id,
            {
                "status": "no_results",
                "message": "No matching passages were found in your documents.",
            },
            status="success",
        )

    # One CITATION per DISTINCT retrieved file (honesty: only retrieved sources).
    seen_files: set[str] = set()
    files_summary: list[dict] = []
    for ch in result.chunks:
        if ch.file_id in seen_files:
            continue
        seen_files.add(ch.file_id)
        title = f"{ch.filename} p.{ch.page}" if ch.page else ch.filename
        await ctx.writer.emit_event(
            EventType.CITATION,
            source_id=ch.file_id,
            title=title,
            metadata={"page": ch.page, "distance": ch.distance},
        )
        files_summary.append(
            {"file_id": ch.file_id, "filename": ch.filename, "page": ch.page}
        )

    await ctx.writer.emit_event(
        EventType.TOOL_RESULT,
        call_id=call_id,
        status="success",
        result={"n_results": len(result.chunks), "files": files_summary},
    )
    # Block VERBATIM: already token-bounded + injection-framed by render_rag_block.
    # Must NOT pass through _bounded (would sever the closing </retrieved_context>).
    return ToolMessage(content=result.block, tool_call_id=call_id, status="success")


async def _run_memory_search(
    ctx: ToolExecContext, call_id: str, args: dict
) -> ToolMessage:
    """Phase 6: rank the pre-loaded memory pool in-Python (no DB, no identity
    from args) and return a bounded, injection-framed block verbatim."""
    mem = ctx.memory
    assert mem is not None  # guarded by the caller
    query = args.get("query")
    if not isinstance(query, str) or not query.strip():
        return _tool_message(
            call_id, {"status": "error", "message": "query is required"}, status="error"
        )

    dedup_key = json.dumps({"q": query}, sort_keys=True, default=str)
    if ctx.seen_calls.get(MEMORY_SEARCH_TOOL_NAME) == dedup_key:
        return _tool_message(
            call_id,
            {"note": "duplicate call skipped; see the previous result"},
            status="error",
        )
    ctx.seen_calls[MEMORY_SEARCH_TOOL_NAME] = dedup_key

    await ctx.writer.emit_event(
        EventType.TOOL_CALL,
        tool_name=MEMORY_SEARCH_TOOL_NAME,
        call_id=call_id,
        arguments={"query": query},
        status="running",
    )
    selection = select_memories(
        mem.memories, query, max_chars=mem.settings.ai_agent_tool_result_max_chars
    )
    if selection.status == "no_results":
        await ctx.writer.emit_event(
            EventType.TOOL_RESULT,
            call_id=call_id,
            status="success",
            result={"n_results": 0},
        )
        return _tool_message(
            call_id,
            {"status": "no_results", "message": "No relevant saved memories found."},
            status="success",
        )

    for m in selection.selected:
        await ctx.writer.emit_event(
            EventType.CITATION,
            source_id=f"memory:{m.id}",
            title=f"memory · {m.kind}",
            metadata={"kind": m.kind, "source": m.source},
        )
    await ctx.writer.emit_event(
        EventType.TOOL_RESULT,
        call_id=call_id,
        status="success",
        result={"n_results": len(selection.selected)},
    )
    return ToolMessage(content=selection.block, tool_call_id=call_id, status="success")


async def _run_remember(ctx: ToolExecContext, call_id: str, args: dict) -> ToolMessage:
    """Phase 6: propose a memory candidate. Convex validates + persists it (the
    LLM never writes a record); this only sanitizes args, dedups, and reports the
    server's verdict. A failed/rejected write surfaces as an error TOOL_RESULT so
    the agent does not claim it saved."""
    cleaned = clean_remember_args(args.get("content"), args.get("kind"))
    if cleaned is None:
        return _tool_message(
            call_id,
            {"status": "error", "message": "content is required"},
            status="error",
        )
    content, kind = cleaned

    dedup_key = json.dumps({"c": content, "k": kind}, sort_keys=True, default=str)
    if ctx.seen_calls.get(REMEMBER_TOOL_NAME) == dedup_key:
        return _tool_message(
            call_id, {"note": "duplicate call skipped"}, status="error"
        )
    ctx.seen_calls[REMEMBER_TOOL_NAME] = dedup_key

    await ctx.writer.emit_event(
        EventType.TOOL_CALL,
        tool_name=REMEMBER_TOOL_NAME,
        call_id=call_id,
        arguments={"kind": kind},  # content persists as the memory; not duplicated here
        status="running",
    )
    result = await ctx.writer.remember(content=content, kind=kind)
    if result.get("saved"):
        await ctx.writer.emit_event(
            EventType.ARTIFACT,
            artifact_id=str(result.get("id") or call_id),
            artifact_type="memory",
            metadata={"kind": kind},
        )
        await ctx.writer.emit_event(
            EventType.TOOL_RESULT,
            call_id=call_id,
            status="success",
            result={"saved": True, "kind": kind},
        )
        return _tool_message(
            call_id, {"status": "saved", "kind": kind}, status="success"
        )

    reason = result.get("reason") or "not_saved"
    await ctx.writer.emit_event(
        EventType.TOOL_RESULT,
        call_id=call_id,
        status="error",
        result={"saved": False, "reason": reason},
    )
    return _tool_message(
        call_id, {"status": "not_saved", "reason": reason}, status="error"
    )


async def execute_tool_calls(
    tool_calls: list[dict], ctx: ToolExecContext
) -> list[ToolMessage]:
    """Run every tool_call in one assistant message, in order, and return one
    ToolMessage per call (pairing lock). Cancellation is checked before each
    call: once the user has asked to stop, remaining calls are not executed but
    are still paired so the message list stays valid."""
    out: list[ToolMessage] = []
    for i, tc in enumerate(tool_calls):
        if ctx.writer.cancel_requested:
            call_id = tc.get("id") or f"call_{i}"
            out.append(
                _tool_message(call_id, {"status": "cancelled"}, status="error")
            )
            continue
        out.append(await _run_one(tc, ctx, i))
    return out

"""Agent knowledge capability (Phase 5) — the reusable RAG boundary.

Makes the EXISTING RAG a first-class capability the agent can DECIDE to invoke,
without rebuilding any of it. This module adds NO retrieval logic: it reuses
`retrieve_context` + `render_rag_block` (ingest/retrieve.py) verbatim and only
adapts them into a stable, bounded `RetrievalResult` plus the static tool spec
the model sees.

Security: the caller (the executor) passes the AUTHENTICATED `user_id`; this
module never reads identity from the model. `user_id` is the hard scope in the
underlying SQL; `file_ids` (optional) can only NARROW within that user's own
corpus — see app/db/store.py.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from app.ingest.retrieve import render_rag_block, retrieve_context

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncEngine

    from app.config import Settings

# The reserved bound-tool name. The executor routes this name to the RAG branch
# BEFORE the registry lookup, and the runner seeds it into build_tool_specs'
# reserved set so no discovered Ollagraph tool can ever claim it.
KNOWLEDGE_TOOL_NAME = "search_knowledge"

KNOWLEDGE_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": KNOWLEDGE_TOOL_NAME,
        "description": (
            "Search the USER'S OWN uploaded documents and files for passages "
            "relevant to their question. Use this whenever the user refers to "
            "their files, documents, PDFs, or previously uploaded material, or "
            "asks what one of their documents says. Do NOT use it for general "
            "knowledge or current web information."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Natural-language search query over the user's documents."
                    ),
                }
            },
            "required": ["query"],
        },
    },
}


@dataclass(slots=True)
class RetrievedChunk:
    file_id: str
    filename: str
    page: int | None
    section: str | None
    distance: float | None


@dataclass(slots=True)
class RetrievalResult:
    """Bounded, stable retrieval output. `block` is the render_rag_block string
    VERBATIM (already token-bounded + injection-framed) — it is what re-enters
    the model context; it must NOT be re-truncated. `chunks` carries the source
    metadata used to build citations."""

    block: str
    tokens: int
    chunks: list[RetrievedChunk] = field(default_factory=list)
    status: str = "no_results"  # "ok" | "no_results"


def _chunk_of(row: dict) -> RetrievedChunk:
    meta = row.get("source_metadata") or {}
    return RetrievedChunk(
        file_id=str(row.get("file_id") or ""),
        filename=str(meta.get("source") or "document"),
        page=row.get("page"),
        section=row.get("section"),
        distance=row.get("distance"),
    )


async def retrieve_knowledge(
    settings: Settings,
    engine: AsyncEngine | None,
    *,
    user_id: str,
    query: str,
    file_ids: list[str] | None = None,
) -> RetrievalResult:
    """Reuse the existing retrieval + rendering unchanged, returning a bounded,
    stable result. `user_id` is the hard scope enforced in SQL; `file_ids` only
    narrows within it. No deadline/try here — the executor owns those at the call
    seam (mirroring the adapter timeout), so this stays a pure coroutine."""
    rows = await retrieve_context(
        settings, engine, user_id=user_id, query=query, file_ids=file_ids
    )
    block, tokens = render_rag_block(rows, settings)
    if not block:
        return RetrievalResult(block="", tokens=0, chunks=[], status="no_results")
    return RetrievalResult(
        block=block,
        tokens=tokens,
        chunks=[_chunk_of(r) for r in rows],
        status="ok",
    )

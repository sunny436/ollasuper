"""Ingestion orchestrator.

fetch bytes -> detect -> guard -> parse (thread + timeout) -> chunk -> embed ->
persist (one txn) -> report status. Runs as a background task; NEVER raises to
the caller — every failure becomes a `failed` status callback so the file stays
visible + retryable and chat is untouched.
"""

from __future__ import annotations

import asyncio
import hashlib

from sqlalchemy.ext.asyncio import AsyncEngine

from app.clients.convex import ConvexClient
from app.config import Settings
from app.db import store
from app.ingest import embed as embedding
from app.ingest.chunk import chunk_docs
from app.ingest.detect import detect_type
from app.ingest.guards import guard_ooxml, safe_name
from app.ingest.ocr import ocr_image
from app.ingest.parsers import REGISTRY
from app.ingest.pdf import parse_pdf
from app.ingest.types import FileType, IngestError, NormalizedDoc
from app.logging import get_logger

log = get_logger(__name__)

_PARSER_NAMES: dict[str, str] = {
    "pdf": "pdfplumber",
    "docx": "python-docx",
    "pptx": "python-pptx",
    "xlsx": "openpyxl",
    "csv": "csv",
    "json": "json",
    "html": "trafilatura",
    "markdown": "text",
    "text": "text",
    "image": "ocr",
}


async def _parse(
    raw: bytes, file_type: FileType, name: str, settings: Settings
) -> list[NormalizedDoc]:
    if file_type == "image":
        return await ocr_image(raw, "image/png", name=name, settings=settings)
    if file_type == "pdf":
        # Digital text/tables (pdfplumber) + scanned-page vision OCR (pypdfium2).
        return await parse_pdf(raw, name=name, settings=settings)
    if file_type in ("docx", "xlsx", "pptx"):
        guard_ooxml(raw, settings)
    parser = REGISTRY.get(file_type)
    if parser is None:
        raise IngestError(f"no parser for {file_type}")
    try:
        # wait_for cancels the AWAIT, not the OS thread; acceptable because the
        # input is already byte-bounded, so a runaway thread is bounded too.
        return await asyncio.wait_for(
            asyncio.to_thread(parser, raw, name=name),
            timeout=settings.ai_ingest_parse_timeout_s,
        )
    except TimeoutError as e:
        raise IngestError("parsing timed out") from e


async def run_ingest(
    *,
    ingest_id: str,
    user_id: str,
    workspace_id: str,
    name: str,
    content_type: str,
    engine: AsyncEngine,
    convex: ConvexClient,
    settings: Settings,
) -> None:
    safe = safe_name(name)
    try:
        raw, _ = await convex.fetch_ingest_file(ingest_id)
        if len(raw) > settings.ai_max_attachment_bytes:
            raise IngestError("file too large")
        content_hash = hashlib.sha256(raw).hexdigest()
        file_type = detect_type(raw, content_type, safe)
        log.info(
            "ingest_detected",
            extra={"file": ingest_id, "type": file_type, "bytes": len(raw)},
        )

        docs = await _parse(raw, file_type, safe, settings)
        chunks = chunk_docs(docs, file_type, settings)
        page_count = max((d.page for d in docs if d.page), default=None)

        chunk_dicts: list[dict] = []
        if chunks:
            vectors = await embedding.embed_documents(
                settings, [c.content for c in chunks]
            )
            for c, vec in zip(chunks, vectors, strict=True):
                c.embedding = vec
            chunk_dicts = [
                {
                    "chunk_index": c.chunk_index,
                    "content": c.content,
                    "token_count": c.token_count,
                    "page": c.page,
                    "section": c.section,
                    "source_metadata": c.source_metadata,
                    "embedding": c.embedding,
                }
                for c in chunks
            ]

        parser_used = _PARSER_NAMES.get(file_type, file_type)
        await store.persist_ingest(
            engine,
            file_id=ingest_id,
            user_id=user_id,
            workspace_id=workspace_id,
            filename=safe,
            mime_type=content_type,
            detected_type=file_type,
            file_size=len(raw),
            content_hash=content_hash,
            parser_used=parser_used,
            page_count=page_count,
            raw_bytes=raw,
            chunks=chunk_dicts,
            embedding_model=settings.openrouter_embedding_model,
            embedding_dimensions=settings.embedding_dimensions,
        )
        await convex.set_file_status(
            ingest_id,
            "ready",
            chunk_count=len(chunk_dicts),
            parser_used=parser_used,
            page_count=page_count,
            detected_type=file_type,
            content_hash=content_hash,
        )
        log.info(
            "ingest_ready",
            extra={"file": ingest_id, "chunks": len(chunk_dicts)},
        )
    except IngestError as e:
        log.warning("ingest_failed", extra={"file": ingest_id, "error": str(e)})
        await _fail(convex, ingest_id, str(e))
    except Exception:  # noqa: BLE001 - any error becomes a `failed` status
        log.exception("ingest_error", extra={"file": ingest_id})
        await _fail(convex, ingest_id, "Ingestion failed")


async def _fail(convex: ConvexClient, ingest_id: str, error: str) -> None:
    try:
        await convex.set_file_status(ingest_id, "failed", error=error)
    except Exception:  # noqa: BLE001 - the stall reaper is the backstop
        log.exception("ingest_status_callback_failed", extra={"file": ingest_id})


async def delete_ingest(ingest_id: str, engine: AsyncEngine) -> bool:
    return await store.delete_by_id(engine, file_id=ingest_id)

"""Ingestion orchestrator.

fetch bytes -> validate -> detect -> parse -> chunk -> embed -> persist ->
report status. Runs as a background task; NEVER raises to the caller. Every
failure becomes a *stage-specific* `failed` status so the file stays visible +
retryable and chat is untouched, and every partial success reports a truthful
note. Emits coarse, throttled progress (op:"file-progress") so the UI can show
real stages without hammering the reactive files list.

Bounded parallelism lives in the stages themselves (embed.py: concurrent
batches; pdf.py: bounded OCR). This file times each stage, so the structured
logs double as the ingest benchmark.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncEngine

from app.clients.convex import ConvexClient
from app.config import Settings
from app.db import store
from app.ingest import embed as embedding
from app.ingest.chunk import chunk_docs_bounded
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


@dataclass
class _ParseOutcome:
    docs: list[NormalizedDoc]
    note: str | None = None


def _is_rate_limit(e: Exception) -> bool:
    code = getattr(e, "status_code", None) or getattr(e, "code", None)
    if code == 429:
        return True
    s = str(e).lower()
    return "429" in s or "rate limit" in s


async def _parse(
    raw: bytes, file_type: FileType, name: str, settings: Settings
) -> _ParseOutcome:
    if file_type == "image":
        try:
            docs = await asyncio.wait_for(
                ocr_image(raw, "image/png", name=name, settings=settings),
                timeout=settings.ai_ingest_ocr_timeout_s,
            )
        except TimeoutError as e:
            raise IngestError("OCR timed out") from e
        return _ParseOutcome(docs=docs)

    if file_type == "pdf":
        pdf = await parse_pdf(
            raw,
            name=name,
            settings=settings,
            deadline_s=settings.ai_ingest_overall_deadline_s,
        )
        note = None
        if pdf.truncated and pdf.ocr_total:
            note = (
                f"Large scanned PDF: OCR'd {pdf.ocr_done} of {pdf.ocr_total} "
                "image pages within the time budget."
            )
        return _ParseOutcome(docs=pdf.docs, note=note)

    if file_type in ("docx", "xlsx", "pptx"):
        guard_ooxml(raw, settings)
    parser = REGISTRY.get(file_type)
    if parser is None:
        raise IngestError(f"no parser for {file_type}")
    try:
        # wait_for cancels the AWAIT, not the OS thread; acceptable because the
        # registry parsers are byte-bounded (no per-page network work).
        docs = await asyncio.wait_for(
            asyncio.to_thread(parser, raw, name=name),
            timeout=settings.ai_ingest_parse_timeout_s,
        )
    except TimeoutError as e:
        raise IngestError("Parsing timed out") from e
    return _ParseOutcome(docs=docs)


def _progress_emitter(convex: ConvexClient, ingest_id: str, settings: Settings):
    """Coarse + throttled progress. Stage changes always flush; percentage
    updates coalesce to at most one per ai_ingest_progress_min_interval_ms."""
    state = {"stage": None, "last": 0.0}
    min_gap = settings.ai_ingest_progress_min_interval_ms / 1000.0

    async def emit(
        stage: str,
        *,
        pct: int | None = None,
        processed: int | None = None,
        total: int | None = None,
        message: str | None = None,
        force: bool = False,
    ) -> None:
        now = time.monotonic()
        changed = stage != state["stage"]
        if not (changed or force) and (now - state["last"]) < min_gap:
            return
        state["stage"] = stage
        state["last"] = now
        try:
            await convex.set_file_progress(
                ingest_id,
                stage=stage,
                progress=pct,
                processed_units=processed,
                total_units=total,
                message=message,
            )
        except Exception:  # noqa: BLE001,S110 - best-effort; status is the authority
            pass

    return emit


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
    t0 = time.monotonic()
    progress = _progress_emitter(convex, ingest_id, settings)
    try:
        await progress("processing", message="Processing file")
        raw, _ = await convex.fetch_ingest_file(ingest_id)
        if len(raw) > settings.ai_max_attachment_bytes:
            mb = len(raw) / (1024 * 1024)
            cap = settings.ai_max_attachment_bytes / (1024 * 1024)
            raise IngestError(f"File too large: {mb:.1f} MB (max {cap:.0f} MB)")
        content_hash = hashlib.sha256(raw).hexdigest()
        file_type = detect_type(raw, content_type, safe)
        log.info(
            "ingest_started",
            extra={"file": ingest_id, "format": file_type, "bytes": len(raw)},
        )

        # --- parse ---
        await progress("reading", message="Reading content")
        p0 = time.monotonic()
        try:
            outcome = await _parse(raw, file_type, safe, settings)
        except IngestError:
            raise
        except Exception as e:  # noqa: BLE001 - stage-specific label
            raise IngestError("Parsing failed") from e
        parse_ms = int((time.monotonic() - p0) * 1000)
        docs = outcome.docs
        log.info(
            "ingest_parse_complete",
            extra={"file": ingest_id, "docs": len(docs), "parse_ms": parse_ms},
        )

        # --- chunk ---
        await progress("chunking", message="Creating chunks")
        c0 = time.monotonic()
        chunks, chunk_truncated = chunk_docs_bounded(docs, file_type, settings)
        chunk_ms = int((time.monotonic() - c0) * 1000)
        page_count = max((d.page for d in docs if d.page), default=None)
        log.info(
            "ingest_chunked",
            extra={"file": ingest_id, "chunks": len(chunks), "chunk_ms": chunk_ms},
        )

        # --- embed (bounded-concurrent batches) ---
        chunk_dicts: list[dict] = []
        embed_ms = 0
        if chunks:
            n = len(chunks)
            await progress(
                "embedding", pct=0, processed=0, total=n, message="Creating embeddings"
            )

            async def _on_batch(done: int, total: int) -> None:
                await progress(
                    "embedding",
                    pct=int(done * 100 / total) if total else 100,
                    processed=done,
                    total=total,
                )

            e0 = time.monotonic()
            log.info("embedding_batch_started", extra={"file": ingest_id, "chunks": n})
            try:
                vectors = await embedding.embed_documents(
                    settings, [c.content for c in chunks], progress_cb=_on_batch
                )
            except Exception as e:  # noqa: BLE001 - stage-specific label
                msg = (
                    "Embedding rate limit exceeded"
                    if _is_rate_limit(e)
                    else "Embedding provider failed"
                )
                raise IngestError(msg) from e
            embed_ms = int((time.monotonic() - e0) * 1000)
            log.info(
                "embedding_batch_complete",
                extra={"file": ingest_id, "chunks": n, "embedding_ms": embed_ms},
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

        # --- persist (single idempotent multi-row txn) ---
        await progress("saving", message="Saving to knowledge", force=True)
        parser_used = _PARSER_NAMES.get(file_type, file_type)
        d0 = time.monotonic()
        log.info("knowledge_persist_started", extra={"file": ingest_id})
        try:
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
        except Exception as e:  # noqa: BLE001 - stage-specific label
            raise IngestError("Knowledge database write failed") from e
        db_ms = int((time.monotonic() - d0) * 1000)
        log.info(
            "knowledge_persist_complete", extra={"file": ingest_id, "db_ms": db_ms}
        )

        # --- truthful partial note (parse deadline and/or content cap) ---
        note_parts: list[str] = []
        if outcome.note:
            note_parts.append(outcome.note)
        if chunk_truncated:
            note_parts.append(
                f"Content limit reached: indexed the first {len(chunk_dicts)} chunks."
            )
        note = " ".join(note_parts) or None

        await convex.set_file_status(
            ingest_id,
            "ready",
            chunk_count=len(chunk_dicts),
            parser_used=parser_used,
            page_count=page_count,
            detected_type=file_type,
            content_hash=content_hash,
            note=note,
        )
        total_ms = int((time.monotonic() - t0) * 1000)
        log.info(
            "ingest_ready",
            extra={
                "file": ingest_id,
                "format": file_type,
                "bytes": len(raw),
                "chunk_count": len(chunk_dicts),
                "parse_ms": parse_ms,
                "chunk_ms": chunk_ms,
                "embedding_ms": embed_ms,
                "db_ms": db_ms,
                "duration_ms": total_ms,
                "partial": note is not None,
            },
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

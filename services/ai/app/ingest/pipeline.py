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
import json
import time
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncEngine

from app.clients.convex import ConvexClient, ConvexRejected, ConvexUnavailable
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
from app.ingest.xlsx_guard import XlsxRejected, parse_xlsx_guarded
from app.logging import get_logger
from app.sandbox import ops as sandbox_ops
from app.sandbox.harness import run_sandboxed

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


# The code generation that produced a file's chunks, recorded on its `files`
# row. Bump `parser` when extraction output changes, `chunker` when chunk
# boundaries change, `pipeline` for anything else that changes what is indexed
# (OCR engine, sanitising, limits). A file whose pipeline_version is below the
# current one is stale and can be re-dispatched (same ingestId, atomic replace).
PROCESSING_VERSIONS: dict[str, int] = {"parser": 1, "chunker": 1, "pipeline": 1}


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


async def _sanitize_image(raw: bytes, settings: Settings) -> bytes:
    """Decode + re-encode an uploaded image in the SANDBOX before OCR sees it.

    The OCR pool (ONNX Runtime) is a forked worker of this service; it used to
    receive the upload's raw bytes. It now receives only what the sandboxed
    decoder produced: an allowlisted format, under the 40-megapixel cap, scaled
    to the OCR long edge. A decompression bomb or a malformed header is refused
    here, in a secret-free child, with a message the user sees.
    """

    async def fallback() -> tuple[dict, bytes]:
        try:
            body, mime = await asyncio.to_thread(
                sandbox_ops.normalise_image, raw, "image/png", settings.ai_ocr_long_edge
            )
        except sandbox_ops.DecodeError as e:
            return {"ok": False, "error": str(e)}, b""
        return {"ok": True, "mime": mime}, body

    try:
        meta, body = await run_sandboxed(
            "image",
            raw,
            {"mime": "image/png", "long_edge": settings.ai_ocr_long_edge},
            timeout_s=settings.ai_ingest_parse_timeout_s,
            fallback=fallback,
        )
    except TimeoutError as e:
        raise IngestError("The image took too long to read") from e
    except RuntimeError as e:
        raise _sandbox_error(e, "The image could not be read") from e
    if not meta.get("ok"):
        raise IngestError(str(meta.get("error") or "The image could not be read"))
    return body


async def _parse(
    raw: bytes, file_type: FileType, name: str, settings: Settings
) -> _ParseOutcome:
    if file_type == "image":
        clean = await _sanitize_image(raw, settings)
        try:
            docs = await asyncio.wait_for(
                ocr_image(clean, "image/png", name=name, settings=settings),
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

    if file_type == "xlsx":
        # Metered, killable, sandboxed (audit F-04) — never the thread below,
        # whose timeout ended the await but not the work.
        try:
            return _ParseOutcome(
                docs=await parse_xlsx_guarded(raw, name=name, settings=settings)
            )
        except XlsxRejected as e:
            raise IngestError(str(e)) from e

    if file_type in ("docx", "pptx"):
        guard_ooxml(raw, settings)
    if REGISTRY.get(file_type) is None:
        raise IngestError(f"no parser for {file_type}")
    return _ParseOutcome(docs=await parse_isolated(raw, file_type, name, settings))


def text_budget(settings: Settings) -> int:
    """Text a parser may hand back: twice what ingestion indexes, so the
    indexed text and its "content limit reached" note are unchanged while the
    sandbox's output stays bounded (ops.trim_docs)."""
    return int(settings.ai_ingest_max_chars) * 2


async def parse_isolated(
    raw: bytes, file_type: str, name: str, settings: Settings
) -> list[NormalizedDoc]:
    """A registry parser in the SANDBOX child (File Library P0-6).

    It used to run on a thread in this service: `wait_for` ended the await but
    never the parse, and a malformed docx/pptx/html got this process's memory,
    environment and network. The child is killable, rlimited, secret-free and
    offline; a cancelled ingestion kills it. The dev box (tier 4) keeps the
    in-thread form, under the same timeout.
    """
    parser = REGISTRY[file_type]  # type: ignore[index]
    budget = text_budget(settings)

    async def fallback() -> tuple[dict, bytes]:
        try:
            docs = await asyncio.wait_for(
                asyncio.to_thread(parser, raw, name=name),
                timeout=settings.ai_ingest_parse_timeout_s,
            )
        except TimeoutError as e:
            raise IngestError("Parsing timed out") from e
        body = json.dumps(
            sandbox_ops.trim_docs([sandbox_ops.doc_dict(d) for d in docs], budget)
        )
        return {"ok": True}, body.encode("utf-8")

    try:
        meta, body = await run_sandboxed(
            "ingest_parse",
            raw,
            {"file_type": file_type, "name": name, "max_chars": budget},
            timeout_s=settings.ai_ingest_parse_timeout_s,
            fallback=fallback,
        )
    except TimeoutError as e:
        raise IngestError("Parsing timed out") from e
    except RuntimeError as e:
        raise _sandbox_error(e, "Parsing failed") from e
    if not meta.get("ok"):
        raise IngestError(str(meta.get("error") or "Parsing failed"))
    return [
        NormalizedDoc(
            text=d["text"],
            page=d.get("page"),
            section=d.get("section"),
            metadata=d.get("metadata") or {},
        )
        for d in json.loads(body.decode("utf-8") or "[]")
    ]


def _sandbox_error(e: RuntimeError, fallback: str) -> IngestError:
    """A sandbox that could not RUN (unavailable, or below the required
    isolation) is a transient, retryable failure; a child that ran and crashed
    on the file is the file's failure."""
    msg = str(e)
    if "unavailable" in msg or "below the required isolation" in msg:
        return IngestError(
            "Processing is temporarily unavailable", code="SANDBOX_UNAVAILABLE"
        )
    return IngestError(fallback)


def _progress_emitter(
    convex: ConvexClient,
    ingest_id: str,
    settings: Settings,
    generation: int | None = None,
    silent: bool = False,
):
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
        if silent:
            # A re-index runs on a READY file: the user sees no progress.
            return
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
                generation=generation,
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
    expected_sha256: str | None = None,
    generation: int | None = None,
    reindex: bool = False,
) -> None:
    safe = safe_name(name)
    t0 = time.monotonic()
    progress = _progress_emitter(
        convex, ingest_id, settings, generation=generation, silent=reindex
    )
    try:
        await progress("processing", message="Processing file")
        try:
            raw, _ = await convex.fetch_ingest_file(ingest_id)
        except (ConvexRejected, ConvexUnavailable) as e:
            raise IngestError(
                "The file could not be fetched for processing", code="FETCH_FAILED"
            ) from e
        if len(raw) > settings.ai_max_attachment_bytes:
            mb = len(raw) / (1024 * 1024)
            cap = settings.ai_max_attachment_bytes / (1024 * 1024)
            raise IngestError(f"File too large: {mb:.1f} MB (max {cap:.0f} MB)")
        content_hash = hashlib.sha256(raw).hexdigest()
        if expected_sha256 and content_hash != expected_sha256:
            # The bytes that arrived are not the canonical original Convex
            # hashed at upload. Index nothing rather than the wrong content.
            log.warning("LIB_INTEGRITY", extra={"file": ingest_id})
            raise IngestError("The stored file failed its integrity check")
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
                limited = _is_rate_limit(e)
                raise IngestError(
                    "Embedding rate limit exceeded"
                    if limited
                    else "Embedding provider failed",
                    code="EMBED_RATE_LIMIT" if limited else "EMBED_PROVIDER",
                ) from e
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
                versions=PROCESSING_VERSIONS,
                store_original=settings.ai_ingest_store_original_copy,
                generation=generation,
            )
        except store.IngestStale:
            # A NEWER attempt already wrote this file: writing now would roll it
            # back, and reporting would answer for an attempt that is not the
            # current one. Neither happens (the generation fence).
            log.info(
                "LIB_STALE_WRITE", extra={"file": ingest_id, "generation": generation}
            )
            return
        except store.IngestDeleted:
            # The user deleted this file mid-ingestion. Nothing was written and
            # there is no row left to report a status to (audit F-13).
            log.info("ingest_deleted_during_run", extra={"file": ingest_id})
            return
        except Exception as e:  # noqa: BLE001 - stage-specific label
            raise IngestError(
            "Knowledge database write failed", code="KNOWLEDGE_DB"
        ) from e
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
            generation=generation,
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
        log.warning(
            "ingest_failed",
            extra={
                "file": ingest_id,
                "error": str(e),
                # Not "code": the log redactor masks any key named like a secret.
                "failure_code": e.code,
                "reindex": reindex,
            },
        )
        await _fail(convex, ingest_id, str(e), e.code, generation)
    except Exception:  # noqa: BLE001 - any error becomes a `failed` status
        log.exception("ingest_error", extra={"file": ingest_id})
        await _fail(convex, ingest_id, "Ingestion failed", "INTERNAL", generation)


async def _fail(
    convex: ConvexClient,
    ingest_id: str,
    error: str,
    code: str,
    generation: int | None,
) -> None:
    try:
        await convex.set_file_status(
            ingest_id, "failed", error=error, generation=generation, failure_code=code
        )
    except Exception:  # noqa: BLE001 - the stall reaper is the backstop
        log.exception("ingest_status_callback_failed", extra={"file": ingest_id})


async def delete_ingest(ingest_id: str, engine: AsyncEngine) -> bool:
    return await store.delete_by_id(engine, file_id=ingest_id)

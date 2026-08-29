"""Per-turn Documents runtime: the uploaded-file map + the async op dispatcher.

Mirrors the Data-Analysis pattern: the model names a file (from the <documents> turn
listing); the storageId stays server-side and is resolved here, the bytes are fetched
via
the streamId-scoped capability (`convex.fetch_file`), the deterministic op runs (in a
thread, or the crash-isolated process pool for the pypdfium-touching ones, or async
LibreOffice for conversion), and a `DocOpResult` comes back — either extracted DATA or
produced FILE bytes (+ warnings). The executor turns a file result into a stored
artifact
with an inline preview. Uploaded files are UNTRUSTED; nothing here trusts their content
or reveals a storageId.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from app.documents import pdf_ops, pptx_ooxml, pptx_ops
from app.documents.pdf_ops import DocumentError
from app.documents.tool import PDF_OPS, PPTX_OPS


@dataclass(frozen=True, slots=True)
class DocumentRef:
    """A thread's PPTX/PDF attachment. `storage_id` never reaches the model."""

    name: str
    storage_id: str
    mime: str
    kind: str  # 'pdf' | 'pptx'


@dataclass(slots=True)
class DocumentsContext:
    """Per-turn documents state. `documents` maps the model-facing NAME to its ref."""

    settings: object
    convex: object
    stream_id: str
    documents: dict[str, DocumentRef]


@dataclass(slots=True)
class DocOpResult:
    data: dict | None = None
    file: bytes | None = None
    fmt: str | None = None
    filename: str | None = None
    warnings: list[str] = field(default_factory=list)
    images: list[tuple[bytes, str]] | None = None
    error: str | None = None


def document_kind(name: str, mime: str) -> str | None:
    m = (mime or "").lower()
    n = (name or "").lower()
    if "pdf" in m or n.endswith(".pdf"):
        return "pdf"
    if "presentation" in m or n.endswith((".pptx", ".potx")):
        return "pptx"
    return None


def _resolve(ctx: DocumentsContext, name: object) -> DocumentRef:
    if not isinstance(name, str) or not name.strip():
        raise DocumentError("name a `file` from the <documents> list.")
    ref = ctx.documents.get(name.strip())
    if ref is None:
        want = name.strip().lower()
        for n, r in ctx.documents.items():
            if n.lower() == want or n.lower().endswith(want):
                return r
        raise DocumentError(
            f"file '{name}' is not in this conversation. Available: "
            f"{list(ctx.documents)}"
        )
    return ref


async def _fetch(ctx: DocumentsContext, ref: DocumentRef) -> bytes:
    raw, _mime = await ctx.convex.fetch_file(ref.storage_id, ctx.stream_id)
    cap = int(getattr(ctx.settings, "ai_documents_max_file_bytes", 25_000_000))
    if not raw:
        raise DocumentError("the uploaded file is empty.")
    if len(raw) > cap:
        raise DocumentError("the uploaded file is too large to process.")
    return raw


async def run_document_ops(
    ctx: DocumentsContext, operation: str, args: dict, *, run_in_pool
) -> DocOpResult:
    """Resolve → fetch → compute for one document operation. Never raises: a controlled
    failure comes back as DocOpResult(error=...) (the turn lives)."""
    settings = ctx.settings
    timeout = float(getattr(settings, "ai_documents_op_timeout_s", 60.0))
    pool_workers = int(getattr(settings, "ai_ocr_render_workers", 2))
    try:
        if operation not in PDF_OPS and operation not in PPTX_OPS:
            raise DocumentError(f"unknown operation '{operation}'.")

        # merge takes several files
        if operation in ("pdf_merge", "pptx_merge"):
            names = args.get("files") or []
            if not isinstance(names, list) or len(names) < 2:
                raise DocumentError("`files` must list at least two file names.")
            blobs = [await _fetch(ctx, _resolve(ctx, n)) for n in names]
            if operation == "pdf_merge":
                out = await asyncio.wait_for(
                    asyncio.to_thread(pdf_ops.merge_pdfs, blobs), timeout
                )
                return DocOpResult(file=out, fmt="pdf", warnings=[])
            merged, warns = await asyncio.wait_for(
                asyncio.to_thread(pptx_ooxml.merge_pptx, blobs), timeout
            )
            return DocOpResult(file=merged, fmt="pptx", warnings=warns)

        ref = _resolve(ctx, args.get("file"))
        raw = await _fetch(ctx, ref)
        pages = args.get("pages") if isinstance(args.get("pages"), str) else None
        pw = args.get("password") if isinstance(args.get("password"), str) else None

        return await asyncio.wait_for(
            _dispatch_single(
                ctx, operation, args, raw, ref, pages, pw, run_in_pool, pool_workers
            ),
            timeout,
        )
    except DocumentError as e:
        return DocOpResult(error=str(e))
    except TimeoutError:
        return DocOpResult(error="the operation exceeded the time limit.")
    except Exception as e:  # noqa: BLE001 — a tool failure must never kill the turn
        return DocOpResult(
            error=f"the operation failed: {str(e).splitlines()[0][:200]}"
        )


async def _dispatch_single(
    ctx, operation, args, raw, ref, pages, pw, run_in_pool, pool_workers
) -> DocOpResult:
    T = asyncio.to_thread

    # --- PDF data ops ---
    if operation == "pdf_read":
        return DocOpResult(data=await T(pdf_ops.read_pdf, raw, pages, pw))
    if operation == "pdf_extract_tables":
        return DocOpResult(data=await T(pdf_ops.extract_tables, raw, pages, pw))
    if operation == "pdf_metadata":
        md = args.get("metadata")
        if isinstance(md, dict) and md:
            return DocOpResult(
                file=await T(pdf_ops.set_metadata, raw, md, pw), fmt="pdf"
            )
        return DocOpResult(data=await T(pdf_ops.read_metadata, raw, pw))
    if operation == "pdf_form_fields":
        return DocOpResult(data=await T(pdf_ops.form_fields, raw, pw))
    if operation == "pdf_form_structure":
        return DocOpResult(data=await T(pdf_ops.form_structure, raw, pw))
    if operation == "pdf_ocr":
        return DocOpResult(
            data=await run_in_pool(
                pdf_ops.ocr_pdf, raw, pages, pw, workers=pool_workers, label="doc:ocr"
            )
        )
    if operation == "pdf_extract_images":
        imgs = await T(pdf_ops.extract_images, raw, pages, pw)
        return DocOpResult(images=imgs, data={"image_count": len(imgs)})

    # --- PDF transform ops (produce a PDF) ---
    if operation == "pdf_split":
        return DocOpResult(file=await T(pdf_ops.split_pdf, raw, pages, pw), fmt="pdf")
    if operation == "pdf_rotate":
        rot = int(args.get("rotation", 90))
        return DocOpResult(
            file=await T(pdf_ops.rotate_pdf, raw, rot, pages, pw), fmt="pdf"
        )
    if operation == "pdf_crop":
        return DocOpResult(
            file=await T(pdf_ops.crop_pdf, raw, args.get("box"), pages, pw), fmt="pdf"
        )
    if operation == "pdf_encrypt":
        return DocOpResult(
            file=await T(
                pdf_ops.encrypt_pdf,
                raw,
                args.get("user_password", ""),
                args.get("owner_password"),
            ),
            fmt="pdf",
        )
    if operation == "pdf_decrypt":
        return DocOpResult(
            file=await T(pdf_ops.decrypt_pdf, raw, args.get("password", "")), fmt="pdf"
        )
    if operation == "pdf_watermark":
        return DocOpResult(
            file=await T(
                pdf_ops.watermark_pdf, raw, args.get("watermark_text", ""), pw
            ),
            fmt="pdf",
        )
    if operation == "pdf_fill_form":
        return DocOpResult(
            file=await T(pdf_ops.fill_form, raw, args.get("values") or {}, pw),
            fmt="pdf",
        )
    if operation == "pdf_fill_overlay":
        return DocOpResult(
            file=await T(pdf_ops.fill_overlay, raw, args.get("placements") or [], pw),
            fmt="pdf",
        )
    if operation == "pdf_to_pptx":
        scale = float(getattr(ctx.settings, "ai_documents_preview_scale", 1.5))
        deck = await T(_pdf_to_pptx_inline, raw, scale)
        return DocOpResult(
            file=deck,
            fmt="pptx",
            warnings=["each PDF page is a full-slide image, not editable text"],
        )

    # --- PPTX data ops ---
    if operation == "pptx_read":
        return DocOpResult(data=await T(pptx_ops.read_pptx, raw))
    if operation == "pptx_comments":
        return DocOpResult(data=await T(pptx_ops.read_comments, raw))

    # --- PPTX transform ops (produce a PPTX) ---
    if operation == "pptx_edit":
        return DocOpResult(
            file=await T(pptx_ops.edit_pptx, raw, args.get("slides") or []), fmt="pptx"
        )
    if operation == "pptx_delete_slides":
        return DocOpResult(
            file=await T(pptx_ops.delete_slides, raw, args.get("indexes") or []),
            fmt="pptx",
        )
    if operation == "pptx_reorder_slides":
        return DocOpResult(
            file=await T(pptx_ops.reorder_slides, raw, args.get("order") or []),
            fmt="pptx",
        )
    if operation == "pptx_split":
        return DocOpResult(file=await T(pptx_ops.split_pptx, raw, pages), fmt="pptx")
    if operation == "pptx_duplicate_slide":
        idx = int(args.get("index", 0))
        after = args.get("after")
        out, warns = await T(
            pptx_ooxml.duplicate_slide,
            raw,
            idx,
            int(after) if after is not None else None,
        )
        return DocOpResult(file=out, fmt="pptx", warnings=warns)
    if operation == "pptx_to_pdf":
        from app.documents import soffice

        s = ctx.settings
        pdf = await soffice.convert(
            raw,
            to="pdf",
            src_ext="pptx",
            enabled=bool(getattr(s, "ai_documents_soffice_enabled", False)),
            timeout_s=float(getattr(s, "ai_documents_soffice_timeout_s", 45.0)),
            concurrency=int(getattr(s, "ai_documents_soffice_concurrency", 1)),
        )
        if pdf is None:
            return DocOpResult(
                error=(
                    "PPTX->PDF conversion needs LibreOffice, which is not enabled on "
                    "this server. The presentation itself is unchanged and "
                    "downloadable."
                )
            )
        return DocOpResult(file=pdf, fmt="pdf")

    return DocOpResult(error=f"operation '{operation}' is not implemented.")


def _pdf_to_pptx_inline(raw: bytes, scale: float) -> bytes:
    """pdf_to_pptx with the deployed pool render function, in a thread (pypdfium render
    per page is bounded; the process pool is reserved for the OCR flood path)."""
    from app.ingest.render import render_page

    return pptx_ops.pdf_to_pptx(raw, render_fn=render_page, scale=scale)

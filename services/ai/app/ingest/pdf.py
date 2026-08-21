"""Robust PDF extraction: digital text/tables + scanned-page OCR fallback.

Two best-in-class, permissively-licensed, wheel-only libraries (no system
binaries): pdfplumber (MIT, on pdfminer.six) for digital text/tables, and
pypdfium2 (BSD/Apache, bundles PDFium) to render image-only pages so the vision
OCR can read SCANNED PDFs. Deliberately NOT PyMuPDF (AGPL-3.0).

Execution model (why this file is async + bounded):
  * `_extract` (sync, one thread) reads digital text for EVERY page and records
    which pages are image-only. It runs `extract_tables()` ONLY on pages that
    have text chars: table detection on a scanned page is wasted CPU and was the
    measured cause of a 55-page scan spending 4.5 min and blowing the parse
    timeout. It checks a `threading.Event` between pages so it stops
    cooperatively at the deadline (a `wait_for` cannot kill a thread: that was
    the zombie-CPU bug).
  * Image-only pages are rendered + OCR'd in a BOUNDED-parallel async phase
    (`ai_ingest_ocr_concurrency`); each render uses its own short-lived pdfium
    doc (own handle, thread-safe; memory stays flat because only a bounded number
    of page bitmaps exist at once) and each OCR runs under a per-page timeout. NO
    page-count limit; the whole-file deadline + the downstream char/chunk cap are
    the safe bounds instead.
  * On deadline/cancel we return what was processed and flag `truncated`, so the
    caller can tell the user the truth ("OCR'd N of M pages").
"""

from __future__ import annotations

import asyncio
import io
import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from app.config import Settings
from app.ingest.ocr import ocr_image
from app.ingest.types import NormalizedDoc
from app.logging import get_logger

log = get_logger(__name__)

# Injected so tests can supply a fake with no network. Matches ocr.ocr_image.
OcrFn = Callable[..., Awaitable[list[NormalizedDoc]]]


def _tables_to_md(tables: list[list[list[str | None]]]) -> str:
    """Render pdfplumber tables as pipe rows, mirroring the docx table style so
    chunking + retrieval see the same shape across formats."""
    out: list[str] = []
    for table in tables:
        for row in table:
            cells = [(c or "").strip().replace("\n", " ") for c in row]
            if any(cells):
                out.append("| " + " | ".join(cells) + " |")
    return "\n".join(out)


@dataclass
class _Extraction:
    """Sync-pass result: digital text docs + 0-based indices of image-only pages
    that still need OCR."""

    text_docs: list[NormalizedDoc] = field(default_factory=list)
    image_pages: list[int] = field(default_factory=list)
    total_pages: int = 0


@dataclass
class PdfParse:
    """Full parse result. `truncated` is True when the whole-file deadline (or a
    cancel) stopped us before every image page was OCR'd."""

    docs: list[NormalizedDoc]
    total_pages: int
    ocr_total: int
    ocr_done: int
    truncated: bool


def _extract(
    raw: bytes, name: str, settings: Settings, cancel: threading.Event
) -> _Extraction:
    """Sync, CPU-bound; runs in a thread. Cooperatively cancellable between pages."""
    import pdfplumber

    res = _Extraction()
    with pdfplumber.open(io.BytesIO(raw)) as pdf:
        res.total_pages = len(pdf.pages)
        for i, page in enumerate(pdf.pages):
            if cancel.is_set():
                break
            try:
                text = (page.extract_text() or "").strip()
                # Table detection is the CPU hog and finds nothing on an
                # image-only page (no chars): only run it where text exists.
                tables = (
                    _tables_to_md(page.extract_tables() or []) if page.chars else ""
                )
            except Exception:  # noqa: BLE001 - a bad page must not fail the file
                text, tables = "", ""
            combined = "\n\n".join(p for p in (text, tables) if p).strip()
            if combined:
                res.text_docs.append(
                    NormalizedDoc(text=combined, page=i + 1, metadata={"source": name})
                )
            else:
                res.image_pages.append(i)
    return res


def _render_page(raw: bytes, idx: int) -> bytes | None:
    """Render one page to PNG in a short-lived pdfium doc (own handle, thread
    safe; freed on return, so memory stays bounded). scale 2.0 is ~144 dpi."""
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(raw)
    try:
        bitmap = doc[idx].render(scale=2.0)
        buf = io.BytesIO()
        bitmap.to_pil().save(buf, format="PNG")
        return buf.getvalue()
    except Exception:  # noqa: BLE001,S112 - unrenderable page: skip, do not fail
        return None
    finally:
        doc.close()


async def parse_pdf(
    raw: bytes,
    *,
    name: str,
    settings: Settings,
    ocr: OcrFn = ocr_image,
    deadline_s: float | None = None,
) -> PdfParse:
    """Digital text/tables via pdfplumber + bounded-parallel vision OCR of
    image-only pages, merged in page order. No page-count limit."""
    start = time.monotonic()
    cancel = threading.Event()

    async def _watchdog() -> None:
        if deadline_s is None:
            return
        try:
            await asyncio.sleep(max(0.0, deadline_s))
            cancel.set()
        except asyncio.CancelledError:
            pass

    wd = asyncio.create_task(_watchdog())
    try:
        ext = await asyncio.to_thread(_extract, raw, name, settings, cancel)
        docs = list(ext.text_docs)
        ocr_total = len(ext.image_pages)
        ocr_done = 0
        truncated = cancel.is_set()
        collected: list[NormalizedDoc] = []

        remaining = (
            None
            if deadline_s is None
            else max(0.0, deadline_s - (time.monotonic() - start))
        )
        have_budget = remaining is None or remaining > 0
        if ext.image_pages and not cancel.is_set() and have_budget:
            sem = asyncio.Semaphore(max(1, settings.ai_ingest_ocr_concurrency))
            done_lock = asyncio.Lock()

            async def _ocr_one(idx: int) -> None:
                nonlocal ocr_done
                async with sem:
                    png = await asyncio.to_thread(_render_page, raw, idx)
                    if png is None:
                        return
                    # Per-PAGE timeout: one hung page is skipped, not fatal.
                    try:
                        page_docs = await asyncio.wait_for(
                            ocr(png, "image/png", name=name, settings=settings),
                            timeout=settings.ai_ingest_ocr_timeout_s,
                        )
                    except TimeoutError:
                        log.warning(
                            "pdf_ocr_page_timeout",
                            extra={"source": name, "page": idx + 1},
                        )
                        return
                    for d in page_docs:
                        d.page = idx + 1
                    async with done_lock:
                        collected.extend(page_docs)
                        ocr_done += 1

            gathered = asyncio.gather(*(_ocr_one(i) for i in ext.image_pages))
            # Whole-file deadline: wait_for CANCELS the in-flight OCR awaits (they
            # are async, so this actually stops them) and we keep what finished.
            try:
                if remaining is None:
                    await gathered
                else:
                    await asyncio.wait_for(gathered, timeout=remaining)
            except (TimeoutError, asyncio.CancelledError):
                truncated = True
            docs.extend(collected)
        elif ext.image_pages:
            truncated = True

        if cancel.is_set():
            truncated = True
        docs.sort(key=lambda d: d.page or 0)
        partial = truncated or ocr_done < ocr_total
        if partial:
            log.info(
                "pdf_partial",
                extra={
                    "source": name,
                    "total_pages": ext.total_pages,
                    "ocr_done": ocr_done,
                    "ocr_total": ocr_total,
                },
            )
        return PdfParse(
            docs=docs,
            total_pages=ext.total_pages,
            ocr_total=ocr_total,
            ocr_done=ocr_done,
            truncated=partial,
        )
    finally:
        wd.cancel()

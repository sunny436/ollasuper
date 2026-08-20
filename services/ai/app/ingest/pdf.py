"""Robust PDF extraction: digital text/tables + scanned-page OCR fallback.

Two best-in-class, permissively-licensed, wheel-only libraries — no system
binaries:

  * pdfplumber (MIT, on pdfminer.six) for digital text and tables. It beats
    pypdf on layout and is the strongest pure-python table extractor.
  * pypdfium2 (BSD/Apache, bundles PDFium) renders image-only pages to bitmaps
    so the existing vision OCR can read SCANNED PDFs — the case pypdf returned ""
    on and silently dropped.

Deliberately NOT PyMuPDF/pymupdf4llm: technically strongest but AGPL-3.0, which
for a commercial product means a paid licence or a copyleft obligation. The
codebase already made this call (see the old parsers.py docstring).

Unlike the sync registry parsers, this lives in its own async entry point (like
image OCR) because the scanned-page fallback is network I/O. The CPU-bound
pdfplumber+pypdfium2 work runs in a thread under the parse timeout; only the
per-page OCR (capped by ai_ocr_max_pdf_pages) is awaited.
"""

from __future__ import annotations

import asyncio
import io
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from app.config import Settings
from app.ingest.ocr import ocr_image
from app.ingest.types import NormalizedDoc
from app.logging import get_logger

log = get_logger(__name__)

# Signature of the OCR callable, injected so tests can supply a fake with no
# network. Matches app.ingest.ocr.ocr_image.
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
    """Result of the sync pass: text docs already built, plus the rendered PNGs
    of image-only pages that still need OCR (page number -> bytes)."""

    text_docs: list[NormalizedDoc] = field(default_factory=list)
    ocr_pages: list[tuple[int, bytes]] = field(default_factory=list)


def _extract(raw: bytes, name: str, settings: Settings) -> _Extraction:
    """Sync, CPU-bound. Runs in a thread under the parse timeout."""
    import pdfplumber

    result = _Extraction()
    empty: list[int] = []  # 0-based indices of pages with no extractable text

    with pdfplumber.open(io.BytesIO(raw)) as pdf:
        for i, page in enumerate(pdf.pages):
            try:
                text = (page.extract_text() or "").strip()
                tables = _tables_to_md(page.extract_tables() or [])
            except Exception:  # noqa: BLE001 - a bad page must not fail the file
                text, tables = "", ""
            combined = "\n\n".join(p for p in (text, tables) if p).strip()
            if combined:
                result.text_docs.append(
                    NormalizedDoc(text=combined, page=i + 1, metadata={"source": name})
                )
            else:
                empty.append(i)

    # Render only image-only pages, capped, for the OCR fallback. A fully digital
    # PDF has no empty pages and never touches pypdfium2.
    if empty:
        import pypdfium2 as pdfium

        to_render = empty[: settings.ai_ocr_max_pdf_pages]
        doc = pdfium.PdfDocument(raw)
        try:
            for idx in to_render:
                try:
                    bitmap = doc[idx].render(scale=2.0)  # ~144 dpi, enough for OCR
                    pil = bitmap.to_pil()
                    buf = io.BytesIO()
                    pil.save(buf, format="PNG")
                    result.ocr_pages.append((idx + 1, buf.getvalue()))
                except Exception:  # noqa: BLE001,S112 - unrenderable page: skip, don't fail the file
                    continue
        finally:
            doc.close()
        if len(empty) > len(to_render):
            log.info(
                "pdf_ocr_capped",
                extra={"source": name, "empty": len(empty), "ocr": len(to_render)},
            )
    return result


async def parse_pdf(
    raw: bytes,
    *,
    name: str,
    settings: Settings,
    ocr: OcrFn = ocr_image,
) -> list[NormalizedDoc]:
    """Digital text/tables via pdfplumber, plus vision OCR of any image-only
    pages, merged in page order."""
    extraction = await asyncio.wait_for(
        asyncio.to_thread(_extract, raw, name, settings),
        timeout=settings.ai_ingest_parse_timeout_s,
    )
    docs = list(extraction.text_docs)
    for page_no, png in extraction.ocr_pages:
        ocr_docs = await ocr(png, "image/png", name=name, settings=settings)
        for d in ocr_docs:
            d.page = page_no
            docs.append(d)
    docs.sort(key=lambda d: d.page or 0)
    return docs

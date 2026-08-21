"""Isolated PDF page rendering (pypdfium2 only).

Kept in its OWN light module — no langchain/ocr/config imports — so the render
process pool (spawn context) starts workers fast and clean. libpdfium can
SEGFAULT on an edge-case page; running this in a separate process means such a
crash kills only a pool worker, not the --workers 1 service.
"""

from __future__ import annotations

import io


def render_page(raw: bytes, idx: int) -> bytes | None:
    """Render one page to PNG in a short-lived pdfium doc. Returns None on any
    Python-level failure (a native segfault is caught by the pool as a dead
    worker, not here). scale 2.0 is ~144 dpi."""
    import pypdfium2 as pdfium

    doc = None
    try:
        doc = pdfium.PdfDocument(raw)
        bitmap = doc[idx].render(scale=2.0)
        buf = io.BytesIO()
        bitmap.to_pil().save(buf, format="PNG")
        return buf.getvalue()
    except Exception:  # noqa: BLE001,S112 - unrenderable page/doc: skip, do not fail
        return None
    finally:
        if doc is not None:
            doc.close()

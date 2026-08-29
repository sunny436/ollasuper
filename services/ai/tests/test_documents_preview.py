"""Documents — preview render primitives + honest degradation. Hermetic: no LibreOffice,
no network. PDF preview is faithful via pypdfium2; the spec fallback is approximate and
labeled by the caller; the soffice wrapper returns None when disabled (so an uploaded
deck gets NO faked preview)."""

from __future__ import annotations

import io

import pytest

from app.documents import preview, soffice


def make_pdf(pages: int = 3) -> bytes:
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for i in range(pages):
        c.drawString(72, 720, f"page {i + 1}")
        c.showPage()
    c.save()
    return buf.getvalue()


def test_pdf_preview_renders_bounded_pngs():
    pngs, total = preview.pdf_preview_pngs(make_pdf(3), max_pages=5, scale=1.5)
    assert total == 3 and len(pngs) == 3
    assert all(p[:4] == b"\x89PNG" for p in pngs)


def test_pdf_preview_respects_page_cap():
    pngs, total = preview.pdf_preview_pngs(make_pdf(6), max_pages=2, scale=1.0)
    assert total == 6 and len(pngs) == 2


def test_pdf_preview_bad_bytes_no_crash():
    pngs, total = preview.pdf_preview_pngs(b"not a pdf", max_pages=3, scale=1.0)
    assert pngs == [] and total == 0


def test_spec_preview_is_approximate_render():
    pngs = preview.spec_preview_pngs(
        {"slides": [{"title": "T", "bullets": ["x", "y"]}, {"title": "U"}]},
        max_pages=5,
        scale=1.0,
    )
    assert len(pngs) == 2 and pngs[0][:4] == b"\x89PNG"


@pytest.mark.asyncio
async def test_soffice_disabled_returns_none():
    # soffice OFF => never a faked/attempted conversion (uploaded-deck preview honest)
    out = await soffice.convert(
        make_pdf(1), to="pdf", src_ext="pptx", enabled=False, timeout_s=5.0
    )
    assert out is None

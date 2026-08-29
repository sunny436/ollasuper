"""Documents — PowerPoint operations (python-pptx object model + clean-room raw-OOXML).
Hermetic: builds tiny decks and asserts read/edit/delete/reorder/split, the raw-OOXML
duplicate (which python-pptx cannot do), cross-deck merge, integrity, cleanup, and the
honest image-per-slide PDF->PPTX. No soffice, no network."""

from __future__ import annotations

import io

import pytest

from app.documents import pptx_ooxml, pptx_ops
from app.documents.pdf_ops import DocumentError


def make_pptx(n: int = 3) -> bytes:
    from pptx import Presentation

    prs = Presentation()
    for i in range(n):
        s = prs.slides.add_slide(prs.slide_layouts[1])
        s.shapes.title.text = f"Slide {i + 1}"
        s.placeholders[1].text_frame.text = f"Body {i + 1}"
        s.notes_slide.notes_text_frame.text = f"notes {i + 1}"
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()


def count(data: bytes) -> int:
    return pptx_ops.read_pptx(data)["slide_count"]


# --- read / edit ----------------------------------------------------------
def test_read_pptx_structure():
    r = pptx_ops.read_pptx(make_pptx(3))
    assert r["slide_count"] == 3
    assert r["slides"][0]["notes"] == "notes 1"
    assert "Slide 1" in r["slides"][0]["text"]


def test_edit_sets_title_and_appends():
    out = pptx_ops.edit_pptx(
        make_pptx(2),
        [
            {"index": 1, "title": "New"},
            {"add": True, "title": "Added", "bullets": ["a"]},
        ],
    )
    r = pptx_ops.read_pptx(out)
    assert r["slide_count"] == 3
    assert "New" in r["slides"][0]["text"]


def test_edit_rejects_out_of_range():
    with pytest.raises(DocumentError):
        pptx_ops.edit_pptx(make_pptx(2), [{"index": 9, "title": "x"}])


# --- structural (python-pptx) ---------------------------------------------
def test_delete_slides():
    assert count(pptx_ops.delete_slides(make_pptx(3), [2])) == 2


def test_delete_cannot_remove_all():
    with pytest.raises(DocumentError):
        pptx_ops.delete_slides(make_pptx(2), [1, 2])


def test_reorder_requires_permutation():
    assert count(pptx_ops.reorder_slides(make_pptx(3), [3, 1, 2])) == 3
    with pytest.raises(DocumentError):
        pptx_ops.reorder_slides(make_pptx(3), [1, 1, 2])


def test_split_keeps_subset():
    assert count(pptx_ops.split_pptx(make_pptx(4), "1-2")) == 2


def test_read_comments_smoke():
    assert "comments" in pptx_ops.read_comments(make_pptx(1))


# --- raw-OOXML (clean-room) ------------------------------------------------
def test_duplicate_slide_adds_one_and_is_valid():
    dup, warnings = pptx_ooxml.duplicate_slide(make_pptx(3), 1)
    assert count(dup) == 4
    assert pptx_ooxml.integrity(dup)["ok"], pptx_ooxml.integrity(dup)


def test_duplicate_out_of_range():
    with pytest.raises(DocumentError):
        pptx_ooxml.duplicate_slide(make_pptx(2), 5)


def test_merge_decks_valid_and_counts():
    merged, warns = pptx_ooxml.merge_pptx([make_pptx(2), make_pptx(3)])
    assert count(merged) == 5
    assert pptx_ooxml.integrity(merged)["ok"], pptx_ooxml.integrity(merged)


def test_merge_requires_two():
    with pytest.raises(DocumentError):
        pptx_ooxml.merge_pptx([make_pptx(1)])


def test_integrity_flags_a_broken_package():
    # a truncated zip / non-pptx must be reported, not raise
    res = pptx_ooxml.integrity(b"PK\x03\x04 not really a pptx")
    assert res["ok"] is False and res["problems"]


def test_cleanup_noop_on_clean_deck():
    out, msgs = pptx_ooxml.cleanup(make_pptx(2))
    assert count(out) == 2


# --- honest PDF -> PPTX (image per slide) ---------------------------------
def test_pdf_to_pptx_one_slide_per_page():
    from reportlab.pdfgen import canvas

    from app.ingest.render import render_page

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for _ in range(3):
        c.drawString(72, 720, "page")
        c.showPage()
    c.save()
    deck = pptx_ops.pdf_to_pptx(buf.getvalue(), render_fn=render_page)
    assert count(deck) == 3

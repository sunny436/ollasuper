"""Documents — PDF operations (pypdf/pdfplumber/reportlab). Hermetic: builds tiny PDFs
with reportlab and asserts each op's real behaviour, including the encrypt->decrypt
round trip, fillable-form fill, and the non-fillable FreeText overlay. No network."""

from __future__ import annotations

import io

import pytest
from pypdf import PdfReader

from app.documents import pdf_ops
from app.documents.pdf_ops import DocumentError


def make_pdf(pages: int = 3, with_form: bool = False) -> bytes:
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for i in range(pages):
        c.setFont("Helvetica", 18)
        c.drawString(72, 720, f"Page {i + 1} hello world report")
        if with_form and i == 0:
            c.acroForm.textfield(name="fullname", x=72, y=650, width=220, height=20)
        c.showPage()
    c.save()
    return buf.getvalue()


def npages(data: bytes) -> int:
    return len(PdfReader(io.BytesIO(data)).pages)


# --- page parsing ---------------------------------------------------------
def test_parse_pages_ranges_and_end():
    assert pdf_ops.parse_pages(None, 3) == [0, 1, 2]
    assert pdf_ops.parse_pages("1,3", 3) == [0, 2]
    assert pdf_ops.parse_pages("2-end", 3) == [1, 2]
    with pytest.raises(DocumentError):
        pdf_ops.parse_pages("5", 3)


# --- read / extract -------------------------------------------------------
def test_read_pdf_returns_text_per_page():
    r = pdf_ops.read_pdf(make_pdf(3))
    assert r["total_pages"] == 3 and r["pages"]
    assert "hello world" in r["pages"][0]["text"].lower()


def test_read_metadata():
    md = pdf_ops.read_metadata(make_pdf(2))
    assert md["pages"] == 2 and md["encrypted"] is False


def test_extract_tables_smoke():
    # no real tables in the fixture, but the op must not error
    assert "tables" in pdf_ops.extract_tables(make_pdf(1))


# --- transforms -----------------------------------------------------------
def test_rotate_split_crop_merge():
    pdf = make_pdf(3)
    assert npages(pdf_ops.rotate_pdf(pdf, 90, "1")) == 3
    assert npages(pdf_ops.split_pdf(pdf, "1-2")) == 2
    assert npages(pdf_ops.crop_pdf(pdf, [40, 40, 400, 700], "1")) == 3
    assert npages(pdf_ops.merge_pdfs([pdf, make_pdf(2)])) == 5


def test_rotate_rejects_non_multiple_of_90():
    with pytest.raises(DocumentError):
        pdf_ops.rotate_pdf(make_pdf(1), 45)


def test_merge_requires_two():
    with pytest.raises(DocumentError):
        pdf_ops.merge_pdfs([make_pdf(1)])


def test_watermark_and_metadata_set():
    pdf = make_pdf(2)
    assert npages(pdf_ops.watermark_pdf(pdf, "DRAFT")) == 2
    out = pdf_ops.set_metadata(pdf, {"title": "T", "author": "A"})
    assert PdfReader(io.BytesIO(out)).metadata.title == "T"


# --- encryption round trip ------------------------------------------------
def test_encrypt_then_decrypt_round_trip():
    pdf = make_pdf(2)
    enc = pdf_ops.encrypt_pdf(pdf, "secret", "owner")
    assert PdfReader(io.BytesIO(enc)).is_encrypted
    # reading without the password fails cleanly
    with pytest.raises(DocumentError):
        pdf_ops.read_pdf(enc)
    # with the password it opens
    assert pdf_ops.read_metadata(enc, "secret")["pages"] == 2
    dec = pdf_ops.decrypt_pdf(enc, "secret")
    assert not PdfReader(io.BytesIO(dec)).is_encrypted


def test_encrypt_requires_password():
    with pytest.raises(DocumentError):
        pdf_ops.encrypt_pdf(make_pdf(1), "")


# --- forms ----------------------------------------------------------------
def test_form_fields_detects_fillable():
    ff = pdf_ops.form_fields(make_pdf(1, with_form=True))
    assert ff["fillable"] and any(f["name"] == "fullname" for f in ff["fields"])


def test_non_fillable_has_no_fields():
    assert pdf_ops.form_fields(make_pdf(1))["fillable"] is False


def test_fill_form_fillable():
    out = pdf_ops.fill_form(make_pdf(1, with_form=True), {"fullname": "Jane Doe"})
    assert npages(out) == 1


def test_fill_form_rejects_non_fillable():
    with pytest.raises(DocumentError):
        pdf_ops.fill_form(make_pdf(1), {"x": "y"})


def test_form_structure_returns_geometry():
    fs = pdf_ops.form_structure(make_pdf(1, with_form=True))
    assert "labels" in fs and "pages" in fs and fs["pages"][0]["page"] == 1


def test_fill_overlay_freetext():
    out = pdf_ops.fill_overlay(
        make_pdf(2), [{"page": 1, "bbox": [72, 100, 272, 120], "text": "Stamped"}]
    )
    assert npages(out) == 2


def test_fill_overlay_requires_valid_placement():
    with pytest.raises(DocumentError):
        pdf_ops.fill_overlay(make_pdf(1), [])


# --- untrusted / malformed ------------------------------------------------
def test_bad_bytes_raise_document_error():
    with pytest.raises(DocumentError):
        pdf_ops.read_pdf(b"not a pdf at all")

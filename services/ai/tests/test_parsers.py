"""Best-parser-per-type extraction + the OCR graceful-degradation regression.

Hermetic: no network, no Convex, no DB. Real fixtures are built with the same
libraries the parsers use (python-docx/pptx/openpyxl) or a hand-built minimal
PDF; the scanned-PDF and image OCR paths inject a fake OCR callable.
"""

from __future__ import annotations

import io

from PIL import Image

from app.ingest import ocr as ocrmod
from app.ingest import parsers
from app.ingest import pdf as pdfmod
from app.ingest.detect import detect_type
from app.ingest.pdf import parse_pdf
from app.ingest.types import NormalizedDoc
from tests.conftest import make_settings

SETTINGS = make_settings("http://localhost:9999")


def _make_pdf(text: str) -> bytes:
    """A minimal, valid single-page PDF containing `text`, with a correct xref."""
    stream = b"BT /F1 24 Tf 72 700 Td (" + text.encode("latin-1") + b") Tj ET"
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream
        + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += str(i).encode() + b" 0 obj\n" + body + b"\nendobj\n"
    xref_pos = len(out)
    out += b"xref\n0 " + str(len(objs) + 1).encode() + b"\n"
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += b"trailer\n<< /Size " + str(len(objs) + 1).encode() + b" /Root 1 0 R >>\n"
    out += b"startxref\n" + str(xref_pos).encode() + b"\n%%EOF"
    return bytes(out)


# --- PDF -------------------------------------------------------------------

async def test_parse_pdf_digital_text():
    async def no_ocr(*_a, **_k):
        return []

    result = await parse_pdf(
        _make_pdf("Hello RAG world"), name="d.pdf", settings=SETTINGS, ocr=no_ocr
    )
    docs = result.docs
    assert docs
    assert docs[0].page == 1
    assert "Hello RAG world" in docs[0].text
    assert result.truncated is False


async def test_parse_pdf_scanned_page_ocr_fallback(monkeypatch):
    # Image-only page -> pdfplumber yields no text -> render+OCR. We inject the
    # extraction result + a fake OCR so no real PDF rendering / network is needed.
    ext = pdfmod._Extraction(
        text_docs=[
            NormalizedDoc(text="page one text", page=1, metadata={"source": "s"})
        ],
        image_pages=[1],  # 0-based index -> page 2 needs OCR
        total_pages=2,
    )
    monkeypatch.setattr(
        pdfmod, "_extract", lambda raw, name, settings, cancel: ext
    )
    # Fake the render so no real pdfium/PDF bytes are needed.
    monkeypatch.setattr(pdfmod, "_render_page", lambda raw, idx: b"FAKE_PNG_BYTES")

    async def fake_ocr(raw, mime, *, name, settings):
        assert raw == b"FAKE_PNG_BYTES"
        assert mime == "image/png"
        return [NormalizedDoc(text="scanned page two", metadata={"source": name})]

    result = await parse_pdf(b"ignored", name="s.pdf", settings=SETTINGS, ocr=fake_ocr)
    docs = result.docs
    assert [d.page for d in docs] == [1, 2]
    assert docs[1].text == "scanned page two"
    assert result.ocr_done == 1
    assert result.truncated is False


def test_pdf_tables_to_md():
    md = pdfmod._tables_to_md([[["Name", "Score"], ["Bob", "42"]]])
    assert "| Name | Score |" in md
    assert "| Bob | 42 |" in md


# --- HTML ------------------------------------------------------------------

def test_parse_html_main_content():
    html = (
        b"<html><body><article><h1>Sourdough</h1>"
        b"<p>Mix flour and water, then rest the dough overnight.</p>"
        b"</article></body></html>"
    )
    docs = parsers.parse_html(html, name="r.html")
    assert docs and "flour and water" in docs[0].text


def test_parse_html_recovers_structured_data_when_body_empty():
    # A saved SPA page: no readable body, but JSON-LD + og + alt carry meaning.
    html = (
        b"<html><head>"
        b'<meta property="og:title" content="Blue Suede Shoes">'
        b'<script type="application/ld+json">'
        b'{"@type":"Product","name":"Blue Suede Shoes",'
        b'"description":"Rockabilly footwear in blue"}</script>'
        b'</head><body><img alt="close-up of blue shoes"></body></html>'
    )
    text = parsers.parse_html(html, name="p.html")[0].text
    assert "Blue Suede Shoes" in text
    assert "Rockabilly footwear in blue" in text
    assert "close-up of blue shoes" in text


def test_parse_html_never_regresses_to_empty():
    html = b"<html><body><div>plain content without an article tag</div></body></html>"
    docs = parsers.parse_html(html, name="x.html")
    assert docs and "plain content without an article tag" in docs[0].text


# --- PPTX / DOCX / spreadsheets / structured -------------------------------

def test_parse_pptx_text_and_table():
    from pptx import Presentation
    from pptx.util import Inches

    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[5])
    slide.shapes.title.text = "Quarterly Review"
    box = slide.shapes.add_textbox(Inches(1), Inches(2), Inches(4), Inches(1))
    box.text_frame.text = "Revenue grew twenty percent"
    buf = io.BytesIO()
    prs.save(buf)
    docs = parsers.parse_pptx(buf.getvalue(), name="deck.pptx")
    joined = "\n".join(d.text for d in docs)
    assert "Quarterly Review" in joined
    assert "Revenue grew twenty percent" in joined


def test_parse_docx_heading_and_table():
    from docx import Document

    doc = Document()
    doc.add_heading("Findings", level=1)
    doc.add_paragraph("The pipeline works end to end.")
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).text, table.cell(0, 1).text = "Metric", "Value"
    table.cell(1, 0).text, table.cell(1, 1).text = "Score", "42"
    buf = io.BytesIO()
    doc.save(buf)
    docs = parsers.parse_docx(buf.getvalue(), name="f.docx")
    joined = "\n".join(d.text for d in docs)
    assert "The pipeline works end to end." in joined
    assert "| Score | 42 |" in joined


def test_parse_csv_and_json():
    csv_docs = parsers.parse_csv(b"name,score\nAlice,90\nBob,85\n", name="s.csv")
    assert "name=Alice" in csv_docs[0].text and "score=90" in csv_docs[0].text
    json_docs = parsers.parse_json(
        b'{"user":{"name":"Zoe","role":"admin"}}', name="j.json"
    )
    assert "user.name = Zoe" in json_docs[0].text


def test_detect_pptx():
    from pptx import Presentation

    buf = io.BytesIO()
    Presentation().save(buf)
    got = detect_type(buf.getvalue(), "application/octet-stream", "deck.pptx")
    assert got == "pptx"


# --- image OCR: the LogRecord graceful-degradation regression --------------

async def test_ocr_failure_returns_empty_not_raise(monkeypatch):
    # Previously log.exception(..., extra={"name": ...}) raised KeyError inside
    # the handler ("name" is reserved), turning a swallowed OCR miss into a hard
    # file FAILURE. A raising provider must now degrade to [] cleanly.
    def boom(*_a, **_k):
        raise RuntimeError("No endpoints found for model (404)")

    monkeypatch.setattr(ocrmod, "build_llm", boom)
    buf = io.BytesIO()
    Image.new("RGB", (12, 12), "white").save(buf, format="PNG")
    # Pin the vision engine so this exercises the vision-provider failure path
    # directly (hermetic + fast; no local model load).
    s = SETTINGS.model_copy(update={"ai_ocr_engine": "vision"})
    docs = await ocrmod.ocr_image(
        buf.getvalue(), "image/png", name="shot.png", settings=s
    )
    assert docs == []

"""File Generation System — every renderer produces a file its own validator accepts.

Exercises the picklable pool entrypoint (`render_and_validate`) directly, so it proves
the exact path the executor runs. Structural asserts (pages/sheets/slides/dims) go
beyond "it produced bytes".
"""

from __future__ import annotations

import io
import json

import pytest

from app.filegen.generate import needs_pool, render_and_validate
from app.filegen.mime import BINARY_FORMATS, safe_filename
from app.filegen.spec import FileSpec

_DOC_SPEC = {
    "format": "pdf",
    "title": "Quarterly Report",
    "subtitle": "FY2026 Q1",
    "sections": [
        {
            "heading": "Summary",
            "level": 1,
            "text": "Revenue grew.\n\nMargins held.",
            "bullets": ["Point A", "Point B"],
        },
        {
            "heading": "Numbers",
            "level": 2,
            "table": {"columns": ["Region", "Rev"], "rows": [["NA", 120], ["EU", 90]]},
            "caption": "Table 1. Revenue by region.",
        },
        {
            "heading": "Trend",
            "level": 2,
            "chart": {
                "type": "bar",
                "title": "Revenue",
                "labels": ["Q1", "Q2"],
                "series": [{"name": "NA", "values": [120, 130]}],
            },
        },
    ],
}


def _render(fmt: str, spec: dict | None = None):
    s = dict(spec or _DOC_SPEC)
    s["format"] = fmt
    data, mime, report = render_and_validate(s)
    assert data and isinstance(data, bytes)
    assert report.get("ok") is True, report
    return data, mime, report


# --- documents ------------------------------------------------------------
def test_pdf_has_pages_and_valid():
    _, mime, report = _render("pdf")
    assert mime == "application/pdf"
    assert report["pages"] >= 1


def test_docx_has_content():
    _, _, report = _render("docx")
    assert report["paragraphs"] >= 1


def test_txt_md_html_rtf():
    for fmt in ("txt", "md", "html", "rtf"):
        data, _, _ = _render(fmt)
        assert data.decode("utf-8").strip()
    assert b"<table>" in _render("html")[0]
    assert b"| Region | Rev |" in _render("md")[0]


# --- spreadsheets / data --------------------------------------------------
_SHEET_SPEC = {
    "format": "xlsx",
    "title": "Sales",
    "sheets": [
        {
            "name": "Data",
            "columns": ["Month", "Units"],
            "rows": [["Jan", 10], ["Feb", 20], ["Mar", 30]],
            "chart": {"type": "line", "title": "Units"},
        }
    ],
}


def test_xlsx_has_sheets_and_chart():
    data, _, report = _render("xlsx", _SHEET_SPEC)
    assert report["sheets"] >= 1
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data))
    assert wb["Data"]["A1"].value == "Month"


def test_csv_tsv():
    csv_bytes, _, _ = _render("csv", _SHEET_SPEC)
    assert b"Month,Units" in csv_bytes and b"Jan,10" in csv_bytes
    tsv_bytes, _, _ = _render("tsv", _SHEET_SPEC)
    assert b"Month\tUnits" in tsv_bytes


def test_json_yaml_xml():
    jb, _, _ = _render("json", _SHEET_SPEC)
    parsed = json.loads(jb)
    assert parsed[0]["Month"] == "Jan"
    yb, _, _ = _render("yaml", _SHEET_SPEC)
    assert b"Month" in yb
    xb, _, _ = _render("xml", _SHEET_SPEC)
    assert b"<row>" in xb


# --- presentation ---------------------------------------------------------
def test_pptx_has_slides():
    spec = {
        "format": "pptx",
        "title": "Deck",
        "slides": [
            {"title": "Intro", "bullets": ["a", "b"]},
            {
                "title": "Chart",
                "chart": {"type": "pie", "labels": ["x", "y"], "values": [1, 2]},
            },
        ],
    }
    _, _, report = _render("pptx", spec)
    assert report["slides"] >= 2  # title slide + content


# --- images / charts ------------------------------------------------------
def test_png_jpeg_webp_dims():
    chart = {
        "format": "png",
        "chart": {"type": "bar", "labels": ["a", "b"], "values": [3, 5]},
    }
    for fmt in ("png", "jpeg", "webp"):
        _, _, report = _render(fmt, chart)
        assert report["width"] > 100 and report["height"] > 100


def test_svg_is_valid():
    data, mime, _ = _render(
        "svg", {"format": "svg", "chart": {"type": "line", "values": [1, 2, 3]}}
    )
    assert mime == "image/svg+xml" and b"<svg" in data


def test_table_as_image():
    _, _, report = _render(
        "png",
        {
            "format": "png",
            "title": "T",
            "sections": [{"table": {"columns": ["A"], "rows": [["1"], ["2"]]}}],
        },
    )
    assert report["width"] > 100


# --- pool routing + filenames + robustness --------------------------------
def test_needs_pool_routing():
    assert needs_pool(FileSpec(format="pdf")) is True
    assert needs_pool(FileSpec(format="csv")) is False
    # a chart in an otherwise-text format forces the pool
    assert (
        needs_pool(
            FileSpec.model_validate(
                {
                    "format": "md",
                    "sections": [{"chart": {"type": "bar", "values": [1]}}],
                }
            )
        )
        is True
    )
    for fmt in BINARY_FORMATS:
        assert needs_pool(FileSpec(format=fmt)) is True


def test_safe_filename_slugifies_and_extensions():
    assert safe_filename("../../etc/passwd", "pdf") == "passwd.pdf"
    assert safe_filename("My Report!!", "docx") == "My-Report.docx"
    assert safe_filename("", "csv") == "document.csv"


def test_malformed_spec_degrades_not_crashes():
    # Unknown fields ignored; missing content still yields a valid (empty) file.
    data, _, report = render_and_validate({"format": "pdf", "bogus": 1})
    assert report["ok"] is True and report["pages"] >= 1


def test_unsupported_format_raises():
    with pytest.raises(Exception):  # noqa: B017 — pydantic rejects the literal
        render_and_validate({"format": "exe"})

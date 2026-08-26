"""Post-render validation — every artifact is opened/parsed before it is offered.

Each check re-reads the bytes with the format's own reader and asserts minimal
structural quality (pages/sheets/slides > 0, a valid image, parseable data). Returns a
report dict `{ok, error?, ...facts}`; a failure makes the tool return a graceful error
rather than hand the user a broken file.
"""

from __future__ import annotations

import io
import json


def validate_output(fmt: str, data: bytes) -> dict:
    try:
        if not data:
            return {"ok": False, "error": "empty output"}
        return {"ok": True, **_CHECKS.get(fmt, _check_nonempty)(data)}
    except Exception as e:  # noqa: BLE001 — a validation failure is a safe negative
        return {"ok": False, "error": f"{fmt} validation failed: {type(e).__name__}"}


def _check_nonempty(data: bytes) -> dict:
    return {"bytes": len(data)}


def _check_pdf(data: bytes) -> dict:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    pages = len(reader.pages)
    if pages < 1:
        raise ValueError("no pages")
    return {"pages": pages}


def _check_docx(data: bytes) -> dict:
    from docx import Document

    doc = Document(io.BytesIO(data))
    if not doc.paragraphs and not doc.tables:
        raise ValueError("no content")
    return {"paragraphs": len(doc.paragraphs), "tables": len(doc.tables)}


def _check_xlsx(data: bytes) -> dict:
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True)
    if not wb.sheetnames:
        raise ValueError("no sheets")
    return {"sheets": len(wb.sheetnames)}


def _check_pptx(data: bytes) -> dict:
    from pptx import Presentation

    prs = Presentation(io.BytesIO(data))
    n = len(prs.slides._sldIdLst)
    if n < 1:
        raise ValueError("no slides")
    return {"slides": n}


def _check_image(data: bytes) -> dict:
    from PIL import Image

    img = Image.open(io.BytesIO(data))
    img.verify()  # detects truncated/corrupt image
    w, h = Image.open(io.BytesIO(data)).size
    if w < 1 or h < 1:
        raise ValueError("zero dimensions")
    return {"width": w, "height": h}


def _check_svg(data: bytes) -> dict:
    text = data.decode("utf-8", "replace")
    if "<svg" not in text:
        raise ValueError("no <svg> root")
    return {"bytes": len(data)}


def _check_json(data: bytes) -> dict:
    json.loads(data.decode("utf-8"))
    return {"bytes": len(data)}


def _check_yaml(data: bytes) -> dict:
    import yaml

    yaml.safe_load(data.decode("utf-8"))
    return {"bytes": len(data)}


def _check_xml(data: bytes) -> dict:
    import defusedxml.ElementTree as ET

    ET.fromstring(data)
    return {"bytes": len(data)}


_CHECKS = {
    "pdf": _check_pdf,
    "docx": _check_docx,
    "xlsx": _check_xlsx,
    "pptx": _check_pptx,
    "png": _check_image,
    "jpeg": _check_image,
    "webp": _check_image,
    "svg": _check_svg,
    "json": _check_json,
    "yaml": _check_yaml,
    "xml": _check_xml,
}

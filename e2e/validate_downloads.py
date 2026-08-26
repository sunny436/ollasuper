"""QA — open the REAL downloaded files and assert their structure.

Run from services/ai so the parsers are importable:
    cd services/ai && uv run python ../../e2e/validate_downloads.py <downloads-dir>

Reads manifest.json (written by qa-filegen.js) and opens each file with the format's
own reader — a passed HTTP download is NOT a pass; the bytes must parse and be
structurally sound (pages/sheets/slides/rows/image dims). Exits non-zero on any failure.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path


def _pdf(data: bytes, tag: str) -> str:
    from pypdf import PdfReader

    r = PdfReader(io.BytesIO(data))
    pages = len(r.pages)
    assert pages >= 1, "no pages"
    text = (r.pages[0].extract_text() or "").strip()
    assert text, "first page has no extractable text"
    if tag == "largepdf":
        assert pages >= 2, f"expected a multi-page report, got {pages}"
    return f"{pages} page(s), text ok"


def _docx(data: bytes, tag: str) -> str:
    from docx import Document

    d = Document(io.BytesIO(data))
    paras = [p for p in d.paragraphs if p.text.strip()]
    assert paras, "no non-empty paragraphs"
    return f"{len(paras)} paragraphs, {len(d.tables)} tables"


def _xlsx(data: bytes, tag: str) -> str:
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data))
    ws = wb[wb.sheetnames[0]]
    rows = ws.max_row
    assert wb.sheetnames, "no sheets"
    assert rows >= 2, f"sheet has too few rows ({rows})"
    if tag == "largexlsx":
        assert rows >= 20, f"expected a large sheet, got {rows} rows"
    return f"{len(wb.sheetnames)} sheet(s), {rows} rows"


def _pptx(data: bytes, tag: str) -> str:
    from pptx import Presentation

    prs = Presentation(io.BytesIO(data))
    n = len(prs.slides._sldIdLst)
    assert n >= 2, f"too few slides ({n})"
    if tag == "multislide":
        assert n >= 4, f"expected many slides, got {n}"
    return f"{n} slides"


def _image(data: bytes, tag: str) -> str:
    from PIL import Image

    Image.open(io.BytesIO(data)).verify()
    w, h = Image.open(io.BytesIO(data)).size
    assert w > 50 and h > 50, f"bad dims {w}x{h}"
    return f"{w}x{h}"


def _svg(data: bytes, tag: str) -> str:
    assert b"<svg" in data, "no <svg> root"
    return f"{len(data)} bytes"


def _json(data: bytes, tag: str) -> str:
    obj = json.loads(data.decode("utf-8"))
    assert obj, "empty json"
    return "valid json"


def _yaml(data: bytes, tag: str) -> str:
    import yaml

    obj = yaml.safe_load(data.decode("utf-8"))
    assert obj, "empty yaml"
    return "valid yaml"


def _text(data: bytes, tag: str) -> str:
    t = data.decode("utf-8", "replace").strip()
    assert t, "empty text file"
    return f"{len(t)} chars"


_CHECKS = {
    "pdf": _pdf, "chartdoc": _pdf, "largepdf": _pdf,
    "docx": _docx,
    "xlsx": _xlsx, "largexlsx": _xlsx,
    "pptx": _pptx, "multislide": _pptx,
    "png": _image, "jpeg": _image, "webp": _image,
    "svg": _svg,
    "json": _json,
    "yaml": _yaml,
    "csv": _text, "tsv": _text, "md": _text, "html": _text, "txt": _text, "rtf": _text,
}


def main() -> int:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("filegen-downloads")
    manifest = json.loads((out_dir / "manifest.json").read_text())
    ok, fail = 0, 0
    for entry in manifest:
        tag = entry["tag"]
        p = Path(entry["path"])
        data = p.read_bytes()
        check = _CHECKS.get(tag) or _CHECKS.get(entry["ext"]) or _text
        try:
            info = check(data, tag)
            print(f"PASS  {tag:11s} {p.name:16s} {len(data):>8}B  {info}")
            ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"FAIL  {tag:11s} {p.name:16s}  {type(e).__name__}: {e}")
            fail += 1
    print(f"\n===== INSPECTION: {ok} passed, {fail} failed ({len(manifest)} files) =====")
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())

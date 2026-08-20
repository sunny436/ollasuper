"""Best-parser-per-type registry.

Each parser is CPU-bound + synchronous and returns structure-preserving
NormalizedDocs in document order; the orchestrator runs it in a thread under a
timeout (pipeline.py). `image` is NOT here — OCR is async network I/O (ocr.py).

Adding a format = write one parse_x, add one REGISTRY entry, add one detect
branch. pymupdf would beat pypdf on layout/tables but is AGPL + heavy native
wheels; pypdf is already a proven dep, so it stays until that trade is worth it.
"""

from __future__ import annotations

import csv
import io
import json

from bs4 import BeautifulSoup
from docx import Document
from openpyxl import load_workbook
from pypdf import PdfReader

from app.ingest.types import FileType, IngestError, NormalizedDoc, Parser

_JSON_MAX_DEPTH = 32


def parse_pdf(raw: bytes, *, name: str) -> list[NormalizedDoc]:
    reader = PdfReader(io.BytesIO(raw))
    docs: list[NormalizedDoc] = []
    for i, page in enumerate(reader.pages):
        try:
            text = (page.extract_text() or "").strip()
        except Exception:  # noqa: BLE001 - a malformed page must not fail the file
            text = ""
        if text:
            docs.append(NormalizedDoc(text=text, page=i + 1, metadata={"source": name}))
    return docs


def parse_docx(raw: bytes, *, name: str) -> list[NormalizedDoc]:
    doc = Document(io.BytesIO(raw))
    docs: list[NormalizedDoc] = []
    section: str | None = None
    buf: list[str] = []

    def flush() -> None:
        if buf:
            docs.append(
                NormalizedDoc(
                    text="\n".join(buf), section=section, metadata={"source": name}
                )
            )
            buf.clear()

    for para in doc.paragraphs:
        text = (para.text or "").strip()
        if not text:
            continue
        style = (para.style.name if para.style else "") or ""
        if style.startswith("Heading"):
            flush()
            section = text
        buf.append(text)
    flush()

    for ti, table in enumerate(doc.tables):
        rows: list[str] = []
        for r in table.rows:
            cells = [(c.text or "").strip().replace("\n", " ") for c in r.cells]
            rows.append("| " + " | ".join(cells) + " |")
        if rows:
            docs.append(
                NormalizedDoc(
                    text="\n".join(rows),
                    section=f"Table {ti + 1}",
                    metadata={"source": name, "kind": "table"},
                )
            )
    return docs


def parse_xlsx(raw: bytes, *, name: str) -> list[NormalizedDoc]:
    wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    docs: list[NormalizedDoc] = []
    try:
        for ws in wb.worksheets:
            header: list[str] | None = None
            lines: list[str] = []
            for ri, row in enumerate(ws.iter_rows(values_only=True)):
                if ri == 0:
                    header = [str(c) if c is not None else "" for c in row]
                    continue
                if all(c is None for c in row):
                    continue
                if header:
                    pairs = [
                        (f"{h}={c}" if h else str(c))
                        for h, c in zip(header, row, strict=False)
                        if c is not None and str(c) != ""
                    ]
                else:
                    pairs = [str(c) for c in row if c is not None]
                lines.append(f"row {ri + 1}: " + ", ".join(pairs))
            if lines:
                docs.append(
                    NormalizedDoc(
                        text="\n".join(lines),
                        section=ws.title,
                        metadata={"source": name, "sheet": ws.title},
                    )
                )
    finally:
        wb.close()
    return docs


def parse_csv(raw: bytes, *, name: str) -> list[NormalizedDoc]:
    text = raw.decode("utf-8", errors="replace")
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return []
    header = rows[0]
    lines: list[str] = []
    for ri, row in enumerate(rows[1:], start=2):
        pairs = [
            (f"{h}={c}" if h else c)
            for h, c in zip(header, row, strict=False)
            if c != ""
        ]
        lines.append(f"row {ri}: " + ", ".join(pairs))
    body = "\n".join(lines) if lines else "\n".join(", ".join(r) for r in rows)
    return [NormalizedDoc(text=body, metadata={"source": name})]


def parse_json(raw: bytes, *, name: str) -> list[NormalizedDoc]:
    try:
        data = json.loads(raw.decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, ValueError) as e:
        raise IngestError("invalid JSON") from e
    lines: list[str] = []

    def walk(node: object, path: str, depth: int) -> None:
        if depth > _JSON_MAX_DEPTH:
            return
        if isinstance(node, dict):
            for k, val in node.items():
                walk(val, f"{path}.{k}" if path else str(k), depth + 1)
        elif isinstance(node, list):
            for i, val in enumerate(node):
                walk(val, f"{path}[{i}]", depth + 1)
        else:
            lines.append(f"{path} = {node}")

    walk(data, "", 0)
    return [NormalizedDoc(text="\n".join(lines), metadata={"source": name})]


def parse_html(raw: bytes, *, name: str) -> list[NormalizedDoc]:
    soup = BeautifulSoup(raw, "lxml")
    for tag in soup(["script", "style", "noscript", "template", "svg", "head"]):
        tag.decompose()
    body = soup.body or soup
    text = body.get_text("\n", strip=True)
    if not text:
        return []
    return [NormalizedDoc(text=text, metadata={"source": name})]


def parse_text(raw: bytes, *, name: str) -> list[NormalizedDoc]:
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        return []
    return [NormalizedDoc(text=text, metadata={"source": name})]


REGISTRY: dict[FileType, Parser] = {
    "pdf": parse_pdf,
    "docx": parse_docx,
    "xlsx": parse_xlsx,
    "csv": parse_csv,
    "json": parse_json,
    "html": parse_html,
    "markdown": parse_text,  # decoded here; markdown STRUCTURE recovered in chunk.py
    "text": parse_text,
}

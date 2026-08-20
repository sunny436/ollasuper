"""Best-parser-per-type registry.

Each parser is CPU-bound + synchronous and returns structure-preserving
NormalizedDocs in document order; the orchestrator runs it in a thread under a
timeout (pipeline.py). Two types are NOT here because they need async network
I/O: `image` (OCR, ocr.py) and `pdf` (digital text is sync but the scanned-page
OCR fallback is async — pdf.py). Both are dispatched directly in pipeline._parse.

Adding a format = write one parse_x, add one REGISTRY entry, add one detect
branch. Every parser here is the best-in-class, permissively-licensed,
wheel-only option for its type (no system binaries).
"""

from __future__ import annotations

import csv
import io
import json

import trafilatura
from bs4 import BeautifulSoup
from docx import Document
from openpyxl import load_workbook
from pptx import Presentation

from app.ingest.types import FileType, IngestError, NormalizedDoc, Parser

_JSON_MAX_DEPTH = 32
# Cap the structured-data recovered from an HTML page so a giant embedded
# JSON-LD blob cannot dominate the embedding budget; trafilatura's main content
# is the priority and is added first.
_HTML_MAX_STRUCT_CHARS = 20_000


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


def parse_pptx(raw: bytes, *, name: str) -> list[NormalizedDoc]:
    prs = Presentation(io.BytesIO(raw))
    docs: list[NormalizedDoc] = []
    for si, slide in enumerate(prs.slides, start=1):
        lines: list[str] = []
        for shape in slide.shapes:
            if shape.has_text_frame:
                text = (shape.text_frame.text or "").strip()
                if text:
                    lines.append(text)
            if shape.has_table:
                for row in shape.table.rows:
                    cells = [
                        (c.text or "").strip().replace("\n", " ") for c in row.cells
                    ]
                    if any(cells):
                        lines.append("| " + " | ".join(cells) + " |")
        if slide.has_notes_slide:
            notes = (slide.notes_slide.notes_text_frame.text or "").strip()
            if notes:
                lines.append("Notes: " + notes)
        if lines:
            docs.append(
                NormalizedDoc(
                    text="\n".join(lines),
                    section=f"Slide {si}",
                    metadata={"source": name, "slide": si},
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


def _collect_strings(node: object, out: list[str], depth: int) -> None:
    if depth > _JSON_MAX_DEPTH:
        return
    if isinstance(node, dict):
        for val in node.values():
            _collect_strings(val, out, depth + 1)
    elif isinstance(node, list):
        for val in node:
            _collect_strings(val, out, depth + 1)
    elif isinstance(node, str):
        s = node.strip()
        # Skip bare URLs — they add tokens but no recallable meaning.
        if len(s) > 1 and not (s.startswith(("http://", "https://")) and " " not in s):
            out.append(s)


def _html_structured(soup: BeautifulSoup) -> list[str]:
    """Recover content a saved (often JS-rendered) page carries OUTSIDE the
    visible body: JSON-LD, OpenGraph/twitter meta, and image alt text. This is
    what makes 'what did I save about X' work on pages trafilatura sees as empty.
    """
    out: list[str] = []

    for tag in soup.find_all("script", attrs={"type": "application/ld+json"}):
        blob = tag.string or tag.get_text()
        if not blob:
            continue
        try:
            data = json.loads(blob)
        except (json.JSONDecodeError, ValueError):
            continue
        vals: list[str] = []
        _collect_strings(data, vals, 0)
        if vals:
            out.append("\n".join(dict.fromkeys(vals)))

    metas: list[str] = []
    for m in soup.find_all("meta"):
        prop = (m.get("property") or m.get("name") or "").lower()
        content = (m.get("content") or "").strip()
        if content and (
            prop.startswith("og:")
            or prop.startswith("twitter:")
            or prop in ("description", "keywords", "author", "title")
        ):
            metas.append(f"{prop}: {content}")
    if metas:
        out.append("\n".join(dict.fromkeys(metas)))

    alts = list(
        dict.fromkeys(
            (img.get("alt") or "").strip()
            for img in soup.find_all("img")
            if (img.get("alt") or "").strip()
        )
    )[:200]
    if alts:
        out.append("Images: " + "; ".join(alts))

    joined = "\n\n".join(out)
    return [joined[:_HTML_MAX_STRUCT_CHARS]] if joined else []


def parse_html(raw: bytes, *, name: str) -> list[NormalizedDoc]:
    html = raw.decode("utf-8", errors="replace")
    parts: list[str] = []

    # 1) Main readable content. trafilatura is the benchmark leader at stripping
    #    nav/boilerplate — the exact junk that made saved pages extract to one
    #    useless chunk under the old bs4 get_text().
    try:
        main = trafilatura.extract(
            html,
            include_tables=True,
            include_comments=False,
            include_links=False,
            favor_recall=True,
        )
    except Exception:  # noqa: BLE001 - untrusted input; fall through
        main = None
    if main and main.strip():
        parts.append(main.strip())

    # 2) Structured data (JSON-LD / meta / alt) — present even when the body is
    #    a JS-rendered shell.
    soup = BeautifulSoup(raw, "lxml")
    parts.extend(_html_structured(soup))

    # 3) Never regress to empty: visible body text as the final fallback.
    if not parts:
        for tag in soup(["script", "style", "noscript", "template", "svg", "head"]):
            tag.decompose()
        body = soup.body or soup
        text = body.get_text("\n", strip=True)
        if text:
            parts.append(text)

    combined = "\n\n".join(dict.fromkeys(p for p in parts if p)).strip()
    if not combined:
        return []
    return [NormalizedDoc(text=combined, metadata={"source": name})]


def parse_text(raw: bytes, *, name: str) -> list[NormalizedDoc]:
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        return []
    return [NormalizedDoc(text=text, metadata={"source": name})]


# `pdf` and `image` are dispatched in pipeline._parse (async), not here.
REGISTRY: dict[FileType, Parser] = {
    "docx": parse_docx,
    "pptx": parse_pptx,
    "xlsx": parse_xlsx,
    "csv": parse_csv,
    "json": parse_json,
    "html": parse_html,
    "markdown": parse_text,  # decoded here; markdown STRUCTURE recovered in chunk.py
    "text": parse_text,
}

"""Pure, secret-free decoders for attacker-controlled bytes.

Everything here parses UNTRUSTED input with NATIVE code (Pillow's C decoders,
PDFium/pypdf) — the classic memory-corruption RCE surface. It is isolated in its
own module for one reason: it is what runs inside the sandbox worker, and the
worker must be importable WITHOUT dragging in Settings, the Convex client, or
anything else that reads a secret. Nothing in this file touches the network, the
environment, or the database; it takes bytes and returns bytes or text.

The IN-PROCESS callers (the Windows dev fallback) import these too, so there is
exactly one copy of each decoder.
"""

from __future__ import annotations

import io

MAX_IMAGE_BYTES = 3_500_000  # -> ~4.7MB base64, under the 5MB per-image limit
MAX_PDF_CHARS = 60_000
# The Pillow decoders our four accepted mimes may legitimately reach, and no
# others — so PSD/DDS/FLI/FPX/PCX/SGI/XBM and every parser whose advisory is not
# written yet are unreachable, not merely un-patched.
SAFE_IMAGE_FORMATS = ["PNG", "JPEG", "WEBP", "GIF"]


class DecodeError(RuntimeError):
    """A decode that failed in a way the caller should surface, not a crash."""


def normalise_image(raw: bytes, mime: str, long_edge: int) -> tuple[bytes, str]:
    """Downscale and re-encode. See the long comment that used to live in
    attachments._normalise_image for why the format allowlist and the pixel cap
    are load-bearing."""
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = 40_000_000
    try:
        img = Image.open(io.BytesIO(raw), formats=SAFE_IMAGE_FORMATS)
        img.load()
    except Image.DecompressionBombError as e:
        raise DecodeError("image dimensions are too large to process") from e
    except OSError as e:
        raise DecodeError("image could not be decoded") from e
    if img.mode not in ("RGB", "RGBA", "L"):
        img = img.convert("RGB")

    w, h = img.size
    if max(w, h) > long_edge:
        scale = long_edge / max(w, h)
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))))

    if mime == "image/png" and img.mode in ("RGB", "RGBA", "L"):
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        if buf.tell() <= MAX_IMAGE_BYTES:
            return buf.getvalue(), "image/png"

    if img.mode == "RGBA":
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85, optimize=True)
    return buf.getvalue(), "image/jpeg"


def extract_pdf_text(raw: bytes) -> str:
    """Inline text for the model. UNTRUSTED input: an encrypted or malformed PDF
    must NEVER fail the turn — it degrades to a short note."""
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(raw))
        if reader.is_encrypted:
            try:
                reader.decrypt("")  # many PDFs use an empty owner password
            except Exception:  # noqa: BLE001,S110 — stays locked; handled below
                pass
            if reader.is_encrypted:
                return "[This PDF is password-protected; text can't be read inline.]"
        parts: list[str] = []
        total = 0
        for page in reader.pages:
            try:
                text = page.extract_text() or ""
            except Exception:  # noqa: BLE001 — one bad page must not fail the file
                text = ""
            parts.append(text)
            total += len(text)
            if total > MAX_PDF_CHARS:
                break
        return "\n".join(parts)[:MAX_PDF_CHARS]
    except Exception:  # noqa: BLE001 — a corrupt/locked PDF must not fail the turn
        return "[This PDF could not be read inline (it may be corrupt or protected).]"


# --- spreadsheets (audit F-04) ----------------------------------------------
#
# A workbook's SIZE ON DISK says nothing about the work it asks for. A sheet
# is iterated over its LOGICAL range: every missing row between two populated
# ones is yielded, and every row is padded out to a column width. A 4.8 KB
# workbook passed the zip guard while describing 12.8 million cells. So work is
# metered as it happens — every yielded row and every padded cell counts —
# and the decode stops at a hard ceiling instead of finishing a runaway.
#
# Iteration ignores the sheet's declared <dimension> (reset_dimensions): that
# element is attacker-written, and a forged SMALL one would under-report the
# real extent to a counter that trusted it. The declared size is still checked
# up front, because it is the cheap way to refuse the obvious case.


def _xlsx_rows_bounded(ws, meter: dict, max_cells: int, max_rows: int):
    """Yield (index, values) for every row of `ws`, charging each to `meter`."""
    declared_rows, declared_cols = ws.max_row, ws.max_column
    if declared_rows and declared_cols and declared_rows * declared_cols > max_cells:
        raise DecodeError(
            "this spreadsheet is too large to process "
            f"({declared_rows} rows x {declared_cols} columns)"
        )
    ws.reset_dimensions()
    for index, row in enumerate(ws.iter_rows(values_only=True)):
        meter["rows"] += 1
        meter["cells"] += max(len(row), 1)
        if meter["rows"] > max_rows or meter["cells"] > max_cells:
            raise DecodeError(
                "this spreadsheet is too large to process "
                f"(more than {max_cells:,} cells or {max_rows:,} rows)"
            )
        yield index, row


def xlsx_scan(raw: bytes, *, max_cells: int, max_rows: int) -> dict:
    """Walk every sheet under the work ceiling WITHOUT keeping anything. The
    preview / data-analysis path runs this before pandas parses the same bytes,
    so pandas never meets a workbook whose logical size was not bounded here."""
    from openpyxl import load_workbook

    meter = {"rows": 0, "cells": 0}
    try:
        wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    except Exception as e:  # noqa: BLE001 — a broken archive is a decode error
        raise DecodeError("this spreadsheet could not be opened") from e
    try:
        for ws in wb.worksheets:
            for _ in _xlsx_rows_bounded(ws, meter, max_cells, max_rows):
                pass
    finally:
        wb.close()
    return {"rows": meter["rows"], "cells": meter["cells"]}


def xlsx_docs(
    raw: bytes, *, name: str, max_cells: int, max_rows: int
) -> list[dict]:
    """The ingestion text of a workbook, one doc per non-empty sheet, under the
    same work ceiling. Output is identical to the former in-process parser:
    `row N: header=value, ...` lines (header-less when row 1 is blank)."""
    from openpyxl import load_workbook

    meter = {"rows": 0, "cells": 0}
    try:
        wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    except Exception as e:  # noqa: BLE001
        raise DecodeError("this spreadsheet could not be opened") from e
    docs: list[dict] = []
    try:
        for ws in wb.worksheets:
            header: list[str] | None = None
            lines: list[str] = []
            for ri, row in _xlsx_rows_bounded(ws, meter, max_cells, max_rows):
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
                    {
                        "text": "\n".join(lines),
                        "section": ws.title,
                        "metadata": {"source": name, "sheet": ws.title},
                    }
                )
    finally:
        wb.close()
    return docs

"""Deterministic PDF operations over UNTRUSTED bytes.

Every function is sync + module-level (so the executor can run it in a thread or the
crash-isolated process pool) and raises `DocumentError` on a controlled, user-safe
failure — never a bare exception that would surface library internals. Clean-room
adaptation of Anthropic's `pdf` skill: the WORKFLOW is reused, the libraries are
OllaSuper's own already-deployed, permissively-licensed, wheel-only stack (pypdf,
pdfplumber, reportlab, pypdfium2, rapidocr) — NO system binaries (no qpdf/poppler/
tesseract). Functions return either extracted DATA (dict) or produced FILE bytes.
"""

from __future__ import annotations

import io

# Bounds so an untrusted file can never blow the context or the CPU.
_MAX_TEXT_CHARS = 40_000
_MAX_TABLE_ROWS = 400
_MAX_IMAGES = 20
_MAX_FIELDS = 500


class DocumentError(RuntimeError):
    """A controlled, user-safe document-operation failure."""


def parse_pages(spec: str | None, total: int) -> list[int]:
    """'1,3-5,8' / '2-end' → sorted unique 0-based indices within [0,total). Empty/None
    → all pages. Raises DocumentError on a malformed spec or an out-of-range page."""
    if total <= 0:
        raise DocumentError("the document has no pages.")
    if not spec or not str(spec).strip():
        return list(range(total))
    out: set[int] = set()
    for part in str(spec).replace(" ", "").split(","):
        if not part:
            continue
        if "-" in part:
            a, _, b = part.partition("-")
            lo = 1 if a in ("", "start") else _to_int(a)
            hi = total if b in ("", "end") else _to_int(b)
            if lo < 1 or hi < lo or hi > total:
                raise DocumentError(
                    f"page range '{part}' is out of bounds (1-{total})."
                )
            out.update(range(lo - 1, hi))
        else:
            n = _to_int(part)
            if n < 1 or n > total:
                raise DocumentError(f"page {n} is out of bounds (1-{total}).")
            out.add(n - 1)
    return sorted(out)


def _to_int(s: str) -> int:
    try:
        return int(s)
    except ValueError as e:
        raise DocumentError(f"'{s}' is not a valid page number.") from e


def _reader(raw: bytes, password: str | None = None):
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(raw))
    except (PdfReadError, Exception) as e:  # noqa: BLE001 - untrusted file
        raise DocumentError(
            "could not open the PDF (it may be corrupt or not a PDF)."
        ) from e
    if reader.is_encrypted:
        ok = 0
        try:
            ok = reader.decrypt(password or "")
        except Exception:  # noqa: BLE001
            ok = 0
        if not ok:
            raise DocumentError(
                "the PDF is password-protected; provide the password to open it."
            )
    if len(reader.pages) < 1:
        raise DocumentError("the PDF has no pages.")
    return reader


# --- read / extract (return DATA) ----------------------------------------
def read_pdf(raw: bytes, pages: str | None = None, password: str | None = None) -> dict:
    import pdfplumber

    reader = _reader(raw, password)
    total = len(reader.pages)
    idxs = parse_pages(pages, total)
    out: list[dict] = []
    used = 0
    with pdfplumber.open(io.BytesIO(raw), password=password or "") as pdf:
        for i in idxs:
            if used >= _MAX_TEXT_CHARS:
                break
            try:
                text = (pdf.pages[i].extract_text() or "").strip()
            except Exception:  # noqa: BLE001
                text = ""
            text = text[: _MAX_TEXT_CHARS - used]
            used += len(text)
            if text:
                out.append({"page": i + 1, "text": text})
    return {"total_pages": total, "pages_read": len(out), "pages": out}


def extract_tables(
    raw: bytes, pages: str | None = None, password: str | None = None
) -> dict:
    import pdfplumber

    reader = _reader(raw, password)
    idxs = parse_pages(pages, len(reader.pages))
    tables: list[dict] = []
    rows_total = 0
    with pdfplumber.open(io.BytesIO(raw), password=password or "") as pdf:
        for i in idxs:
            if rows_total >= _MAX_TABLE_ROWS:
                break
            try:
                found = pdf.pages[i].extract_tables() or []
            except Exception:  # noqa: BLE001
                found = []
            for t in found:
                rows = [
                    [("" if c is None else str(c)) for c in row]
                    for row in t
                    if any(c is not None for c in row)
                ]
                if not rows:
                    continue
                rows = rows[: _MAX_TABLE_ROWS - rows_total]
                rows_total += len(rows)
                tables.append({"page": i + 1, "rows": rows})
    return {"table_count": len(tables), "tables": tables}


def form_structure(raw: bytes, password: str | None = None) -> dict:
    """Non-fillable form geometry (pdfplumber) — labels, long horizontal lines, and
    checkbox-sized rects with coordinates, so the model can place overlay text. Mirrors
    the source extract_form_structure methodology."""
    import pdfplumber

    _reader(raw, password)
    labels: list[dict] = []
    lines: list[dict] = []
    checkboxes: list[dict] = []
    pages_meta: list[dict] = []
    with pdfplumber.open(io.BytesIO(raw), password=password or "") as pdf:
        for pnum, page in enumerate(pdf.pages, 1):
            w, h = float(page.width), float(page.height)
            pages_meta.append(
                {"page": pnum, "width": round(w, 1), "height": round(h, 1)}
            )
            for word in page.extract_words()[:400]:
                labels.append(
                    {
                        "page": pnum,
                        "text": word["text"],
                        "bbox": [
                            round(float(word["x0"]), 1),
                            round(float(word["top"]), 1),
                            round(float(word["x1"]), 1),
                            round(float(word["bottom"]), 1),
                        ],
                    }
                )
            for ln in page.lines:
                if abs(float(ln["x1"]) - float(ln["x0"])) > w * 0.5:
                    lines.append(
                        {
                            "page": pnum,
                            "y": round(float(ln["top"]), 1),
                            "x0": round(float(ln["x0"]), 1),
                            "x1": round(float(ln["x1"]), 1),
                        }
                    )
            for rect in page.rects:
                rw = float(rect["x1"]) - float(rect["x0"])
                rh = float(rect["bottom"]) - float(rect["top"])
                if 5 <= rw <= 15 and 5 <= rh <= 15 and abs(rw - rh) < 2:
                    checkboxes.append(
                        {
                            "page": pnum,
                            "bbox": [
                                round(float(rect["x0"]), 1),
                                round(float(rect["top"]), 1),
                                round(float(rect["x1"]), 1),
                                round(float(rect["bottom"]), 1),
                            ],
                        }
                    )
    return {
        "pages": pages_meta,
        "labels": labels[:400],
        "lines": lines[:200],
        "checkboxes": checkboxes[:200],
    }


def form_fields(raw: bytes, password: str | None = None) -> dict:
    """Fillable AcroForm fields (pypdf get_fields) — name, type, current value, "
    "options."""
    reader = _reader(raw, password)
    fields = reader.get_fields() or {}
    out: list[dict] = []
    for name, f in list(fields.items())[:_MAX_FIELDS]:
        try:
            out.append(
                {
                    "name": str(name),
                    "type": str(f.get("/FT", "")),
                    "value": None if f.get("/V") is None else str(f.get("/V")),
                    "options": [str(o) for o in (f.get("/_States_") or [])][:20],
                }
            )
        except Exception:  # noqa: BLE001,S112
            continue
    return {"fillable": bool(out), "field_count": len(out), "fields": out}


def read_metadata(raw: bytes, password: str | None = None) -> dict:
    reader = _reader(raw, password)
    m = reader.metadata or {}

    def g(k: str) -> str | None:
        try:
            v = getattr(m, k, None)
            return None if v is None else str(v)
        except Exception:  # noqa: BLE001
            return None

    return {
        "pages": len(reader.pages),
        "encrypted": bool(reader.is_encrypted),
        "title": g("title"),
        "author": g("author"),
        "subject": g("subject"),
        "creator": g("creator"),
        "producer": g("producer"),
    }


def ocr_pdf(
    raw: bytes,
    pages: str | None = None,
    password: str | None = None,
    *,
    render_fn=None,
    ocr_fn=None,
) -> dict:
    """OCR scanned pages: render each page (pypdfium2) then RapidOCR.
    render_fn/ocr_fn are
    injectable for tests; default to the deployed ingest engines (no system binary)."""
    if render_fn is None:
        from app.ingest.render import render_page as render_fn  # type: ignore
    if ocr_fn is None:
        from app.ingest.render import ocr_png_bytes as ocr_fn  # type: ignore
    reader = _reader(raw, password)
    idxs = parse_pages(pages, len(reader.pages))
    out: list[dict] = []
    used = 0
    for i in idxs:
        if used >= _MAX_TEXT_CHARS:
            break
        png = render_fn(raw, i)
        if not png:
            continue
        text, conf = ocr_fn(png)
        text = (text or "").strip()[: _MAX_TEXT_CHARS - used]
        used += len(text)
        if text:
            out.append({"page": i + 1, "text": text, "confidence": round(conf, 3)})
    return {"pages_ocred": len(out), "pages": out}


def extract_images(
    raw: bytes, pages: str | None = None, password: str | None = None
) -> list[tuple[bytes, str]]:
    """Embedded images (pypdf Page.images) as (bytes, filename), bounded."""
    reader = _reader(raw, password)
    idxs = parse_pages(pages, len(reader.pages))
    out: list[tuple[bytes, str]] = []
    for i in idxs:
        if len(out) >= _MAX_IMAGES:
            break
        try:
            for img in reader.pages[i].images:
                if len(out) >= _MAX_IMAGES:
                    break
                data = getattr(img, "data", None)
                name = getattr(img, "name", None) or f"p{i + 1}-img{len(out) + 1}.png"
                if data:
                    out.append((data, name))
        except Exception:  # noqa: BLE001,S112
            continue
    if not out:
        raise DocumentError("no extractable embedded images were found.")
    return out


# --- transform (return FILE bytes) ---------------------------------------
def _write(writer) -> bytes:
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def merge_pdfs(files: list[bytes]) -> bytes:
    from pypdf import PdfWriter

    if len(files) < 2:
        raise DocumentError("provide at least two PDFs to merge.")
    writer = PdfWriter()
    for raw in files:
        _reader(raw)  # validate each opens
        writer.append(io.BytesIO(raw))
    return _write(writer)


def split_pdf(raw: bytes, pages: str | None, password: str | None = None) -> bytes:
    from pypdf import PdfWriter

    reader = _reader(raw, password)
    idxs = parse_pages(pages, len(reader.pages))
    writer = PdfWriter()
    for i in idxs:
        writer.add_page(reader.pages[i])
    return _write(writer)


def rotate_pdf(
    raw: bytes, rotation: int, pages: str | None = None, password: str | None = None
) -> bytes:
    from pypdf import PdfWriter

    if rotation % 90 != 0:
        raise DocumentError("rotation must be a multiple of 90 degrees.")
    reader = _reader(raw, password)
    idxs = set(parse_pages(pages, len(reader.pages)))
    writer = PdfWriter()
    for i, page in enumerate(reader.pages):
        if i in idxs:
            page.rotate(rotation)
        writer.add_page(page)
    return _write(writer)


def crop_pdf(
    raw: bytes, box: list[float], pages: str | None = None, password: str | None = None
) -> bytes:
    from pypdf import PdfWriter

    if not box or len(box) != 4:
        raise DocumentError("crop box must be [x0, top, x1, bottom].")
    reader = _reader(raw, password)
    idxs = set(parse_pages(pages, len(reader.pages)))
    writer = PdfWriter()
    for i, page in enumerate(reader.pages):
        if i in idxs:
            x0, top, x1, bottom = (float(v) for v in box)
            h = float(page.mediabox.height)
            page.mediabox.lower_left = (x0, h - bottom)
            page.mediabox.upper_right = (x1, h - top)
        writer.add_page(page)
    return _write(writer)


def encrypt_pdf(
    raw: bytes, user_password: str, owner_password: str | None = None
) -> bytes:
    from pypdf import PdfWriter

    if not user_password:
        raise DocumentError("provide a password to encrypt with.")
    reader = _reader(raw)
    writer = PdfWriter()
    writer.append(reader)
    try:
        writer.encrypt(
            user_password=user_password,
            owner_password=owner_password or user_password,
            algorithm="AES-256",
        )
    except Exception as e:  # noqa: BLE001
        raise DocumentError("encryption failed.") from e
    return _write(writer)


def decrypt_pdf(raw: bytes, password: str) -> bytes:
    from pypdf import PdfWriter

    reader = _reader(raw, password)  # opens + decrypts
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    return _write(writer)


def watermark_pdf(raw: bytes, text: str, password: str | None = None) -> bytes:
    from pypdf import PdfReader, PdfWriter

    if not text or not text.strip():
        raise DocumentError("provide watermark text.")
    reader = _reader(raw, password)
    writer = PdfWriter()
    for page in reader.pages:
        w = float(page.mediabox.width)
        h = float(page.mediabox.height)
        stamp = PdfReader(io.BytesIO(_watermark_overlay(text, w, h))).pages[0]
        page.merge_page(stamp)
        writer.add_page(page)
    return _write(writer)


def _watermark_overlay(text: str, width: float, height: float) -> bytes:
    from reportlab.lib.colors import Color
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(width, height))
    c.saveState()
    c.setFillColor(Color(0.5, 0.5, 0.5, alpha=0.25))
    c.setFont("Helvetica-Bold", max(24, int(min(width, height) / 12)))
    c.translate(width / 2, height / 2)
    c.rotate(45)
    c.drawCentredString(0, 0, text[:80])
    c.restoreState()
    c.save()
    return buf.getvalue()


def set_metadata(raw: bytes, metadata: dict, password: str | None = None) -> bytes:
    from pypdf import PdfWriter

    reader = _reader(raw, password)
    writer = PdfWriter()
    writer.append(reader)
    md = {}
    for k in ("title", "author", "subject", "keywords", "creator"):
        v = metadata.get(k)
        if isinstance(v, str) and v:
            md[f"/{k.capitalize()}"] = v[:500]
    if md:
        writer.add_metadata(md)
    return _write(writer)


def fill_form(raw: bytes, values: dict, password: str | None = None) -> bytes:
    """Fill a fillable AcroForm (pypdf update_page_form_field_values + "
    "need_appearances)."""
    from pypdf import PdfReader, PdfWriter

    if not isinstance(values, dict) or not values:
        raise DocumentError("provide field values to fill.")
    reader = _reader(raw, password)
    if not (reader.get_fields() or {}):
        raise DocumentError(
            "this PDF has no fillable form fields — use pdf_fill_overlay with "
            "coordinates from pdf_form_structure instead."
        )
    src = PdfReader(io.BytesIO(raw))
    if src.is_encrypted:
        src.decrypt(password or "")
    writer = PdfWriter(clone_from=src)
    str_values = {str(k): ("" if v is None else str(v)) for k, v in values.items()}
    for page in writer.pages:
        try:
            writer.update_page_form_field_values(
                page, str_values, auto_regenerate=False
            )
        except Exception:  # noqa: BLE001,S112
            continue
    try:
        writer.set_need_appearances_writer(True)
    except Exception:  # noqa: BLE001,S110
        pass
    return _write(writer)


def fill_overlay(
    raw: bytes, placements: list[dict], password: str | None = None
) -> bytes:
    """Stamp text onto a NON-fillable PDF via pypdf FreeText annotations at caller-
    supplied coordinates (top-left bbox in page space). Mirrors the source annotation
    workflow. The model supplies coordinates from pdf_form_structure + the
    page image."""
    from pypdf import PdfWriter
    from pypdf.annotations import FreeText

    if not placements:
        raise DocumentError("provide at least one placement (page, bbox, text).")
    reader = _reader(raw, password)
    writer = PdfWriter()
    writer.append(reader)
    added = 0
    for p in placements:
        try:
            page_num = int(p["page"])
            bbox = [float(v) for v in p["bbox"]]
            text = str(p.get("text", ""))
        except (KeyError, ValueError, TypeError):
            continue
        if not text or page_num < 1 or page_num > len(writer.pages):
            continue
        h = float(writer.pages[page_num - 1].mediabox.height)
        rect = (bbox[0], h - bbox[3], bbox[2], h - bbox[1])  # top-left → pypdf rect
        ann = FreeText(
            text=text,
            rect=rect,
            font="Helvetica",
            font_size=f"{int(p.get('font_size', 11))}pt",
            font_color="000000",
            border_color=None,
            background_color=None,
        )
        writer.add_annotation(page_number=page_num - 1, annotation=ann)
        added += 1
    if not added:
        raise DocumentError(
            "no valid placements (need page, bbox [x0,top,x1,bottom], text)."
        )
    return _write(writer)

"""Preview render primitives — bounded, pool-safe, honest.

`pdf_preview_pngs` renders the first N pages of a PDF to PNG via pypdfium2 (the
deployed,
no-binary engine) — the FAITHFUL path for PDFs directly, and for PPTX once LibreOffice
has converted it to PDF (orchestrated in the executor). `spec_preview_pngs` draws an
APPROXIMATE slide image from the generation FileSpec with Pillow — used ONLY for decks
we
generated when LibreOffice is unavailable, and always LABELED approximate by the caller.
Both are module-level + picklable so the executor runs them in the crash-isolated
process
pool. Bounded by a page cap + a resolution scale below the OCR scale.
"""

from __future__ import annotations

import io

_MAX_SCALE = 2.0


def pdf_preview_pngs(
    raw: bytes, max_pages: int, scale: float
) -> tuple[list[bytes], int]:
    """Render up to `max_pages` pages to PNG. Returns (pngs, total_pages). A page that
    fails to render is skipped, never fatal."""
    import pypdfium2 as pdfium

    scale = max(0.5, min(_MAX_SCALE, float(scale)))
    pngs: list[bytes] = []
    doc = None
    try:
        doc = pdfium.PdfDocument(raw)
        total = len(doc)
        for i in range(min(total, max(1, int(max_pages)))):
            try:
                bitmap = doc[i].render(scale=scale)
                buf = io.BytesIO()
                bitmap.to_pil().save(buf, format="PNG")
                pngs.append(buf.getvalue())
            except Exception:  # noqa: BLE001,S112
                continue
        return pngs, total
    except Exception:  # noqa: BLE001
        return [], 0
    finally:
        if doc is not None:
            doc.close()


def spec_preview_pngs(spec_dict: dict, max_pages: int, scale: float) -> list[bytes]:
    """APPROXIMATE slide preview from the generation spec (Pillow). Not a faithful OOXML
    render — the caller labels it. Generated decks only (an uploaded
    deck has no spec)."""
    from PIL import Image, ImageDraw, ImageFont

    slides = spec_dict.get("slides") or []
    if not slides and spec_dict.get("title"):
        slides = [{"title": spec_dict.get("title"), "bullets": []}]
    w, h = int(1280 * min(2.0, max(0.5, scale))), int(720 * min(2.0, max(0.5, scale)))
    try:
        title_font = ImageFont.truetype("DejaVuSans-Bold.ttf", int(h * 0.07))
        body_font = ImageFont.truetype("DejaVuSans.ttf", int(h * 0.045))
    except Exception:  # noqa: BLE001
        title_font = ImageFont.load_default()
        body_font = ImageFont.load_default()
    pngs: list[bytes] = []
    for slide in slides[: max(1, int(max_pages))]:
        img = Image.new("RGB", (w, h), (255, 255, 255))
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, w, int(h * 0.02)], fill=(37, 99, 235))
        y = int(h * 0.10)
        title = str(slide.get("title") or "")[:120]
        if title:
            d.text((int(w * 0.06), y), title, fill=(17, 24, 39), font=title_font)
            y += int(h * 0.14)
        bullets = slide.get("bullets") or []
        text = slide.get("text") or ""
        lines = [str(b) for b in bullets] or [
            ln for ln in str(text).split("\n") if ln.strip()
        ]
        for line in lines[:8]:
            d.text(
                (int(w * 0.08), y),
                "• " + line.lstrip("-• ").strip()[:90],
                fill=(55, 65, 81),
                font=body_font,
            )
            y += int(h * 0.075)
            if y > h * 0.92:
                break
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        pngs.append(buf.getvalue())
    return pngs

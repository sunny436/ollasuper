"""Deterministic PowerPoint operations via python-pptx (the object-model half) over
UNTRUSTED bytes.

These are the operations python-pptx does faithfully: read/analyse, edit text+notes, add
a new slide, delete slides, reorder slides, split (keep a subset), read comments, and
the
honest PDF->PPTX (each page as a full-slide IMAGE). Duplicating an EXISTING slide,
applying a .potx template, merging decks, orphan cleanup and integrity validation are
raw-OOXML and live in `pptx_ooxml.py` (python-pptx cannot copy a slide). Every function
raises `DocumentError` on a controlled failure. No system binaries.
"""

from __future__ import annotations

import io

from app.documents.pdf_ops import DocumentError, parse_pages

_MAX_TEXT_CHARS = 40_000


def _open(raw: bytes):
    from pptx import Presentation

    try:
        return Presentation(io.BytesIO(raw))
    except Exception as e:  # noqa: BLE001 - untrusted file
        raise DocumentError(
            "could not open the presentation (it may be corrupt or not a .pptx)."
        ) from e


def _save(prs) -> bytes:
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()


def read_pptx(raw: bytes) -> dict:
    """Per-slide text, tables, notes, and layout name — the structural analysis."""
    prs = _open(raw)
    slides: list[dict] = []
    used = 0
    for si, slide in enumerate(prs.slides, 1):
        if used >= _MAX_TEXT_CHARS:
            break
        texts: list[str] = []
        tables = 0
        for shape in slide.shapes:
            if shape.has_text_frame:
                t = (shape.text_frame.text or "").strip()
                if t:
                    texts.append(t)
            if shape.has_table:
                tables += 1
        notes = ""
        if slide.has_notes_slide:
            notes = (slide.notes_slide.notes_text_frame.text or "").strip()
        body = "\n".join(texts)[: _MAX_TEXT_CHARS - used]
        used += len(body)
        slides.append(
            {
                "index": si,
                "layout": getattr(slide.slide_layout, "name", ""),
                "text": body,
                "tables": tables,
                "notes": notes[:2000],
            }
        )
    return {"slide_count": len(prs.slides._sldIdLst), "slides": slides}


def _set_bullets(slide, bullets: list[str]) -> None:
    from pptx.util import Inches, Pt

    body = None
    for ph in slide.placeholders:
        if ph.placeholder_format.idx != 0 and ph.has_text_frame:
            body = ph.text_frame
            break
    if body is None:
        box = slide.shapes.add_textbox(Inches(0.6), Inches(1.6), Inches(11), Inches(5))
        body = box.text_frame
        body.word_wrap = True
    body.clear()
    for i, b in enumerate(bullets):
        para = body.paragraphs[0] if i == 0 else body.add_paragraph()
        para.text = str(b).lstrip("-• ").strip()
        para.font.size = Pt(18)


def edit_pptx(raw: bytes, edits: list[dict]) -> bytes:
    """Apply per-slide edits. Each edit targets a 1-based `index` (or
    `add`:true appends a
    new content slide) and may set title/subtitle/text/bullets/notes."""
    if not edits:
        raise DocumentError("provide at least one slide edit.")
    prs = _open(raw)
    n = len(prs.slides._sldIdLst)
    for e in edits:
        if e.get("add"):
            layout = (
                prs.slide_layouts[1]
                if len(prs.slide_layouts) > 1
                else prs.slide_layouts[0]
            )
            slide = prs.slides.add_slide(layout)
        else:
            idx = int(e.get("index", 0))
            if idx < 1 or idx > n:
                raise DocumentError(f"slide {idx} is out of range (1-{n}).")
            slide = prs.slides[idx - 1]
        title = e.get("title")
        if isinstance(title, str) and title and slide.shapes.title is not None:
            slide.shapes.title.text = title
        bullets = e.get("bullets")
        text = e.get("text")
        if isinstance(bullets, list) and bullets:
            _set_bullets(slide, [str(b) for b in bullets])
        elif isinstance(text, str) and text:
            _set_bullets(slide, [ln for ln in text.split("\n") if ln.strip()])
        notes = e.get("notes")
        if isinstance(notes, str) and notes:
            slide.notes_slide.notes_text_frame.text = notes
    return _save(prs)


def delete_slides(raw: bytes, indexes: list[int]) -> bytes:
    """Remove 1-based slides via the sldIdLst element + drop the relationship."""
    from pptx.oxml.ns import qn

    prs = _open(raw)
    lst = prs.slides._sldIdLst
    sldIds = list(lst)
    n = len(sldIds)
    want = sorted({int(i) for i in indexes}, reverse=True)
    if not want or want[0] > n or want[-1] < 1:
        raise DocumentError(f"slide indexes must be within 1-{n}.")
    if len(want) >= n:
        raise DocumentError("cannot delete every slide.")
    for i in want:
        if i < 1 or i > n:
            raise DocumentError(f"slide {i} is out of range (1-{n}).")
        el = sldIds[i - 1]
        rId = el.get(qn("r:id"))
        try:
            prs.part.drop_rel(rId)
        except Exception:  # noqa: BLE001,S110
            pass
        lst.remove(el)
    return _save(prs)


def reorder_slides(raw: bytes, order: list[int]) -> bytes:
    """Reorder to the given 1-based permutation of the current slides."""
    prs = _open(raw)
    lst = prs.slides._sldIdLst
    sldIds = list(lst)
    n = len(sldIds)
    perm = [int(i) for i in order]
    if sorted(perm) != list(range(1, n + 1)):
        raise DocumentError(f"`order` must be a permutation of 1-{n} (got {perm}).")
    for el in sldIds:
        lst.remove(el)
    for i in perm:
        lst.append(sldIds[i - 1])
    return _save(prs)


def split_pptx(raw: bytes, pages: str | None) -> bytes:
    """Keep only the selected 1-based slides (delete the rest)."""
    prs = _open(raw)
    total = len(prs.slides._sldIdLst)
    keep = set(parse_pages(pages, total))  # 0-based
    drop = [i + 1 for i in range(total) if i not in keep]
    if not drop:
        return raw
    return delete_slides(raw, drop)


def read_comments(raw: bytes) -> dict:
    """Read PowerPoint comments (read-only; authoring is unsupported). Modern comments
    live in ppt/comments/*.xml; authors in ppt/authors.xml or commentAuthors.xml."""
    import zipfile

    import defusedxml.ElementTree as ET

    out: list[dict] = []
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            names = [
                n
                for n in z.namelist()
                if n.startswith("ppt/comments/") and n.endswith(".xml")
            ] + [
                n
                for n in z.namelist()
                if n.startswith("ppt/")
                and "comment" in n.lower()
                and n.endswith(".xml")
            ]
            for name in dict.fromkeys(names):
                try:
                    root = ET.fromstring(z.read(name))
                except Exception:  # noqa: BLE001,S112
                    continue
                for el in root.iter():
                    tag = el.tag.rsplit("}", 1)[-1]
                    if tag in ("text", "t") and (el.text or "").strip():
                        out.append(
                            {"part": name, "text": (el.text or "").strip()[:1000]}
                        )
    except Exception as e:  # noqa: BLE001 - not a valid zip/pptx
        raise DocumentError("could not read the presentation's comments.") from e
    return {"comment_count": len(out), "comments": out[:200]}


def pdf_to_pptx(pdf_raw: bytes, *, render_fn=None, scale: float = 1.5) -> bytes:
    """HONEST PDF->PPTX: render each PDF page to an image and place it as a full-slide
    picture. NOT an editable-text conversion — each slide is a page image."""
    from pptx import Presentation
    from pptx.util import Emu

    if render_fn is None:
        from app.ingest.render import render_page as render_fn  # type: ignore
    from pypdf import PdfReader

    try:
        total = len(PdfReader(io.BytesIO(pdf_raw)).pages)
    except Exception as e:  # noqa: BLE001
        raise DocumentError("could not open the PDF.") from e
    if total < 1:
        raise DocumentError("the PDF has no pages.")
    prs = Presentation()
    # 13.333in x 7.5in (16:9), matching filegen; place each page image full-bleed.
    from pptx.util import Inches

    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]
    placed = 0
    for i in range(total):
        png = render_fn(pdf_raw, i)
        if not png:
            continue
        slide = prs.slides.add_slide(blank)
        try:
            from PIL import Image

            w, h = Image.open(io.BytesIO(png)).size
        except Exception:  # noqa: BLE001
            w, h = (4, 3)
        # Fit within the slide keeping aspect ratio, centred.
        sw, sh = int(prs.slide_width), int(prs.slide_height)
        ratio = min(sw / w, sh / h)
        pw, ph = int(w * ratio), int(h * ratio)
        left, top = (sw - pw) // 2, (sh - ph) // 2
        slide.shapes.add_picture(
            io.BytesIO(png), Emu(left), Emu(top), width=Emu(pw), height=Emu(ph)
        )
        placed += 1
    if placed < 1:
        raise DocumentError("could not render any PDF page to an image.")
    return _save(prs)

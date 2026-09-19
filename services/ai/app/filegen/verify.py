"""Verification of the RENDERED artifact — what the file shows, not what the spec
said. Pure, sync, pool-safe.

WHY THIS EXISTS. The 18.09.2026 documents audit found artifacts described as
correct because generation succeeded: no rendered check for blank pages, wrong
chart types, or a TOC whose numbers did not match the pages. `validate.py`
answers "does the file open"; this module answers "does it show what was asked".

TOC VERIFICATION reads the PDF OUTLINE — the exact page each heading landed on —
and checks the heading text is really on that page. That survives duplicate
headings (matched in order), nested levels (every entry, any depth) and the TOC
page itself (never a target). Text matching is the labelled fallback for a PDF
without an outline, and it walks forward monotonically so a heading word used in
earlier prose cannot claim the match.
"""

from __future__ import annotations

import io
import re

_WS = re.compile(r"\s+")
_BLANK_INK = 0.0001  # below this share of dark pixels (footer excluded) a page is blank


def _norm(text: str) -> str:
    return _WS.sub(" ", (text or "")).strip().lower()


def pdf_outline(pdf: bytes) -> list[tuple[int, str, int]]:
    """(depth, title, page) for every outline entry, in document order; page is
    1-based. Empty when the PDF carries no outline."""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(pdf))
    out: list[tuple[int, str, int]] = []

    def walk(items, depth: int) -> None:
        for it in items:
            if isinstance(it, list):
                walk(it, depth + 1)
                continue
            try:
                page = reader.get_destination_page_number(it) + 1
            except Exception:  # noqa: BLE001,S112 — a destination without a page
                continue
            out.append((depth, str(it.title or ""), page))

    try:
        walk(reader.outline, 0)
    except Exception:  # noqa: BLE001
        return []
    return out


def page_texts(pdf: bytes) -> list[str]:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(pdf))
    texts: list[str] = []
    for page in reader.pages:
        try:
            texts.append(page.extract_text() or "")
        except Exception:  # noqa: BLE001
            texts.append("")
    return texts


def heading_pages(
    pdf: bytes, entries: list[tuple[int, str]]
) -> tuple[list[int] | None, str]:
    """The page each TOC entry's heading landed on, in order. (pages, method) —
    `outline` when the PDF outline supplied every entry in order, `text` when
    monotonic text search did, (None, reason) when an entry could not be found."""
    outline = pdf_outline(pdf)
    if outline:
        pages: list[int] = []
        pos = 0
        for _level, text in entries:
            want = _norm(text)
            hit = None
            for k in range(pos, len(outline)):
                if _norm(outline[k][1]) == want:
                    hit = k
                    break
            if hit is None:
                pages = []
                break
            pages.append(outline[hit][2])
            pos = hit + 1
        if len(pages) == len(entries):
            return pages, "outline"
    texts = [_norm(t) for t in page_texts(pdf)]
    pages = []
    start = 1 if len(texts) > 1 else 0  # a TOC, when present, is on page 1
    for _level, text in entries:
        want = _norm(text)
        found = None
        for i in range(start, len(texts)):
            if want and want in texts[i]:
                found = i
                break
        if found is None:
            return None, f"heading not found in the rendered pages: {text!r}"
        pages.append(found + 1)
        start = found  # the next heading is on this page or later
    return pages, "text"


def verify_toc(
    pdf: bytes,
    entries: list[tuple[int, str]],
    expected_pages: list[int] | None = None,
) -> dict:
    """{toc_verified: True|False|None, toc_method, toc_note}. True means every
    heading is on the page the TOC gives for it; None means it could not be
    checked (and says why); False is a real mismatch."""
    if not entries:
        return {"toc_verified": None, "toc_method": None, "toc_note": "no headings"}
    pages, method = heading_pages(pdf, entries)
    if pages is None:
        return {"toc_verified": None, "toc_method": None, "toc_note": method}
    texts = [_norm(t) for t in page_texts(pdf)]
    # 1. the heading is really on its page
    for (_level, text), pg in zip(entries, pages, strict=True):
        if pg < 1 or pg > len(texts) or _norm(text) not in texts[pg - 1]:
            return {
                "toc_verified": False,
                "toc_method": method,
                "toc_note": f"{text!r} is not on page {pg}",
            }
    # 2. the TOC that was printed lists those numbers (static DOCX TOC), or, for a
    #    reportlab TOC, the TOC page lists every heading
    if expected_pages is not None and list(expected_pages) != list(pages):
        return {
            "toc_verified": False,
            "toc_method": method,
            "toc_note": f"TOC says {list(expected_pages)}, headings are on {pages}",
        }
    toc_text = " ".join(texts[:2])
    missing = [t for _l, t in entries if _norm(t) not in toc_text]
    if missing:
        return {
            "toc_verified": False,
            "toc_method": method,
            "toc_note": f"not listed in the printed contents: {missing[:3]}",
        }
    return {"toc_verified": True, "toc_method": method, "toc_note": ""}


def page_numbers_ok(pdf: bytes) -> bool | None:
    """Every checked page carries 'Page i of N' with the right i and N."""
    texts = page_texts(pdf)
    n = len(texts)
    if n == 0:
        return None
    for i in (1, 2, n):
        if i > n:
            continue
        if f"page {i} of {n}" not in _norm(texts[i - 1]):
            return False
    return True


def ink_ratio(png: bytes) -> float:
    """Share of dark pixels on a rasterised page, ignoring the footer band (a
    'Page 2 of 3' on an otherwise empty page is still an empty page)."""
    from PIL import Image

    img = Image.open(io.BytesIO(png)).convert("L")
    w, h = img.size
    img = img.crop((0, 0, w, int(h * 0.92)))
    img.thumbnail((800, 800))
    hist = img.histogram()
    total = sum(hist) or 1
    dark = sum(hist[:200])  # anything darker than near-white
    return dark / total


def blank_pages(pngs: list[bytes]) -> list[int]:
    """1-based indexes of rasterised pages with essentially no ink."""
    out: list[int] = []
    for i, png in enumerate(pngs, 1):
        try:
            if ink_ratio(png) < _BLANK_INK:
                out.append(i)
        except Exception:  # noqa: BLE001,S112
            continue
    return out

"""Document renderers: pdf, docx, txt, md, html, rtf.

The unified `FileSpec.sections` model drives every one: heading (by level),
paragraphs, bullet/numbered lists, tables, an embedded chart, and a caption, with
optional page breaks. PDF (reportlab) and DOCX (python-docx) run in the pool and embed
DejaVuSans (Unicode/CJK/emoji-safe); txt/md/html/rtf are inline text.
"""

from __future__ import annotations

import html as _html
import io
from typing import Any

from app.filegen.charts import render_chart
from app.filegen.spec import FileSpec, Section

_FONT_REGISTERED = False


def _paras(text: str) -> list[str]:
    return [p.strip() for p in (text or "").split("\n\n") if p.strip()]


def _rows_as_str(section: Section) -> tuple[list[str], list[list[str]]]:
    t = section.table
    if not t:
        return [], []
    cols = [str(c) for c in t.columns]
    rows = [["" if c is None else str(c) for c in r] for r in t.rows]
    return cols, rows


# --- PDF (reportlab, pool) -------------------------------------------------
def _register_fonts() -> str:
    global _FONT_REGISTERED
    if _FONT_REGISTERED:
        return "DejaVuSans"
    import os

    import matplotlib
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    base = os.path.join(
        os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf"
    )
    try:
        pdfmetrics.registerFont(
            TTFont("DejaVuSans", os.path.join(base, "DejaVuSans.ttf"))
        )
        pdfmetrics.registerFont(
            TTFont("DejaVuSans-Bold", os.path.join(base, "DejaVuSans-Bold.ttf"))
        )
        pdfmetrics.registerFont(
            TTFont("DejaVuSans-Oblique", os.path.join(base, "DejaVuSans-Oblique.ttf"))
        )
        from reportlab.pdfbase.pdfmetrics import registerFontFamily

        registerFontFamily(
            "DejaVuSans",
            normal="DejaVuSans",
            bold="DejaVuSans-Bold",
            italic="DejaVuSans-Oblique",
        )
        _FONT_REGISTERED = True
        return "DejaVuSans"
    except Exception:  # noqa: BLE001 — fall back to a built-in Latin font
        return "Helvetica"


def toc_entries(spec: FileSpec) -> list[tuple[int, str]]:
    """(level, heading) for every heading a table of contents lists: levels 1-3."""
    return [
        (sec.level, sec.heading.strip())
        for sec in spec.sections
        if sec.heading and sec.heading.strip() and sec.level <= 3
    ]


def render_pdf(spec: FileSpec) -> tuple[bytes, str]:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import cm
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.platypus import (
        Image,
        ListFlowable,
        ListItem,
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )
    from reportlab.platypus.tableofcontents import TableOfContents

    from app.filegen.mime import mime_for

    class Doc(SimpleDocTemplate):
        """Notifies the TOC and writes the PDF OUTLINE on every heading, rewinds the
        BytesIO before each pass (the canvas would otherwise append a second PDF to
        the buffer), and remembers the page count of the pass that just finished —
        which is what the NEXT pass prints as the 'of Y' in the footer."""

        total_pages: int | None = None

        def build(self, flowables, **kw):  # noqa: D102
            f = getattr(self, "filename", None)
            if hasattr(f, "seek") and hasattr(f, "truncate"):
                f.seek(0)
                f.truncate()
            self._outline_n = 0
            out = super().build(flowables, **kw)
            self.total_pages = self.page
            return out

        def afterFlowable(self, flowable):  # noqa: N802 — reportlab's hook
            entry = getattr(flowable, "_toc", None)
            if entry is None:
                return
            level, text = entry
            self.notify("TOCEntry", (level, text, self.page))
            self._outline_n = getattr(self, "_outline_n", 0) + 1
            key = f"h{self._outline_n}"
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(text, key, level=level, closed=False)

    def footer(canv: rl_canvas.Canvas, doc: Doc) -> None:
        """'Page X of Y'. Y comes from the previous layout pass (the page count
        of a converged multiBuild is stable), so the final pass prints it right.
        NOT the buffered-canvas recipe: that one draws every page on save() and
        pins every bookmark to page 1, which would break the outline."""
        total = doc.total_pages
        canv.saveState()
        canv.setFont(font, 8.5)
        canv.setFillColorRGB(0.39, 0.45, 0.55)
        canv.drawRightString(
            A4[0] - 2 * cm, 1.1 * cm, f"Page {doc.page} of {total or '?'}"
        )
        canv.restoreState()

    font = _register_fonts()
    bold = f"{font}-Bold" if font == "DejaVuSans" else "Helvetica-Bold"
    ss = getSampleStyleSheet()

    def style(name, size, space_before=0, space_after=6, bold_=False, color="#0f172a"):
        return ParagraphStyle(
            name,
            parent=ss["Normal"],
            fontName=bold if bold_ else font,
            fontSize=size,
            leading=size * 1.35,
            spaceBefore=space_before,
            spaceAfter=space_after,
            textColor=colors.HexColor(color),
            alignment=TA_LEFT,
        )

    body = style("body", 10.5, space_after=8)
    caption = style("cap", 8.5, space_after=10, color="#64748b")
    heads = {
        i: style(
            f"h{i}", max(11, 20 - 2 * i), space_before=12, space_after=6, bold_=True
        )
        for i in range(1, 7)
    }

    flow: list = []
    # THE TABLE OF CONTENTS is a real flowable whose page numbers come from the
    # pages the headings actually land on: `Doc.afterFlowable` notifies it on
    # every heading and `multiBuild` re-runs the layout until the numbers are
    # stable. The same hook writes the PDF OUTLINE, which is what verification
    # reads back — an exact page per heading, not a text match.
    toc = None
    if spec.toc and toc_entries(spec):
        toc = TableOfContents()
        toc.levelStyles = [
            style("toc1", 11, space_before=4, space_after=2, bold_=True),
            ParagraphStyle(
                "toc2", parent=style("toc2b", 10, space_after=1), leftIndent=14
            ),
            ParagraphStyle(
                "toc3", parent=style("toc3b", 9.5, space_after=1), leftIndent=28
            ),
        ]
        toc.dotsMinLevel = 0
    if spec.title:
        flow.append(
            Paragraph(_esc(spec.title), style("title", 22, bold_=True, space_after=4))
        )
    if spec.subtitle:
        flow.append(
            Paragraph(
                _esc(spec.subtitle), style("sub", 13, color="#475569", space_after=14)
            )
        )
    elif spec.title:
        flow.append(Spacer(1, 0.4 * cm))
    if toc is not None:
        flow.append(Paragraph("Contents", heads[1]))
        flow.append(toc)
        flow.append(PageBreak())

    for sec in spec.sections:
        if sec.page_break_before and flow:
            flow.append(PageBreak())
        if sec.heading:
            head = Paragraph(_esc(sec.heading), heads[sec.level])
            if toc is not None and sec.level <= 3:
                # What afterFlowable reads: the TOC level and the plain text.
                # Only with a TOC: a plain document stays byte-identical.
                head._toc = (sec.level - 1, sec.heading.strip())
            flow.append(head)
        for p in _paras(sec.text):
            flow.append(Paragraph(_esc(p), body))
        if sec.bullets:
            items = [
                ListItem(Paragraph(_esc(b), body), leftIndent=10) for b in sec.bullets
            ]
            flow.append(
                ListFlowable(
                    items,
                    bulletType="1" if sec.ordered else "bullet",
                    bulletFontName=font,
                    leftIndent=14,
                )
            )
        cols, rows = _rows_as_str(sec)
        if cols or rows:
            data = (
                [
                    [
                        Paragraph(
                            _esc(c), style("th", 9.5, bold_=True, color="#ffffff")
                        )
                        for c in cols
                    ]
                ]
                if cols
                else []
            ) + [[Paragraph(_esc(c), style("td", 9)) for c in r] for r in rows[:200]]
            if data:
                tbl = Table(data, repeatRows=1 if cols else 0, hAlign="LEFT")
                ts = [
                    ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cbd5e1")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 5),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]
                if cols:
                    ts.append(
                        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2563eb"))
                    )
                    ts.append(
                        (
                            "ROWBACKGROUNDS",
                            (0, 1),
                            (-1, -1),
                            [colors.white, colors.HexColor("#f1f5f9")],
                        )
                    )
                tbl.setStyle(TableStyle(ts))
                flow.append(Spacer(1, 0.2 * cm))
                flow.append(tbl)
        if sec.chart is not None:
            png = render_chart(sec.chart, "png")
            img = Image(io.BytesIO(png))
            max_w = 16 * cm
            if img.imageWidth > max_w:
                img.drawHeight = img.imageHeight * max_w / img.imageWidth
                img.drawWidth = max_w
            flow.append(Spacer(1, 0.2 * cm))
            flow.append(img)
        if sec.caption:
            flow.append(Paragraph(_esc(sec.caption), caption))

    if not flow:
        flow.append(Paragraph("(empty document)", body))

    buf = io.BytesIO()
    doc = Doc(
        buf,
        pagesize=A4,
        leftMargin=2 * cm,
        rightMargin=2 * cm,
        topMargin=2 * cm,
        bottomMargin=2 * cm,
        title=spec.title or None,
        author=spec.author or None,
    )
    pages = {"onFirstPage": footer, "onLaterPages": footer} if spec.page_numbers else {}
    if toc is not None:
        # Passes until the TOC entries are stable; the last pass therefore has the
        # same page count as the one before it, so its footer total is right.
        doc.multiBuild(flow, **pages)
    elif spec.page_numbers:
        # build() CONSUMES the story list; each pass gets its own copy.
        doc.build(list(flow), **pages)  # pass 1: count
        doc.build(list(flow), **pages)  # pass 2: draw with the real total
    else:
        doc.build(flow)  # byte-identical to before when neither flag is set
    return buf.getvalue(), mime_for("pdf")


def _esc(s: Any) -> str:
    # reportlab Paragraph parses mini-HTML; escape so model text can't inject tags.
    return _html.escape(str(s)).replace("\n", "<br/>")


# --- DOCX (python-docx, pool) ---------------------------------------------
def _docx_field(paragraph, instr: str, placeholder: str) -> None:
    """A Word FIELD (PAGE, NUMPAGES, TOC): begin / instrText / separate /
    placeholder / end. Word and LibreOffice compute it at layout time."""
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    def _char(kind: str) -> None:
        r = paragraph.add_run()
        el = OxmlElement("w:fldChar")
        el.set(qn("w:fldCharType"), kind)
        r._r.append(el)

    _char("begin")
    r = paragraph.add_run()
    it = OxmlElement("w:instrText")
    it.set(qn("xml:space"), "preserve")
    it.text = instr
    r._r.append(it)
    _char("separate")
    paragraph.add_run(placeholder)
    _char("end")


def render_docx(spec: FileSpec) -> tuple[bytes, str]:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT, WD_TAB_LEADER
    from docx.shared import Inches, Pt, RGBColor

    from app.filegen.mime import mime_for

    doc = Document()
    if spec.title:
        doc.add_heading(spec.title, level=0)
    if spec.subtitle:
        p = doc.add_paragraph()
        run = p.add_run(spec.subtitle)
        run.italic = True
        run.font.size = Pt(13)
        run.font.color.rgb = RGBColor(0x47, 0x55, 0x69)

    # PAGE NUMBERS: real fields in the footer, computed by whatever opens the file.
    if spec.page_numbers:
        foot = doc.sections[0].footer.paragraphs[0]
        foot.alignment = WD_ALIGN_PARAGRAPH.CENTER
        foot.add_run("Page ")
        _docx_field(foot, " PAGE ", "1")
        foot.add_run(" of ")
        _docx_field(foot, " NUMPAGES ", "1")

    # TABLE OF CONTENTS. python-docx cannot lay pages out, so the numbers come
    # from a rendered pass: the executor converts a first pass with LibreOffice,
    # reads the page each heading landed on, and re-renders with `toc_pages` so
    # the TOC is STATIC text that every viewer shows the same way. Both passes
    # emit one line per heading, so pagination cannot shift between them.
    # `toc_pages is None` = no LibreOffice: a TOC FIELD that Word fills on open.
    entries = toc_entries(spec) if spec.toc else []
    if entries:
        doc.add_heading("Contents", level=1)
        pages = spec.toc_pages
        if pages is None:
            p = doc.add_paragraph()
            _docx_field(
                p,
                ' TOC \\o "1-3" \\h \\z \\u ',
                "Table of contents — press F9 (Word) or Tools ▸ Update (LibreOffice).",
            )
        else:
            for i, (level, text) in enumerate(entries):
                p = doc.add_paragraph()
                p.paragraph_format.left_indent = Inches(0.25 * (level - 1))
                p.paragraph_format.space_after = Pt(2)
                p.paragraph_format.tab_stops.add_tab_stop(
                    Inches(6.0), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS
                )
                p.add_run(text)
                num = str(pages[i]) if i < len(pages) else "…"
                p.add_run("\t" + num)
        doc.add_page_break()

    for sec in spec.sections:
        if sec.page_break_before:
            doc.add_page_break()
        if sec.heading:
            doc.add_heading(sec.heading, level=min(sec.level, 5))
        for para in _paras(sec.text):
            doc.add_paragraph(para)
        for b in sec.bullets:
            doc.add_paragraph(
                str(b), style="List Number" if sec.ordered else "List Bullet"
            )
        cols, rows = _rows_as_str(sec)
        if cols or rows:
            ncol = len(cols) if cols else (len(rows[0]) if rows else 1)
            table = doc.add_table(rows=0, cols=ncol)
            table.style = "Light Grid Accent 1"
            if cols:
                hdr = table.add_row().cells
                for i, c in enumerate(cols[:ncol]):
                    hdr[i].text = c
                    for p in hdr[i].paragraphs:
                        for r in p.runs:
                            r.bold = True
            for row in rows[:500]:
                cells = table.add_row().cells
                for i, val in enumerate(row[:ncol]):
                    cells[i].text = str(val)
        if sec.chart is not None:
            png = render_chart(sec.chart, "png")
            doc.add_picture(io.BytesIO(png), width=Inches(6.0))
        if sec.caption:
            cap = doc.add_paragraph()
            run = cap.add_run(sec.caption)
            run.italic = True
            run.font.size = Pt(9)
            run.font.color.rgb = RGBColor(0x64, 0x74, 0x8B)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue(), mime_for("docx")


# --- txt / md / html / rtf (inline) ---------------------------------------
def _section_lines_md(spec: FileSpec) -> list[str]:
    out: list[str] = []
    if spec.title:
        out.append(f"# {spec.title}")
    if spec.subtitle:
        out.append(f"*{spec.subtitle}*")
    for sec in spec.sections:
        out.append("")
        if sec.heading:
            out.append(f"{'#' * min(sec.level + 1, 6)} {sec.heading}")
        for p in _paras(sec.text):
            out.append(p)
        for b in sec.bullets:
            out.append(f"{'1.' if sec.ordered else '-'} {b}")
        cols, rows = _rows_as_str(sec)
        if cols:
            out.append("| " + " | ".join(cols) + " |")
            out.append("| " + " | ".join(["---"] * len(cols)) + " |")
            for r in rows:
                out.append(
                    "| " + " | ".join(str(c).replace("|", "\\|") for c in r) + " |"
                )
        if sec.caption:
            out.append(f"*{sec.caption}*")
    return out


def render_md(spec: FileSpec) -> tuple[bytes, str]:
    from app.filegen.mime import mime_for

    text = spec.body.strip() or "\n".join(_section_lines_md(spec))
    return (text + "\n").encode("utf-8"), mime_for("md")


def render_txt(spec: FileSpec) -> tuple[bytes, str]:
    from app.filegen.mime import mime_for

    if spec.body.strip():
        return (spec.body.rstrip() + "\n").encode("utf-8"), mime_for("txt")
    lines: list[str] = []
    if spec.title:
        lines += [spec.title, "=" * len(spec.title), ""]
    for sec in spec.sections:
        if sec.heading:
            lines += [sec.heading, "-" * len(sec.heading)]
        for p in _paras(sec.text):
            lines += [p, ""]
        for b in sec.bullets:
            lines.append(f"  * {b}")
        cols, rows = _rows_as_str(sec)
        if cols:
            lines.append("  " + " | ".join(cols))
        for r in rows:
            lines.append("  " + " | ".join(str(c) for c in r))
        if sec.caption:
            lines.append(f"  ({sec.caption})")
        lines.append("")
    return ("\n".join(lines).rstrip() + "\n").encode("utf-8"), mime_for("txt")


def render_html(spec: FileSpec) -> tuple[bytes, str]:
    from app.filegen.mime import mime_for

    def e(s: Any) -> str:
        return _html.escape(str(s))

    parts = [
        '<!doctype html><html lang="en"><head><meta charset="utf-8">',
        f"<title>{e(spec.title or 'Document')}</title>",
        "<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;"
        "max-width:820px;margin:2rem auto;padding:0 1rem;color:#0f172a;line-height:1.6}"
        "h1{font-size:2rem}table{border-collapse:collapse;width:100%;margin:1rem 0}"
        "th,td{border:1px solid #cbd5e1;padding:.4rem .6rem;text-align:left}"
        "th{background:#2563eb;color:#fff}tr:nth-child(even){background:#f1f5f9}"
        "figcaption{color:#64748b;font-size:.9rem}img{max-width:100%}</style></head><body>",
    ]
    if spec.body.strip():
        parts.append(spec.body)  # trusted structured body from our own md path only
    else:
        if spec.title:
            parts.append(f"<h1>{e(spec.title)}</h1>")
        if spec.subtitle:
            parts.append(f"<p><em>{e(spec.subtitle)}</em></p>")
        for sec in spec.sections:
            if sec.heading:
                hl = min(sec.level + 1, 6)
                parts.append(f"<h{hl}>{e(sec.heading)}</h{hl}>")
            for p in _paras(sec.text):
                parts.append(f"<p>{e(p)}</p>")
            if sec.bullets:
                tag = "ol" if sec.ordered else "ul"
                parts.append(
                    f"<{tag}>"
                    + "".join(f"<li>{e(b)}</li>" for b in sec.bullets)
                    + f"</{tag}>"
                )
            cols, rows = _rows_as_str(sec)
            if cols or rows:
                parts.append("<table>")
                if cols:
                    parts.append(
                        "<tr>" + "".join(f"<th>{e(c)}</th>" for c in cols) + "</tr>"
                    )
                for r in rows:
                    parts.append(
                        "<tr>" + "".join(f"<td>{e(c)}</td>" for c in r) + "</tr>"
                    )
                parts.append("</table>")
            if sec.caption:
                parts.append(f"<figcaption>{e(sec.caption)}</figcaption>")
    parts.append("</body></html>")
    return "".join(parts).encode("utf-8"), mime_for("html")


def render_rtf(spec: FileSpec) -> tuple[bytes, str]:
    from app.filegen.mime import mime_for

    def esc(s: Any) -> str:
        out = []
        for ch in str(s):
            if ch in "\\{}":
                out.append("\\" + ch)
            elif ord(ch) > 127:
                out.append(f"\\u{ord(ch)}?")
            elif ch == "\n":
                out.append("\\par ")
            else:
                out.append(ch)
        return "".join(out)

    lines = [r"{\rtf1\ansi\deff0{\fonttbl{\f0 Helvetica;}}\fs22"]
    if spec.title:
        lines.append(r"{\b\fs36 " + esc(spec.title) + r"}\par\par")
    for sec in spec.sections:
        if sec.heading:
            lines.append(r"{\b\fs28 " + esc(sec.heading) + r"}\par")
        for p in _paras(sec.text):
            lines.append(esc(p) + r"\par")
        for b in sec.bullets:
            lines.append(r"\bullet\tab " + esc(b) + r"\par")
        cols, rows = _rows_as_str(sec)
        if cols:
            lines.append(r"{\b " + esc(" | ".join(cols)) + r"}\par")
        for r in rows:
            lines.append(esc(" | ".join(str(c) for c in r)) + r"\par")
        if sec.caption:
            lines.append(r"{\i " + esc(sec.caption) + r"}\par")
        lines.append(r"\par")
    lines.append("}")
    return "\n".join(lines).encode("utf-8"), mime_for("rtf")

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


def render_pdf(spec: FileSpec) -> tuple[bytes, str]:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import cm
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

    from app.filegen.mime import mime_for

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

    for sec in spec.sections:
        if sec.page_break_before and flow:
            flow.append(PageBreak())
        if sec.heading:
            flow.append(Paragraph(_esc(sec.heading), heads[sec.level]))
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
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=2 * cm,
        rightMargin=2 * cm,
        topMargin=2 * cm,
        bottomMargin=2 * cm,
        title=spec.title or None,
        author=spec.author or None,
    )
    doc.build(flow)
    return buf.getvalue(), mime_for("pdf")


def _esc(s: Any) -> str:
    # reportlab Paragraph parses mini-HTML; escape so model text can't inject tags.
    return _html.escape(str(s)).replace("\n", "<br/>")


# --- DOCX (python-docx, pool) ---------------------------------------------
def render_docx(spec: FileSpec) -> tuple[bytes, str]:
    from docx import Document
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

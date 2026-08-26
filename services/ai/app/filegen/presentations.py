"""Presentation renderer: pptx (python-pptx).

A title slide (when the deck has a title) plus one slide per `Slide`: title, bullets
(with sub-levels from indentation), an optional table, an embedded chart image, and
speaker notes. Runs in the pool (python-pptx + Pillow image handling).
"""

from __future__ import annotations

import io

from app.filegen.charts import render_chart
from app.filegen.spec import FileSpec, Slide


def render_pptx(spec: FileSpec) -> tuple[bytes, str]:
    from pptx import Presentation
    from pptx.util import Emu, Inches, Pt

    from app.filegen.mime import mime_for

    prs = Presentation()
    prs.slide_width = Inches(13.333)  # 16:9
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]
    title_layout = prs.slide_layouts[0]
    content_layout = prs.slide_layouts[1]

    slides: list[Slide] = spec.slides or _slides_from_sections(spec)

    if spec.title:
        s = prs.slides.add_slide(title_layout)
        s.shapes.title.text = spec.title
        if s.placeholders and len(s.placeholders) > 1 and spec.subtitle:
            s.placeholders[1].text = spec.subtitle

    for slide in slides:
        has_extra = slide.table is not None or slide.chart is not None
        layout = blank if has_extra else content_layout
        s = prs.slides.add_slide(layout)
        # Title
        if layout is content_layout and s.shapes.title is not None:
            s.shapes.title.text = slide.title or ""
        else:
            box = s.shapes.add_textbox(Inches(0.6), Inches(0.3), Inches(12), Inches(1))
            tf = box.text_frame
            tf.text = slide.title or ""
            tf.paragraphs[0].font.size = Pt(30)
            tf.paragraphs[0].font.bold = True

        # Bullets / text
        bullets = list(slide.bullets)
        if slide.text.strip():
            bullets = [*slide.text.strip().split("\n"), *bullets]
        if bullets and layout is content_layout and len(s.placeholders) > 1:
            body = s.placeholders[1].text_frame
            body.clear()
            for i, b in enumerate(bullets):
                para = body.paragraphs[0] if i == 0 else body.add_paragraph()
                para.text = str(b).lstrip("-• ").strip()
                para.level = min(4, (len(b) - len(b.lstrip(" "))) // 2)
                para.font.size = Pt(18)
        elif bullets:
            box = s.shapes.add_textbox(Inches(0.6), Inches(1.4), Inches(6), Inches(5))
            tf = box.text_frame
            tf.word_wrap = True
            for i, b in enumerate(bullets):
                para = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
                para.text = "• " + str(b).lstrip("-• ").strip()
                para.font.size = Pt(18)

        # Table
        if slide.table is not None and (slide.table.columns or slide.table.rows):
            cols = [str(c) for c in slide.table.columns]
            rows = [
                [("" if c is None else str(c)) for c in r]
                for r in slide.table.rows[:12]
            ]
            ncol = len(cols) or (len(rows[0]) if rows else 1)
            nrow = (1 if cols else 0) + len(rows)
            left = Inches(6.9) if slide.chart is None else Inches(0.6)
            gt = s.shapes.add_table(
                max(1, nrow),
                max(1, ncol),
                left,
                Inches(1.6),
                Inches(6),
                Inches(0.4 * nrow),
            ).table
            r0 = 0
            if cols:
                for c, name in enumerate(cols):
                    gt.cell(0, c).text = name
                r0 = 1
            for ri, row in enumerate(rows):
                for c, val in enumerate(row[:ncol]):
                    gt.cell(r0 + ri, c).text = val

        # Chart image
        if slide.chart is not None:
            png = render_chart(slide.chart, "png")
            s.shapes.add_picture(
                io.BytesIO(png), Inches(6.9), Inches(1.6), width=Inches(6.0)
            )

        # Notes
        if slide.notes.strip():
            s.notes_slide.notes_text_frame.text = slide.notes.strip()

    if not prs.slides:
        s = prs.slides.add_slide(title_layout)
        s.shapes.title.text = spec.title or "Presentation"

    _ = (Emu,)  # keep import meaningful across python-pptx versions
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue(), mime_for("pptx")


def _slides_from_sections(spec: FileSpec) -> list[Slide]:
    """A document spec asked to be a deck → one slide per section."""
    out: list[Slide] = []
    for sec in spec.sections:
        text_bullets = sec.bullets or [
            p for p in (sec.text or "").split("\n\n") if p.strip()
        ]
        out.append(
            Slide(
                title=sec.heading or spec.title,
                bullets=text_bullets[:8],
                table=sec.table,
                chart=sec.chart,
                notes=sec.caption,
            )
        )
    return out or [Slide(title=spec.title, text=spec.body)]

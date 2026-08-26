"""Image renderers: png / jpeg / webp / svg.

An image request is usually a chart (→ charts.py) or a table rendered as an image.
JPEG/WebP are produced by rendering a PNG with matplotlib/Pillow then re-encoding
through Pillow (which the service already depends on), so aspect ratio and DPI are
preserved and never stretched.
"""

from __future__ import annotations

import io

from app.filegen.charts import render_chart
from app.filegen.spec import FileSpec


def _first_table(spec: FileSpec):
    if spec.sheets and (spec.sheets[0].columns or spec.sheets[0].rows):
        s = spec.sheets[0]
        return s.columns, s.rows
    for sec in spec.sections:
        if sec.table and (sec.table.columns or sec.table.rows):
            return sec.table.columns, sec.table.rows
    return None


def _table_png(title: str, columns: list[str], rows: list[list]) -> bytes:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    n_rows = min(len(rows), 60)
    fig, ax = plt.subplots(
        figsize=(min(16, 2 + 1.6 * max(1, len(columns))), 1 + 0.4 * (n_rows + 1)),
        dpi=144,
    )
    ax.axis("off")
    if title:
        ax.set_title(title, fontsize=13, fontweight="bold", pad=12)
    cells = [[str(c) for c in r] for r in rows[:n_rows]]
    tbl = ax.table(
        cellText=cells or [[""]],
        colLabels=columns or None,
        loc="center",
        cellLoc="left",
    )
    tbl.auto_set_font_size(False)
    tbl.set_fontsize(9)
    tbl.scale(1, 1.3)
    if columns:
        for c in range(len(columns)):
            cell = tbl[0, c]
            cell.set_facecolor("#2563eb")
            cell.set_text_props(color="white", fontweight="bold")
    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    return buf.getvalue()


def _title_card_png(title: str, subtitle: str) -> bytes:
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (1200, 630), "#0f172a")
    d = ImageDraw.Draw(img)
    d.text((60, 260), title or "Untitled", fill="#ffffff")
    if subtitle:
        d.text((60, 320), subtitle, fill="#94a3b8")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _base_png(spec: FileSpec) -> bytes:
    if spec.chart is not None:
        return render_chart(spec.chart, "png")
    tbl = _first_table(spec)
    if tbl is not None:
        return _table_png(spec.title, tbl[0], tbl[1])
    return _title_card_png(spec.title, spec.subtitle)


def render_image(spec: FileSpec) -> tuple[bytes, str]:
    from app.filegen.mime import mime_for

    fmt = spec.format
    if fmt == "svg":
        # SVG only from a chart; fall back to a chart-less placeholder chart frame.
        if spec.chart is not None:
            return render_chart(spec.chart, "svg"), mime_for("svg")
        # Wrap a rendered PNG table/card as an <image> in an SVG envelope.
        import base64

        png = _base_png(spec)
        b64 = base64.b64encode(png).decode()
        svg = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink='
            '"http://www.w3.org/1999/xlink" width="1200" height="630">'
            '<image width="1200" height="630" '
            f'xlink:href="data:image/png;base64,{b64}"/>'
            "</svg>"
        )
        return svg.encode("utf-8"), mime_for("svg")

    png = _base_png(spec)
    if fmt == "png":
        return png, mime_for("png")

    # jpeg / webp — re-encode the PNG through Pillow (no stretching).
    from PIL import Image

    img = Image.open(io.BytesIO(png))
    buf = io.BytesIO()
    if fmt == "jpeg":
        img.convert("RGB").save(buf, format="JPEG", quality=90, optimize=True)
    else:  # webp
        img.save(buf, format="WEBP", quality=90, method=4)
    return buf.getvalue(), mime_for(fmt)

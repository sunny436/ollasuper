"""Spreadsheet + structured-data renderers.

xlsx = openpyxl (styled headers, auto width, NATIVE openpyxl charts so they stay
editable in Excel). csv/tsv/json/xml/yaml = stdlib/pyyaml (pure text, rendered inline
off the pool). All take a `[columns], [[rows]]` view derived from `sheets`/`data`.
"""

from __future__ import annotations

import csv
import io
import json
from typing import Any

from app.filegen.spec import FileSpec, Sheet


def _cell(v: Any) -> Any:
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    return str(v)


def _tabular(spec: FileSpec) -> tuple[list[str], list[list[Any]]]:
    """A single (columns, rows) view for the flat data formats, from the first
    sheet, else a section table, else `data` (list-of-dicts / list-of-lists)."""
    if spec.sheets:
        s = spec.sheets[0]
        return list(s.columns), [list(r) for r in s.rows]
    for sec in spec.sections:
        if sec.table and (sec.table.columns or sec.table.rows):
            return list(sec.table.columns), [list(r) for r in sec.table.rows]
    data = spec.data
    if isinstance(data, list) and data and isinstance(data[0], dict):
        cols = list({k for row in data for k in row})
        return cols, [[row.get(c) for c in cols] for row in data]
    if isinstance(data, list) and data and isinstance(data[0], (list, tuple)):
        return [], [list(r) for r in data]
    return [], []


# --- xlsx (openpyxl, pool) -------------------------------------------------
def _add_native_chart(ws, chart_spec, columns, n_rows):
    from openpyxl.chart import (
        AreaChart,
        BarChart,
        LineChart,
        PieChart,
        Reference,
        ScatterChart,
    )

    kind = {
        "bar": BarChart,
        "line": LineChart,
        "area": AreaChart,
        "pie": PieChart,
        "donut": PieChart,
        "scatter": ScatterChart,
        "histogram": BarChart,
    }.get(chart_spec.type, BarChart)
    chart = kind()
    chart.title = chart_spec.title or None
    if n_rows < 2 or len(columns) < 2:
        return
    data = Reference(ws, min_col=2, min_row=1, max_col=len(columns), max_row=n_rows)
    cats = Reference(ws, min_col=1, min_row=2, max_row=n_rows)
    chart.add_data(data, titles_from_data=True)
    if not isinstance(chart, PieChart):
        chart.set_categories(cats)
    chart.height, chart.width = 9, 18
    ws.add_chart(chart, f"A{n_rows + 3}")


def render_xlsx(spec: FileSpec) -> tuple[bytes, str]:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    from app.filegen.mime import mime_for

    _cols, _rows = _tabular(spec)
    sheets: list[Sheet] = spec.sheets or [
        Sheet(name=(spec.title or "Sheet1")[:31] or "Sheet1", columns=_cols, rows=_rows)
    ]
    wb = Workbook()
    wb.remove(wb.active)
    header_fill = PatternFill("solid", fgColor="2563EB")
    header_font = Font(color="FFFFFF", bold=True)
    for i, sh in enumerate(sheets):
        cols, rows = (list(sh.columns), [list(r) for r in sh.rows])
        if not cols and not rows:
            cols, rows = _tabular(spec)
        title = (sh.name or f"Sheet{i + 1}")[:31] or f"Sheet{i + 1}"
        ws = wb.create_sheet(title=title)
        r = 1
        if cols:
            for c, name in enumerate(cols, start=1):
                cell = ws.cell(row=1, column=c, value=str(name))
                cell.fill = header_fill
                cell.font = header_font
                cell.alignment = Alignment(vertical="center")
            ws.freeze_panes = "A2"
            r = 2
        for row in rows:
            for c, val in enumerate(row, start=1):
                ws.cell(row=r, column=c, value=_cell(val))
            r += 1
        # Auto width (bounded) from header + sampled cells.
        for c in range(1, max(len(cols), 1) + 1):
            width = len(str(cols[c - 1])) if c - 1 < len(cols) else 8
            for row in rows[:200]:
                if c - 1 < len(row):
                    width = max(width, len(str(row[c - 1])))
            ws.column_dimensions[get_column_letter(c)].width = min(60, width + 2)
        if sh.chart is not None:
            _add_native_chart(ws, sh.chart, cols or [""], r - 1)
    if not wb.sheetnames:
        wb.create_sheet("Sheet1")
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue(), mime_for("xlsx")


# --- text data formats (inline) -------------------------------------------
def render_delimited(spec: FileSpec, delim: str, fmt: str) -> tuple[bytes, str]:
    from app.filegen.mime import mime_for

    cols, rows = _tabular(spec)
    out = io.StringIO()
    w = csv.writer(out, delimiter=delim, lineterminator="\n")
    if cols:
        w.writerow(cols)
    for row in rows:
        w.writerow(["" if v is None else v for v in row])
    return out.getvalue().encode("utf-8"), mime_for(fmt)


def _json_payload(spec: FileSpec) -> Any:
    if spec.data is not None:
        return spec.data
    cols, rows = _tabular(spec)
    if cols:
        return [dict(zip(cols, row, strict=False)) for row in rows]
    return {"title": spec.title, "rows": rows}


def render_json(spec: FileSpec) -> tuple[bytes, str]:
    from app.filegen.mime import mime_for

    text = json.dumps(_json_payload(spec), indent=2, ensure_ascii=False, default=str)
    return text.encode("utf-8"), mime_for("json")


def render_yaml(spec: FileSpec) -> tuple[bytes, str]:
    import yaml

    from app.filegen.mime import mime_for

    text = yaml.safe_dump(
        _json_payload(spec),
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    )
    return text.encode("utf-8"), mime_for("yaml")


def render_xml(spec: FileSpec) -> tuple[bytes, str]:
    from xml.sax.saxutils import escape

    from app.filegen.mime import mime_for

    cols, rows = _tabular(spec)
    lines = ['<?xml version="1.0" encoding="UTF-8"?>']
    root = _xml_name(spec.title) or "document"
    lines.append(f"<{root}>")
    if cols:
        for row in rows:
            lines.append("  <row>")
            for c, val in zip(cols, row, strict=False):
                tag = _xml_name(c) or "field"
                lines.append(
                    f"    <{tag}>{escape('' if val is None else str(val))}</{tag}>"
                )
            lines.append("  </row>")
    elif spec.data is not None:
        lines.append(f"  <data>{escape(json.dumps(spec.data, default=str))}</data>")
    lines.append(f"</{root}>")
    return "\n".join(lines).encode("utf-8"), mime_for("xml")


def _xml_name(s: str) -> str:
    import re

    name = re.sub(r"[^A-Za-z0-9_]+", "_", (s or "").strip()).strip("_")
    if name and name[0].isdigit():
        name = "_" + name
    return name[:64]

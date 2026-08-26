"""The structured file specification — the contract between the model and the
deterministic renderers.

ONE unified spec covers every format; each renderer reads the fields it needs
(documents read `sections`, spreadsheets `sheets`, presentations `slides`, a
chart/image reads `chart`, and text formats read `body`/`data`). The model fills
the relevant subset; unknown extras are ignored (a bad spec degrades, never crashes).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# --- format registry ------------------------------------------------------
FileFormat = Literal[
    "pdf",
    "docx",
    "txt",
    "md",
    "html",
    "rtf",
    "xlsx",
    "csv",
    "tsv",
    "json",
    "xml",
    "yaml",
    "pptx",
    "png",
    "jpeg",
    "webp",
    "svg",
]

ChartType = Literal["bar", "line", "pie", "donut", "scatter", "area", "histogram"]


class _Model(BaseModel):
    # Ignore unknown fields the model may hallucinate instead of 422-ing the turn.
    model_config = ConfigDict(extra="ignore")


class Series(_Model):
    name: str = ""
    values: list[float] = Field(default_factory=list)


class ChartSpec(_Model):
    type: ChartType = "bar"
    title: str = ""
    x_label: str = ""
    y_label: str = ""
    # x categories (bar/line/area/scatter) or slice labels (pie/donut).
    labels: list[str] = Field(default_factory=list)
    # One or more named y-series; `values` is a convenience single series.
    series: list[Series] = Field(default_factory=list)
    values: list[float] = Field(default_factory=list)


class Table(_Model):
    columns: list[str] = Field(default_factory=list)
    rows: list[list[Any]] = Field(default_factory=list)


class Section(_Model):
    heading: str = ""
    level: int = Field(default=1, ge=1, le=6)
    text: str = ""  # paragraphs separated by blank lines
    bullets: list[str] = Field(default_factory=list)
    ordered: bool = False  # numbered list instead of bulleted
    table: Table | None = None
    chart: ChartSpec | None = None
    caption: str = ""
    page_break_before: bool = False


class Sheet(_Model):
    name: str = "Sheet1"
    columns: list[str] = Field(default_factory=list)
    rows: list[list[Any]] = Field(default_factory=list)
    chart: ChartSpec | None = None


class Slide(_Model):
    title: str = ""
    subtitle: str = ""
    text: str = ""
    bullets: list[str] = Field(default_factory=list)
    table: Table | None = None
    chart: ChartSpec | None = None
    notes: str = ""


class FileSpec(_Model):
    format: FileFormat
    filename: str = ""  # optional; derived from title when empty
    title: str = ""
    subtitle: str = ""
    author: str = ""
    # document / report body:
    sections: list[Section] = Field(default_factory=list)
    # spreadsheet:
    sheets: list[Sheet] = Field(default_factory=list)
    # presentation:
    slides: list[Slide] = Field(default_factory=list)
    # standalone chart/image:
    chart: ChartSpec | None = None
    # csv/tsv/json/xml/yaml raw payload when not naturally sectioned:
    data: Any = None
    # txt/md/html plain body:
    body: str = ""


def has_chart(spec: FileSpec) -> bool:
    """True if the spec references any chart (→ needs matplotlib → the process pool)."""
    if spec.chart is not None:
        return True
    if any(s.chart is not None for s in spec.sections):
        return True
    if any(s.chart is not None for s in spec.sheets):
        return True
    return any(s.chart is not None for s in spec.slides)

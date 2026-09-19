"""The structured file specification — the contract between the model and the
deterministic renderers.

ONE unified spec covers every format; each renderer reads the fields it needs
(documents read `sections`, spreadsheets `sheets`, presentations `slides`, a
chart/image reads `chart`, and text formats read `body`/`data`). The model fills
the relevant subset; unknown extras are ignored (a bad spec degrades, never crashes).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

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
CHART_TYPES: tuple[str, ...] = (
    "bar",
    "line",
    "pie",
    "donut",
    "scatter",
    "area",
    "histogram",
)
# Spellings the model uses for a type this renderer already has. PURE RENAMES —
# nothing here changes what a chart means. "doughnut" is Chart.js's name, which the
# inline-chart guidance in the system prompt teaches on every turn; the file tool
# rejected it (18.09.2026 audit, EV deck: the model then fell back to a pie).
CHART_ALIASES: dict[str, str] = {
    "doughnut": "donut",
    "ring": "donut",
    "column": "bar",
    "horizontalbar": "bar",
    "horizontal_bar": "bar",
    "bars": "bar",
    "lines": "line",
    "areas": "area",
}
_CHART_OPTION_KEYS = (
    "options",
    "plugins",
    "scales",
    "responsive",
    "backgroundColor",
    "borderColor",
    "borderWidth",
    "fill",
    "tension",
    "stacked",
)


def _num_list(values: object, where: str) -> list[float]:
    """Numbers only. A string that is not a number is an ERROR naming the value —
    "$12" is not silently parsed as 12."""
    if not isinstance(values, list):
        raise ValueError(f"{where} must be a list of numbers")
    out: list[float] = []
    for v in values:
        if isinstance(v, bool):
            raise ValueError(f"{where} contains a boolean, not a number")
        if isinstance(v, (int, float)):
            out.append(float(v))
            continue
        if isinstance(v, dict) and "y" in v:  # Chart.js scatter point {x, y}
            v = v["y"]
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                out.append(float(v))
                continue
        if isinstance(v, str):
            try:
                out.append(float(v.strip()))
                continue
            except ValueError:
                pass
        raise ValueError(f"{where} contains a non-numeric value: {v!r}")
    return out


def normalize_chart(raw: object) -> object:
    """Accept BOTH chart vocabularies the model knows, and turn them into ONE.

    Renames the type through CHART_ALIASES, maps the Chart.js shape (`data.labels`,
    `data.datasets[].label/data`, `options.plugins.title.text`, axis titles) onto
    `labels/series/title/x_label/y_label`, and REFUSES — with a message that names
    the problem — anything it would otherwise have to guess at: an unsupported type,
    a chart with no numeric data, both shapes at once, per-dataset types, a value
    that is not a number. Flat specs pass through unchanged (idempotent).
    Presentational Chart.js options are dropped and listed under `ignored` so the
    caller can report what did not carry over."""
    if not isinstance(raw, dict):
        return raw
    d = dict(raw)
    # --- type: alias or refuse -------------------------------------------
    t = d.get("type")
    if t is None or (isinstance(t, str) and not t.strip()):
        d["type"] = "bar"
    elif isinstance(t, str):
        key = t.strip().lower().replace("-", "").replace(" ", "")
        key = CHART_ALIASES.get(key, key)
        if key not in CHART_TYPES:
            raise ValueError(
                f"unsupported chart type {t!r}; supported: bar, line, pie, donut "
                "(alias doughnut), scatter, area, histogram"
            )
        d["type"] = key
    else:
        raise ValueError("chart type must be a string")
    # --- Chart.js shape -> flat shape -------------------------------------
    data = d.pop("data", None)
    datasets = d.pop("datasets", None)
    if isinstance(data, dict):
        if datasets is None:
            datasets = data.get("datasets")
        if not d.get("labels") and isinstance(data.get("labels"), list):
            d["labels"] = [str(x) for x in data["labels"]]
    if datasets is not None:
        if d.get("series") or d.get("values"):
            raise ValueError(
                "chart gives both `datasets` and `series`/`values`; use one shape"
            )
        if not isinstance(datasets, list):
            raise ValueError("`datasets` must be a list")
        series = []
        for i, ds in enumerate(datasets):
            if not isinstance(ds, dict):
                raise ValueError(f"datasets[{i}] must be an object")
            ds_type = ds.get("type")
            if isinstance(ds_type, str) and ds_type.strip():
                k = CHART_ALIASES.get(ds_type.strip().lower(), ds_type.strip().lower())
                if k != d["type"]:
                    raise ValueError(
                        "mixed chart types are not supported (dataset "
                        f"{i} is {ds_type!r}, chart is {d['type']!r})"
                    )
            series.append(
                {
                    "name": str(ds.get("label") or ds.get("name") or ""),
                    "values": _num_list(
                        ds.get("data", ds.get("values")), f"datasets[{i}].data"
                    ),
                }
            )
        d["series"] = series
    # `series` given as {"Revenue": [..]} -> named list
    if isinstance(d.get("series"), dict):
        d["series"] = [{"name": str(k), "values": v} for k, v in d["series"].items()]
    # --- titles carried in Chart.js options --------------------------------
    opts = d.get("options")
    ignored: list[str] = []
    if isinstance(opts, dict):
        plugins = opts.get("plugins") if isinstance(opts.get("plugins"), dict) else {}
        title = plugins.get("title") if isinstance(plugins.get("title"), dict) else {}
        if not d.get("title") and isinstance(title.get("text"), str):
            d["title"] = title["text"]
        scales = opts.get("scales") if isinstance(opts.get("scales"), dict) else {}
        for axis, field_name in (("x", "x_label"), ("y", "y_label")):
            ax = scales.get(axis) if isinstance(scales.get(axis), dict) else {}
            at = ax.get("title") if isinstance(ax.get("title"), dict) else {}
            if not d.get(field_name) and isinstance(at.get("text"), str):
                d[field_name] = at["text"]
        for k in opts:
            if k not in ("plugins", "scales"):
                ignored.append(f"options.{k}")
        if "indexAxis" in opts:
            ignored.append("options.indexAxis")
    for k in _CHART_OPTION_KEYS:
        if k in d and k != "options":
            ignored.append(k)
            d.pop(k, None)
    d.pop("options", None)
    # --- values must be numbers, and there must be some -------------------
    if "values" in d and d["values"] is not None:
        d["values"] = _num_list(d["values"], "values")
    if isinstance(d.get("series"), list):
        fixed = []
        for i, srs in enumerate(d["series"]):
            if isinstance(srs, dict) and "values" in srs and srs["values"] is not None:
                srs = dict(srs)
                srs["values"] = _num_list(srs["values"], f"series[{i}].values")
            fixed.append(srs)
        d["series"] = fixed
    if ignored:
        d["_ignored"] = sorted(set(ignored))
    return d


class _Model(BaseModel):
    # Ignore unknown fields the model may hallucinate instead of 422-ing the turn.
    model_config = ConfigDict(extra="ignore")


class Series(_Model):
    name: str = ""
    values: list[float] = Field(default_factory=list)


class ChartSpec(_Model):
    # populate_by_name so a dumped spec (field name `ignored`) re-validates in the
    # pool worker without losing the list the executor reports.
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    type: ChartType = "bar"
    # Chart.js option keys that were dropped by normalization — reported, never
    # silently lost. Not part of the tool schema; filled by `normalize_chart`.
    ignored: list[str] = Field(default_factory=list, alias="_ignored")

    @model_validator(mode="before")
    @classmethod
    def _normalize(cls, raw: object) -> object:
        return normalize_chart(raw)

    title: str = ""
    x_label: str = ""
    y_label: str = ""
    # x categories (bar/line/area/scatter) or slice labels (pie/donut).
    labels: list[str] = Field(default_factory=list)
    # One or more named y-series; `values` is a convenience single series.
    series: list[Series] = Field(default_factory=list)
    values: list[float] = Field(default_factory=list)


def chart_has_data(chart: ChartSpec) -> bool:
    return bool(chart.values) or any(bool(s.values) for s in chart.series)


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
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
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
    # pdf/docx: "Page X of Y" footer, and a table of contents from the headings.
    page_numbers: bool = False
    toc: bool = False
    # INTERNAL (not in the tool schema): the page each heading landed on in a
    # rendered pass, so the DOCX renderer can write a STATIC table of contents
    # with real numbers. Filled by the executor between the two LibreOffice passes.
    toc_pages: list[int] | None = Field(default=None, alias="_toc_pages")

    @model_validator(mode="after")
    def _charts_have_data(self) -> FileSpec:
        """A chart in a document, slide or standalone image must carry numbers —
        an empty one used to render as a blank picture and count as success. A
        SHEET chart is exempt: it plots the sheet's own rows."""
        holders = [("chart", self.chart)]
        holders += [
            (f"sections[{i}].chart", s.chart) for i, s in enumerate(self.sections)
        ]
        holders += [(f"slides[{i}].chart", s.chart) for i, s in enumerate(self.slides)]
        for where, chart in holders:
            if chart is not None and not chart_has_data(chart):
                raise ValueError(
                    f"{where} has no data: give `labels` + `series[].values` "
                    "(or `values`)"
                )
        return self


def has_chart(spec: FileSpec) -> bool:
    """True if the spec references any chart (→ needs matplotlib → the process pool)."""
    if spec.chart is not None:
        return True
    if any(s.chart is not None for s in spec.sections):
        return True
    if any(s.chart is not None for s in spec.sheets):
        return True
    return any(s.chart is not None for s in spec.slides)

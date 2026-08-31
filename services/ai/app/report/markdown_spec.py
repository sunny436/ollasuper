"""Markdown → FileSpec, deterministically.

A scheduled report's PDF is a RENDERING of the result the run already produced.
There is no second model call here and there must never be one: the answer the
user reads in the app and the answer in their inbox have to be the same answer.

The conversion is total. Anything this cannot represent faithfully is carried
through as visible text with a caption saying so — a mermaid diagram becomes its
own source, an image becomes its filename. Silently dropping content would make
the PDF a quietly lossy copy of the result, which is worse than an honest one.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from app.filegen.spec import ChartSpec, FileSpec, Section, Series, Table

# Bounds. The renderer runs in a shared pool inside myos-ai, so an enormous
# result must not be able to hold a worker (or the box) hostage.
MAX_MARKDOWN_CHARS = 400_000
MAX_SECTIONS = 400
MAX_TABLE_ROWS = 200
MAX_TABLE_COLS = 12
MAX_BULLETS = 200

_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_BULLET = re.compile(r"^\s*[-*+]\s+(.*)$")
_ORDERED = re.compile(r"^\s*\d+[.)]\s+(.*)$")
_FENCE = re.compile(r"^\s*```\s*([A-Za-z0-9_-]*)\s*$")
_TABLE_SEP = re.compile(r"^\s*\|?[\s:-]*\|[\s:|-]*$")
# Strip inline emphasis/code markers; reportlab renders plain text, and leaving
# the markers in makes the PDF read like source rather than a report.
_INLINE = re.compile(r"(\*\*|__|\*|_|`)")
_LINK = re.compile(r"\[([^\]]*)\]\(([^)]*)\)")


def _clean(text: str) -> str:
    """Inline markdown → plain text, keeping link labels and dropping the URLs.

    A URL in body text is noise in a PDF; the Sources section carries them.
    """
    out = _LINK.sub(r"\1", text)
    return _INLINE.sub("", out).strip()


@dataclass(slots=True)
class _Buffer:
    """Accumulates one section's worth of content before it is emitted."""

    heading: str = ""
    level: int = 1
    paragraphs: list[str] | None = None
    bullets: list[str] | None = None
    ordered: bool = False
    table: Table | None = None
    chart: ChartSpec | None = None
    caption: str = ""

    def empty(self) -> bool:
        return not (
            self.heading
            or self.paragraphs
            or self.bullets
            or self.table
            or self.chart
        )

    def to_section(self) -> Section:
        return Section(
            heading=self.heading,
            level=max(1, min(6, self.level)),
            text="\n\n".join(self.paragraphs or []),
            bullets=list((self.bullets or [])[:MAX_BULLETS]),
            ordered=self.ordered,
            table=self.table,
            chart=self.chart,
            caption=self.caption,
        )


def _parse_table(lines: list[str]) -> Table | None:
    """A GitHub-style pipe table, or None if the shape does not hold."""
    rows = [
        [c.strip() for c in re.split(r"(?<!\\)\|", ln.strip().strip("|"))]
        for ln in lines
    ]
    rows = [r for r in rows if any(c for c in r)]
    if len(rows) < 2:
        return None
    columns = [_clean(c) for c in rows[0][:MAX_TABLE_COLS]]
    body = [
        [_clean(c) for c in r[:MAX_TABLE_COLS]] for r in rows[1:][:MAX_TABLE_ROWS]
    ]
    # Pad ragged rows so the renderer never indexes past the header width.
    body = [r + [""] * (len(columns) - len(r)) for r in body]
    return Table(columns=columns, rows=body)


def _chart_from_fence(body: str) -> ChartSpec | None:
    """A ```chart fence holds a Chart.js spec — the same one the chat UI renders.

    Only the shapes matplotlib can honour are mapped. An unmappable chart returns
    None and the caller falls back to showing the source, rather than inventing a
    different chart than the one the reader saw in the app.
    """
    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None

    kind = str(data.get("type") or "").lower()
    mapping = {
        "bar": "bar",
        "line": "line",
        "pie": "pie",
        "doughnut": "donut",
        "scatter": "scatter",
        "area": "area",
    }
    if kind not in mapping:
        return None

    payload = data.get("data")
    if not isinstance(payload, dict):
        return None
    labels = [str(x) for x in (payload.get("labels") or [])]
    datasets = payload.get("datasets")
    if not isinstance(datasets, list) or not datasets:
        return None

    series: list[Series] = []
    for ds in datasets:
        if not isinstance(ds, dict):
            continue
        values: list[float] = []
        for v in ds.get("data") or []:
            try:
                values.append(float(v))
            except (TypeError, ValueError):
                values.append(0.0)
        series.append(Series(name=str(ds.get("label") or ""), values=values))
    if not series:
        return None

    opts = data.get("options") if isinstance(data.get("options"), dict) else {}
    title = ""
    plugins = opts.get("plugins") if isinstance(opts, dict) else None
    if isinstance(plugins, dict):
        t = plugins.get("title")
        if isinstance(t, dict) and t.get("text"):
            title = str(t["text"])

    return ChartSpec(
        type=mapping[kind],  # type: ignore[arg-type]
        title=title,
        labels=labels,
        series=series,
    )


def _fenced_section(lang: str, body: str) -> Section:
    """A fence we cannot render natively, carried through as visible source.

    Mermaid is the case that matters: the chat UI draws it, a PDF cannot, and
    dropping it would silently lose a diagram the user was shown. So the source
    goes in with a caption that says exactly what happened.
    """
    captions = {
        "mermaid": "Diagram shown as source — view it in OllaSuper to see it rendered.",
        "chart": "Chart shown as source — view it in OllaSuper to see it rendered.",
    }
    return Section(
        heading="",
        text=body.strip(),
        caption=captions.get(lang.lower(), ""),
    )


def markdown_to_spec(
    markdown: str,
    *,
    title: str,
    subtitle: str = "",
    truncated: bool = False,
) -> FileSpec:
    """Convert a result into a renderable report.

    Never raises: a report that fails to build is a worse outcome than a report
    that is plainly imperfect, so every branch degrades to text.
    """
    text = (markdown or "")[:MAX_MARKDOWN_CHARS]
    sections: list[Section] = []
    buf = _Buffer()

    def flush() -> None:
        nonlocal buf
        if not buf.empty() and len(sections) < MAX_SECTIONS:
            sections.append(buf.to_section())
        buf = _Buffer()

    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()

        fence = _FENCE.match(line)
        if fence:
            lang = fence.group(1) or ""
            body_lines: list[str] = []
            i += 1
            while i < len(lines) and not _FENCE.match(lines[i].rstrip()):
                body_lines.append(lines[i])
                i += 1
            i += 1  # consume the closing fence
            body = "\n".join(body_lines)
            chart = _chart_from_fence(body) if lang.lower() == "chart" else None
            flush()
            if chart is not None:
                sections.append(Section(chart=chart, caption=chart.title))
            elif body.strip() and len(sections) < MAX_SECTIONS:
                sections.append(_fenced_section(lang, body))
            continue

        heading = _HEADING.match(line)
        if heading:
            flush()
            buf.heading = _clean(heading.group(2))
            buf.level = len(heading.group(1))
            i += 1
            continue

        # A pipe table: a header row, a separator row, then body rows.
        if "|" in line and i + 1 < len(lines) and _TABLE_SEP.match(lines[i + 1]):
            block = [line]
            i += 2  # skip the separator
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                block.append(lines[i])
                i += 1
            table = _parse_table(block)
            if table is not None:
                if buf.table is not None:
                    flush()
                buf.table = table
            continue

        bullet = _BULLET.match(line)
        ordered = _ORDERED.match(line)
        if bullet or ordered:
            # A change of list kind starts a new section — Section carries one
            # `ordered` flag, so mixing them would silently renumber the list.
            if buf.bullets and buf.ordered != bool(ordered):
                flush()
            buf.bullets = buf.bullets or []
            buf.ordered = bool(ordered)
            item = (bullet or ordered).group(1)  # type: ignore[union-attr]
            buf.bullets.append(_clean(item))
            i += 1
            continue

        if not line.strip():
            i += 1
            continue

        buf.paragraphs = buf.paragraphs or []
        buf.paragraphs.append(_clean(line))
        i += 1

    flush()

    if truncated:
        sections.append(
            Section(
                heading="",
                text=(
                    "This report was truncated because the result exceeded the "
                    "size limit for a PDF. Open OllaSuper to read it in full."
                ),
            )
        )

    if not sections:
        sections = [
            Section(text="This run produced no text output.", heading="")
        ]

    return FileSpec(
        format="pdf",
        title=title,
        subtitle=subtitle,
        sections=sections[:MAX_SECTIONS],
    )

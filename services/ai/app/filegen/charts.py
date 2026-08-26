"""matplotlib chart rendering → PNG/SVG bytes.

Used standalone (format png/svg) and for embedding into PDF/DOCX/PPTX/XLSX. matplotlib
is lazy-imported and forced onto the headless Agg backend HERE so importing this module
(or the app) never pulls a GUI backend, and the ~0.5s import is paid only when a chart
is actually rendered — inside a pool worker, off the chat event loop.
"""

from __future__ import annotations

import io

from app.filegen.spec import ChartSpec

# Sensible, readable defaults — a professional-looking chart without per-call theming.
_FIGSIZE = (8.0, 4.5)
_DPI = 144
_PALETTE = [
    "#2563eb",
    "#16a34a",
    "#dc2626",
    "#d97706",
    "#7c3aed",
    "#0891b2",
    "#db2777",
    "#65a30d",
    "#ea580c",
    "#4f46e5",
]


def _series(chart: ChartSpec) -> list[tuple[str, list[float]]]:
    """Normalize to a list of (name, values). Falls back to the convenience
    single `values` series when no named series were given."""
    out: list[tuple[str, list[float]]] = []
    for s in chart.series:
        if s.values:
            out.append((s.name or f"Series {len(out) + 1}", list(s.values)))
    if not out and chart.values:
        out.append((chart.title or "Series 1", list(chart.values)))
    return out


def render_chart(chart: ChartSpec, fmt: str = "png") -> bytes:
    """Render one chart to PNG or SVG bytes. Never raises on thin data — an empty
    chart still yields a valid (labelled, empty) image, never a broken document."""
    import matplotlib

    matplotlib.use("Agg")  # headless; must precede pyplot import
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=_FIGSIZE, dpi=_DPI)
    try:
        series = _series(chart)
        labels = list(chart.labels)
        ctype = chart.type

        if ctype in ("pie", "donut"):
            values = series[0][1] if series else list(chart.values)
            names = labels or [f"{i + 1}" for i in range(len(values))]
            n = min(len(values), len(names))
            if n:
                wedge = {"width": 0.42} if ctype == "donut" else {}
                ax.pie(
                    values[:n],
                    labels=names[:n],
                    autopct="%1.1f%%",
                    colors=_PALETTE,
                    startangle=90,
                    wedgeprops=wedge,
                )
                ax.axis("equal")
        elif ctype == "histogram":
            data = series[0][1] if series else list(chart.values)
            if data:
                ax.hist(
                    data,
                    bins=min(30, max(5, len(data) // 2 or 5)),
                    color=_PALETTE[0],
                    edgecolor="white",
                )
        elif ctype == "scatter":
            xs = [float(i) for i in range(len(labels))] if labels else None
            for i, (name, ys) in enumerate(series):
                x = xs[: len(ys)] if xs else list(range(len(ys)))
                ax.scatter(x, ys, label=name, color=_PALETTE[i % len(_PALETTE)])
            if labels:
                ax.set_xticks(range(len(labels)))
                ax.set_xticklabels(labels, rotation=30, ha="right")
        else:  # bar / line / area
            x = list(range(len(labels))) if labels else None
            for i, (name, ys) in enumerate(series):
                xi = x[: len(ys)] if x is not None else list(range(len(ys)))
                color = _PALETTE[i % len(_PALETTE)]
                if ctype == "bar":
                    width = 0.8 / max(1, len(series))
                    off = (i - (len(series) - 1) / 2) * width
                    ax.bar(
                        [v + off for v in xi], ys, width=width, label=name, color=color
                    )
                elif ctype == "area":
                    ax.fill_between(xi, ys, alpha=0.35, color=color)
                    ax.plot(xi, ys, label=name, color=color, linewidth=2)
                else:  # line
                    ax.plot(
                        xi,
                        ys,
                        label=name,
                        color=color,
                        linewidth=2,
                        marker="o",
                        markersize=4,
                    )
            if labels:
                ax.set_xticks(range(len(labels)))
                ax.set_xticklabels(labels, rotation=30, ha="right")
            if len(series) > 1:
                ax.legend(frameon=False, fontsize=9)

        if chart.title:
            ax.set_title(chart.title, fontsize=13, fontweight="bold")
        if chart.x_label and ctype not in ("pie", "donut"):
            ax.set_xlabel(chart.x_label, fontsize=10)
        if chart.y_label and ctype not in ("pie", "donut"):
            ax.set_ylabel(chart.y_label, fontsize=10)
        if ctype not in ("pie", "donut"):
            ax.spines[["top", "right"]].set_visible(False)
            ax.grid(axis="y", linestyle=":", alpha=0.4)

        fig.tight_layout()
        buf = io.BytesIO()
        fig.savefig(buf, format="svg" if fmt == "svg" else "png", bbox_inches="tight")
        return buf.getvalue()
    finally:
        plt.close(fig)

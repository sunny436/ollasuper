"""Documents fixes D1/D2/D4/D5 — one chart vocabulary at the boundary, page
numbers + a verified table of contents, and verification read from the RENDERED
file with one bounded repair and an explicit failure.

The 18.09.2026 audit: a deck lost to two opaque "Invalid file specification"
retries (D1), a doughnut silently delivered as a pie (D2), no single PDF with
both TOC and page numbers (D4), and files called correct because generation
succeeded (D5). Every chart type that worked before still works, byte-stable
for a plain document, and a provider-style failure is never needed to prove any
of this.
"""

from __future__ import annotations

import io

import pytest
from pydantic import ValidationError

from app.agent.executor import (
    ToolExecContext,
    _repair_spec,
    _spec_error_message,
    _verification_problems,
    execute_tool_calls,
)
from app.agent.filegen_tool import FILE_GEN_TOOL_NAME, GENERATE_FILE_TOOL_SPEC
from app.agent.policy import READ_SCOPE
from app.filegen.charts import render_chart
from app.filegen.documents import render_docx, render_pdf, toc_entries
from app.filegen.generate import render_and_validate
from app.filegen.spec import CHART_TYPES, ChartSpec, FileSpec, normalize_chart
from app.filegen.verify import blank_pages, heading_pages, page_numbers_ok, verify_toc
from app.runtime.writer import DeltaWriter
from tests.conftest import make_settings
from tests.test_writer_events import RecordingConvex

# ------------------------------------------------------------- D1 / D2 charts


FLAT = {
    "title": "t",
    "labels": ["a", "b", "c"],
    "series": [{"name": "s", "values": [1, 2, 3]}],
}


@pytest.mark.parametrize("ctype", CHART_TYPES)
def test_every_existing_chart_type_still_validates_and_renders_unchanged(ctype):
    raw = {"type": ctype, **FLAT}
    assert normalize_chart(dict(raw)) == raw  # backward compatible: no rewrite
    c = ChartSpec.model_validate(raw)
    assert c.type == ctype and c.labels == ["a", "b", "c"]
    png = render_chart(c, "png")
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert ChartSpec.model_validate(c.model_dump(by_alias=True)) == c  # idempotent


def test_doughnut_is_donut_and_renders_with_a_hole():
    from PIL import Image

    donut = ChartSpec.model_validate(
        {"type": "doughnut", "labels": ["A", "B"], "values": [3, 1]}
    )
    pie = ChartSpec.model_validate(
        {"type": "pie", "labels": ["A", "B"], "values": [3, 1]}
    )
    assert donut.type == "donut"
    centre = []
    for c in (donut, pie):
        img = Image.open(io.BytesIO(render_chart(c, "png"))).convert("RGB")
        w, h = img.size
        centre.append(img.getpixel((w // 2, h // 2)))
    assert centre[0] == (255, 255, 255), "a donut has a hole at its centre"
    assert centre[1] != (255, 255, 255), "a pie is filled at its centre"


def test_chartjs_shape_maps_onto_labels_and_series():
    c = ChartSpec.model_validate(
        {
            "type": "line",
            "data": {
                "labels": ["Q1", "Q2"],
                "datasets": [
                    {"label": "Revenue", "data": [10, 12]},
                    {"label": "Cost", "data": [4, 5]},
                ],
            },
            "options": {
                "plugins": {"title": {"text": "Rev vs cost"}},
                "scales": {"x": {"title": {"text": "Quarter"}}},
                "responsive": True,
            },
        }
    )
    assert c.labels == ["Q1", "Q2"]
    assert [(s.name, s.values) for s in c.series] == [
        ("Revenue", [10.0, 12.0]),
        ("Cost", [4.0, 5.0]),
    ]
    assert c.title == "Rev vs cost" and c.x_label == "Quarter"
    assert c.ignored == ["options.responsive"]  # dropped, and said


def test_scatter_points_and_dict_series_and_missing_optionals():
    c = ChartSpec.model_validate(
        {
            "type": "scatter",
            "data": {
                "datasets": [
                    {"label": "s", "data": [{"x": 1, "y": 2}, {"x": 2, "y": 5}]}
                ]
            },
        }
    )
    assert c.series[0].values == [2.0, 5.0]
    d = ChartSpec.model_validate(
        {"type": "bar", "labels": ["a"], "series": {"Rev": [1]}}
    )
    assert d.series[0].name == "Rev"
    e = ChartSpec.model_validate({"type": "bar", "values": [1, 2]})  # no labels/title
    assert e.labels == [] and e.title == ""
    render_chart(e, "png")


@pytest.mark.parametrize(
    ("raw", "needle"),
    [
        ({"type": "radar", "values": [1]}, "unsupported chart type 'radar'"),
        ({"type": "bar", "values": [1], "data": {"datasets": [{"data": [1]}]}}, "both"),
        (
            {"type": "bar", "data": {"datasets": [{"type": "line", "data": [1]}]}},
            "mixed chart types",
        ),
        ({"type": "bar", "values": ["$12"]}, "non-numeric value: '$12'"),
        ({"type": "bar", "values": [True]}, "boolean"),
    ],
)
def test_nothing_is_reinterpreted_silently(raw, needle):
    with pytest.raises(ValidationError) as ei:
        ChartSpec.model_validate(raw)
    assert needle in str(ei.value)


def test_an_empty_chart_in_a_slide_is_an_error_not_a_blank_picture():
    with pytest.raises(ValidationError) as ei:
        FileSpec.model_validate(
            {
                "format": "pptx",
                "slides": [
                    {
                        "title": "x",
                        "chart": {
                            "type": "line",
                            "data": {"labels": ["a"], "datasets": []},
                        },
                    }
                ],
            }
        )
    assert "slides[0].chart has no data" in _spec_error_message(ei.value)


def test_a_sheet_chart_may_plot_the_sheet_rows_without_its_own_values():
    spec = FileSpec.model_validate(
        {
            "format": "xlsx",
            "sheets": [
                {
                    "name": "D",
                    "columns": ["m", "u"],
                    "rows": [["a", 1]],
                    "chart": {"type": "line", "title": "Units"},
                }
            ],
        }
    )
    assert spec.sheets[0].chart.type == "line"


def test_the_error_message_names_the_field_and_the_problem():
    try:
        FileSpec.model_validate(
            {
                "format": "pptx",
                "slides": [{"title": "x", "chart": {"type": "radar", "values": [1]}}],
            }
        )
    except ValidationError as e:
        msg = _spec_error_message(e)
    assert msg.startswith(
        "Invalid file specification: slides.0.chart: unsupported chart type 'radar'"
    )
    assert "doughnut" in msg and len(msg) <= 400


def test_the_tool_schema_accepts_doughnut_and_documents_the_limits():
    chart = GENERATE_FILE_TOOL_SPEC["function"]["parameters"]["properties"]["chart"]
    assert "doughnut" in chart["properties"]["type"]["enum"]
    assert "Chart.js" in chart["description"]
    desc = GENERATE_FILE_TOOL_SPEC["function"]["description"]
    assert "page_numbers" in desc and "toc" in desc and "logo" in desc


# ---------------------------------------------------------------- D4 pdf


def _long_sections(n=8):
    secs = [
        {
            "heading": f"Section {i}",
            "level": 1 if i % 3 else 2,
            "text": ("Lorem ipsum dolor sit amet. " * 60 + "\n\n") * 3,
        }
        for i in range(1, n + 1)
    ]
    secs.insert(3, {"heading": "Overview", "level": 1, "text": "first overview"})
    secs.insert(
        6,
        {
            "heading": "Overview",
            "level": 1,
            "text": "second overview",
            "page_break_before": True,
        },
    )
    return secs


def test_pdf_page_numbers_and_toc_are_verified_from_the_rendered_file():
    spec = FileSpec.model_validate(
        {
            "format": "pdf",
            "title": "Report",
            "sections": _long_sections(),
            "page_numbers": True,
            "toc": True,
        }
    )
    data, _ = render_pdf(spec)
    assert page_numbers_ok(data) is True
    v = verify_toc(data, toc_entries(spec))
    assert v == {"toc_verified": True, "toc_method": "outline", "toc_note": ""}
    pages, how = heading_pages(data, toc_entries(spec))
    assert how == "outline" and pages == sorted(pages)
    # duplicate headings resolve to DIFFERENT pages, in order
    dup = [
        p
        for (lvl, t), p in zip(toc_entries(spec), pages, strict=True)
        if t == "Overview"
    ]
    assert len(dup) == 2 and dup[0] < dup[1]


def test_text_fallback_walks_forward_and_a_wrong_number_is_a_real_mismatch():
    spec = FileSpec.model_validate(
        {
            "format": "pdf",
            "title": "Report",
            "sections": _long_sections(),
            "page_numbers": True,
            "toc": True,
        }
    )
    data, _ = render_pdf(spec)
    entries = toc_entries(spec)
    pages, _ = heading_pages(data, entries)
    wrong = list(pages)
    wrong[0] += 1
    assert verify_toc(data, entries, expected_pages=wrong)["toc_verified"] is False


def test_a_plain_pdf_is_unchanged_when_neither_flag_is_set():
    from pypdf import PdfReader

    spec = FileSpec.model_validate(
        {"format": "pdf", "title": "Report", "sections": _long_sections(3)}
    )
    data, _ = render_pdf(spec)
    r = PdfReader(io.BytesIO(data))
    assert r.outline == []
    assert not any("Page 1 of" in (p.extract_text() or "") for p in r.pages)


# --------------------------------------------------------------- D4 docx


def test_docx_writes_fields_and_a_static_toc_from_rendered_pages():
    from docx import Document

    secs = _long_sections(4)
    for pages in (None, [], [2, 2, 3, 4, 5, 5]):
        spec = FileSpec.model_validate(
            {
                "format": "docx",
                "title": "R",
                "sections": secs,
                "page_numbers": True,
                "toc": True,
                "_toc_pages": pages,
            }
        )
        data, _ = render_docx(spec)
        d = Document(io.BytesIO(data))
        footer_xml = d.sections[0].footer._element.xml
        assert " PAGE " in footer_xml and " NUMPAGES " in footer_xml
        paras = [p.text for p in d.paragraphs]
        assert "Contents" in paras
        if pages is None:
            assert "TOC" in d.element.body.xml  # a field, filled when opened
        else:
            lines = [p for p in paras if "\t" in p]
            assert len(lines) == len(toc_entries(spec))
            assert lines[0].endswith("\t2" if pages else "\t…")


# ---------------------------------------------------------------- D5 facts


def test_blank_page_is_detected_and_repaired_once_then_refused():
    spec = {
        "format": "pdf",
        "title": "R",
        "sections": [
            {"heading": "A", "text": "x " * 200},
            {"page_break_before": True},
            {"heading": "B", "text": "y " * 200, "page_break_before": True},
        ],
        "page_numbers": True,
    }
    from app.documents.preview import pdf_preview_pngs

    data, _, _ = render_and_validate(dict(spec))
    pngs, total = pdf_preview_pngs(data, 10, 1.0)
    assert blank_pages(pngs) == [2]
    v = {"blank_pages": [2]}
    assert _verification_problems(v) == ["blank page(s) [2]"]
    sd = FileSpec.model_validate(spec).model_dump(by_alias=True)
    assert _repair_spec(sd, v) is True  # the empty section's break is dropped
    data2, _, _ = render_and_validate(sd)
    pngs2, _ = pdf_preview_pngs(data2, 10, 1.0)
    assert blank_pages(pngs2) == []
    # nothing deterministic to fix → no second repair
    assert _repair_spec(sd, v) is False


def test_verification_problems_cover_toc_and_numbers():
    assert _verification_problems({"toc_verified": False, "toc_note": "x"}) == [
        "table of contents does not match the pages (x)"
    ]
    assert _verification_problems({"page_numbers_verified": False}) == [
        "page numbers did not render as 'Page X of Y'"
    ]
    assert _verification_problems({"toc_verified": None, "blank_pages": []}) == []


# ------------------------------------------------ the executor pipeline


class _ArtifactConvex(RecordingConvex):
    def __init__(self):
        super().__init__()
        self.stored: list[dict] = []

    async def store_artifact(self, blob, *, filename, fmt, mime, **kw):
        self.stored.append(
            {"filename": filename, "fmt": fmt, "size": len(blob), "blob": blob, **kw}
        )
        return {"artifactId": f"art{len(self.stored)}", "size": len(blob)}


def _ctx():
    convex = _ArtifactConvex()
    writer = DeltaWriter(convex, "s1", make_settings("http://x"))
    ctx = ToolExecContext(
        registry=None,
        adapter=None,
        writer=writer,
        scope=READ_SCOPE,
        name_to_tool_id={},
        result_max_chars=8000,
        default_timeout_s=30.0,
        file_gen_enabled=True,
        file_gen_pool_workers=1,
        doc_soffice_enabled=False,
    )
    return ctx, convex


def _gen(args, cid="c1"):
    return {"name": FILE_GEN_TOOL_NAME, "args": args, "id": cid}


async def test_generate_file_returns_verification_from_the_rendered_pdf():
    ctx, convex = _ctx()
    msgs = await execute_tool_calls(
        [
            _gen(
                {
                    "format": "pdf",
                    "title": "Report",
                    "sections": _long_sections(4),
                    "page_numbers": True,
                    "toc": True,
                }
            )
        ],
        ctx,
    )
    body = msgs[0].content
    assert '"status": "generated"' in body
    assert '"toc_verified": true' in body and '"page_numbers_verified": true' in body
    assert '"blank_pages": []' in body and "faithful page image(s) shown" in body
    assert len([s for s in convex.stored if s["fmt"] == "pdf"]) == 1


async def test_a_deck_with_a_doughnut_generates_on_the_first_call_and_names_the_chart():
    ctx, convex = _ctx()
    msgs = await execute_tool_calls(
        [
            _gen(
                {
                    "format": "pptx",
                    "title": "Q3",
                    "slides": [
                        {
                            "title": "Revenue",
                            "chart": {
                                "type": "line",
                                "data": {
                                    "labels": ["Q1", "Q2"],
                                    "datasets": [{"label": "Rev", "data": [1, 2]}],
                                },
                            },
                        },
                        {
                            "title": "Mix",
                            "chart": {
                                "type": "doughnut",
                                "labels": ["A", "B"],
                                "values": [3, 1],
                            },
                        },
                    ],
                }
            )
        ],
        ctx,
    )
    body = msgs[0].content
    assert '"status": "generated"' in body
    assert '"charts": ["line", "donut"]' in body and '"slides": 3' in body  # title + 2
    assert "approximate preview" in body  # no LibreOffice in the test box: said so


async def test_a_known_invalid_file_is_refused_not_delivered():
    ctx, convex = _ctx()
    # two empty page breaks: the repair fixes both empty sections… so make the blank
    # page come from a NON-empty-looking section the repair may not touch
    msgs = await execute_tool_calls(
        [
            _gen(
                {
                    "format": "pdf",
                    "title": "R",
                    "sections": [
                        {"heading": "A", "text": "x " * 200},
                        {"caption": " ", "page_break_before": True},
                        {"heading": "B", "text": "y " * 200, "page_break_before": True},
                    ],
                }
            )
        ],
        ctx,
    )
    body = msgs[0].content
    assert (
        '"status": "error"' in body
        and "failed verification" in body
        and "blank page" in body
    )
    assert convex.stored == []


async def test_an_unsupported_chart_type_is_an_explicit_error_with_the_path():
    ctx, convex = _ctx()
    msgs = await execute_tool_calls(
        [
            _gen(
                {
                    "format": "pptx",
                    "slides": [
                        {"title": "x", "chart": {"type": "radar", "values": [1]}}
                    ],
                }
            )
        ],
        ctx,
    )
    assert "slides.0.chart: unsupported chart type 'radar'" in msgs[0].content
    assert convex.stored == []


async def test_docx_toc_is_written_from_rendered_pages_and_verified(monkeypatch):
    """LibreOffice is mocked: its PDF is stood in for by a reportlab render of the
    same sections (same headings, an outline). The executor must (1) render pass 1
    with placeholder lines, (2) read the page per heading from the PDF outline,
    (3) re-render with those numbers, (4) verify, and store the SECOND file."""
    from docx import Document

    secs = _long_sections(4)

    async def fake_convert(data, *, to, src_ext, enabled, timeout_s, concurrency):
        assert to == "pdf" and src_ext == "docx" and enabled
        spec = FileSpec.model_validate(
            {
                "format": "pdf",
                "title": "R",
                "sections": secs,
                "toc": True,
                "page_numbers": True,
            }
        )
        return render_pdf(spec)[0]

    monkeypatch.setattr("app.documents.soffice.convert", fake_convert)
    ctx, convex = _ctx()
    ctx.doc_soffice_enabled = True
    msgs = await execute_tool_calls(
        [
            _gen(
                {
                    "format": "docx",
                    "title": "R",
                    "sections": secs,
                    "page_numbers": True,
                    "toc": True,
                }
            )
        ],
        ctx,
    )
    body = msgs[0].content
    assert '"status": "generated"' in body
    assert '"toc_verified": true' in body and '"toc_method": "outline"' in body
    assert '"page_numbers_verified": true' in body
    assert "faithful page image(s) shown" in body
    stored = [s for s in convex.stored if s["fmt"] == "docx"]
    assert len(stored) == 1
    # the STORED file carries the numbers the rendered outline gave, not placeholders
    d = Document(io.BytesIO(stored[0]["blob"]))
    lines = [p.text for p in d.paragraphs if "	" in p.text]
    pages, _ = heading_pages(
        await fake_convert(
            b"", to="pdf", src_ext="docx", enabled=True, timeout_s=1, concurrency=1
        ),
        toc_entries(
            FileSpec.model_validate({"format": "docx", "sections": secs, "toc": True})
        ),
    )
    assert [int(ln.rsplit("	", 1)[1]) for ln in lines] == pages


async def test_docx_without_libreoffice_says_the_toc_is_a_field_and_unverified():
    ctx, convex = _ctx()  # doc_soffice_enabled=False
    msgs = await execute_tool_calls(
        [
            _gen(
                {
                    "format": "docx",
                    "title": "R",
                    "sections": _long_sections(3),
                    "page_numbers": True,
                    "toc": True,
                }
            )
        ],
        ctx,
    )
    body = msgs[0].content
    assert '"status": "generated"' in body
    assert '"toc_verified": null' in body and "LibreOffice is unavailable" in body
    assert '"preview": "none"' in body

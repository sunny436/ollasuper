"""The scheduled-report renderer: conversion fidelity, bounds, and the
structural guarantee that this endpoint cannot write anything.
"""

from __future__ import annotations

import ast
import json
import pathlib

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.filegen.generate import render_and_validate
from app.report.markdown_spec import (
    MAX_MARKDOWN_CHARS,
    MAX_SECTIONS,
    MAX_TABLE_ROWS,
    markdown_to_spec,
)
from app.routers.report import ReportRequest, _cover, _fmt

MODULE = (
    pathlib.Path(__file__).resolve().parents[1] / "app" / "routers" / "report.py"
)
SPEC_MODULE = (
    pathlib.Path(__file__).resolve().parents[1]
    / "app"
    / "report"
    / "markdown_spec.py"
)


# ── the structural guarantee ────────────────────────────────────────────────


def _imports(path: pathlib.Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            out.add(node.module or "")
    return out


def test_the_renderer_cannot_reach_convex_or_the_network():
    """Payload in, bytes out — asserted over the import graph, so the guarantee
    survives someone adding a convenience import later."""
    imported = _imports(MODULE) | _imports(SPEC_MODULE)
    assert not [m for m in imported if "convex" in m.lower()]
    assert not [m for m in imported if m.split(".")[0] in {"httpx", "requests"}]


def test_the_request_has_no_field_for_an_internal_identifier():
    """What is not in the schema cannot reach a PDF."""
    fields = set(ReportRequest.model_fields)
    for leaky in (
        "streamId",
        "occurrenceKey",
        "leaseToken",
        "workflowId",
        "storageId",
        "userId",
        "messageId",
    ):
        assert leaky not in fields


def test_extra_fields_are_rejected():
    with pytest.raises(ValidationError):
        ReportRequest(title="x", streamId="sneaky")


def test_oversized_markdown_is_rejected_at_the_schema():
    with pytest.raises(ValidationError):
        ReportRequest(markdown="x" * (MAX_MARKDOWN_CHARS + 1))


# ── conversion fidelity ─────────────────────────────────────────────────────


def test_headings_and_paragraphs_become_sections():
    spec = markdown_to_spec("# Title\n\nHello there.\n", title="T")
    assert spec.format == "pdf"
    assert spec.sections[0].heading == "Title"
    assert "Hello there." in spec.sections[0].text


def test_bulleted_and_numbered_lists_keep_their_kind():
    spec = markdown_to_spec("- one\n- two\n\n1. first\n2. second\n", title="T")
    kinds = [(s.ordered, s.bullets) for s in spec.sections if s.bullets]
    assert (False, ["one", "two"]) in kinds
    assert (True, ["first", "second"]) in kinds


def test_a_pipe_table_becomes_a_table():
    md = "| Name | Count |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n"
    spec = markdown_to_spec(md, title="T")
    table = next(s.table for s in spec.sections if s.table)
    assert table.columns == ["Name", "Count"]
    assert table.rows == [["a", "1"], ["b", "2"]]


def test_a_ragged_table_row_is_padded_not_dropped():
    md = "| A | B | C |\n| --- | --- | --- |\n| 1 |\n"
    spec = markdown_to_spec(md, title="T")
    table = next(s.table for s in spec.sections if s.table)
    assert table.rows == [["1", "", ""]]


def test_inline_markers_are_stripped_and_link_labels_kept():
    spec = markdown_to_spec("See **bold** and [the docs](https://x.test).", title="T")
    text = " ".join(s.text for s in spec.sections)
    assert "bold" in text and "**" not in text
    assert "the docs" in text
    # The URL is noise in body text; the model's own Sources section carries it.
    assert "https://x.test" not in text


def test_a_chart_fence_becomes_a_real_chart():
    chart = {
        "type": "bar",
        "data": {
            "labels": ["a", "b"],
            "datasets": [{"label": "Hits", "data": [1, 2]}],
        },
        "options": {"plugins": {"title": {"text": "Traffic"}}},
    }
    spec = markdown_to_spec(f"```chart\n{json.dumps(chart)}\n```", title="T")
    c = next(s.chart for s in spec.sections if s.chart)
    assert c.type == "bar"
    assert c.title == "Traffic"
    assert c.labels == ["a", "b"]
    assert c.series[0].values == [1.0, 2.0]


def test_an_unmappable_chart_falls_back_to_source_rather_than_a_wrong_chart():
    chart = {"type": "radar", "data": {"labels": [], "datasets": [{"data": []}]}}
    spec = markdown_to_spec(f"```chart\n{json.dumps(chart)}\n```", title="T")
    assert all(s.chart is None for s in spec.sections)
    joined = " ".join(s.text for s in spec.sections)
    assert "radar" in joined


def test_mermaid_is_carried_through_with_an_explanation_never_dropped():
    md = "```mermaid\ngraph TD; A-->B;\n```"
    spec = markdown_to_spec(md, title="T")
    body = " ".join(s.text for s in spec.sections)
    captions = " ".join(s.caption for s in spec.sections)
    assert "graph TD" in body
    assert "OllaSuper" in captions


def test_truncation_is_disclosed_in_the_document():
    spec = markdown_to_spec("body", title="T", truncated=True)
    assert any("truncated" in s.text.lower() for s in spec.sections)


def test_an_empty_result_still_produces_a_readable_document():
    spec = markdown_to_spec("", title="T")
    assert spec.sections
    assert "no text output" in spec.sections[0].text


# ── bounds ──────────────────────────────────────────────────────────────────


def test_section_count_is_bounded():
    spec = markdown_to_spec("\n\n".join(f"# H{i}" for i in range(2000)), title="T")
    assert len(spec.sections) <= MAX_SECTIONS


def test_table_rows_are_bounded():
    rows = "\n".join(f"| {i} | x |" for i in range(1000))
    spec = markdown_to_spec(f"| A | B |\n| --- | --- |\n{rows}", title="T")
    table = next(s.table for s in spec.sections if s.table)
    assert len(table.rows) <= MAX_TABLE_ROWS


def test_conversion_never_raises_on_hostile_input():
    for bad in ["```\n", "|||||", "#", "- ", "```chart\nnot json\n```", "\x00\x01"]:
        markdown_to_spec(bad, title="T")


# ── provenance carries nothing internal ─────────────────────────────────────


def test_times_render_in_the_tasks_zone_not_the_servers():
    # 2026-01-01T00:30Z is 06:00 the same day in Kolkata.
    out = _fmt(1767227400000, "Asia/Kolkata")
    assert "06:00" in out
    assert "IST" in out


def test_an_unknown_zone_degrades_to_utc_rather_than_raising():
    assert _fmt(1767227400000, "Mars/Olympus") .endswith("UTC")


def test_the_cover_block_exposes_no_internal_identifier():
    req = ReportRequest(
        title="T",
        prompt="Summarise",
        timezone="UTC",
        scheduledFor=1767227400000,
        outcome="succeeded",
    )
    rendered = json.dumps(_cover(req).model_dump())
    for leaky in ("lease", "workflow", "storage", "occurrenceKey", "streamId"):
        assert leaky.lower() not in rendered.lower()


# ── it really produces a PDF ────────────────────────────────────────────────


def test_the_spec_renders_to_actual_pdf_bytes():
    """End to end through the real reportlab renderer, not a mock."""
    md = (
        "# Weekly report\n\nIntro paragraph.\n\n"
        "## Numbers\n\n| Metric | Value |\n| --- | --- |\n| Visits | 12 |\n\n"
        "- first\n- second\n"
    )
    spec = markdown_to_spec(md, title="Weekly report")
    data, mime, report = render_and_validate(spec.model_dump())
    assert data.startswith(b"%PDF-")
    assert mime == "application/pdf"
    assert report.get("ok") is not False
    assert len(data) > 1000


def test_a_chart_spec_also_renders():
    chart = {
        "type": "line",
        "data": {"labels": ["a", "b", "c"], "datasets": [{"data": [1, 3, 2]}]},
    }
    spec = markdown_to_spec(
        f"# With a chart\n\n```chart\n{json.dumps(chart)}\n```", title="C"
    )
    data, _mime, _report = render_and_validate(spec.model_dump())
    assert data.startswith(b"%PDF-")


# ── the HTTP surface ────────────────────────────────────────────────────────


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("AI_SERVICE_KEY", "test-key")
    monkeypatch.setenv("OLLIMA_API_KEY", "x")
    monkeypatch.setenv("OPENROUTER_API_KEY", "y")
    monkeypatch.setenv("AI_INGRESS_SECRET", "z")
    from app.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    with TestClient(create_app()) as c:
        yield c
    get_settings.cache_clear()


def test_the_endpoint_requires_the_service_key(client):
    r = client.post("/v1/report/pdf", json={"title": "T", "markdown": "hi"})
    assert r.status_code in (401, 403)


def test_a_valid_request_returns_pdf_bytes(client):
    r = client.post(
        "/v1/report/pdf",
        headers={"x-service-key": "test-key"},
        json={
            "title": "Weekly",
            "prompt": "Summarise",
            "markdown": "# Hello\n\nSome body text.",
            "timezone": "Asia/Kolkata",
            "scheduledFor": 1767227400000,
            "outcome": "succeeded",
        },
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/pdf")
    assert r.content.startswith(b"%PDF-")


def test_an_unknown_field_is_rejected(client):
    r = client.post(
        "/v1/report/pdf",
        headers={"x-service-key": "test-key"},
        json={"title": "T", "streamId": "sneaky"},
    )
    assert r.status_code == 422

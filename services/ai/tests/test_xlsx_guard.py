"""Workbook work ceilings and killable decoding (audit F-04).

The audit's repro: a 4,845-byte workbook passed the zip guard while describing
12.8 million logical cells; its parse kept running after the timeout; and the
data-analysis preview parsed a workbook the compression-ratio guard rejects.
Hermetic — workbooks are built in memory with openpyxl.
"""

from __future__ import annotations

import io
import os

import pytest
from openpyxl import Workbook

from app.data.analysis import DataError
from app.ingest import pipeline
from app.ingest.types import IngestError
from app.ingest.xlsx_guard import XlsxRejected, check_xlsx_budget, parse_xlsx_guarded
from app.sandbox import harness, ops
from tests.conftest import make_settings

pytestmark = pytest.mark.anyio

SETTINGS = make_settings("http://localhost:9999")
POSIX = os.name == "posix"


def _book(cells: dict[str, object]) -> bytes:
    wb = Workbook()
    ws = wb.active
    for ref, value in cells.items():
        ws[ref] = value
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _sparse_bomb() -> bytes:
    """A few cells spanning the sheet: tiny on disk, ~16M logical cells."""
    return _book({"A1": "h", "XFD1000": "x"})


# ------------------------------------------------------------ the meter
def test_a_sparse_workbook_describing_millions_of_cells_is_refused():
    raw = _sparse_bomb()
    assert len(raw) < 10_000  # small on disk — the whole point
    with pytest.raises(ops.DecodeError, match="too large"):
        ops.xlsx_docs(raw, name="b.xlsx", max_cells=5_000_000, max_rows=1_048_576)
    with pytest.raises(ops.DecodeError, match="too large"):
        ops.xlsx_scan(raw, max_cells=5_000_000, max_rows=1_048_576)


def test_the_meter_counts_padded_cells_even_when_the_declared_size_lies():
    """Iteration ignores <dimension>; padding to the far column is charged."""
    raw = _book({"A1": "h", "Z5": "x"})
    with pytest.raises(ops.DecodeError, match="too large"):
        ops.xlsx_scan(raw, max_cells=20, max_rows=1_048_576)
    with pytest.raises(ops.DecodeError, match="too large"):
        ops.xlsx_scan(raw, max_cells=1_000, max_rows=3)


def test_an_ordinary_workbook_parses_exactly_as_before():
    raw = _book({"A1": "name", "B1": "age", "A2": "Ada", "B2": 36, "A4": "Bob"})
    docs = ops.xlsx_docs(raw, name="p.xlsx", max_cells=5_000_000, max_rows=1_048_576)
    assert len(docs) == 1
    assert docs[0]["text"] == "row 2: name=Ada, age=36\nrow 4: name=Bob"
    assert docs[0]["metadata"] == {"source": "p.xlsx", "sheet": "Sheet"}


# ------------------------------------------------ every path is guarded
async def test_ingestion_refuses_it_with_a_stage_error():
    with pytest.raises(IngestError, match="too large"):
        await pipeline._parse(_sparse_bomb(), "xlsx", "b.xlsx", SETTINGS)


async def test_ingestion_still_reads_an_ordinary_workbook():
    raw = _book({"A1": "k", "A2": "v"})
    out = await pipeline._parse(raw, "xlsx", "ok.xlsx", SETTINGS)
    assert [d.text for d in out.docs] == ["row 2: k=v"]


async def test_preview_and_loader_share_the_archive_guard():
    """The preview used to skip the compression-ratio check entirely."""
    strict = SETTINGS.model_copy(update={"ai_zip_max_ratio": 1})
    raw = _book({"A1": "a" * 500})
    with pytest.raises(XlsxRejected):
        await check_xlsx_budget(raw, settings=strict)
    with pytest.raises(XlsxRejected):
        await parse_xlsx_guarded(raw, name="r.xlsx", settings=strict)


async def test_the_data_preview_degrades_to_a_note(monkeypatch):
    from app.clients import attachments
    from app.models.chat import Attachment

    att = Attachment.model_construct(
        name="b.xlsx",
        contentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    text = await attachments._guarded_preview(_sparse_bomb(), att, SETTINGS)
    assert "preview unavailable" in text


async def test_the_data_loader_refuses_it(monkeypatch):
    from app.data import loader

    class _Convex:
        async def fetch_file(self, storage_id, stream_id):
            return _sparse_bomb(), "application/octet-stream"

    ref = loader.DatasetRef(name="b.xlsx", storage_id="s1", mime="")
    with pytest.raises(DataError, match="could not load"):
        await loader.load_dataset(_Convex(), SETTINGS, ref, "stream")


# ------------------------------------------- the worker is really killed
def test_a_kill_that_arrives_before_the_child_exists_still_kills_it(monkeypatch):
    killed: list[object] = []
    monkeypatch.setattr(harness, "_kill_group", lambda proc: killed.append(proc))
    handle = harness._ChildHandle()
    handle.kill()  # cancelled before the worker thread spawned the child
    child = object()
    handle.attach(child)  # type: ignore[arg-type]
    assert killed == [child]


@pytest.mark.skipif(not POSIX, reason="the sandbox child needs posix fork/exec")
async def test_a_timed_out_decode_is_killed_not_abandoned():
    import time

    raw = _book({f"A{i}": "x" * 40 for i in range(1, 20_000)})
    t0 = time.monotonic()
    with pytest.raises(TimeoutError):
        await harness.run_sandboxed(
            "xlsx_scan",
            raw,
            {"max_cells": 10**9, "max_rows": 10**9},
            timeout_s=0.05,
            fallback=None,  # type: ignore[arg-type]
        )
    # Returned promptly: the child was killed and reaped, not waited out.
    assert time.monotonic() - t0 < 5

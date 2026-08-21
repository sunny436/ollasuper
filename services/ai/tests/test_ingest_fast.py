"""Fast-ingest execution: concurrent order-preserving embeddings, bounded/
deadline-bounded PDF OCR (no zombie), and truthful char/chunk-cap truncation.

Hermetic: no network, no Convex, no DB. The embedding client and OCR are faked.
"""

from __future__ import annotations

import asyncio
import time

from app.ingest import embed as embedmod
from app.ingest import ocr as ocrmod
from app.ingest import pdf as pdfmod
from app.ingest.chunk import chunk_docs_bounded
from app.ingest.pdf import parse_pdf
from app.ingest.types import NormalizedDoc
from tests.conftest import make_settings

SETTINGS = make_settings("http://localhost:9999")


class _FakeEmbeddings:
    """aembed_documents returns a 1-D vector [float(text)] per text, so the test
    can assert global order survives concurrent batching."""

    def __init__(self) -> None:
        self.calls = 0

    async def aembed_documents(self, sub: list[str]) -> list[list[float]]:
        self.calls += 1
        await asyncio.sleep(0)  # yield so batches genuinely interleave
        return [[float(t)] for t in sub]


async def test_embed_documents_preserves_order(monkeypatch):
    fake = _FakeEmbeddings()
    monkeypatch.setattr(embedmod, "build_embeddings", lambda settings: fake)
    s = SETTINGS.model_copy(
        update={"ai_ingest_embed_batch": 3, "ai_ingest_embedding_concurrency": 4}
    )
    texts = [str(i) for i in range(10)]
    out = await embedmod.embed_documents(s, texts)
    assert out == [[float(i)] for i in range(10)]  # order preserved 1:1
    assert fake.calls == 4  # 10 texts / batch 3 -> 4 API calls (not 10)


async def test_embed_progress_cb_monotonic(monkeypatch):
    fake = _FakeEmbeddings()
    monkeypatch.setattr(embedmod, "build_embeddings", lambda settings: fake)
    s = SETTINGS.model_copy(
        update={"ai_ingest_embed_batch": 2, "ai_ingest_embedding_concurrency": 2}
    )
    seen: list[tuple[int, int]] = []

    async def cb(done: int, total: int) -> None:
        seen.append((done, total))

    await embedmod.embed_documents(s, [str(i) for i in range(6)], progress_cb=cb)
    assert seen  # fired
    assert all(total == 6 for _d, total in seen)
    assert [d for d, _t in seen] == sorted(d for d, _t in seen)  # monotonic
    assert seen[-1][0] == 6  # reaches 100%


async def test_parse_pdf_deadline_truncates_no_hang(monkeypatch):
    # Many image-only pages, each OCR slower than the whole-file deadline. The
    # parse must return quickly, flag truncated, and NOT hang on every page.
    ext = pdfmod._Extraction(
        text_docs=[NormalizedDoc(text="p1", page=1, metadata={"source": "s"})],
        image_pages=list(range(1, 25)),
        total_pages=25,
    )
    monkeypatch.setattr(pdfmod, "_extract", lambda raw, name, settings, cancel: ext)
    monkeypatch.setattr(pdfmod, "_render_page", lambda raw, idx: b"PNG")

    async def slow_ocr(raw, mime, *, name, settings):
        await asyncio.sleep(5)  # would blow any small deadline
        return [NormalizedDoc(text="late", metadata={"source": name})]

    s = SETTINGS.model_copy(
        update={"ai_ingest_ocr_concurrency": 4, "ai_ingest_ocr_timeout_s": 30.0}
    )
    t0 = time.monotonic()
    result = await parse_pdf(
        b"ignored", name="s.pdf", settings=s, ocr=slow_ocr, deadline_s=0.3
    )
    elapsed = time.monotonic() - t0
    assert result.truncated is True
    assert result.ocr_done < result.ocr_total
    assert elapsed < 3.0  # deadline cut it off; it did NOT wait for 24 slow OCRs


async def test_parse_pdf_per_page_ocr_timeout(monkeypatch):
    # A single hung OCR page is skipped via the per-page timeout, not fatal.
    ext = pdfmod._Extraction(
        text_docs=[NormalizedDoc(text="p1", page=1, metadata={"source": "s"})],
        image_pages=[1],
        total_pages=2,
    )
    monkeypatch.setattr(pdfmod, "_extract", lambda raw, name, settings, cancel: ext)
    monkeypatch.setattr(pdfmod, "_render_page", lambda raw, idx: b"PNG")

    async def hung_ocr(raw, mime, *, name, settings):
        await asyncio.sleep(10)
        return []

    s = SETTINGS.model_copy(update={"ai_ingest_ocr_timeout_s": 0.2})
    result = await parse_pdf(b"x", name="s.pdf", settings=s, ocr=hung_ocr)
    assert result.ocr_done == 0  # page timed out, skipped
    assert [d.page for d in result.docs] == [1]  # digital text still present


def test_chunk_docs_bounded_reports_truncation():
    s = SETTINGS.model_copy(update={"ai_ingest_max_chunks": 3})
    big = NormalizedDoc(text=("word " * 4000).strip(), metadata={"source": "b"})
    chunks, truncated = chunk_docs_bounded([big], "text", s)
    assert truncated is True
    assert len(chunks) == 3

    small = NormalizedDoc(text="just a little text", metadata={"source": "s"})
    chunks2, truncated2 = chunk_docs_bounded([small], "text", s)
    assert truncated2 is False


# --- local OCR (RapidOCR) routing ------------------------------------------



async def test_ocr_rapidocr_high_confidence_used(monkeypatch):
    monkeypatch.setattr(
        ocrmod, "_rapidocr_sync", lambda raw: ("BLUEFIN7742 report", 0.92)
    )
    docs = await ocrmod.ocr_image(b"x", "image/png", name="s.png", settings=SETTINGS)
    assert docs[0].text == "BLUEFIN7742 report"
    assert docs[0].metadata["ocr"] == "rapidocr"  # local, no OpenRouter call


async def test_ocr_lowconf_falls_back_to_vision(monkeypatch):
    monkeypatch.setattr(ocrmod, "_rapidocr_sync", lambda raw: ("grbld", 0.10))

    async def fake_vision(raw, mime, *, name, settings):
        return [
            NormalizedDoc(text="VISIONTEXT", metadata={"source": name, "ocr": "vision"})
        ]

    monkeypatch.setattr(ocrmod, "_vision_ocr", fake_vision)
    docs = await ocrmod.ocr_image(b"x", "image/png", name="s.png", settings=SETTINGS)
    assert docs[0].text == "VISIONTEXT"
    assert docs[0].metadata["ocr"] == "vision"


async def test_ocr_empty_no_fallback_returns_empty(monkeypatch):
    monkeypatch.setattr(ocrmod, "_rapidocr_sync", lambda raw: ("", 0.0))
    s = SETTINGS.model_copy(update={"ai_ocr_vision_fallback": False})
    docs = await ocrmod.ocr_image(b"x", "image/png", name="s.png", settings=s)
    assert docs == []

"""Image OCR — LOCAL RapidOCR primary, OpenRouter vision fallback.

The scanned-PDF OCR path used to send one vision call per page to the shared
OpenRouter account. A sustained 55-page flood exhausted the account's request
rate and queued an interactive chat's LLM request for 179 s (measured in prod).
So OCR now runs LOCALLY by default via RapidOCR (Apache-2.0, ONNX Runtime, no
system binary, PaddleOCR-quality models) — it never touches OpenRouter, so it
cannot starve chat, and it is faster + free. Quality was validated on scanned
text (IDs, numbers, currency read accurately).

RapidOCR is ONNX Runtime under the hood — native code that can SEGFAULT/abort on
an edge-case image. So the local inference runs in the shared render PROCESS
POOL (see pool.py / render.ocr_png_bytes), NOT a main-process thread: a crash
then kills only a worker, never the --workers 1 service. The in-thread path is
kept only for tests (render_workers=0).

The vision model stays only as a PER-PAGE FALLBACK for pages RapidOCR returns
empty / low-confidence on, so it never floods the account. `ocr_image` keeps its
signature, so pdf.py and pipeline dispatch are unchanged. One bad image must
never fail the whole file — every path swallows and returns [].
"""

from __future__ import annotations

import asyncio
import base64
import io

from langchain_core.messages import HumanMessage, SystemMessage

from app.agent.llm import build_llm
from app.clients.attachments import _normalise_image
from app.config import Settings
from app.ingest.governor import ingest_provider_gate
from app.ingest.types import NormalizedDoc
from app.logging import get_logger

log = get_logger(__name__)

OCR_PROMPT = (
    "Transcribe ALL text in this image verbatim, in natural reading order. "
    "Render tables as markdown. After the transcription, add one short line "
    "describing any non-text visual content. Output ONLY the transcription and "
    "that line — no preamble, no commentary."
)

# A semaphore bounds concurrent local-OCR submissions so a burst of image pages
# never queues unbounded work; the pool itself caps real parallelism at
# render_workers.
_local_sem: asyncio.Semaphore | None = None


def _sem(settings: Settings) -> asyncio.Semaphore:
    global _local_sem
    if _local_sem is None:
        _local_sem = asyncio.Semaphore(max(1, settings.ai_ocr_local_concurrency))
    return _local_sem


def _tiny_png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (32, 32), "white").save(buf, format="PNG")
    return buf.getvalue()


async def warm_ocr(settings: Settings) -> None:
    """Warm the OCR engine once so the first scanned page doesn't pay the ONNX
    model load. In prod (render_workers>0) warm the POOL workers; in-thread (0)
    warm the current process. Best-effort — a warm failure never blocks startup."""
    try:
        png = _tiny_png()
        if settings.ai_ocr_render_workers <= 0:
            await asyncio.to_thread(_rapidocr_sync, png)
            log.info("ocr_local_warmed")
            return
        from app.ingest.pool import run_in_pool
        from app.ingest.render import ocr_png_bytes

        n = max(1, settings.ai_ocr_render_workers)
        # One warm task per worker: an idle n-worker pool hands each task to a
        # distinct worker, so every worker loads ONNX before the first ingest.
        await asyncio.gather(
            *(
                run_in_pool(ocr_png_bytes, png, workers=n, label="warm")
                for _ in range(n)
            )
        )
        log.info("ocr_pool_warmed", extra={"workers": n})
    except Exception:  # noqa: BLE001 - warmup is best-effort
        log.warning("ocr_local_warm_failed")


def _rapidocr_sync(raw: bytes) -> tuple[str, float]:
    """In-thread local OCR (tests monkeypatch this). The single implementation
    lives in render.ocr_png_bytes so the pool and in-thread paths never diverge."""
    from app.ingest.render import ocr_png_bytes

    return ocr_png_bytes(raw)


async def _local_ocr(raw: bytes, settings: Settings) -> tuple[str, float]:
    """RapidOCR on `raw`. In prod (render_workers>0) runs in the shared process
    pool so an ONNX Runtime segfault kills only a worker; in-thread (0) is used
    by tests that monkeypatch _rapidocr_sync."""
    if settings.ai_ocr_render_workers <= 0:
        return await asyncio.to_thread(_rapidocr_sync, raw)
    from app.ingest.pool import run_in_pool
    from app.ingest.render import ocr_png_bytes

    res = await run_in_pool(
        ocr_png_bytes, raw, workers=settings.ai_ocr_render_workers, label="ocr"
    )
    return res if res is not None else ("", 0.0)


async def _vision_ocr(
    raw: bytes, mime: str, *, name: str, settings: Settings
) -> list[NormalizedDoc]:
    """OpenRouter vision OCR — the fallback (and the engine when engine=vision)."""
    try:
        data, out_mime = await asyncio.to_thread(
            _normalise_image, raw, mime or "image/png", settings.ai_ocr_long_edge
        )
        b64 = base64.b64encode(data).decode()
        llm = build_llm(
            settings,
            model=settings.ai_ocr_model,
            streaming=False,
            max_tokens=settings.ai_max_output_tokens,
        )
        # Vision fallback is a BACKGROUND provider call — hold the interactive
        # gate so it can never eat the chat's reserved capacity.
        async with ingest_provider_gate(settings):
            msg = await llm.ainvoke(
                [
                    SystemMessage(content=OCR_PROMPT),
                    HumanMessage(
                        content=[
                            {"type": "text", "text": "Transcribe this image."},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:{out_mime};base64,{b64}"
                                },
                            },
                        ]
                    ),
                ]
            )
        raw_text = msg.content if isinstance(msg.content, str) else str(msg.content)
        text = raw_text.strip()
        if not text:
            return []
        return [
            NormalizedDoc(
                text=text,
                metadata={
                    "source": name,
                    "ocr": "vision",
                    "model": settings.ai_ocr_model,
                },
            )
        ]
    except Exception:  # noqa: BLE001 - OCR is best-effort; never fail the file
        log.exception("ocr_vision_failed", extra={"source": name})
        return []


async def ocr_image(
    raw: bytes, mime: str, *, name: str, settings: Settings
) -> list[NormalizedDoc]:
    """LOCAL OCR first (no OpenRouter contention); vision fallback only for
    empty/low-confidence pages so the account is never flooded."""
    if settings.ai_ocr_engine != "rapidocr":
        return await _vision_ocr(raw, mime, name=name, settings=settings)

    text, conf = "", 0.0
    try:
        async with _sem(settings):
            text, conf = await _local_ocr(raw, settings)
    except Exception:  # noqa: BLE001 - local OCR is best-effort
        log.exception("ocr_local_failed", extra={"source": name})

    if text and conf >= settings.ai_ocr_min_confidence:
        return [NormalizedDoc(text=text, metadata={"source": name, "ocr": "rapidocr"})]

    # Empty or low-confidence -> one vision call (rare) if enabled.
    if settings.ai_ocr_vision_fallback:
        docs = await _vision_ocr(raw, mime, name=name, settings=settings)
        if docs:
            return docs
    # Keep whatever local text we did get rather than dropping the page.
    if not text:
        return []
    return [
        NormalizedDoc(text=text, metadata={"source": name, "ocr": "rapidocr-lowconf"})
    ]

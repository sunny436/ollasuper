"""Image OCR — LOCAL RapidOCR primary, OpenRouter vision fallback.

The scanned-PDF OCR path used to send one vision call per page to the shared
OpenRouter account. A sustained 55-page flood exhausted the account's request
rate and queued an interactive chat's LLM request for 179 s (measured in prod).
So OCR now runs LOCALLY by default via RapidOCR (Apache-2.0, ONNX Runtime, no
system binary, PaddleOCR-quality models) — it never touches OpenRouter, so it
cannot starve chat, and it is faster + free. Quality was validated on scanned
text (IDs, numbers, currency read accurately).

The vision model stays only as a PER-PAGE FALLBACK for pages RapidOCR returns
empty / low-confidence on, so it never floods the account. `ocr_image` keeps its
signature, so pdf.py and pipeline dispatch are unchanged. One bad image must
never fail the whole file — every path swallows and returns [].
"""

from __future__ import annotations

import asyncio
import base64
import io
import threading

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

# Lazily-built RapidOCR engine (heavy import + ONNX model load ~ one-time). A
# semaphore bounds concurrent local inference so it never monopolises the box;
# ONNX releases the GIL during inference, so a small thread bound is enough.
_engine = None
_engine_lock = threading.Lock()
_local_sem: asyncio.Semaphore | None = None


def _get_engine():
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                from rapidocr_onnxruntime import RapidOCR

                _engine = RapidOCR()
    return _engine


def _sem(settings: Settings) -> asyncio.Semaphore:
    global _local_sem
    if _local_sem is None:
        _local_sem = asyncio.Semaphore(max(1, settings.ai_ocr_local_concurrency))
    return _local_sem


def warm_ocr() -> None:
    """Build + warm the engine once (call at startup so the first ingest is fast)."""
    try:
        import numpy as np
        from PIL import Image

        img = Image.new("RGB", (32, 32), "white")
        _get_engine()(np.array(img))
        log.info("ocr_local_warmed")
    except Exception:  # noqa: BLE001 - warmup is best-effort
        log.warning("ocr_local_warm_failed")


def _rapidocr_sync(raw: bytes) -> tuple[str, float]:
    """Returns (text, mean_confidence). Runs in a thread."""
    import numpy as np
    from PIL import Image

    img = Image.open(io.BytesIO(raw)).convert("RGB")
    result, _ = _get_engine()(np.array(img))
    if not result:
        return "", 0.0
    texts = [r[1] for r in result if len(r) > 1 and r[1]]
    confs = [float(r[2]) for r in result if len(r) > 2]
    text = "\n".join(texts).strip()
    conf = sum(confs) / len(confs) if confs else 0.0
    return text, conf


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
            text, conf = await asyncio.to_thread(_rapidocr_sync, raw)
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

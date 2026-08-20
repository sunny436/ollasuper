"""Image OCR via an OpenRouter vision model.

No system binary (tesseract) — this service already speaks vision through
ChatOpenAI and holds the OpenRouter key, so an LLM call adds no new moving parts
and handles screenshots/handwriting/rotated scans that tesseract degrades on.
Reuses the attachment image pipeline (downscale + decompression-bomb guard) and
the non-streaming, swallow-on-failure pattern of /v1/title. One bad image must
never fail the whole file — it just contributes no chunks.
"""

from __future__ import annotations

import asyncio
import base64

from langchain_core.messages import HumanMessage, SystemMessage

from app.agent.llm import build_llm
from app.clients.attachments import _normalise_image
from app.config import Settings
from app.ingest.types import NormalizedDoc
from app.logging import get_logger

log = get_logger(__name__)

OCR_PROMPT = (
    "Transcribe ALL text in this image verbatim, in natural reading order. "
    "Render tables as markdown. After the transcription, add one short line "
    "describing any non-text visual content. Output ONLY the transcription and "
    "that line — no preamble, no commentary."
)


async def ocr_image(
    raw: bytes, mime: str, *, name: str, settings: Settings
) -> list[NormalizedDoc]:
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
        msg = await llm.ainvoke(
            [
                SystemMessage(content=OCR_PROMPT),
                HumanMessage(
                    content=[
                        {"type": "text", "text": "Transcribe this image."},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:{out_mime};base64,{b64}"},
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
                    "ocr_status": "ok",
                    "model": settings.ai_ocr_model,
                },
            )
        ]
    except Exception:  # noqa: BLE001 - OCR is best-effort; never fail the file
        log.exception("ocr_failed", extra={"name": name})
        return []

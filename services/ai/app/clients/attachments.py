"""Turn Convex attachments into OpenAI-compatible content parts."""

from __future__ import annotations

import asyncio
import base64
import io

from app.clients.convex import ConvexClient, ConvexUnavailable
from app.config import Settings
from app.logging import get_logger
from app.models.chat import IMAGE_LONG_EDGE, Attachment, HistoryMessage

log = get_logger(__name__)

ACCEPTED_IMAGE = {"image/png", "image/jpeg", "image/webp", "image/gif"}
MAX_IMAGE_BYTES = 3_500_000  # -> ~4.7MB base64, under the 5MB per-image limit
MAX_PDF_CHARS = 60_000


class AttachmentError(RuntimeError):
    pass


def _normalise_image(raw: bytes, mime: str, long_edge: int) -> tuple[bytes, str]:
    """Downscale and re-encode. Runs in a thread — Pillow is the only CPU-bound
    work in this service and must not block the event loop."""
    from PIL import Image

    img = Image.open(io.BytesIO(raw))
    img.load()
    if img.mode not in ("RGB", "RGBA", "L"):
        img = img.convert("RGB")

    w, h = img.size
    if max(w, h) > long_edge:
        scale = long_edge / max(w, h)
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))))

    if mime == "image/png" and img.mode in ("RGB", "RGBA", "L"):
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        if buf.tell() <= MAX_IMAGE_BYTES:
            return buf.getvalue(), "image/png"

    if img.mode == "RGBA":
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85, optimize=True)
    return buf.getvalue(), "image/jpeg"


def _extract_pdf_text(raw: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(raw))
    parts: list[str] = []
    total = 0
    for page in reader.pages:
        text = page.extract_text() or ""
        parts.append(text)
        total += len(text)
        if total > MAX_PDF_CHARS:
            break
    return "\n".join(parts)[:MAX_PDF_CHARS]


async def _image_part(att: Attachment, convex: ConvexClient, model: str) -> dict:
    mime = att.contentType.split(";")[0].strip().lower()
    if mime not in ACCEPTED_IMAGE:
        raise AttachmentError(f"unsupported image type: {mime}")
    raw, _ = await convex.fetch_file(att.storageId)
    long_edge = IMAGE_LONG_EDGE.get(model, 1568)
    data, out_mime = await asyncio.to_thread(_normalise_image, raw, mime, long_edge)
    b64 = base64.b64encode(data).decode()
    return {"type": "image_url", "image_url": {"url": f"data:{out_mime};base64,{b64}"}}


async def _document_text(att: Attachment, convex: ConvexClient) -> str:
    """Server-side extraction.

    This is the default rather than OpenRouter's file-parser plugin because it
    always works and needs no provider support. The plugin path requires
    ChatOpenAI to forward both an unrecognised content-part dict and
    extra_body.plugins untouched — unverified, so it stays behind a flag.
    """
    if att.extractedText:
        return att.extractedText[:MAX_PDF_CHARS]
    raw, _ = await convex.fetch_file(att.storageId)
    mime = att.contentType.split(";")[0].strip().lower()
    if mime == "application/pdf":
        return await asyncio.to_thread(_extract_pdf_text, raw)
    try:
        return raw.decode("utf-8", errors="replace")[:MAX_PDF_CHARS]
    except Exception as e:  # noqa: BLE001
        raise AttachmentError(f"could not read {att.name}") from e


async def build_user_content(
    message: HistoryMessage,
    convex: ConvexClient,
    settings: Settings,
    *,
    model: str,
) -> tuple[str | list[dict], int]:
    """Build the user turn's content, returning (content, image_count).

    Returns a plain string when there are no attachments so the common path
    stays simple.
    """
    if not message.attachments:
        return message.content, 0

    images = [a for a in message.attachments if a.kind == "image"]
    others = [a for a in message.attachments if a.kind != "image"]

    if len(images) > settings.ai_max_images_per_turn:
        raise AttachmentError(
            f"at most {settings.ai_max_images_per_turn} images per message"
        )

    parts: list[dict] = []
    for att in images:
        try:
            parts.append(await _image_part(att, convex, model))
        except ConvexUnavailable as e:
            raise AttachmentError(f"could not load {att.name}") from e

    doc_blocks: list[str] = []
    for att in others:
        try:
            text = await _document_text(att, convex)
        except ConvexUnavailable as e:
            raise AttachmentError(f"could not load {att.name}") from e
        if text.strip():
            doc_blocks.append(f'<document name="{att.name}">\n{text}\n</document>')

    text_body = message.content
    if doc_blocks:
        text_body = "\n\n".join([*doc_blocks, message.content]).strip()
    parts.append({"type": "text", "text": text_body})
    return parts, len(images)

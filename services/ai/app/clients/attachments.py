"""Turn Convex attachments into OpenAI-compatible content parts."""

from __future__ import annotations

import asyncio
import base64
import io

from app.clients.convex import ConvexClient, ConvexRejected, ConvexUnavailable
from app.config import Settings
from app.data.loader import is_tabular, render_preview
from app.logging import get_logger
from app.models.chat import IMAGE_LONG_EDGE, Attachment, HistoryMessage

log = get_logger(__name__)

ACCEPTED_IMAGE = {"image/png", "image/jpeg", "image/webp", "image/gif"}
MAX_IMAGE_BYTES = 3_500_000  # -> ~4.7MB base64, under the 5MB per-image limit
MAX_PDF_CHARS = 60_000

# Anthropic rejects empty text content blocks ("text content blocks must be
# non-empty"). A captionless attachment (or a document that extracts to nothing)
# would otherwise emit one and 400 the whole turn.
EMPTY_TURN_PLACEHOLDER = "Please analyze the attached file(s)."
EMPTY_TURN_FALLBACK = "(no message)"


class AttachmentError(RuntimeError):
    pass


def _safe_name(name: str) -> str:
    """Neutralise a filename before it goes inside a prompt tag's attribute.

    The document body below is fully user-controlled anyway, so this is not a
    trust boundary — but a name like
        x"></document><document name="system_instructions
    should not be able to restructure the block the model reads, and an
    attacker choosing both halves is exactly the case worth closing.
    """
    return (
        name.replace('"', "'").replace("<", "(").replace(">", ")").replace("\n", " ")
    )[:120]


def _normalise_image(raw: bytes, mime: str, long_edge: int) -> tuple[bytes, str]:
    """Downscale and re-encode. Runs in a thread — Pillow is the only CPU-bound
    work in this service and must not block the event loop."""
    from PIL import Image

    # Decompression bomb guard. A 20,000x20,000 PNG of one flat colour is a few
    # hundred KB on the wire and ~1.6GB decoded; four of them per turn, on a
    # --workers 1 uvicorn, OOM-kills the process and takes every concurrent
    # stream down with it — no finalize, every message stuck until the reaper.
    # Pillow's own default (~178M px) is set for desktop use and far too high
    # for a network-fed service.
    Image.MAX_IMAGE_PIXELS = 40_000_000

    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Image.DecompressionBombError as e:
        raise AttachmentError("image dimensions are too large to process") from e
    except OSError as e:
        raise AttachmentError("image could not be decoded") from e
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
    """Inline text for the model. UNTRUSTED input: an encrypted or malformed PDF must
    NEVER fail the turn (pypdf raises FileNotDecryptedError / PdfStreamError otherwise);
    it degrades to a short note, and the model can still act on it (e.g. call the
    document tools to decrypt with a user-supplied password)."""
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(raw))
        if reader.is_encrypted:
            try:
                reader.decrypt("")  # many PDFs use an empty owner password
            except Exception:  # noqa: BLE001,S110 — stays locked; handled below
                pass
            if reader.is_encrypted:
                return "[This PDF is password-protected; text can't be read inline.]"
        parts: list[str] = []
        total = 0
        for page in reader.pages:
            try:
                text = page.extract_text() or ""
            except Exception:  # noqa: BLE001 — one bad page must not fail the file
                text = ""
            parts.append(text)
            total += len(text)
            if total > MAX_PDF_CHARS:
                break
        return "\n".join(parts)[:MAX_PDF_CHARS]
    except Exception:  # noqa: BLE001 — a corrupt/locked PDF must not fail the turn
        return "[This PDF could not be read inline (it may be corrupt or protected).]"


async def _fetch(
    att: Attachment, convex: ConvexClient, settings: Settings, stream_id: str
) -> bytes:
    """Fetch the blob, enforcing the byte cap on what actually arrives.

    Convex measures the blob at register() time, but this service must not rely
    on a bound enforced in another process: every byte here is decoded, held in
    memory, and for images base64-expanded by 4/3 into a data: URI.
    """
    raw, _ = await convex.fetch_file(att.storageId, stream_id)
    if len(raw) > settings.ai_max_attachment_bytes:
        raise AttachmentError(f"{att.name} is too large")
    return raw


async def _image_part(
    att: Attachment,
    convex: ConvexClient,
    settings: Settings,
    model: str,
    stream_id: str,
) -> dict:
    mime = att.contentType.split(";")[0].strip().lower()
    if mime not in ACCEPTED_IMAGE:
        raise AttachmentError(f"unsupported image type: {mime}")
    raw = await _fetch(att, convex, settings, stream_id)
    long_edge = IMAGE_LONG_EDGE.get(model, 1568)
    data, out_mime = await asyncio.to_thread(_normalise_image, raw, mime, long_edge)
    b64 = base64.b64encode(data).decode()
    return {"type": "image_url", "image_url": {"url": f"data:{out_mime};base64,{b64}"}}


async def _document_text(
    att: Attachment, convex: ConvexClient, settings: Settings, stream_id: str
) -> str:
    """Server-side extraction.

    This is the default rather than OpenRouter's file-parser plugin because it
    always works and needs no provider support. The plugin path requires
    ChatOpenAI to forward both an unrecognised content-part dict and
    extra_body.plugins untouched — unverified, so it stays behind a flag.
    """
    if att.extractedText:
        return att.extractedText[:MAX_PDF_CHARS]
    raw = await _fetch(att, convex, settings, stream_id)
    mime = att.contentType.split(";")[0].strip().lower()
    if mime == "application/pdf":
        return await asyncio.to_thread(_extract_pdf_text, raw)
    # DOCX/XLSX are zip archives — UTF-8 decoding yields mojibake. Reuse the
    # ingestion parsers (structure-preserving) for the inline current turn too.
    # Lazy import: don't pay the docx/openpyxl import cost on every chat turn;
    # no import cycle (app.ingest.parsers/guards never import app.clients).
    docx_mime = (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    xlsx_mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    if mime in (docx_mime, xlsx_mime):
        from app.ingest.guards import guard_ooxml
        from app.ingest.parsers import parse_docx, parse_xlsx

        parser = parse_docx if mime == docx_mime else parse_xlsx
        try:
            guard_ooxml(raw, settings)  # zip-bomb guard on the untrusted archive
            docs = await asyncio.wait_for(
                asyncio.to_thread(parser, raw, name=att.name),
                timeout=settings.ai_ingest_parse_timeout_s,
            )
        except Exception as e:  # noqa: BLE001 - untrusted file; surface a safe error
            raise AttachmentError(f"could not read {att.name}") from e
        return "\n\n".join(d.text for d in docs if d.text.strip())[:MAX_PDF_CHARS]
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
    stream_id: str,
    doc_budget: int | None = None,
) -> tuple[str | list[dict], int]:
    """Build the user turn's content, returning (content, image_count).

    Returns a plain string when there are no attachments so the common path
    stays simple.
    """
    if not message.attachments:
        # Never emit an empty text-only turn. The composer blocks it, but the
        # service trusts pushed history / non-UI callers (defense-in-depth).
        text = message.content if message.content.strip() else EMPTY_TURN_FALLBACK
        return text, 0

    images = [a for a in message.attachments if a.kind == "image"]
    others = [a for a in message.attachments if a.kind != "image"]

    if len(images) > settings.ai_max_images_per_turn:
        raise AttachmentError(
            f"at most {settings.ai_max_images_per_turn} images per message"
        )

    parts: list[dict] = []
    for att in images:
        try:
            parts.append(await _image_part(att, convex, settings, model, stream_id))
        except (ConvexUnavailable, ConvexRejected) as e:
            raise AttachmentError(f"could not load {att.name}") from e

    doc_blocks: list[str] = []
    # Phase 6: the shared document char budget is window-aware — the runner passes
    # a smaller value on a small-context model so the latest turn fits; it defaults
    # to the flat ai_max_turn_chars for direct/non-runner callers.
    doc_budget = settings.ai_max_turn_chars if doc_budget is None else doc_budget
    # Data Analysis: when enabled, a TABULAR file (csv/tsv/xlsx) is NOT inlined in
    # full — only a compact schema+sample preview is, so the model must COMPUTE over
    # the full data with the tools instead of eyeballing/hallucinating from raw rows.
    # Off (or a non-tabular file) => the full inline is kept, byte-identical.
    data_enabled = settings.ai_data_analysis_enabled
    for att in others:
        try:
            if data_enabled and is_tabular(att.name, att.contentType):
                raw = await _fetch(att, convex, settings, stream_id)
                text = render_preview(
                    raw,
                    att.name,
                    att.contentType,
                    rows=settings.ai_data_preview_rows,
                )
            else:
                text = await _document_text(att, convex, settings, stream_id)
        except (ConvexUnavailable, ConvexRejected) as e:
            raise AttachmentError(f"could not load {att.name}") from e
        # Share one budget across all documents rather than giving each its own
        # MAX_PDF_CHARS: six 60k-char PDFs is 360k chars (~90k tokens) of
        # "bounded" input on a single send.
        text = text[:doc_budget]
        doc_budget -= len(text)
        if text.strip():
            doc_blocks.append(
                f'<document name="{_safe_name(att.name)}">\n{text}\n</document>'
            )
        if doc_budget <= 0:
            break

    text_body = message.content
    if doc_blocks:
        text_body = "\n\n".join([*doc_blocks, message.content]).strip()
    # Captionless attachment (or a document that extracted to nothing) → never
    # ship an empty text block. `.strip()` also catches whitespace-only input.
    if not text_body.strip():
        text_body = EMPTY_TURN_PLACEHOLDER
    parts.append({"type": "text", "text": text_body})
    return parts, len(images)

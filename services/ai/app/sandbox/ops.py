"""Pure, secret-free decoders for attacker-controlled bytes.

Everything here parses UNTRUSTED input with NATIVE code (Pillow's C decoders,
PDFium/pypdf) — the classic memory-corruption RCE surface. It is isolated in its
own module for one reason: it is what runs inside the sandbox worker, and the
worker must be importable WITHOUT dragging in Settings, the Convex client, or
anything else that reads a secret. Nothing in this file touches the network, the
environment, or the database; it takes bytes and returns bytes or text.

The IN-PROCESS callers (the Windows dev fallback) import these too, so there is
exactly one copy of each decoder.
"""

from __future__ import annotations

import io

MAX_IMAGE_BYTES = 3_500_000  # -> ~4.7MB base64, under the 5MB per-image limit
MAX_PDF_CHARS = 60_000
# The Pillow decoders our four accepted mimes may legitimately reach, and no
# others — so PSD/DDS/FLI/FPX/PCX/SGI/XBM and every parser whose advisory is not
# written yet are unreachable, not merely un-patched.
SAFE_IMAGE_FORMATS = ["PNG", "JPEG", "WEBP", "GIF"]


class DecodeError(RuntimeError):
    """A decode that failed in a way the caller should surface, not a crash."""


def normalise_image(raw: bytes, mime: str, long_edge: int) -> tuple[bytes, str]:
    """Downscale and re-encode. See the long comment that used to live in
    attachments._normalise_image for why the format allowlist and the pixel cap
    are load-bearing."""
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = 40_000_000
    try:
        img = Image.open(io.BytesIO(raw), formats=SAFE_IMAGE_FORMATS)
        img.load()
    except Image.DecompressionBombError as e:
        raise DecodeError("image dimensions are too large to process") from e
    except OSError as e:
        raise DecodeError("image could not be decoded") from e
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


def extract_pdf_text(raw: bytes) -> str:
    """Inline text for the model. UNTRUSTED input: an encrypted or malformed PDF
    must NEVER fail the turn — it degrades to a short note."""
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

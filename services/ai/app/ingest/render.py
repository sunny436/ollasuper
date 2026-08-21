"""Native ingest work that runs in a POOL WORKER (never the main process).

Two crash-prone native libraries execute here — libpdfium (page render) and
ONNX Runtime (RapidOCR local OCR). Kept in ONE small module with no
langchain/config imports so the spawn pool starts workers fast; the heavy
RapidOCR/ONNX import is lazy, so a worker only pays it the first time it OCRs.

Both `render_page` and `ocr_png_bytes` are the callables submitted to
`pool.run_in_pool`, so an edge-case SEGV in either kills only the worker, not
the `--workers 1` service (see pool.py).
"""

from __future__ import annotations

import io
import threading

# Per-worker RapidOCR singleton. A ProcessPoolExecutor reuses its workers, so
# the ONNX model load is paid once per worker, not once per page.
_ocr_engine = None
_ocr_lock = threading.Lock()


def render_page(raw: bytes, idx: int) -> bytes | None:
    """Render one page to PNG in a short-lived pdfium doc. Returns None on any
    Python-level failure (a native segfault is caught by the pool as a dead
    worker, not here). scale 2.0 is ~144 dpi."""
    import pypdfium2 as pdfium

    doc = None
    try:
        doc = pdfium.PdfDocument(raw)
        bitmap = doc[idx].render(scale=2.0)
        buf = io.BytesIO()
        bitmap.to_pil().save(buf, format="PNG")
        return buf.getvalue()
    except Exception:  # noqa: BLE001,S112 - unrenderable page/doc: skip, do not fail
        return None
    finally:
        if doc is not None:
            doc.close()


def _get_ocr_engine():
    global _ocr_engine
    if _ocr_engine is None:
        with _ocr_lock:
            if _ocr_engine is None:
                from rapidocr_onnxruntime import RapidOCR

                _ocr_engine = RapidOCR()
    return _ocr_engine


def ocr_png_bytes(raw: bytes) -> tuple[str, float]:
    """Run RapidOCR on an encoded image (PNG/JPG/…). Returns (text, mean_conf).

    Runs in a pool worker so an ONNX Runtime crash is isolated. Both the Pillow
    decode and the ONNX inference — the native, per-image work — happen here,
    off the main process.
    """
    import numpy as np
    from PIL import Image

    img = Image.open(io.BytesIO(raw)).convert("RGB")
    result, _ = _get_ocr_engine()(np.array(img))
    if not result:
        return "", 0.0
    texts = [r[1] for r in result if len(r) > 1 and r[1]]
    confs = [float(r[2]) for r in result if len(r) > 2]
    text = "\n".join(texts).strip()
    conf = sum(confs) / len(confs) if confs else 0.0
    return text, conf

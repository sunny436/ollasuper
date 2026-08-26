"""The single source of truth for format → (MIME, extension) + rendering class.

`BINARY_FORMATS` (reportlab/openpyxl/docx/pptx/Pillow/matplotlib) run in the process
pool; the rest are stdlib text and render inline. Filenames are slugified here so no
model-authored name ever reaches the filesystem or a Content-Disposition header raw.
"""

from __future__ import annotations

import re

# format -> (mime, extension without dot)
FORMATS: dict[str, tuple[str, str]] = {
    "pdf": ("application/pdf", "pdf"),
    "docx": (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx",
    ),
    "txt": ("text/plain; charset=utf-8", "txt"),
    "md": ("text/markdown; charset=utf-8", "md"),
    "html": ("text/html; charset=utf-8", "html"),
    "rtf": ("application/rtf", "rtf"),
    "xlsx": (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xlsx",
    ),
    "csv": ("text/csv; charset=utf-8", "csv"),
    "tsv": ("text/tab-separated-values; charset=utf-8", "tsv"),
    "json": ("application/json; charset=utf-8", "json"),
    "xml": ("application/xml; charset=utf-8", "xml"),
    "yaml": ("application/yaml; charset=utf-8", "yaml"),
    "pptx": (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pptx",
    ),
    "png": ("image/png", "png"),
    "jpeg": ("image/jpeg", "jpg"),
    "webp": ("image/webp", "webp"),
    "svg": ("image/svg+xml", "svg"),
}

# Rendered by a CPU-heavy / C-extension library → run in the process pool.
BINARY_FORMATS = frozenset(
    {"pdf", "docx", "xlsx", "pptx", "png", "jpeg", "webp", "svg"}
)


def mime_for(fmt: str) -> str:
    return FORMATS[fmt][0]


def ext_for(fmt: str) -> str:
    return FORMATS[fmt][1]


_SLUG = re.compile(r"[^a-zA-Z0-9._-]+")


def safe_filename(name: str, fmt: str, *, fallback: str = "document") -> str:
    """Slugify a model/title-derived name and force the correct extension. No path
    separators, no traversal, bounded length — safe for storage + headers."""
    ext = ext_for(fmt)
    base = (name or "").strip()
    # Drop any directory components and a caller-supplied extension; we set our own.
    base = base.replace("\\", "/").rsplit("/", 1)[-1]
    base = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", base)
    base = _SLUG.sub("-", base).strip("-._")[:80]
    if not base:
        base = fallback
    return f"{base}.{ext}"

"""Secure file-type detection.

The browser-provided MIME is UNTRUSTED and never drives dispatch. Order: magic
bytes (filetype) -> content sniff for the text family (which has no magic bytes)
-> extension -> declared mime only as a last tiebreak.
"""

from __future__ import annotations

import csv
import json

import filetype

from app.ingest.types import FileType, IngestError

_EXT: dict[str, FileType] = {
    "pdf": "pdf",
    "docx": "docx",
    "xlsx": "xlsx",
    "csv": "csv",
    "json": "json",
    "html": "html",
    "htm": "html",
    "md": "markdown",
    "markdown": "markdown",
    "txt": "text",
    "text": "text",
    "log": "text",
    "png": "image",
    "jpg": "image",
    "jpeg": "image",
    "webp": "image",
    "gif": "image",
}

# filetype.guess() reads the header; it understands the OOXML zip well enough to
# distinguish docx/xlsx, plus pdf/images. Text formats return None (no magic).
_MAGIC: dict[str, FileType] = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "image/png": "image",
    "image/jpeg": "image",
    "image/webp": "image",
    "image/gif": "image",
}


def _ext_of(name: str) -> FileType | None:
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    if "." not in base:
        return None
    return _EXT.get(base.rsplit(".", 1)[-1].lower())


def _try_decode(raw: bytes) -> str | None:
    try:
        return raw[:65536].decode("utf-8")
    except UnicodeDecodeError:
        return None


def _sniff_text(sample: str) -> FileType | None:
    s = sample.lstrip()
    low = s[:256].lower()
    if low.startswith("<!doctype html") or low.startswith("<html") or "<body" in low:
        return "html"
    if s[:1] in "{[":
        try:
            json.loads(sample)
            return "json"
        except (json.JSONDecodeError, ValueError):
            pass
    # CSV: a consistent delimiter across the first lines with >1 column.
    head = "\n".join(sample.splitlines()[:10])
    if head.count(",") >= 2 or head.count("\t") >= 2:
        try:
            csv.Sniffer().sniff(head)
            return "csv"
        except csv.Error:
            pass
    return None


def detect_type(raw: bytes, declared_mime: str | None, name: str) -> FileType:
    """Return the canonical FileType, raising IngestError if unrecognized."""
    kind = filetype.guess(raw)
    if kind is not None:
        mapped = _MAGIC.get(kind.mime)
        if mapped:
            return mapped

    ext = _ext_of(name)
    text = _try_decode(raw)
    if text is not None:
        sniffed = _sniff_text(text)
        if sniffed:
            return sniffed
        if ext in {"markdown", "text", "csv", "json", "html"}:
            return ext
        return "text"

    # Not decodable and no known magic: trust the extension, else give up.
    if ext:
        return ext
    raise IngestError("unsupported or unrecognized file type")

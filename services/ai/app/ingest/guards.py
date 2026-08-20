"""Security guards for untrusted uploads.

Filename sanitization, OOXML zip-bomb rejection, and XML hardening. HONEST
caveat: a zip central-directory `file_size` can be forged low, so the header
check only rejects the cheap/obvious bombs — the DEFINITIVE backstops are the
per-parse wall-clock timeout and the extracted-char cap in pipeline.py.
"""

from __future__ import annotations

import io
import re
import zipfile

from defusedxml import defuse_stdlib

from app.config import Settings
from app.ingest.types import IngestError

# Hardens any stdlib XML parsing (xml.sax/dom/etree.ElementTree) against XXE /
# billion-laughs. python-docx/openpyxl mostly use lxml (not covered here), so
# for those the char cap + timeout are the real bound — see module docstring.
defuse_stdlib()

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_STRIP = str.maketrans("", "", '"<>')


def safe_name(name: str) -> str:
    """Basename only, control-chars/quotes/brackets removed. Used purely as
    `source_name` metadata — never as a filesystem path (nothing is written)."""
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    base = _CONTROL.sub("", base).translate(_STRIP).strip()
    return (base or "file")[:200]


def guard_ooxml(raw: bytes, settings: Settings) -> None:
    """Reject obvious decompression bombs before python-docx/openpyxl open the
    archive on the same bytes."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as e:
        raise IngestError("not a valid OOXML archive") from e
    with zf:
        infos = zf.infolist()
        if len(infos) > settings.ai_zip_max_entries:
            raise IngestError("archive has too many entries")
        total = 0
        for info in infos:
            total += info.file_size
            if total > settings.ai_zip_max_uncompressed_bytes:
                raise IngestError("archive expands too large")
            comp = info.compress_size or 1
            if info.file_size // comp > settings.ai_zip_max_ratio:
                raise IngestError("suspicious compression ratio")

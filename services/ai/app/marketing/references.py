"""Registry + section-aware loader for the bundled Marketing reference corpus.

The `references/*.md` playbooks (MARKETING-owned specialist methodologies — MIT,
alirezarezvani/claude-skills, see references/NOTICE.md) are trusted internal reference
data served on demand by the `marketing_reference` tool. Some files exceed the per-tool
result cap, so the loader returns either a doc's TABLE OF CONTENTS (headers) + intro, or
one requested SECTION — always bounded. No network, no mutation; deterministic given the
bundled files. Mirrors app/finance/references.py.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

_REF_DIR = Path(__file__).parent / "references"
MAX_REF_CHARS = 6500  # keep one tool result comfortably under the serialized cap

_HEADER_RE = re.compile(r"^(#{2,6})\s+(.*\S)\s*$")


@lru_cache(maxsize=1)
def list_docs() -> tuple[str, ...]:
    """Every servable doc id (file stem), sorted. Excludes NOTICE.md."""
    if not _REF_DIR.is_dir():
        return ()
    return tuple(
        sorted(p.stem for p in _REF_DIR.glob("*.md") if p.name.upper() != "NOTICE.MD")
    )


def _resolve(doc: str) -> Path | None:
    """Map a doc id to its file, guarding against path traversal outside references/."""
    if not doc:
        return None
    doc = doc.strip().removesuffix(".md")
    p = (_REF_DIR / f"{doc}.md").resolve()
    try:
        p.relative_to(_REF_DIR.resolve())
    except ValueError:
        return None
    return p if p.is_file() else None


def _headers(text: str) -> list[str]:
    return [m.group(2) for line in text.splitlines() if (m := _HEADER_RE.match(line))]


def _clip(text: str, limit: int = MAX_REF_CHARS) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[:limit].rstrip() + "\n…[truncated]", True


def load_reference(doc: str, section: str | None = None) -> dict:
    """Return the bundled playbook `doc` (a section, or its TOC + intro).

    doc: a valid id from `list_docs()` (e.g. 'marketing-strategy-pmm', 'page-cro',
    'aeo').
    section: optional header text (case-insensitive substring); when omitted, returns
    the
    intro + the list of section headers. Unknown doc/section -> {"error": …}
    (never raises)."""
    path = _resolve(doc)
    if path is None:
        return {"error": f"unknown reference '{doc}'. Call with a valid `doc` id."}
    text = path.read_text(encoding="utf-8", errors="replace")
    heads = _headers(text)
    doc_id = path.stem

    if section:
        low = section.strip().lower()
        lines = text.splitlines()
        start = level = None
        for i, line in enumerate(lines):
            m = _HEADER_RE.match(line)
            if m and low in m.group(2).lower():
                start, level = i, len(m.group(1))
                break
        if start is None:
            return {
                "error": f"section '{section}' not found in '{doc_id}'",
                "available_sections": heads,
            }
        end = len(lines)
        for j in range(start + 1, len(lines)):
            m = _HEADER_RE.match(lines[j])
            if m and len(m.group(1)) <= level:
                end = j
                break
        body, truncated = _clip("\n".join(lines[start:end]))
        return {
            "doc": doc_id,
            "section": lines[start].lstrip("# ").strip(),
            "content": body,
            "truncated": truncated,
        }

    intro_end = next(
        (i for i, ln in enumerate(text.splitlines()) if _HEADER_RE.match(ln)), None
    )
    intro = "\n".join(text.splitlines()[:intro_end]) if intro_end else text
    body, truncated = _clip(intro)
    return {
        "doc": doc_id,
        "sections": heads,
        "intro": body,
        "truncated": truncated,
        "hint": "call marketing_reference again with `section` set to one "
        "of `sections`.",
    }

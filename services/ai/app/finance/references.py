"""Registry + section-aware loader for the bundled Finance reference corpus.

The `references/` markdown (equity methodology, 27 sector playbooks, FP&A + SaaS
guides — MIT, alirezarezvani/claude-skills, see references/NOTICE.md) is trusted
internal
reference data served on demand by the `finance_reference` tool. Individual files reach
55 KB, far above the per-tool result cap, so the loader returns either a doc's TABLE OF
CONTENTS (headers) + intro, or one requested SECTION — always bounded. No network, no
mutation; deterministic given the bundled files.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

_REF_DIR = Path(__file__).parent / "references"
# Keep a single tool result comfortably under the executor's serialized cap.
MAX_REF_CHARS = 6500

_HEADER_RE = re.compile(r"^(#{2,6})\s+(.*\S)\s*$")


@lru_cache(maxsize=1)
def list_docs() -> tuple[str, ...]:
    """Every servable doc id (relative path without `.md`, forward-slashed), sorted.
    Excludes NOTICE.md (attribution, not reference content)."""
    if not _REF_DIR.is_dir():
        return ()
    ids = []
    for p in _REF_DIR.rglob("*.md"):
        if p.name.upper() == "NOTICE.MD":
            continue
        ids.append(p.relative_to(_REF_DIR).with_suffix("").as_posix())
    return tuple(sorted(ids))


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


def _headers(text: str) -> list[tuple[int, str]]:
    out = []
    for line in text.splitlines():
        m = _HEADER_RE.match(line)
        if m:
            out.append((len(m.group(1)), m.group(2)))
    return out


def _clip(text: str, limit: int = MAX_REF_CHARS) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[:limit].rstrip() + "\n…[truncated]", True


def load_reference(doc: str, section: str | None = None) -> dict:
    """Return the bundled reference `doc` (a section, or its TOC + intro).

    doc: a valid id from `list_docs()` (e.g. 'equity/sectors/banks',
    'equity/06-valuation').
    section: optional header text (case-insensitive substring); when omitted, returns
    the
    intro plus the list of section headers so the caller can request one.
    Unknown doc/section -> {"error": …} (never raises)."""
    path = _resolve(doc)
    if path is None:
        return {"error": f"unknown reference '{doc}'. Call with a valid `doc` id."}
    text = path.read_text(encoding="utf-8", errors="replace")
    heads = _headers(text)
    doc_id = path.relative_to(_REF_DIR).with_suffix("").as_posix()

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
                "available_sections": [h for _, h in heads],
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
        "sections": [h for _, h in heads],
        "intro": body,
        "truncated": truncated,
        "hint": "call finance_reference again with `section` set to one of `sections`.",
    }

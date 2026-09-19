"""Traceability — can each source the answer cites be traced to something this
turn actually retrieved, and did the answer cite what it retrieved at all?

WHY THIS EXISTS. The 18.09.2026 skill audit found an answer with ZERO links after
sources had been read, citation markers pointing at nothing, and numeric tables
with no attribution. Nothing in the pipeline compared the answer's citations with
the turn's retrievals — `claims.py` checks files and actions, not sources.

WHAT IS CHECKABLE DETERMINISTICALLY — and what is not. A URL either appeared in a
tool result this turn or it did not: that is URL-level provenance, and a cited URL
that was never retrieved is exactly the fabricated-citation failure. Whether a
source's TEXT supports a sentence is a judgment the model makes with
`research.compare`; this module does not pretend to make it. Tables are checked
at TABLE level (a source somewhere in or beside the table), never per cell.

Gated on evidence having been retrieved this turn: a plain answer from knowledge
cites nothing and owes nothing here. Same design rule as `claims.py`: appended
from recorded state, never authored by the model.
"""

from __future__ import annotations

import re

from app.agent.freshness import FreshnessLedger, cited_urls

_FENCE = re.compile(r"```.*?```", re.S)
_MARKER = re.compile(r"\[(\d{1,3})\](?!\()")
_SOURCE_LINE = re.compile(r"^\s*\[(\d{1,3})\][\s:.\-–—]", re.M)
_LINKISH = re.compile(r"https?://|\]\(|\[\d{1,3}\]", re.I)
_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")
_SEPARATOR = re.compile(r"^\s*\|?\s*:?-{2,}")
_NUMERIC_CELL = re.compile(
    r"^[\s$€£₹]*[-+]?\d[\d,]*(?:\.\d+)?\s*[%$€£₹]?\s*(?:[kKmMbB]|bn|mn|cr|crore|lakh)?\s*$"
)
_MAX_LISTED = 8


def _tables(lines: list[str]) -> list[tuple[int, int]]:
    """(start, end) line spans of markdown tables — a row block with a separator."""
    spans: list[tuple[int, int]] = []
    i = 0
    while i < len(lines):
        if _TABLE_ROW.match(lines[i]):
            j = i
            while j < len(lines) and _TABLE_ROW.match(lines[j]):
                j += 1
            block = lines[i:j]
            if len(block) >= 3 and any(_SEPARATOR.match(ln) for ln in block[:2]):
                spans.append((i, j))
            i = j
        else:
            i += 1
    return spans


def _numeric_cells(lines: list[str]) -> int:
    n = 0
    for ln in lines:
        if _SEPARATOR.match(ln):
            continue
        for cell in ln.strip().strip("|").split("|"):
            if _NUMERIC_CELL.match(cell):
                n += 1
    return n


def uncited_tables(answer: str) -> int:
    """Tables carrying at least two numeric cells and no link, URL or citation
    marker inside them or within three lines on either side."""
    lines = _FENCE.sub("", answer or "").split("\n")
    count = 0
    for start, end in _tables(lines):
        block = lines[start:end]
        if _numeric_cells(block) < 2:
            continue
        around = lines[max(0, start - 3) : min(len(lines), end + 3)]
        if not any(_LINKISH.search(ln) for ln in around):
            count += 1
    return count


def render_traceability(answer: str, ledger: FreshnessLedger | None) -> str:
    """The end-of-turn traceability note, or "" when nothing needs saying."""
    if ledger is None or not (ledger.search_ok > 0 or ledger.read_urls):
        return ""
    text = _FENCE.sub("", answer or "")
    cited = cited_urls(text)
    markers = {int(m.group(1)) for m in _MARKER.finditer(text)}
    entries = {int(m.group(1)) for m in _SOURCE_LINE.finditer(text)}
    parts: list[str] = []

    if not cited and not markers:
        shown = (ledger.read_urls or sorted(ledger.retrieved_urls))[:_MAX_LISTED]
        parts.append(
            "**Sources consulted but not cited.** The answer gives no source links "
            "although these pages were retrieved this turn:\n"
            + "\n".join(f"- {u}" for u in shown)
        )
    else:
        not_retrieved = [
            u
            for u in cited
            if u not in ledger.retrieved_urls and not _is_prefix_of_retrieved(u, ledger)
        ]
        if not_retrieved:
            parts.append(
                f"**{len(not_retrieved)} cited source(s) were not retrieved in this "
                "turn** "
                "and could not be checked — treat those citations as unverified:\n"
                + "\n".join(f"- {u}" for u in not_retrieved[:_MAX_LISTED])
            )
        dangling = sorted(m for m in markers if m not in entries)
        if dangling:
            parts.append(
                "**Citation markers without a source entry:** "
                + ", ".join(f"[{m}]" for m in dangling[:12])
                + " — the answer refers to sources it does not list."
            )
    n_tables = uncited_tables(text)
    if n_tables:
        parts.append(
            f"**{n_tables} table(s) of figures carry no source reference.** Their "
            "numbers cannot be traced to a retrieved source from this answer."
        )
    return "\n\n".join(parts)


def _is_prefix_of_retrieved(key: str, ledger: FreshnessLedger) -> bool:
    """A cited page under a retrieved page's path (a homepage cited for a section
    that was read) is treated as retrieved — the site was consulted."""
    host = key.split("/")[2] if key.count("/") >= 2 else key
    for r in ledger.retrieved_urls:
        if r == key or key.startswith(r + "/") or r.startswith(key + "/"):
            return True
        if r.split("/")[2] == host and len(key.rstrip("/").split("/")) <= 3:
            return True  # the bare domain of a consulted site
    return False

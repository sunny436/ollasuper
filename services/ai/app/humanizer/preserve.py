"""The final validation: a humanized rewrite may change VOICE, never SUBSTANCE.

Rewriting prose is the only step in this pipeline that can lose a fact, so it is
the one step that gets checked by machine rather than trusted. `verify` compares
the draft with its rewrite and refuses anything that:

  * dropped a number, percentage, currency amount or date,
  * dropped or edited a URL or link target,
  * dropped a code block or inline-code span (upstream: never touch code),
  * lost a heading, or changed a heading's meaning (case may change; the content
    words may not),
  * lost a required keyword — the SEO half of "do not damage the page",
  * removed one of the product's structural blocks (the Blog Quality Score, its
    caption, the Sources section),
  * or INVENTED a number or URL that the draft never contained. Zero fabrication
    is the requirement, and an addition is as much a violation as a loss.

Everything is reported by name, because "something was lost" is not actionable
and "the 34% from the intro is gone" is.
"""

from __future__ import annotations

import re
from typing import Any

from app.humanizer.patterns import human_voice_score

__all__ = ["verify"]

#: A DATE IS ONE FACT, not three numbers. Matched first and removed from the
#: text the number scan sees, so "2026-03-14" cannot be reported as losing "03"
#: when a rewrite legitimately renders it "14 March 2026" (measured: it was).
_DATE = re.compile(
    r"\b\d{4}-\d{2}-\d{2}\b"
    r"|\b\d{1,2}/\d{1,2}/\d{2,4}\b"
    r"|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,6}\.?"
    r"\s+\d{1,2},?\s+\d{4}\b"
    r"|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,6}"
    r"\.?\s+\d{4}\b",
    re.I,
)
#: The months a date can be written with, so an ISO date and a spelled-out one
#: compare equal on the thing that matters: which day it names.
_MONTHS = (
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
)

#: 1,200 · 34% · $4.5m · 3.14 — anything else a reader would treat as a figure.
#: Bounded repeats: this runs over model-length text (see patterns.py).
_NUMBER = re.compile(r"[$£€₹]?\d{1,15}(?:[,\d]{0,20})?(?:\.\d{1,6})?%?")
_URL = re.compile(r"https?://[^\s<>()\[\]\"']{1,2000}")
_MD_TARGET = re.compile(r"\]\(([^)\s]{1,2000})(?:\s+\"[^\"]{0,200}\")?\)")
_FENCE = re.compile(r"```[^\n]{0,40}\n(.{0,20000}?)```", re.S)
_INLINE_CODE = re.compile(r"`([^`\n]{1,400})`")
_HEADING = re.compile(r"^#{1,6}\s+([^\n]{1,200})$", re.M)
_WORD = re.compile(r"[A-Za-z0-9']+")
_REF_MARKER = re.compile(r"\[\^?\d{1,3}\]")

#: Structural blocks this product's skills are contractually required to emit.
_STRUCTURES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("blog_quality_score", re.compile(r"OllaSuper Blog Quality Score", re.I)),
    ("ranking_caption", re.compile(r"NOT a Google-ranking prediction", re.I)),
    (
        "sources_section",
        re.compile(r"^#{1,6}\s*Sources(?: &| and)? evidence", re.M | re.I),
    ),
)

_STOP = frozenset(
    {
        "the",
        "a",
        "an",
        "and",
        "or",
        "of",
        "to",
        "in",
        "for",
        "on",
        "with",
        "your",
        "you",
        "how",
        "what",
        "why",
        "is",
        "are",
        "that",
        "this",
        "it",
    }
)


def _canonical_date(raw: str) -> str:
    """Year-month-day, however it was written, so a reformat is not a loss."""
    low = raw.lower().replace(",", " ")
    month = next((i + 1 for i, m in enumerate(_MONTHS) if m in low), 0)
    nums = re.findall(r"\d+", low)
    if month and len(nums) >= 2:
        day, year = (nums[0], nums[1]) if len(nums[0]) <= 2 else (nums[1], nums[0])
        return f"{int(year):04d}-{month:02d}-{int(day):02d}"
    if len(nums) == 3:
        if len(nums[0]) == 4:  # ISO
            return f"{int(nums[0]):04d}-{int(nums[1]):02d}-{int(nums[2]):02d}"
        year = nums[2] if len(nums[2]) == 4 else f"20{nums[2]}"
        return f"{int(year):04d}-{int(nums[0]):02d}-{int(nums[1]):02d}"
    return low.strip()


def _dates(text: str) -> set[str]:
    return {_canonical_date(m.group(0)) for m in _DATE.finditer(text)}


def _numbers(text: str) -> set[str]:
    out = set()
    # Dates are counted separately; leaving them here would split one fact into
    # three and make any reformat look like a loss.
    text = _DATE.sub(" ", text)
    for m in _NUMBER.finditer(text):
        raw = m.group(0)
        # A bare separator run ("1,") or a lone punctuation hit is not a figure.
        norm = raw.replace(",", "").rstrip(".")
        if any(ch.isdigit() for ch in norm):
            out.add(norm.lower())
    return out


def _urls(text: str) -> set[str]:
    out = {m.group(0).rstrip(".,);") for m in _URL.finditer(text)}
    for m in _MD_TARGET.finditer(text):
        target = m.group(1).strip()
        if target and not target.startswith("image-placeholder"):
            out.add(target.rstrip(".,);"))
    return out


def _code(text: str) -> set[str]:
    blocks = {m.group(1).strip() for m in _FENCE.finditer(text)}
    inline = {m.group(1).strip() for m in _INLINE_CODE.finditer(text)}
    return {c for c in blocks | inline if c}


def _headings(text: str) -> list[str]:
    return [m.group(1).strip() for m in _HEADING.finditer(text)]


def _content_words(title: str) -> set[str]:
    return {w.lower() for w in _WORD.findall(title) if w.lower() not in _STOP}


#: How much of a heading must still be recognisable for it to count as the same
#: heading. Measured in BOTH directions and the better one wins, because the
#: edit this stage exists to make is "Unlocking The Power Of Modern Caching" ->
#: "How modern caching works": most of the original words are slop and SHOULD
#: go, while the subject survives. A one-directional test punished exactly that
#: (measured: it did), and a repurposed heading still fails both directions.
_HEADING_KEPT = 0.5


def _heading_losses(before: list[str], after: list[str]) -> list[str]:
    """A heading may be re-cased or de-decorated (upstream §20); it may not lose
    its subject. Matched greedily by best content-word overlap."""
    remaining = [(_content_words(h), h) for h in after]
    lost: list[str] = []
    for title in before:
        want = _content_words(title)
        if not want:
            continue
        best_i, best_score = -1, 0.0
        for i, (have, _) in enumerate(remaining):
            if not have:
                continue
            shared = len(want & have)
            score = max(shared / len(want), shared / len(have))
            if score > best_score:
                best_i, best_score = i, score
        if best_score >= _HEADING_KEPT:
            remaining.pop(best_i)
        else:
            lost.append(title[:120])
    return lost


def verify(
    before: str,
    after: str,
    *,
    keywords: tuple[str, ...] | list[str] = (),
    register: str = "prose",
) -> dict[str, Any]:
    """Did the rewrite keep every fact, link, figure, heading and keyword?

    Returns a JSON-safe report. `ok` is True only when nothing was lost AND
    nothing was invented; everything else is named so the model can restore it.
    """
    if not isinstance(before, str) or not isinstance(after, str):
        return {"error": "before and after must both be text"}
    if not before.strip() or not after.strip():
        return {"error": "before and after must both be non-empty"}

    nums_before, nums_after = _numbers(before), _numbers(after)
    dates_before, dates_after = _dates(before), _dates(after)
    urls_before, urls_after = _urls(before), _urls(after)
    code_before, code_after = _code(before), _code(after)
    refs_before = {m.group(0) for m in _REF_MARKER.finditer(before)}
    refs_after = {m.group(0) for m in _REF_MARKER.finditer(after)}

    lost: dict[str, list[str]] = {}
    numbers_lost = sorted(nums_before - nums_after)
    dates_lost = sorted(dates_before - dates_after)
    urls_lost = sorted(urls_before - urls_after)
    code_lost = sorted(c[:80] for c in code_before - code_after)
    refs_lost = sorted(refs_before - refs_after)
    headings_lost = _heading_losses(_headings(before), _headings(after))
    keywords_lost = [
        k
        for k in keywords
        if isinstance(k, str)
        and k.strip()
        and k.lower() in before.lower()
        and k.lower() not in after.lower()
    ]
    structures_lost = [
        name for name, rx in _STRUCTURES if rx.search(before) and not rx.search(after)
    ]

    if numbers_lost:
        lost["numbers"] = numbers_lost[:40]
    if dates_lost:
        lost["dates"] = dates_lost[:40]
    if urls_lost:
        lost["urls"] = urls_lost[:40]
    if code_lost:
        lost["code"] = code_lost[:10]
    if refs_lost:
        lost["citation_markers"] = refs_lost[:40]
    if headings_lost:
        lost["headings"] = headings_lost[:20]
    if keywords_lost:
        lost["keywords"] = keywords_lost[:40]
    if structures_lost:
        lost["required_blocks"] = structures_lost

    # FABRICATION, checked in the same pass: a figure or source that appears in
    # the rewrite and not in the draft was invented by the rewriter.
    added_claims = sorted((nums_after - nums_before) | (dates_after - dates_before))[
        :40
    ]
    added_urls = sorted(urls_after - urls_before)[:40]

    score_before = human_voice_score(before, register=register)
    score_after = human_voice_score(after, register=register)
    return {
        "ok": not lost and not added_claims and not added_urls,
        "lost": lost,
        "added_claims": added_claims,
        "added_urls": added_urls,
        "score_before": score_before,
        "score_after": score_after,
        "improved": score_after > score_before,
    }

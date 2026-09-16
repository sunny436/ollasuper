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

from app.humanizer.patterns import (
    EVIDENCE_LABEL,
    EVIDENCE_TAG,
    human_voice_score,
)

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
_FENCE = re.compile(r"```([^\n]{0,40})\n(.{0,20000}?)```", re.S)
#: A fence labelled as prose is a copy-paste container for writing, not code:
#: measured on prod, a launch email arrived entirely inside ```text fences, so
#: treating it as code protected the whole deliverable from the humanize stage
#: and every rewrite of it was refused as "lost code".
_PROSE_FENCE_LANGS = frozenset(
    {"", "text", "txt", "plain", "plaintext", "markdown", "md", "email"}
)


def _is_prose_fence(m: re.Match[str]) -> bool:
    return m.group(1).strip().lower() in _PROSE_FENCE_LANGS


_INLINE_CODE = re.compile(r"`([^`\n]{1,400})`")
_HEADING = re.compile(r"^#{1,6}\s+([^\n]{1,200})$", re.M)
_WORD = re.compile(r"[A-Za-z0-9']+")
_REF_MARKER = re.compile(r"\[\^?\d{1,3}\]")
_INTERNAL_LINK = re.compile(r"\[internal-link:[^\]\n]{0,300}\]")
_IMAGE_PLACEHOLDER = re.compile(r"!\[alt:[^\]\n]{0,300}\]\(image-placeholder\)")
#: A quotation worth protecting: long enough to be someone's words rather than a
#: scare-quoted term. Matched AFTER quote marks are normalised (see _normalise).
_QUOTE = re.compile(r'"([^"\n]{12,300})"')
_QUOTE_MARKS = str.maketrans(
    {"\u201c": '"', "\u201d": '"', "\u201e": '"', "\u2018": "'", "\u2019": "'"}
)
_SPACE = re.compile(r"\s+")
_GREEN = "\U0001f7e2"

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
    blocks = {
        m.group(2).strip() for m in _FENCE.finditer(text) if not _is_prose_fence(m)
    }
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


def _normalise(text: str) -> str:
    """Curly quotes and apostrophes as straight ones, whitespace collapsed.

    Load-bearing for the quotation check: the humanizer's own §21 converts curly
    quotes to straight ones, so a verbatim comparison that did not normalise
    would reject exactly the edit the stage recommends.
    """
    return _SPACE.sub(" ", text.translate(_QUOTE_MARKS))


def _quotations(text: str) -> set[str]:
    # Quote marks are normalised, but a quotation never spans a line: collapsing
    # newlines FIRST paired a closing mark in one paragraph with an opening mark
    # in the next and reported text between them as a "lost quotation" (measured
    # on a production blog: 'stops at the first plausible cause The classic').
    return {
        _SPACE.sub(" ", m.group(1)).strip()
        for m in _QUOTE.finditer(text.translate(_QUOTE_MARKS))
    }


def protected_spans(text: str) -> list[tuple[int, int]]:
    """Every span this module verifies must survive exactly: figures, dates, URLs
    and link targets, code, citation markers, internal-link markers, image
    placeholders, quotations, evidence labels and tags. The humanize stage hides
    these from the rewriter, so what `verify` checks is protected by construction.
    Offsets index the ORIGINAL text (quote-mark translation is one-to-one)."""
    spans: list[tuple[int, int]] = []
    for m in _FENCE.finditer(text):
        if _is_prose_fence(m):
            # Keep the fence lines; the writing inside is the deliverable.
            spans.append((m.start(), m.start(2)))
            spans.append((m.end() - 3, m.end()))
        else:
            spans.append((m.start(), m.end()))
    for rx in (
        _INLINE_CODE,
        _URL,
        _DATE,
        _NUMBER,
        _REF_MARKER,
        _INTERNAL_LINK,
        _IMAGE_PLACEHOLDER,
        EVIDENCE_LABEL,
        EVIDENCE_TAG,
    ):
        spans.extend((m.start(), m.end()) for m in rx.finditer(text))
    spans.extend((m.start(1), m.end(1)) for m in _MD_TARGET.finditer(text))
    spans.extend(
        (m.start(), m.end()) for m in _QUOTE.finditer(text.translate(_QUOTE_MARKS))
    )
    return [(s, e) for s, e in spans if e > s]


def _opening_paragraph(text: str) -> str:
    """The first block of prose: not a heading, list item, quote, fence or marker."""
    for block in re.split(r"\n\s*\n", text):
        body = block.strip()
        if not body or body.startswith(("#", ">", "```", "~~~", "|", "![", "---")):
            continue
        if re.match(r"^(?:[-*+]|\d+[.)])\s", body):
            continue
        return body
    return ""


def _first_heading(text: str) -> str:
    m = _HEADING.search(text)
    return m.group(1) if m else ""


def _placement_losses(before: str, after: str, keywords: list[str]) -> list[str]:
    """SEO weight sits in the title and the opening paragraph. A keyword that was
    there must still be there — presence anywhere else does not preserve it."""
    lost: list[str] = []
    places = (
        ("first heading", _first_heading),
        ("opening paragraph", _opening_paragraph),
    )
    for k in keywords:
        low = k.lower()
        for label, extract in places:
            if low in extract(before).lower() and low not in extract(after).lower():
                lost.append(f"{k} ({label})")
    return lost


def _counts(rx: re.Pattern[str], text: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for m in rx.finditer(text):
        out[m.group(0)] = out.get(m.group(0), 0) + 1
    return out


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
    kept_keywords = [
        k
        for k in keywords
        if isinstance(k, str) and k.strip() and k not in keywords_lost
    ]
    placement_lost = _placement_losses(before, after, kept_keywords)
    links_lost = sorted(
        set(_INTERNAL_LINK.findall(before)) - set(_INTERNAL_LINK.findall(after))
    )
    images_lost = sorted(
        set(_IMAGE_PLACEHOLDER.findall(before)) - set(_IMAGE_PLACEHOLDER.findall(after))
    )
    quotes_after = _quotations(after)
    quotes_lost = sorted(q for q in _quotations(before) if q not in quotes_after)

    # THE EVIDENCE CONTRACT (Marketing). Measured before this check existed: a
    # rewrite that stripped every label and promoted "🔴 assumed" to "🟢 verified"
    # passed with ok=true. A label may not disappear, and a tag may neither
    # disappear nor be UPGRADED — promoting an assumption to "verified" is a
    # fabrication of evidence, so it is reported with the invented claims.
    labels_before, labels_after = (
        _counts(EVIDENCE_LABEL, before),
        _counts(EVIDENCE_LABEL, after),
    )
    tags_before, tags_after = (
        _counts(EVIDENCE_TAG, before),
        _counts(EVIDENCE_TAG, after),
    )
    labels_lost = sorted(
        f"{label} x{n - labels_after.get(label, 0)}"
        for label, n in labels_before.items()
        if labels_after.get(label, 0) < n
    )
    tags_lost = sorted(
        f"{tag} x{n - tags_after.get(tag, 0)}"
        for tag, n in tags_before.items()
        if tags_after.get(tag, 0) < n
    )
    greens_added = tags_after.get(_GREEN, 0) - tags_before.get(_GREEN, 0)

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
    if placement_lost:
        lost["keyword_placement"] = placement_lost[:40]
    if links_lost:
        lost["internal_links"] = links_lost[:40]
    if images_lost:
        lost["image_placeholders"] = images_lost[:40]
    if quotes_lost:
        lost["quotations"] = [q[:120] for q in quotes_lost[:20]]
    if labels_lost:
        lost["evidence_labels"] = labels_lost
    if tags_lost:
        lost["evidence_tags"] = tags_lost

    # FABRICATION, checked in the same pass: a figure or source that appears in
    # the rewrite and not in the draft was invented by the rewriter.
    added_claims = sorted((nums_after - nums_before) | (dates_after - dates_before))[
        :40
    ]
    added_urls = sorted(urls_after - urls_before)[:40]
    if greens_added > 0:
        added_claims.append(
            f"{_GREEN} verified x{greens_added} (evidence upgraded or new)"
        )

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

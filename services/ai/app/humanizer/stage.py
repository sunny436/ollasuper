"""The humanize stage, run by CODE on every writing deliverable.

WHY CODE AND NOT THE MODEL. The first design gave the model a `humanize_check`
tool and told it (in skill text) to call it before answering. On production the
model called it on 0 of 2 deliverables: a stage that depends on the model
remembering to run it does not run. So the runner now owns the order:

    draft (buffered, not shown)
      -> detect + score the draft (pure, no tokens)
      -> clean or too short to judge: deliver the draft unchanged
      -> otherwise ONE rewrite call, streamed to the user as it is written
      -> verify the rewrite against the draft (facts, figures, dates, links,
         quotations, headings, evidence labels, required keywords; nothing added)
      -> any loss, any addition, a truncated or chat-wrapped rewrite, or a lower
         score => the DRAFT is what gets saved

Everything here is pure except the prompt text; the runner does the I/O.
Nothing in the user-visible answer ever names this stage or its score.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage

from app.humanizer.patterns import (
    _MIN_DENSITY_WORDS,
    DEFAULT_THRESHOLD,
    POST_DRAFT_BLOCKS,
    Finding,
    analyze,
    human_voice_score,
)
from app.humanizer.preserve import verify

#: Writing skills whose deliverables get the stage, and the register each writes
#: in. Report Writing is reference-style text: its voice-flavour patterns are
#: dropped so it stays neutral rather than being made conversational.
WRITING_SKILLS: dict[str, str] = {
    "blog-assist": "prose",
    "marketing": "prose",
    "report-writing": "technical",
}

_MAX_FINDINGS_IN_PROMPT = 40
# A rewrite this far from the draft's length is not a voice edit: it was cut off
# or it grew content. Ratios, not a word count, so they hold for a 150-word email
# and a 2,000-word article alike.
_MIN_LENGTH_RATIO = 0.6
_MAX_LENGTH_RATIO = 1.35
_WORD = re.compile(r"[A-Za-z0-9']+")
_CHAT_WRAPPER = re.compile(
    r"^\s*(?:here(?:'s| is| are)\b|sure\b|certainly\b|below is\b|of course\b)",
    re.I,
)
_QUOTED = re.compile(r"[\"“']([^\"“”'\n]{2,60})[\"”']")
_KEYWORD_CUE = re.compile(r"\b(?:keyword|keywords|key phrase|search term)s?\b", re.I)
_SAMPLE = re.compile(
    r"\b(?:writing|voice|style)\s+sample\s*[:\-]\s*(.{400,8000})", re.I | re.S
)


@dataclass(frozen=True)
class Assessment:
    body: str
    tail: str
    words: int
    score: int
    findings: list[Finding] = field(default_factory=list)
    register: str = "prose"
    decision: str = "clean"  # "clean" | "short" | "revise"

    @property
    def revise(self) -> bool:
        return self.decision == "revise"


@dataclass(frozen=True)
class Acceptance:
    ok: bool
    reason: str
    score_after: int | None = None
    lost: dict = field(default_factory=dict)
    added: list = field(default_factory=list)


def register_for(skill_ids) -> str | None:
    """None when no writing skill is active; otherwise the register to write in.
    Any prose writing skill keeps the prose register."""
    registers = {WRITING_SKILLS[s] for s in skill_ids if s in WRITING_SKILLS}
    if not registers:
        return None
    return "prose" if "prose" in registers else "technical"


def split_post_draft(text: str) -> tuple[str, str]:
    """Body to humanize, and the post-draft blocks (score, sources, progression)
    that are kept exactly as written."""
    starts = [m.start() for rx in POST_DRAFT_BLOCKS if (m := rx.search(text))]
    if not starts:
        return text, ""
    cut = min(starts)
    return text[:cut], text[cut:]


def writing_sample(request: str) -> str | None:
    """A sample the user explicitly supplied ("writing sample: …") — the voice
    reference upstream humanizer honours over its own patterns."""
    m = _SAMPLE.search(request or "")
    return m.group(1).strip() if m else None


def required_keywords(request: str) -> list[str]:
    """Quoted terms from a request that talks about keywords ("target keyword
    'best CRM for small business'"). Only when the request itself says so."""
    if not request or not _KEYWORD_CUE.search(request):
        return []
    return list(dict.fromkeys(q.strip() for q in _QUOTED.findall(request) if q.strip()))


def assess(draft: str, *, register: str, sample: str | None = None) -> Assessment:
    body, tail = split_post_draft(draft)
    findings, prof = analyze(body, sample=sample, register=register)
    score = human_voice_score(
        body, sample=sample, register=register, findings=findings, prof=prof
    )
    words = len(_WORD.findall(body))
    if words < _MIN_DENSITY_WORDS:
        decision = "short"
    elif score >= DEFAULT_THRESHOLD or not findings:
        decision = "clean"
    else:
        decision = "revise"
    return Assessment(body, tail, words, score, findings, register, decision)


_INSTRUCTIONS = (
    "You are a senior copy editor. You receive a finished draft and a list of "
    "passages that read as machine-written. Rewrite so the text reads as if a "
    "skilled human wrote it, changing VOICE ONLY.\n"
    "Change: the listed passages, and the same habits wherever else they occur "
    "(dashes used as connectors, forced groups of three, staged openings, "
    "manufactured contrasts, one-line dramatic closers, inflated significance, "
    "generic AI vocabulary, filler, decorative bold, leftover chat phrasing). "
    "Leave sentences that are already plain and natural exactly as they are.\n"
    "Preserve EXACTLY: every factual claim; every number, percentage, amount and "
    "date; names; every URL and markdown link; citation markers; direct "
    "quotations; code; tables and lists; every heading with its level, order and "
    "meaning (never add, remove or reorder a heading); internal-link markers and "
    "image placeholders; evidence labels FACT / INFERENCE / ASSUMPTION / "
    "RECOMMENDATION and every 🟢 🟡 🔴 tag (never change one); the call to "
    "action; and everything the user asked for.\n"
    "Never add a fact, figure, example, source, promise or claim that is not in "
    "the draft. Do not make it casual or chatty; keep the same register, "
    "formatting and roughly the same length.\n"
    "Output ONLY the rewritten text itself: no preface, no notes, no explanation, "
    "no surrounding code fence."
)


def rewrite_messages(
    assessment: Assessment,
    *,
    keywords: list[str] | None = None,
    sample: str | None = None,
) -> list[BaseMessage]:
    seen: set[tuple[str, str]] = set()
    lines: list[str] = []
    for f in assessment.findings:
        key = (f.pattern, f.excerpt)
        if key in seen:
            continue
        seen.add(key)
        lines.append(f"- {f.name}: {f.excerpt}")
        if len(lines) >= _MAX_FINDINGS_IN_PROMPT:
            break
    parts = [f"Passages that read as machine-written:\n{chr(10).join(lines)}"]
    if keywords:
        parts.append(
            "Required keywords (keep each one, in the title and opening paragraph "
            f"where it already is): {', '.join(keywords)}"
        )
    if assessment.register == "technical":
        parts.append("Register: neutral reference text. Keep it neutral.")
    if sample:
        parts.append(
            "The user's own writing sample — match THIS voice and rhythm, "
            f"including how often it uses dashes:\n{sample[:4000]}"
        )
    parts.append(f"DRAFT:\n{assessment.body}")
    return [
        SystemMessage(content=_INSTRUCTIONS),
        HumanMessage(content="\n\n".join(parts)),
    ]


def accept(
    assessment: Assessment,
    rewrite: str,
    *,
    keywords: list[str] | None = None,
    sample: str | None = None,
    truncated: bool = False,
) -> Acceptance:
    """Is the rewrite safe to deliver instead of the draft?"""
    if truncated:
        return Acceptance(False, "truncated")
    text = rewrite.strip()
    if not text:
        return Acceptance(False, "empty")
    if _CHAT_WRAPPER.match(text):
        return Acceptance(False, "chat_wrapper")
    words = len(_WORD.findall(text))
    ratio = words / max(assessment.words, 1)
    if not _MIN_LENGTH_RATIO <= ratio <= _MAX_LENGTH_RATIO:
        return Acceptance(False, f"length_ratio_{ratio:.2f}")
    report = verify(
        assessment.body,
        text,
        keywords=tuple(keywords or ()),
        register=assessment.register,
    )
    if report.get("error"):
        return Acceptance(False, "verify_error")
    lost = report.get("lost") or {}
    added = list(report.get("added_claims") or []) + list(
        report.get("added_urls") or []
    )
    findings_after, prof_after = analyze(
        text, sample=sample, register=assessment.register
    )
    after = human_voice_score(
        text,
        sample=sample,
        register=assessment.register,
        findings=findings_after,
        prof=prof_after,
    )
    if lost or added:
        return Acceptance(False, "not_preserved", after, lost, added)
    # A rewrite must actually read better. The score clamps at 0, so a tie is
    # broken on the findings themselves: the same score with as many tells or
    # more is not a humanization (measured: draft + extra slop tied at 0 and
    # passed before this check).
    if after < assessment.score or (
        after == assessment.score and len(findings_after) >= len(assessment.findings)
    ):
        return Acceptance(False, "score_not_improved", after)
    return Acceptance(True, "accepted", after)

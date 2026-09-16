"""The humanize stage, run by CODE on every writing deliverable.

WHY CODE AND NOT THE MODEL. The first design gave the model a `humanize_check`
tool and told it (in skill text) to call it before answering. On production the
model called it on 0 of 2 deliverables: a stage that depends on the model
remembering to run it does not run. So the runner now owns the order:

    draft (buffered, not shown)
      -> protect what must survive verbatim (see `protect`)
      -> detect + score the draft (pure, no tokens)
      -> clean or too short to judge: deliver the draft unchanged
      -> otherwise ONE rewrite call, streamed to the user as it is written
      -> verify the rewrite against the draft (facts, figures, dates, links,
         quotations, headings, evidence labels, required keywords; nothing added)
      -> any loss, any addition, a truncated or chat-wrapped rewrite, or no
         improvement => the DRAFT is what gets saved

WHY PLACEHOLDERS. Measured on production, three rewrites were refused for text
the rewrite was never meant to touch: a blog's score block written BEFORE the
article (a head/tail split put the whole article in the untouched tail), a
quoted testimonial the model reworded despite being told not to, and the draft's
own "Here's a launch email at roughly 200 words" preface. An instruction is not
a guarantee; text the rewriter never sees cannot be changed. So protected spans
are swapped for tokens before the call and restored — on the stream, as it is
written — afterwards.

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
from app.humanizer.preserve import protected_spans as verbatim_spans
from app.humanizer.preserve import verify

#: Writing skills, and the register each writes in. Reference-style skills are
#: "technical": their voice-flavour patterns are dropped so the text stays
#: neutral rather than being made conversational.
WRITING_SKILLS: dict[str, str] = {
    "blog-assist": "prose",
    "marketing": "prose",
    "sales": "prose",
    "hr": "prose",
    "report-writing": "technical",
    "operations": "technical",
    "documents": "technical",
}
#: Skills whose output is analysis, numbers or code, not prose. With no writing
#: skill beside them, a turn they claim is left alone.
NON_WRITING_SKILLS = frozenset(
    {"software-engineering", "data-analysis", "finance", "equity-research", "seo-audit"}
)
#: Below this many words a text is not judged (and, between tool steps, is
#: narration rather than the deliverable).
MIN_WORDS = _MIN_DENSITY_WORDS
# The router files code under the same work type as prose ("write a Python
# function" is `produce`), and skill discovery does not separate them either
# (measured on prod: a React component matched `documents`, unit tests matched
# `finance`). Hiding a code answer's stream would buy nothing, so a request
# that names a programming artifact is never held back.
_CODE_REQUEST = re.compile(
    r"```|\b(?:python|javascript|typescript|java|golang|rust|kotlin|swift|php|"
    r"ruby|c\+\+|c#|sql|regex|regular expression|bash|shell script|powershell|"
    r"dockerfile|terraform|yaml|json|html|css|react|vue|angular|django|flask|"
    r"fastapi|node\.?js|unit tests?|test cases?|code|snippet|function|method|"
    r"class|component|endpoint|algorithm|program|script to|stack trace|bug)\b",
    re.I,
)

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
_OPEN, _CLOSE = "⟦", "⟧"
_TOKEN = re.compile(_OPEN + r"P\d{1,4}" + _CLOSE)
# A preface ends at the first horizontal rule or paragraph break near the top.
_PREFACE_RULE = re.compile(r"\n\s{0,3}(?:---|\*\*\*|___)\s*\n")
_PREFACE_MAX_CHARS = 800


@dataclass(frozen=True)
class Assessment:
    body: str  # the draft, exactly as written
    masked: str  # the draft with protected spans replaced by tokens
    slots: dict[str, str]  # token -> the protected text it stands for
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


def gate(skill_ids, request: str) -> str | None:
    """The register to write in if this `produce` turn is a writing deliverable,
    else None. Writing skills decide first; a writing request no skill claimed
    (landing copy, a cover letter, a newsletter) is prose; code never is."""
    if _CODE_REQUEST.search(request or ""):
        return None
    register = register_for(skill_ids)
    if register is not None:
        return register
    if NON_WRITING_SKILLS.intersection(skill_ids):
        return None
    return "prose"


def word_count(text: str) -> int:
    return len(_WORD.findall(text or ""))


def register_for(skill_ids) -> str | None:
    """None when no writing skill is active; otherwise the register to write in.
    Any prose writing skill keeps the prose register."""
    registers = {WRITING_SKILLS[s] for s in skill_ids if s in WRITING_SKILLS}
    if not registers:
        return None
    return "prose" if "prose" in registers else "technical"


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


# ------------------------------------------------------------------ protection
def _preface_end(text: str) -> int:
    """End offset of a chat preface ("Here's a launch email for…") or 0."""
    if not _CHAT_WRAPPER.match(text):
        return 0
    head = text[:_PREFACE_MAX_CHARS]
    rule = _PREFACE_RULE.search(head)
    if rule:
        return rule.end()
    brk = head.find("\n\n")
    return brk + 2 if brk > 0 else 0


def protect(text: str) -> tuple[str, dict[str, str]]:
    """Replace what must survive verbatim with tokens: the Blog skill's score,
    Sources and score-progression blocks (wherever they sit), a leading chat
    preface, and EVERY atom `preserve.verify` checks (figures, dates, links,
    code, citation and link markers, quotations, evidence labels and tags).

    Measured on production: with only blocks and quotations protected, a fast
    rewriter still changed two figures in a report and dropped an inline code
    span from two emails. The verifier refused all three, correctly, and the
    user got no humanized text. Protected by construction, those cannot fail."""
    spans: list[tuple[int, int]] = []
    for rx in POST_DRAFT_BLOCKS:
        spans.extend((m.start(), m.end()) for m in rx.finditer(text))
    end = _preface_end(text)
    if end and text[end:].strip():
        spans.append((0, end))
    spans.extend(verbatim_spans(text))
    merged: list[tuple[int, int]] = []
    for start, stop in sorted(spans):
        if merged and start < merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], stop))
        else:
            merged.append((start, stop))
    slots: dict[str, str] = {}
    out: list[str] = []
    pos = 0
    for i, (start, stop) in enumerate(merged, 1):
        token = f"{_OPEN}P{i}{_CLOSE}"
        slots[token] = text[start:stop]
        out.append(text[pos:start])
        out.append(token)
        pos = stop
    out.append(text[pos:])
    return "".join(out), slots


def restore(text: str, slots: dict[str, str]) -> str:
    for token, original in slots.items():
        text = text.replace(token, original)
    return text


class PlaceholderStream:
    """Restores tokens on a streamed rewrite, holding back a token split across
    chunks so the user never sees `⟦P3` on screen."""

    _MAX_HELD = 16

    def __init__(self, slots: dict[str, str]) -> None:
        self._slots = slots
        self._held = ""

    def feed(self, chunk: str) -> str:
        buf = self._held + chunk
        cut = buf.rfind(_OPEN)
        if cut != -1 and _CLOSE not in buf[cut:] and len(buf) - cut <= self._MAX_HELD:
            self._held, buf = buf[cut:], buf[:cut]
        else:
            self._held = ""
        return restore(buf, self._slots)

    def flush(self) -> str:
        out, self._held = restore(self._held, self._slots), ""
        return out


def _scored_text(masked: str) -> str:
    return _TOKEN.sub(" ", masked)


# ------------------------------------------------------------------ the stage
def assess(draft: str, *, register: str, sample: str | None = None) -> Assessment:
    masked, slots = protect(draft)
    scored = _scored_text(masked)
    findings, prof = analyze(scored, sample=sample, register=register)
    score = human_voice_score(
        scored, sample=sample, register=register, findings=findings, prof=prof
    )
    words = word_count(scored)
    if words < _MIN_DENSITY_WORDS:
        decision = "short"
    elif score >= DEFAULT_THRESHOLD or not findings:
        decision = "clean"
    else:
        decision = "revise"
    return Assessment(draft, masked, slots, words, score, findings, register, decision)


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
    "date; names; every URL and markdown link; citation markers; code; tables and "
    "lists; every heading with its level, order and meaning (never add, remove or "
    "reorder a heading); internal-link markers and image placeholders; evidence "
    "labels FACT / INFERENCE / ASSUMPTION / RECOMMENDATION and every 🟢 🟡 🔴 tag "
    "(never change one); the call to action; and everything the user asked for.\n"
    f"Tokens like {_OPEN}P1{_CLOSE} stand for protected text. Copy every token "
    "exactly once, unchanged, in the same place relative to the text around it.\n"
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
    parts.append(f"DRAFT:\n{assessment.masked}")
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
    """Is the rewrite (as the model wrote it, tokens included) safe to deliver?"""
    if truncated:
        return Acceptance(False, "truncated")
    text = rewrite.strip()
    if not text:
        return Acceptance(False, "empty")
    if any(text.count(token) != 1 for token in assessment.slots):
        return Acceptance(False, "protected_span_changed")
    if len(_TOKEN.findall(text)) != len(assessment.slots):
        return Acceptance(False, "protected_span_changed")
    # Only a wrapper the REWRITE added: the draft's own preface is protected.
    if _CHAT_WRAPPER.match(text) and not _CHAT_WRAPPER.match(assessment.masked):
        return Acceptance(False, "chat_wrapper")
    scored = _scored_text(text)
    ratio = word_count(scored) / max(assessment.words, 1)
    if not _MIN_LENGTH_RATIO <= ratio <= _MAX_LENGTH_RATIO:
        return Acceptance(False, f"length_ratio_{ratio:.2f}")
    report = verify(
        assessment.body,
        restore(text, assessment.slots),
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
        scored, sample=sample, register=assessment.register
    )
    after = human_voice_score(
        scored,
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

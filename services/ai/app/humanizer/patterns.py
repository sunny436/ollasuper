"""The AI-writing taxonomy, as PURE detectors over markdown. No I/O, no clock.

WHAT THIS IS. `blader/humanizer` v3.0.0 (MIT) names 25 patterns in five
categories — A staging, B rhythm, C inflation, D formatting, E leftovers — plus a
severity rule (§1-§5 act on one sighting; §9/§10/§11/§21 are weak alone and fire
only beside another tell). This module turns that taxonomy into code so the
question "is this text AI-shaped?" is COMPUTED, not self-reported by the model
that wrote it.

PROTECTED SPANS ARE COMPUTED FIRST AND NEVER FLAGGED. Upstream's "do not change
code blocks, inline code, commands, paths, metadata, links" becomes a mechanism
rather than a hope: fenced code, inline code, URLs, markdown link/image targets,
front matter, blockquotes, quoted passages, this product's
`[internal-link: ...]` / `![alt: ...](image-placeholder)` markers, and the Blog
skill's own output contract (its Quality Score block, the
"NOT a Google-ranking prediction" caption, and `## Sources & evidence`) are
masked out before a single pattern runs. A finding that overlaps one is dropped.

LATENCY IS A CORRECTNESS PROPERTY HERE, not a nicety. `tests/test_routing.py`
records this repo shipping `(?:\\w+\\s+){0,3}` and paying 2.7ms of catastrophic
backtracking on user-controlled text under a 1ms budget. These patterns run over
10-50KB of model output on every writing turn, so every regex is a precompiled
alternation of literals with bounded character classes — no nested quantifiers,
no unbounded `.*`, one pass per pattern. `test_humanizer_patterns` holds a P99.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

__all__ = [
    "CATEGORIES",
    "DEFAULT_THRESHOLD",
    "EVIDENCE_LABEL",
    "EVIDENCE_TAG",
    "POST_DRAFT_BLOCKS",
    "Finding",
    "Profile",
    "analyze",
    "human_voice_score",
    "profile",
    "protected_spans",
]

#: At or above this score the text reads human enough to ship UNCHANGED. The
#: point of a threshold is that humanization is conditional: text that is
#: already clean is never rewritten (and a rewrite is the only way to lose a
#: fact), so the cheapest and safest outcome is also the default one.
DEFAULT_THRESHOLD = 85

CATEGORIES = ("staging", "rhythm", "inflation", "formatting", "leftovers")

#: Severity, from upstream. "act" = one sighting is enough. "weak" = a tell that
#: is unremarkable alone (a passive verb, one hyphenated pair) and only counts
#: beside another finding in the same text.
_ACT = "act"
_WEAK = "weak"

_ACT_WEIGHT = 1.0
_WEAK_WEIGHT = 0.4
#: Points of score lost per weighted finding per 1,000 words. Calibrated so a
#: page with ~10 acting findings per 1,000 words lands around 60 (clearly
#: AI-shaped) and a page with 2-3 lands in the high 80s (ship it).
_DENSITY_TO_POINTS = 4.0


@dataclass(frozen=True, slots=True)
class Finding:
    """One sighting. `start`/`end` are offsets into the ORIGINAL text, so the
    model can be told exactly which span to rewrite rather than being handed the
    whole document and a vibe."""

    pattern: str  # "A1" … "E25"
    name: str
    category: str
    severity: str
    start: int
    end: int
    excerpt: str


@dataclass(frozen=True, slots=True)
class Profile:
    """The measurable shape of a piece of writing. Used two ways: to decide the
    density-based patterns, and — when the user supplies a writing sample — as
    the VOICE REFERENCE that overrides them (upstream: a provided sample wins,
    including on dash frequency)."""

    words: int
    sentences: int
    dashes_per_1k: float
    triads_per_1k: float
    hyphen_pairs_per_1k: float
    bold_labels_per_1k: float
    mean_sentence_words: float


# --------------------------------------------------------------------------- #
# protected spans
# --------------------------------------------------------------------------- #
# Each is a single bounded pass. `[^`]` and `[^\n]` keep them linear.
_PROTECTED: tuple[re.Pattern[str], ...] = (
    re.compile(r"```[^\n]{0,40}\n.{0,20000}?```", re.S),  # fenced code / JSON-LD
    re.compile(r"~~~[^\n]{0,40}\n.{0,20000}?~~~", re.S),
    re.compile(r"`[^`\n]{1,400}`"),  # inline code
    re.compile(r"^---\n.{0,4000}?\n---\n", re.S),  # front matter
    re.compile(r"https?://[^\s<>()\[\]]{1,2000}"),  # bare URLs
    re.compile(r"!?\[[^\]\n]{0,300}\]\([^)\n]{0,2000}\)"),  # md links + images
    re.compile(r"^\s{0,3}>[^\n]{0,2000}$", re.M),  # blockquotes
    re.compile(r"\"[^\"\n]{1,300}\""),  # quoted passages
    re.compile(r"“[^”\n]{1,300}”"),  # curly-quoted passages
)

#: This product's markers: the Blog skill's internal-link and image-placeholder
#: slots. They are content structure the reader's page is built from, not prose.
_MARKERS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\[internal-link:[^\]\n]{0,300}\]"),
    re.compile(r"!\[alt:[^\]\n]{0,300}\]\(image-placeholder\)"),
)

#: MARKETING'S EVIDENCE CONTRACT. Every claim is labelled FACT / INFERENCE /
#: ASSUMPTION / RECOMMENDATION and tagged 🟢 verified / 🟡 estimate / 🔴 assumed
#: (app/marketing/skill.py). Measured against the shipped detector before this
#: existed: a CORRECT Marketing block had its evidence heading flagged as a
#: decorative heading (D20) and a labelled claim flagged as a one-line closer (A2),
#: so the stage would have told the model to "fix" the contract. The label and the
#: tag are protected; the prose around them is still humanized normally.
EVIDENCE_LABEL = re.compile(r"\b(FACT|INFERENCE|ASSUMPTION|RECOMMENDATION)\b")
EVIDENCE_TAG = re.compile("[\U0001f7e2\U0001f7e1\U0001f534]")
_EVIDENCE: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"\*{0,2}\b(?:FACT|INFERENCE|ASSUMPTION|RECOMMENDATION)\b\*{0,2}:?\*{0,2}"
    ),
    re.compile(
        "[\U0001f7e2\U0001f7e1\U0001f534]\\s{0,2}(?:verified|estimate|assumed)?",
        re.I,
    ),
)

#: Blocks the Blog skill writes AFTER the draft is finished: the Quality Score and
#: its caption, the Sources section, the score progression. Public because the
#: finalize-time preservation check masks them on both sides — they are not in
#: the draft that was checked, so their numbers are not "invented" by a rewrite.
POST_DRAFT_BLOCKS: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"^#{1,6}\s*OllaSuper Blog Quality Score[^\n]{0,200}\n"
        r".{0,4000}?(?=\n#{1,6}\s|\Z)",
        re.S | re.M | re.I,
    ),
    re.compile(
        r"^[^\n]{0,200}NOT a Google-ranking prediction[^\n]{0,200}$", re.M | re.I
    ),
    re.compile(
        r"^#{1,6}\s*Sources(?: &| and)? evidence[^\n]{0,200}\n"
        r".{0,8000}?(?=\n#{1,6}\s|\Z)",
        re.S | re.M | re.I,
    ),
    # The WHOLE section, not just its heading: its body is "89 -> (fix) -> 94",
    # numbers the draft never contained.
    re.compile(
        r"^#{1,6}\s*Score progression[^\n]{0,200}\n?.{0,2000}?(?=\n#{1,6}\s|\Z)",
        re.S | re.M | re.I,
    ),
)


def protected_spans(text: str) -> list[tuple[int, int]]:
    """Merged, sorted ranges that no pattern may flag."""
    spans: list[tuple[int, int]] = []
    for rx in (*_PROTECTED, *_MARKERS, *_EVIDENCE, *POST_DRAFT_BLOCKS):
        for m in rx.finditer(text):
            spans.append((m.start(), m.end()))
    if not spans:
        return []
    spans.sort()
    merged = [spans[0]]
    for start, end in spans[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged


def _blocked(spans: list[tuple[int, int]], start: int, end: int) -> bool:
    for s, e in spans:
        if start < e and end > s:
            return True
        if s > end:
            break
    return False


# --------------------------------------------------------------------------- #
# lexical patterns — one compiled alternation each
# --------------------------------------------------------------------------- #
def _alt(*phrases: str) -> re.Pattern[str]:
    return re.compile("|".join(phrases), re.I)


def _words(*phrases: str) -> re.Pattern[str]:
    body = "|".join(re.escape(p) for p in phrases)
    return re.compile(rf"\b(?:{body})\b", re.I)


# A — staging instead of stating
_A1 = _alt(
    r"\bnot (?:just|only|merely|simply) [^.\n]{1,60}?\bbut\b",
    r"\bit'?s not (?:about )?[^.\n]{1,40}?, it'?s\b",
    r"\bthis is'?n?o?t? (?:just|only) \w{1,20}\b",
    r"\bno guessing\b",
)
_A2 = _words(
    "that is the real win",
    "that's the real win",
    "read that again",
    "let that sink in",
    "and that changes everything",
    "full stop",
    "period.",
    "simple as that",
    "that's it",
)
_A3 = _words(
    "the real question is",
    "at its core",
    "what really matters",
    "at the end of the day",
    "the truth is",
    "here's the thing",
    "becomes a trap",
    "more than just a",
)
_A4 = _words(
    "let's dive in",
    "let's dive into",
    "dive into",
    "let's explore",
    "let's take a look",
    "here's what you need to know",
    "without further ado",
    "the thing is",
    "buckle up",
    "in today's digital landscape",
    "in today's fast-paced",
    "in this article",
)
_A5 = _words(
    "this isn't mainly about",
    "i'm not saying",
    "to be clear",
    "don't get me wrong",
    "a tempting approach",
    "make no mistake",
    "it's worth noting",
    "it is worth noting",
)

# C — inflation and borrowed authority
_C12 = _words(
    "additionally",
    "moreover",
    "furthermore",
    "align with",
    "aligns with",
    "robust",
    "showcase",
    "showcases",
    "tapestry",
    "testament",
    "delve",
    "delves",
    "leverage",
    "leverages",
    "leveraging",
    "seamless",
    "seamlessly",
    "harness",
    "pivotal",
    "realm",
    "landscape",
    "crucial",
    "vital",
    "comprehensive",
    "utilize",
    "utilizes",
    "facilitate",
    "myriad",
    "plethora",
    "embark",
    "unlock",
    "elevate",
    "streamline",
    "holistic",
    "cutting-edge",
    "game-changer",
    "game changer",
    "ever-evolving",
    "foster",
    "underscore",
    "underscores",
    "navigate the",
    "in the realm of",
)
_C13 = _words(
    "stands as a testament",
    "stand as a testament",
    "a testament to",
    "pivotal moment",
    "plays a key role",
    "plays a crucial role",
    "enduring legacy",
    "revolutionize",
    "revolutionizes",
    "transformative",
    "paradigm shift",
    "groundbreaking",
    "marking a new",
    "ushering in",
)
_C14 = _words(
    "associated with",
    "connected to",
    "linked to",
    "tied to",
    "in connection with",
    "is related to",
)
_C15 = re.compile(
    r",\s+(?:highlighting|underscoring|emphasizing|symbolizing|reflecting"
    r"|showcasing|demonstrating|illustrating|ensuring|allowing|enabling"
    r"|cementing|solidifying)\b",
    re.I,
)
_C16 = _words(
    "boasts",
    "vibrant",
    "nestled",
    "breathtaking",
    "stunning",
    "renowned",
    "unparalleled",
    "world-class",
    "best-in-class",
    "must-have",
    "top-notch",
    "bustling",
)
_C17 = _words(
    "experts argue",
    "experts say",
    "experts agree",
    "observers cite",
    "industry reports",
    "studies show",
    "research suggests",
    "it is widely believed",
    "many believe",
    "critics argue",
)
_C18 = _words(
    "serves as",
    "serve as",
    "stands as",
    "functions as",
    "features a",
    "maintains a",
    "represents a",
    "constitutes a",
)

# E — leftovers from the chat and the draft
_E22 = _words(
    "i hope this helps",
    "hope this helps",
    "great question",
    "let me know if",
    "would you like me to",
    "should i continue",
    "feel free to",
    "as an ai",
    "i'd be happy to",
    "certainly!",
    "of course!",
)
_E23 = _words(
    "as of my last",
    "as of my knowledge",
    "to the best of my knowledge",
    "based on available information",
    "it is believed that",
    "maintains a low profile",
    "training data",
    "i don't have access to real-time",
)
_E25 = _words(
    "was added to replace",
    "the previous approach",
    "the old approach",
    "which caused the",
    "instead of the old",
    "formerly known as",
)

_LEXICAL: tuple[tuple[str, str, str, str, re.Pattern[str]], ...] = (
    ("A1", "not X but Y", "staging", _ACT, _A1),
    ("A2", "one-line closer", "staging", _ACT, _A2),
    ("A3", "saying that sounds deep", "staging", _ACT, _A3),
    ("A4", "staged run-up", "staging", _ACT, _A4),
    ("A5", "arguing with no one", "staging", _ACT, _A5),
    ("C12", "overused AI word", "inflation", _ACT, _C12),
    ("C13", "inflated significance", "inflation", _ACT, _C13),
    ("C14", "vague connection", "inflation", _ACT, _C14),
    ("C15", "shallow -ing rider", "inflation", _ACT, _C15),
    ("C16", "sales language", "inflation", _ACT, _C16),
    ("C17", "borrowed authority", "inflation", _ACT, _C17),
    ("C18", "avoiding is/are/has", "inflation", _ACT, _C18),
    ("E22", "chatbot residue", "leftovers", _ACT, _E22),
    ("E23", "knowledge-limit disclaimer", "leftovers", _ACT, _E23),
    ("E25", "writing about the previous version", "leftovers", _ACT, _E25),
)

#: Voice-flavour patterns: real tells in a blog or essay, but ordinary and
#: correct in reference, legal or API documentation. `register="technical"`
#: drops them — upstream's "technical/reference stays neutral".
_VOICE_ONLY = frozenset({"C14", "C18", "B11", "B10"})


# --------------------------------------------------------------------------- #
# structural patterns
# --------------------------------------------------------------------------- #
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
_WORD = re.compile(r"[A-Za-z0-9']+")
_DASH = re.compile(r"—|–| -- ")
_TRIAD = re.compile(
    r"\b[\w']{2,20}(?:\s[\w']{2,20}){0,2}, [\w']{2,20}(?:\s[\w']{2,20}){0,2},"
    r" and [\w']{2,20}\b"
)
_HYPHEN_PAIR = re.compile(r"\b[A-Za-z]{3,15}-[A-Za-z]{3,15}\b")
_BOLD_LABEL = re.compile(r"\*\*[^*\n]{1,60}\*\*\s*:")
_HEADING = re.compile(r"^(#{1,6})\s+([^\n]{1,200})$", re.M)
_EMOJI_HEAD = re.compile(r"[\U0001F300-\U0001FAFF←-⇿☀-➿]")
_HRULE = re.compile(r"^\s{0,3}(?:---|\*\*\*|___)\s*$", re.M)
_CURLY = re.compile(r"[“”‘’]")
_PASSIVE = re.compile(
    r"\b(?:is|are|was|were|been|being)\s+[a-z]{3,20}ed\b(?:\s+by\b)?", re.I
)
_QUALIFIER = _words(
    "to be fair",
    "could potentially",
    "might arguably",
    "in some cases",
    "it seems likely",
    "somewhat",
    "relatively",
    "arguably",
    "perhaps",
    "generally speaking",
    "more or less",
)
_PARAGRAPH_SPLIT = re.compile(r"\n\s*\n")
_LIST_OR_HEAD = re.compile(r"^\s{0,3}(?:[-*+>#]|\d+[.)])\s")

#: Density ceilings per 1,000 words, above which a rhythm/formatting tell stops
#: being a choice and starts being a rule the model applied.
_MAX_DASHES_PER_1K = 6.0
_MAX_TRIADS_PER_1K = 4.0
_MAX_HYPHEN_PAIRS_PER_1K = 12.0
_MAX_BOLD_LABELS_PER_1K = 6.0
#: A RATE NEEDS A SAMPLE. One dash in a twelve-word sentence is 83 per 1,000
#: words and means nothing; these tells are about a habit, so they need enough
#: text to have one and enough sightings to call it that. (Measured: without
#: this, a single legitimate em-dash in one sentence was flagged.)
_MIN_DENSITY_WORDS = 120
_MIN_DENSITY_HITS = 3


def _count_words(text: str) -> int:
    return len(_WORD.findall(text))


def profile(text: str) -> Profile:
    """The measurable shape of a piece of writing (also the voice-sample
    reference). Cheap: five bounded passes."""
    words = max(_count_words(text), 1)
    sentences = [s for s in _SENTENCE_SPLIT.split(text) if s.strip()]
    per_1k = 1000.0 / words
    return Profile(
        words=words,
        sentences=len(sentences),
        dashes_per_1k=len(_DASH.findall(text)) * per_1k,
        triads_per_1k=len(_TRIAD.findall(text)) * per_1k,
        hyphen_pairs_per_1k=len(_HYPHEN_PAIR.findall(text)) * per_1k,
        bold_labels_per_1k=len(_BOLD_LABEL.findall(text)) * per_1k,
        mean_sentence_words=words / max(len(sentences), 1),
    )


def _density_findings(
    text: str,
    spans: list[tuple[int, int]],
    ref: Profile | None,
    prof: Profile,
) -> list[Finding]:
    """B8/B6/B10/D19 — tells that are only tells in bulk. A supplied voice
    sample RAISES the ceiling to whatever that writer actually does, which is
    upstream's rule that a sample overrides the patterns (dashes included)."""
    out: list[Finding] = []
    if prof.words < _MIN_DENSITY_WORDS:
        return out
    checks = (
        (
            "B8",
            "dashes as universal connector",
            "rhythm",
            _DASH,
            prof.dashes_per_1k,
            max(_MAX_DASHES_PER_1K, ref.dashes_per_1k if ref else 0.0),
        ),
        (
            "B6",
            "forced triads",
            "rhythm",
            _TRIAD,
            prof.triads_per_1k,
            max(_MAX_TRIADS_PER_1K, ref.triads_per_1k if ref else 0.0),
        ),
        (
            "B10",
            "hyphenated pairs everywhere",
            "rhythm",
            _HYPHEN_PAIR,
            prof.hyphen_pairs_per_1k,
            max(_MAX_HYPHEN_PAIRS_PER_1K, ref.hyphen_pairs_per_1k if ref else 0.0),
        ),
        (
            "D19",
            "bold as decoration",
            "formatting",
            _BOLD_LABEL,
            prof.bold_labels_per_1k,
            max(_MAX_BOLD_LABELS_PER_1K, ref.bold_labels_per_1k if ref else 0.0),
        ),
    )
    for pid, name, cat, rx, rate, ceiling in checks:
        hits = list(rx.finditer(text))
        if rate <= ceiling or len(hits) < _MIN_DENSITY_HITS:
            continue
        severity = _WEAK if pid in ("B10",) else _ACT
        for m in hits:
            if _blocked(spans, m.start(), m.end()):
                continue
            out.append(
                Finding(pid, name, cat, severity, m.start(), m.end(), _excerpt(text, m))
            )
    return out


def _excerpt(text: str, m: re.Match[str]) -> str:
    start = max(0, m.start() - 20)
    end = min(len(text), m.end() + 20)
    return text[start:end].replace("\n", " ").strip()[:120]


def _repeated_openings(text: str, spans: list[tuple[int, int]]) -> list[Finding]:
    """B7 — consecutive sentences anchored on the same opening word."""
    out: list[Finding] = []
    pos = 0
    previous = ""
    for sentence in _SENTENCE_SPLIT.split(text):
        start = text.find(sentence, pos)
        if start < 0:
            break
        pos = start + len(sentence)
        first = _WORD.search(sentence)
        opener = first.group(0).lower() if first else ""
        if opener and opener == previous and len(opener) >= 3:
            if not _blocked(spans, start, start + len(opener)):
                out.append(
                    Finding(
                        "B7",
                        "repeated sentence opening",
                        "rhythm",
                        _ACT,
                        start,
                        start + len(opener),
                        sentence.strip()[:120],
                    )
                )
        previous = opener
    return out


def _stacked_qualifiers(text: str, spans: list[tuple[int, int]]) -> list[Finding]:
    """B9 — weak alone; a tell when two hedges share one sentence."""
    out: list[Finding] = []
    pos = 0
    for sentence in _SENTENCE_SPLIT.split(text):
        start = text.find(sentence, pos)
        if start < 0:
            break
        pos = start + len(sentence)
        hits = list(_QUALIFIER.finditer(sentence))
        if len(hits) < 2:
            continue
        first = hits[0]
        at = start + first.start()
        if not _blocked(spans, at, at + len(first.group(0))):
            out.append(
                Finding(
                    "B9",
                    "stacked qualifiers",
                    "rhythm",
                    _WEAK,
                    at,
                    at + len(first.group(0)),
                    sentence.strip()[:120],
                )
            )
    return out


def _short_closers(text: str, spans: list[tuple[int, int]]) -> list[Finding]:
    """A2 (structural half) — a dramatic one-line paragraph that restates."""
    out: list[Finding] = []
    pos = 0
    for para in _PARAGRAPH_SPLIT.split(text):
        start = text.find(para, pos)
        if start < 0:
            break
        pos = start + len(para)
        body = para.strip()
        if not body or _LIST_OR_HEAD.match(body):
            continue
        n = _count_words(body)
        if 1 <= n <= 5 and body.endswith((".", "!", "?")):
            if not _blocked(spans, start, start + len(body)):
                out.append(
                    Finding(
                        "A2",
                        "one-line closer",
                        "staging",
                        _ACT,
                        start,
                        start + len(body),
                        body[:120],
                    )
                )
    return out


def _headings(text: str, spans: list[tuple[int, int]]) -> list[Finding]:
    """D20 decorative headings + E24 the heading echoed in the first sentence."""
    out: list[Finding] = []
    for m in _HEADING.finditer(text):
        title = m.group(2).strip()
        at, end = m.start(2), m.end(2)
        if _blocked(spans, at, end):
            continue
        words = _WORD.findall(title)
        titled = [w for w in words if w[:1].isupper()]
        decorative = bool(_EMOJI_HEAD.search(title)) or (
            len(words) >= 4 and len(titled) == len(words)
        )
        if decorative:
            out.append(
                Finding("D20", "decorative heading", "formatting", _ACT, at, end, title)
            )
        # E24: the sentence right after the heading restates it.
        tail = text[m.end() : m.end() + 400]
        follow = next((s for s in _SENTENCE_SPLIT.split(tail.strip()) if s.strip()), "")
        head_words = {w.lower() for w in words if len(w) > 3}
        follow_words = {w.lower() for w in _WORD.findall(follow) if len(w) > 3}
        if head_words and follow_words:
            overlap = len(head_words & follow_words) / len(head_words)
            if overlap >= 0.6:
                out.append(
                    Finding(
                        "E24",
                        "heading repeated in the first sentence",
                        "leftovers",
                        _ACT,
                        m.end(),
                        m.end() + len(follow),
                        follow.strip()[:120],
                    )
                )
    for m in _HRULE.finditer(text):
        if not _blocked(spans, m.start(), m.end()):
            out.append(
                Finding(
                    "D20",
                    "decorative heading",
                    "formatting",
                    _WEAK,
                    m.start(),
                    m.end(),
                    "horizontal rule",
                )
            )
    return out


def _simple(
    text: str,
    spans: list[tuple[int, int]],
    pid: str,
    name: str,
    category: str,
    severity: str,
    rx: re.Pattern[str],
) -> list[Finding]:
    out: list[Finding] = []
    for m in rx.finditer(text):
        if _blocked(spans, m.start(), m.end()):
            continue
        out.append(
            Finding(
                pid, name, category, severity, m.start(), m.end(), _excerpt(text, m)
            )
        )
    return out


# --------------------------------------------------------------------------- #
# the public surface
# --------------------------------------------------------------------------- #
def analyze(
    text: str,
    *,
    sample: str | None = None,
    register: str = "prose",
) -> tuple[list[Finding], Profile]:
    """Every sighting in `text`, ordered by position.

    `sample` is the user's own writing, used as the voice reference: its
    measured rhythm raises the density ceilings, so a writer who genuinely uses
    dashes is not corrected into someone else. `register="technical"` drops the
    voice-flavour patterns and keeps only the slop ones.
    """
    if not isinstance(text, str) or not text.strip():
        return [], profile("")
    spans = protected_spans(text)
    ref = profile(sample) if isinstance(sample, str) and sample.strip() else None
    technical = register == "technical"
    # ONE profile for the whole pass. It walks 50KB of text (measured: 26ms),
    # and computing it per consumer was a third of the total scan cost.
    prof = profile(text)

    findings: list[Finding] = []
    for pid, name, category, severity, rx in _LEXICAL:
        if technical and pid in _VOICE_ONLY:
            continue
        findings.extend(_simple(text, spans, pid, name, category, severity, rx))
    findings.extend(_short_closers(text, spans))
    findings.extend(_repeated_openings(text, spans))
    findings.extend(_stacked_qualifiers(text, spans))
    findings.extend(_headings(text, spans))
    findings.extend(_density_findings(text, spans, ref, prof))
    if not technical:
        findings.extend(
            _simple(text, spans, "B11", "passive voice", "rhythm", _WEAK, _PASSIVE)
        )
    findings.extend(
        _simple(
            text, spans, "D21", "curly quotation marks", "formatting", _WEAK, _CURLY
        )
    )

    # UPSTREAM'S SEVERITY RULE: a weak tell alone is not evidence of anything.
    # It counts only when something that acts on one sighting is also present.
    if not any(f.severity == _ACT for f in findings):
        findings = [f for f in findings if f.severity == _ACT]
    findings.sort(key=lambda f: (f.start, f.pattern))
    return findings, prof


def human_voice_score(
    text: str,
    *,
    sample: str | None = None,
    register: str = "prose",
    findings: list[Finding] | None = None,
    prof: Profile | None = None,
) -> int:
    """0-100, where 100 is "nothing here reads like a model wrote it".

    A weighted density, not a verdict: findings per 1,000 words, acting tells at
    full weight and weak ones at 0.4. Reproducible for the same input, which is
    what makes it usable as a gate.
    """
    if findings is None:
        findings, prof = analyze(text, sample=sample, register=register)
    elif prof is None:
        prof = profile(text)
    if not findings:
        return 100
    weight = sum(_ACT_WEIGHT if f.severity == _ACT else _WEAK_WEIGHT for f in findings)
    density = weight * 1000.0 / max(prof.words, 1)
    return max(0, min(100, round(100 - density * _DENSITY_TO_POINTS)))

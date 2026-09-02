"""Conversational context — resolution, classification and compilation.

ONE layer, consumed by every skill and agent. It is wired into
`build_system_prompt` in runner.py, which is the single seam every turn passes
through (skills self-declare and there is deliberately no central router — see
roster.py). A skill therefore inherits continuity by existing, and no skill
contains context logic of its own.

WHAT THIS FIXES. Continuity was previously solved three separate times, each for
one skill: Deep Research is seeded from `activeResearchRun` so it "continues OPEN
sub-questions", Data Analysis from `datasets` so "a follow-up with no new upload
still analyses the same data", and the capability overview from live runtime
state. Each is correct and none of them helps Blog, SEO, Coding or Documents.

WHAT IT DOES NOT DO. It does not decide what the state IS. The floor —
active artifact, version, lineage, subject, entity activation order — is derived
in Convex as a pure function of rows the application owns, and arrives on the
request. This module reads it. A model that never calls `record_context` cannot
make any of it stale or missing, and nothing below reads a model-supplied field.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.agent.budget import tokens
from app.models.chat import ArtifactRef, ConversationContext, HistoryMessage

# ---------------------------------------------------------------- operations

CREATE = "CREATE"
MODIFY = "MODIFY"
EXTEND = "EXTEND"
REWRITE = "REWRITE"
CONTINUE = "CONTINUE"
TRANSFORM = "TRANSFORM"
AUDIT = "AUDIT"
APPLY_AUDIT = "APPLY_AUDIT"
REVERT = "REVERT"
COMPARE = "COMPARE"
ANSWER = "ANSWER"
NEW_TASK = "NEW_TASK"

# Ordered most-specific first: "apply those changes" is an APPLY_AUDIT, not a
# MODIFY, and "go back to the previous version" is a REVERT, not a CONTINUE.
_OPERATION_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        REVERT,
        re.compile(
            r"\b(revert|roll ?back|undo|restore)\b"
            r"|\bgo back to (the )?(previous|earlier|last|v\d)",
            re.I,
        ),
    ),
    (
        APPLY_AUDIT,
        re.compile(r"\bapply\b.*\b(chang|recommend|suggest|fix|edit|feedback)", re.I),
    ),
    (AUDIT, re.compile(r"\b(audit|review|critique|assess|evaluate|check)\b", re.I)),
    (
        TRANSFORM,
        re.compile(
            r"\b(turn|convert|reformat|repurpose|adapt) (it|this|that|the \w+) into\b"
            r"|\bas a (linkedin|tweet|thread|email|slide)",
            re.I,
        ),
    ),
    (
        COMPARE,
        re.compile(r"\bcompare\b|\bversus\b|\bvs\.?\b|\bdifference between\b", re.I),
    ),
    (
        CONTINUE,
        re.compile(
            r"\bcontinue\b|\bkeep going\b|\bcarry on\b|\bgo on\b"
            r"|\bfinish (it|this|that)\b|\bwhere (we|you) (stopped|left off)\b",
            re.I,
        ),
    ),
    (
        EXTEND,
        re.compile(
            r"\badd\b|\balso include\b|\bappend\b|\bone more\b|\bextend\b", re.I
        ),
    ),
    (
        REWRITE,
        re.compile(
            r"\brewrite\b|\breword\b|\brephrase\b"
            r"|\bmore human\b|\bless robotic\b|\bfrom scratch\b",
            re.I,
        ),
    ),
    (
        MODIFY,
        re.compile(
            r"\bmore detail|\bin detail\b|\bexpand\b|\belaborate\b"
            r"|\bimprove\b|\bbetter\b|\bmake it\b|\bmake the\b"
            r"|\blonger\b|\bshorter\b|\bremove\b|\bdelete\b",
            re.I,
        ),
    ),
    (
        CREATE,
        re.compile(
            r"\b(write|create|generate|draft|build|produce|give me)\b.*\b(a|an|some)\b",
            re.I,
        ),
    ),
]


def classify_operation(text: str) -> str:
    """Deterministic. Runs BEFORE any skill executes."""
    stripped = (text or "").strip()
    if not stripped:
        return ANSWER
    for op, pattern in _OPERATION_PATTERNS:
        if pattern.search(stripped):
            return op
    if stripped.endswith("?"):
        return ANSWER
    return NEW_TASK


# ---------------------------------------------------------------- references

# A bare reference is one that means nothing without state.
_REFERENCE_MARKERS = re.compile(
    r"\b(it|this|that|these|those|them|they|one)\b"
    r"|\b(above|below|previous|earlier|prior|last|latest|former)\b",
    re.I,
)
# Kind words a user actually says, mapped onto the artifact `kind` field.
_KIND_WORDS: dict[str, tuple[str, ...]] = {
    "blog": ("blog", "post", "article", "write-up", "writeup"),
    "report": ("report", "brief", "summary", "analysis"),
    "code": ("code", "script", "function", "snippet", "program"),
    "document": ("document", "doc", "pdf", "deck", "presentation", "slides"),
    "audit": ("audit", "review", "recommendations"),
}
_EXPLICIT_VERSION = re.compile(r"\bv(?:ersion\s*)?(\d{1,3})\b", re.I)
_PREVIOUS_VERSION = re.compile(
    r"\b(previous|earlier|prior|last|older)\s+(version|draft|revision)\b"
    r"|\bgo back to (the )?(previous|earlier|last)\b",
    re.I,
)
_SECTION = re.compile(
    r"\bsection\s+(\d{1,2})\b|\bthe\s+([a-z][a-z \-]{2,30}?)\s+section\b", re.I
)

# Rung names, in precedence order. Emitted in the observability line so a
# resolution can be explained after the fact rather than guessed at.
RUNG_EXPLICIT = "explicit_identity"
RUNG_STATE = "authoritative_state"
RUNG_IDENTITY = "artifact_identity"
RUNG_LINEAGE = "version_lineage"
RUNG_ACTIVATION = "entity_activation"
RUNG_RECENCY = "recency"
RUNG_AMBIGUOUS = "ambiguous"


@dataclass(frozen=True)
class Resolution:
    reference: str
    artifact_id: str | None
    version: int | None
    confidence: float
    rung: str
    candidates: tuple[str, ...] = field(default=())
    section: str | None = None

    @property
    def resolved(self) -> bool:
        return self.artifact_id is not None


def _heads(ctx: ConversationContext) -> list[ArtifactRef]:
    """Lineage heads, newest first. One entry per artifact identity."""
    seen: set[str] = set()
    out: list[ArtifactRef] = []
    for a in sorted(ctx.artifacts, key=lambda x: x.seq, reverse=True):
        if a.artifactId in seen:
            continue
        seen.add(a.artifactId)
        out.append(a)
    return out


def _versions_of(ctx: ConversationContext, artifact_id: str) -> list[ArtifactRef]:
    return sorted(
        (a for a in ctx.artifacts if a.artifactId == artifact_id),
        key=lambda x: x.version,
    )


def _named_subject(text: str, ctx: ConversationContext) -> str | None:
    """A subject the user named outright, longest match first.

    Longest-first matters when one subject contains another ("WireGuard" inside
    "Cloud WireGuard VPN") — the more specific name is the one they meant.
    """
    low = text.lower()
    for name in sorted({a.subject for a in ctx.artifacts}, key=len, reverse=True):
        if name and name.lower() in low:
            return name
    return None


def _named_kind(text: str) -> str | None:
    low = text.lower()
    for kind, words in _KIND_WORDS.items():
        for w in words:
            if re.search(rf"\b{re.escape(w)}\b", low):
                return kind
    return None


def resolve_reference(text: str, ctx: ConversationContext) -> Resolution:
    """The precedence ladder. Semantics are the LAST resort, never the first.

    Returns an unresolved Resolution when there is nothing to resolve (a fresh
    CREATE names its own subject) and an `ambiguous` one when two candidates are
    genuinely close — which is the only case that should ever cost an LLM call,
    or a clarifying question.
    """
    raw = (text or "").strip()
    marker = _REFERENCE_MARKERS.search(raw)
    section_m = _SECTION.search(raw)
    section = None
    if section_m:
        section = section_m.group(1) or (section_m.group(2) or "").strip()

    subject = _named_subject(raw, ctx)
    kind = _named_kind(raw)
    heads = _heads(ctx)

    # Nothing to point at.
    if not heads:
        return Resolution(raw[:120], None, None, 0.0, RUNG_RECENCY, section=section)

    # A turn with no reference marker, no named subject and no kind word is not
    # referring to prior work at all — resolving anyway is how "write a blog
    # about Kubernetes" silently becomes an edit of the WireGuard article.
    # A version reference is a reference. "restore v1" names no subject, no kind
    # and no pronoun, but it is unambiguously about existing work — the early
    # exit below used to discard it.
    version_ref = bool(_EXPLICIT_VERSION.search(raw) or _PREVIOUS_VERSION.search(raw))

    if not marker and not subject and not kind and not section_m and not version_ref:
        return Resolution(raw[:120], None, None, 0.0, RUNG_RECENCY, section=section)

    def with_version(a: ArtifactRef, rung: str, conf: float) -> Resolution:
        versions = _versions_of(ctx, a.artifactId)
        chosen = a.version
        explicit = _EXPLICIT_VERSION.search(raw)
        if explicit:
            want = int(explicit.group(1))
            if any(v.version == want for v in versions):
                return Resolution(
                    raw[:120], a.artifactId, want, 0.99, RUNG_EXPLICIT, section=section
                )
        if _PREVIOUS_VERSION.search(raw):
            # LINEAGE, not "the message before". The previous VERSION is the one
            # below the current head in the supersedes chain — which is a
            # different thing entirely once a turn has produced two artifacts.
            below = [v for v in versions if v.version < a.version]
            if below:
                return Resolution(
                    raw[:120],
                    a.artifactId,
                    below[-1].version,
                    0.95,
                    RUNG_LINEAGE,
                    section=section,
                )
        return Resolution(raw[:120], a.artifactId, chosen, conf, rung, section=section)

    # 1. EXPLICIT IDENTITY — the user named the subject (optionally with a kind).
    # A subject named ALONGSIDE a bare pronoun is a COMPARAND, not the referent.
    #
    # "compare that with Redis" names Redis and points `that` at something else —
    # the thing the user was just working on. Treating the named subject as the
    # referent gets this exactly backwards, and it is the most common shape of a
    # multi-subject turn. So rung 1 is skipped and activation order decides,
    # excluding the comparand.
    comparand = subject if (subject and marker) else None

    if subject and not comparand:
        matches = [a for a in heads if a.subject == subject]
        if kind:
            typed = [a for a in matches if a.kind == kind]
            if typed:
                matches = typed
        if len(matches) == 1:
            return with_version(matches[0], RUNG_EXPLICIT, 0.98)
        if len(matches) > 1:
            return Resolution(
                raw[:120],
                None,
                None,
                0.4,
                RUNG_AMBIGUOUS,
                candidates=tuple(a.artifactId for a in matches),
                section=section,
            )

    # 2. AUTHORITATIVE STATE — the active artifact, when a kind word does not
    #    contradict it.
    if ctx.activeArtifactId:
        active = next((a for a in heads if a.artifactId == ctx.activeArtifactId), None)
        if active and (not kind or active.kind == kind):
            return with_version(active, RUNG_STATE, 0.95)

    # 3. ARTIFACT IDENTITY — a kind word alone ("expand the article").
    if kind:
        typed = [a for a in heads if a.kind == kind]
        if len(typed) == 1:
            return with_version(typed[0], RUNG_IDENTITY, 0.9)
        if len(typed) > 1:
            # Two articles in play: fall through to activation order, which is
            # the thing that actually knows which one the user returned to.
            heads = typed

    # 4. ENTITY ACTIVATION — the multi-subject case. After
    #    PostgreSQL -> Redis -> "go back to PostgreSQL", a following "compare
    #    that with Redis" must bind `that` to PostgreSQL. Mention-recency binds
    #    it to Redis and is wrong; activation order is what distinguishes them.
    if ctx.entities:
        for ent in sorted(ctx.entities, key=lambda e: e.activatedAtSeq, reverse=True):
            # Never resolve a pronoun to the thing it is being compared WITH.
            if comparand and ent.name == comparand:
                continue
            match = next((a for a in heads if a.subject == ent.name), None)
            if match:
                return with_version(match, RUNG_ACTIVATION, 0.85)

    # 5. RECENCY — the last thing produced.
    top = heads[0]
    runner_up = heads[1] if len(heads) > 1 else None
    if runner_up and runner_up.seq == top.seq:
        return Resolution(
            raw[:120],
            None,
            None,
            0.45,
            RUNG_AMBIGUOUS,
            candidates=(top.artifactId, runner_up.artifactId),
            section=section,
        )
    return with_version(top, RUNG_RECENCY, 0.8)


# ---------------------------------------------------------------- compilation


@dataclass
class Compiled:
    block: str
    operation: str
    resolution: Resolution
    pinned_artifact_id: str | None
    pinned_tokens: int
    pinned_clipped: bool


def _artifact_text(
    ref: ArtifactRef | None,
    ctx: ConversationContext,
    history: list[HistoryMessage],
) -> str | None:
    """The artifact's text, from the window if it is there, else from the payload.

    Matched by `seq` rather than by messageId because history entries carry seq —
    and seq is what orders a thread, so it is the stable join.
    """
    if ref is None:
        return None
    for h in history:
        if h.seq == ref.seq and h.content.strip():
            return h.content
    # Out of window. Convex attaches the active artifact's text precisely for
    # this case; anything else is unretrievable and must NOT be claimed.
    if ctx.activeArtifactId == ref.artifactId and ctx.activeArtifactText:
        return ctx.activeArtifactText
    return None


def _clip_to_tokens(text: str, reserve: int) -> tuple[str, int, bool]:
    """Clip to a TOKEN reserve, not a character count.

    Characters are not tokens and the ratio swings by ~3x between prose and code,
    so a char cap cannot stand in for one. Measure, estimate the ratio from the
    text itself, clip, then re-measure and shrink if the estimate was optimistic.
    """
    measured = tokens(text)
    if measured <= reserve:
        return text, measured, False
    ratio = max(1.0, len(text) / max(1, measured))
    out = text
    for _ in range(4):
        target_chars = int(reserve * ratio)
        head = int(target_chars * 0.6)
        tail = max(0, target_chars - head)
        out = (
            text[:head]
            + "\n\n[... middle omitted for length; the full text exists in the "
            + "conversation ...]\n\n"
            + (text[-tail:] if tail else "")
        )
        measured = tokens(out)
        if measured <= reserve:
            break
        ratio *= 0.8
    return out, measured, True


def compile_context(
    *,
    user_text: str,
    ctx: ConversationContext | None,
    history: list[HistoryMessage],
    artifact_reserve_tokens: int,
) -> Compiled | None:
    """Build the `<conversation_state>` block for this turn.

    Returns None when there is genuinely no state — a first turn — so the system
    prompt is byte-identical to what it was before this layer existed.
    """
    operation = classify_operation(user_text)
    if ctx is None or (not ctx.artifacts and not ctx.userConstraints):
        return None

    resolution = resolve_reference(user_text, ctx)
    ref: ArtifactRef | None = None
    if resolution.resolved:
        versions = _versions_of(ctx, resolution.artifact_id or "")
        ref = next(
            (v for v in versions if v.version == resolution.version),
            versions[-1] if versions else None,
        )

    text = _artifact_text(ref, ctx, history)
    pinned = ""
    pinned_tokens = 0
    clipped = False
    if ref is not None and text:
        body, pinned_tokens, clipped = _clip_to_tokens(text, artifact_reserve_tokens)
        pinned = (
            f'<active_artifact id="{ref.artifactId}" kind="{ref.kind}" '
            f'version="{ref.version}" subject="{ref.subject}">\n'
            f"{body}\n</active_artifact>"
        )

    lines: list[str] = ["<conversation_state>"]
    if ctx.activeSubject:
        lines.append(f"Active subject: {ctx.activeSubject}")
    if len(ctx.entities) > 1:
        others = ", ".join(
            e.name
            for e in sorted(ctx.entities, key=lambda x: x.activatedAtSeq, reverse=True)
        )
        lines.append(f"Subjects in play, most recently active first: {others}")
    for a in _heads(ctx)[:8]:
        flag = " (ACTIVE)" if a.artifactId == ctx.activeArtifactId else ""
        lines.append(
            f"Artifact {a.artifactId}: {a.kind} about {a.subject}, v{a.version}{flag}"
        )
    lines.append(f"This turn's operation: {operation}")
    if resolution.resolved:
        lines.append(
            f'Resolved reference: "{resolution.reference}" -> {resolution.artifact_id} '
            f"v{resolution.version} (via {resolution.rung}, "
            f"confidence {resolution.confidence:.2f})"
        )
        if resolution.section:
            lines.append(f"Referring to section: {resolution.section}")
        lines.append(
            "The referenced work is included below. Act on it directly. Do NOT ask "
            "the user to paste or re-supply content that is already here."
        )
    elif resolution.candidates:
        lines.append(
            "Reference is ambiguous between: " + ", ".join(resolution.candidates)
        )
        lines.append("Ask ONE short clarifying question naming the candidates.")
    if ctx.userConstraints:
        lines.append(
            "Standing constraints (carry these forward unless the user changes "
            "them; a narrow edit must not discard them): "
            + "; ".join(ctx.userConstraints)
        )
    if ctx.userDecisions:
        lines.append("Decisions already made: " + "; ".join(ctx.userDecisions))
    if ctx.openLoops:
        lines.append("Still outstanding: " + "; ".join(ctx.openLoops))
    lines.append("</conversation_state>")

    block = "\n".join(lines)
    if pinned:
        block = f"{block}\n\n{pinned}"

    return Compiled(
        block=block,
        operation=operation,
        resolution=resolution,
        pinned_artifact_id=ref.artifactId if ref and pinned else None,
        pinned_tokens=pinned_tokens,
        pinned_clipped=clipped,
    )


# ------------------------------------------------------- artifact derivation

# Below this a reply is an ANSWER, not a work product. Registering every
# two-line response as an artifact would make "it" ambiguous on every turn and
# bury the thing the user actually cares about.
MIN_ARTIFACT_CHARS = 1_200

_HEADING = re.compile(r"^#{1,3}\s+(.{3,120})$", re.M)
_FENCE = re.compile(r"^```", re.M)
# The BODY of each fenced block, so classification can weigh how much of the
# text is actually code rather than merely counting delimiters.
_FENCED_BLOCK = re.compile(r"```[^\n]*\n(.*?)```", re.S)

# Operations that produce a NEW VERSION of the thing already in play, rather
# than a new thing. This is what makes v1 -> v2 -> v3 a lineage instead of
# three unrelated artifacts.
_SUPERSEDING = {MODIFY, EXTEND, REWRITE, CONTINUE, APPLY_AUDIT}


@dataclass(frozen=True)
class DerivedArtifact:
    kind: str
    subject: str
    supersedes_artifact_id: str | None


def derive_artifact(
    *,
    operation: str,
    final_text: str,
    ctx: ConversationContext | None,
    resolution: Resolution | None,
    fallback_subject: str,
) -> DerivedArtifact | None:
    """What this turn produced, derived in CODE.

    THE FLOOR FOR ARTIFACT IDENTITY. If registration depended on the model
    calling a tool, then a model that skipped the call would leave the next turn
    with nothing to resolve against — which is the original bug wearing a
    different hat. So the application decides, from the turn it just produced,
    and `record_context` may only refine the subject afterwards.

    Returns None for a turn that is an answer rather than a work product.
    """
    text = (final_text or "").strip()
    if len(text) < MIN_ARTIFACT_CHARS:
        return None
    if operation in (ANSWER, AUDIT, COMPARE):
        # An audit or a comparison is ABOUT an artifact; it is not a new version
        # of one. Treating it as one would silently make "apply those changes"
        # resolve to the audit rather than to the thing being audited.
        return None

    # A technical article full of config examples is still an ARTICLE.
    #
    # Counting fences was not enough: the WireGuard blog has several code blocks
    # and was registered as kind="code" on production, which then made "the
    # article" fail to match it by kind. What distinguishes them is how much of
    # the text is inside the fences, not how many there are.
    fenced_chars = sum(len(m) for m in _FENCED_BLOCK.findall(text))
    code_ratio = fenced_chars / max(1, len(text))
    headings = len(_HEADING.findall(text))
    if code_ratio > 0.5 and headings < 3:
        kind = "code"
    elif headings >= 2 and re.search(
        r"(report|analysis|findings|audit)", text[:400], re.I
    ):
        kind = "report"
    else:
        kind = "blog"

    heading = _HEADING.search(text)
    subject = (heading.group(1).strip() if heading else "") or fallback_subject
    # A superseding operation keeps the SUBJECT of the thing it edits: "make it
    # more human" must not rename the article after whatever heading the rewrite
    # happened to open with.
    supersedes = None
    if operation in _SUPERSEDING and resolution and resolution.resolved:
        supersedes = resolution.artifact_id
        if ctx:
            prior = next((a for a in ctx.artifacts if a.artifactId == supersedes), None)
            if prior:
                subject = prior.subject
                kind = prior.kind

    return DerivedArtifact(
        kind=kind, subject=subject[:200], supersedes_artifact_id=supersedes
    )

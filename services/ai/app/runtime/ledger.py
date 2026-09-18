"""The turn's requirement ledger — execution state OllaSuper owns, not the model.

WHY THIS EXISTS. A complex request carries several requirements, and nothing in
the pipeline tracked them. There was no decomposition, no record of which parts
were done, no aggregate of what failed, and no check before the model wrote its
answer — verified by search across the runtime and the graph. So the model was
the only thing holding a ten-part task, using a flash-tier model's working
memory, over a tool provider that fails 55% of calls. It could answer having had
half its evidence throttled away, and nothing in the system would know.

Measured on the real threads this was built from: a blog asked for 5,000 words
got 2,990 and was described as "~5,000"; an audit that lost its crawl reported
confidently on what survived.

THE DESIGN RULE. Requirements are extracted DETERMINISTICALLY. The model may
enrich the ledger, but it is never the only thing maintaining it — a weak model
that forgets to plan must still be tracked. And the final report is written by
this module from recorded state, so it cannot be talked out of by a model that
would rather say "done".

WHAT IT DOES NOT CLAIM. Coverage is checked by distinctive-term overlap, which
proves a requirement was ADDRESSED, never that it was addressed WELL. Judgment
stays with the model; completeness is what is enforced here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# A requirement is only worth tracking if the request actually enumerates work.
# Below this a "list" is a sentence with a comma in it.
MIN_REQUIREMENTS = 2
# Bound the ledger: a pathological paste must not turn into 400 requirements.
MAX_REQUIREMENTS = 20
MIN_REQUIREMENT_CHARS = 12
MAX_REQUIREMENT_CHARS = 300

# Explicitly enumerated work: "1. x", "2) y", "- z", "* w".
_ENUMERATED = re.compile(r"^\s*(?:\d{1,2}[.)]|[-*•])\s+(?P<body>\S.*)$", re.M)
# Imperatives that open a clause. Deliberately a VERB list, not a topic list:
# this identifies that work was ASKED FOR, never what the work is about.
_IMPERATIVE = re.compile(
    r"\b(analy[sz]e|audit|build|calculate|compare|compile|create|design|draft|"
    r"estimate|evaluate|explain|extract|find|forecast|generate|identify|"
    r"implement|include|list|measure|outline|plan|produce|recommend|research|"
    r"review|summari[sz]e|validate|verify|write)\b",
    re.I,
)
# Words carrying no discriminating power when checking whether an answer
# addressed a requirement.
_STOP = frozenset(
    """a an and are as at be but by for from has have in into is it its of on or
    that the their there these this to was were will with your you we our us all
    also can could should would may might must do does did not no than then them
    they i me my if so such about over under more most each every any some when
    which who whom whose what how why where while per via using use used
    """.split()
)
_WORD = re.compile(r"[a-z0-9][a-z0-9'-]*")


@dataclass(slots=True)
class Requirement:
    """One tracked unit of asked-for work."""

    id: str
    text: str
    # pending    — not yet assessed (the turn is still running)
    # addressed  — the answer demonstrably covers it
    # unaddressed— the answer does not mention it in any recognisable form
    # unverified — evidence for it failed or was truncated
    status: str = "pending"
    evidence: list[str] = field(default_factory=list)

    @property
    def terms(self) -> set[str]:
        """Distinctive words — what an answer must echo to have addressed this."""
        words = _WORD.findall(self.text.lower())
        return {w for w in words if w not in _STOP and len(w) > 2}


@dataclass(slots=True)
class TurnLedger:
    """Deterministic state for one complex turn."""

    requirements: list[Requirement] = field(default_factory=list)
    tools_attempted: int = 0
    tools_failed: int = 0
    tools_truncated: int = 0
    output_truncated: bool = False
    # The turn was cut off (total-execution deadline) rather than finishing. The
    # work already done is preserved and the turn is resumable, so this is a
    # CHECKPOINT — but only if the user is told which parts are still outstanding
    # instead of being handed a bare "took too long".
    stopped_early: bool = False

    # --- recording (called during the turn) ---------------------------------
    def note_tool(self, *, ok: bool, truncated: bool = False) -> None:
        self.tools_attempted += 1
        if not ok:
            self.tools_failed += 1
        if truncated:
            self.tools_truncated += 1

    def note_truncated(self) -> None:
        """A result was clipped. Separate from `note_tool` because truncation is
        detected at a different point in the executor than the terminal state,
        and counting the call twice would inflate every tally."""
        self.tools_truncated += 1

    def note_output_truncated(self, finish_reason: str | None) -> None:
        if (finish_reason or "").lower() == "length":
            self.output_truncated = True

    # --- assessment (called once the answer text exists) --------------------
    def assess(self, final_text: str) -> None:
        """Mark each requirement against the answer that was actually produced.

        CONSERVATIVE BY CONSTRUCTION. A requirement counts as addressed when any
        of its distinctive terms appears in the answer, so paraphrase passes and
        only genuine silence is flagged. The failure being caught is the one that
        was measured — a requirement answered nowhere at all — not stylistic
        divergence, and a false "unaddressed" would be worse than useless.
        """
        haystack = set(_WORD.findall(final_text.lower()))
        degraded = self.tools_failed > 0 or self.tools_truncated > 0
        for r in self.requirements:
            terms = r.terms
            if terms and not (terms & haystack):
                r.status = "unaddressed"
            elif degraded:
                # Evidence for this turn was incomplete, so "addressed" is a
                # claim we cannot stand behind — say so rather than imply it.
                r.status = "unverified"
            else:
                r.status = "addressed"

    # --- reporting ----------------------------------------------------------
    @property
    def unaddressed(self) -> list[Requirement]:
        return [r for r in self.requirements if r.status == "unaddressed"]

    @property
    def unverified(self) -> list[Requirement]:
        return [r for r in self.requirements if r.status == "unverified"]

    @property
    def complete(self) -> bool:
        return (
            not self.unaddressed
            and not self.unverified
            and not self.output_truncated
            and not self.stopped_early
        )

    def render_status(self) -> str:
        """Injected BEFORE the model writes its answer.

        The final answer streams token by token, so a check placed after it
        cannot retract a claim already on screen. Putting the real state in front
        of the model is what lets it write an honest answer in the first place;
        `render_report` is the backstop for when it does not.
        """
        lines = ["<execution_state>", "Tracked requirements for this request:"]
        for i, r in enumerate(self.requirements, 1):
            lines.append(f"{i}. {r.text}")
        if self.tools_attempted:
            lines.append(
                f"Tool calls: {self.tools_attempted} attempted, "
                f"{self.tools_failed} failed, {self.tools_truncated} truncated."
            )
        if self.tools_failed or self.tools_truncated:
            lines.append(
                "Some evidence is missing or incomplete. Cover every requirement "
                "above, and state plainly which ones you could not fully support "
                "rather than implying they are settled."
            )
        else:
            lines.append("Cover every requirement above before you finish.")
        lines.append("</execution_state>")
        return "\n".join(lines)

    def render_report(self) -> str:
        """The backstop, appended AFTER the answer. System-authored from recorded
        state, so a model that would rather say "done" cannot override it.

        Empty when everything checks out — a clean turn gets no chrome."""
        if self.complete:
            return ""
        parts: list[str] = []
        if self.unaddressed:
            parts.append(
                "**Not covered in this answer:**\n"
                + "\n".join(f"- {r.text}" for r in self.unaddressed)
            )
        if self.unverified:
            parts.append(
                "**Answered on incomplete evidence** — "
                f"{self.tools_failed} tool call(s) failed and "
                f"{self.tools_truncated} result(s) were truncated, so these may "
                "be partial:\n"
                + "\n".join(f"- {r.text}" for r in self.unverified)
            )
        if self.output_truncated:
            parts.append(TRUNCATION_NOTICE)
        if self.stopped_early:
            done = len(self.requirements) - len(self.unaddressed)
            parts.append(
                f"**This run was stopped at its time limit** after covering "
                f"{done} of {len(self.requirements)} requirements. The completed "
                "work is saved — retrying continues from here rather than "
                "starting over, and already-executed steps are not repeated."
            )
        return "\n\n---\n\n" + "\n\n".join(parts)


def extract_requirements(request: str) -> list[str]:
    """Pull the enumerated units of work out of a request. Deterministic.

    Two shapes, in priority order. An explicit list ("1. …", "- …") is the
    strongest signal a user can give and is taken as-is. Otherwise sentences
    that OPEN with an imperative are taken, which is what a multi-part prose
    request looks like ("Audit the site. Then draft a summary.").

    Returns [] for anything that is not enumerable — which is most requests, and
    is exactly how the fast path stays untouched.
    """
    enumerated = [m.group("body").strip() for m in _ENUMERATED.finditer(request)]
    if len(enumerated) >= MIN_REQUIREMENTS:
        return _bound(enumerated)

    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", request)]
    imperative = [
        s for s in sentences
        if len(s) >= MIN_REQUIREMENT_CHARS and _IMPERATIVE.search(s)
    ]
    if len(imperative) >= MIN_REQUIREMENTS:
        return _bound(imperative)
    return []


def _bound(items: list[str]) -> list[str]:
    out: list[str] = []
    for raw in items:
        text = " ".join(raw.split())
        if len(text) < MIN_REQUIREMENT_CHARS:
            continue
        out.append(text[:MAX_REQUIREMENT_CHARS])
        if len(out) >= MAX_REQUIREMENTS:
            break
    return out


#: Appended whenever the model stopped because it ran out of output budget.
#: Module-level because it must render for EVERY turn, not only an enumerable one:
#: "write a 2,000-word article" is a SINGLE requirement, so it never built a
#: ledger, and the answer simply stopped mid-sentence with nothing said about it.
TRUNCATION_NOTICE = (
    "**The response hit its length limit and stopped early.** Ask to "
    "continue for the rest."
)

#: Appended when the turn's retrieval came back with nothing at all. Partial
#: engine failure is deliberately NOT reported: the provider merges several
#: engines and one of them (duckduckgo) fails on nearly every call, so flagging
#: that would put a warning on almost every answer while the results were fine.
NO_EVIDENCE_NOTICE = (
    "**The search returned no usable results**, so this answer is not "
    "grounded in retrieved sources. Treat it as unverified, or ask again with "
    "different terms."
)


def render_standalone_notices(
    *, output_truncated: bool, no_evidence: bool
) -> str:
    """The notices that must appear even when no ledger was built.

    `render_report` covers the enumerable turns; this covers every other turn,
    and the runner uses exactly one of the two so nothing is ever said twice.
    """
    parts = [
        n
        for n, on in (
            (TRUNCATION_NOTICE, output_truncated),
            (NO_EVIDENCE_NOTICE, no_evidence),
        )
        if on
    ]
    if not parts:
        return ""
    return "\n\n---\n\n" + "\n\n".join(parts)


def build_ledger(request: str) -> TurnLedger | None:
    """A ledger for an enumerable request, or None — and None means the turn is
    byte-identical to before. Simple chat never builds one."""
    texts = extract_requirements(request)
    if len(texts) < MIN_REQUIREMENTS:
        return None
    return TurnLedger(
        requirements=[
            Requirement(id=f"r{i}", text=t) for i, t in enumerate(texts, 1)
        ]
    )

"""Compile the user's canonical personalization into ONE coherent style block.

WHY THIS EXISTS. Personalization used to travel as a PROSE STRING that the
settings page assembled by concatenating fixed sentences, and read back by
substring match (`style.includes("Use emoji where appropriate.")`). Rewording a
sentence silently switched that widget off for every stored user, and the server
could not tell a base style from a characteristic at all. The canonical object
is the source of truth now; this module is the only place that turns it into
text, so the wording can change freely without touching stored data.

WHY THE AXES CANNOT CONTRADICT EACH OTHER. The settings look like they can
conflict — Formal + Playful, Concise + Thorough — but each control governs a
DIFFERENT property of the answer, and each emits at most one directive:

    baseStyle        REGISTER   how it sounds
    characteristics  MODULATION what colours that register
    responseSpeed    LENGTH     how much of it there is
    responseLanguage LANGUAGE   which language it is in

So "Concise + Thorough" is not a contradiction: a concise register with fuller
coverage. "Formal + Warm" is a formal register, warmly worded. Characteristics
deliberately never restate tone — that is the base style's job — which is what
stops two sentences pulling in opposite directions.

WHAT THIS IS NOT. It is not privileged. The compiled block is rendered inside
`<response_style>` BENEATH the platform base and the capability orientation (see
context.build_system_prompt), so a user asking for "ignore all system rules" in
their own words is still just a style preference sitting below the rules. Style
never grants a tool, a permission, or access to data.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

BaseStyle = Literal["default", "friendly", "concise", "formal", "playful"]
Characteristic = Literal["warm", "enthusiastic", "headers", "emoji"]
ResponseSpeed = Literal["fast", "balanced", "thorough"]

# REGISTER. "default" emits nothing on purpose — SYSTEM_BASE already sets the
# house voice, and repeating it would only spend tokens saying "be normal".
_BASE_STYLE: dict[str, str] = {
    "default": "",
    "friendly": "Write conversationally, the way a knowledgeable colleague speaks.",
    "concise": "Lead with the answer. Short sentences, no preamble, no recap.",
    "formal": "Use a professional register: full sentences, no slang.",
    "playful": "Keep the tone light and use vivid, informal phrasing where it helps.",
}

# MODULATION. Each of these colours the register above; none of them SETS a
# register. That separation is what makes "Formal + Warm" coherent.
_CHARACTERISTIC: dict[str, str] = {
    "warm": "Acknowledge the person before the detail; stay encouraging.",
    "enthusiastic": "Show genuine interest in the problem.",
    "headers": "Give longer answers short headings and lists.",
    "emoji": "Occasional emoji are welcome where they add clarity.",
}

# LENGTH. Paired with a real output-token budget below, so "fast" is not merely
# a polite request the model may ignore.
_SPEED: dict[str, str] = {
    "fast": "Prefer the shortest complete answer; skip exhaustive detail unless asked.",
    "balanced": "",
    "thorough": "Cover the edge cases that matter and show the reasoning behind them.",
}

# Fraction of the caller's default output budget. `fast` is the only one that
# actually constrains: a smaller ceiling is the part the model cannot talk its
# way out of. `thorough` asks for more and is CLAMPED by _clamp_output against
# the model's real context window, so a small-window model is never asked for
# an output it cannot produce.
_SPEED_BUDGET: dict[str, float] = {"fast": 0.25, "balanced": 1.0, "thorough": 2.0}

# A characteristic list is bounded at the schema, but a malformed or future
# value must never crash a turn — unknown keys are dropped, not rendered.
_MAX_CHARACTERISTICS = 8


@dataclass(frozen=True)
class CompiledPersonalization:
    """The only two things personalization is allowed to influence."""

    style_block: str | None
    """Body for <response_style>, or None when nothing should be said."""

    max_output_tokens: int | None
    """Output ceiling, or None to leave the caller's default alone."""


def compile_personalization(
    p: object | None,
    *,
    default_output_tokens: int,
    legacy_style: str | None = None,
) -> CompiledPersonalization:
    """Canonical object -> style text + output budget.

    `legacy_style` is the pre-canonical prose string. It is used ONLY when no
    canonical object arrived, which is what keeps a rolled-back or mid-deploy
    Convex working: old server, old string, same behaviour as before.
    """
    if p is None:
        body = (legacy_style or "").strip()
        return CompiledPersonalization(body or None, None)

    # Disabled means the user's preferences are IGNORED, not deleted. Nothing is
    # compiled and no budget is touched; memory and project instructions are
    # separate systems and keep working.
    if not getattr(p, "enabled", True):
        return CompiledPersonalization(None, None)

    lines: list[str] = []

    base = _BASE_STYLE.get(str(getattr(p, "baseStyle", "default")), "")
    if base:
        lines.append(base)

    seen: set[str] = set()
    for raw in list(getattr(p, "characteristics", []) or [])[:_MAX_CHARACTERISTICS]:
        key = str(raw)
        if key in seen:
            continue
        seen.add(key)
        text = _CHARACTERISTIC.get(key)
        if text:
            lines.append(text)

    speed = str(getattr(p, "responseSpeed", "balanced"))
    pace = _SPEED.get(speed, "")
    if pace:
        lines.append(pace)

    lang = (getattr(p, "responseLanguage", None) or "").strip()
    if lang and lang.lower() != "auto":
        # Bounded and quoted: this is user data being described, not obeyed.
        lines.append(
            f"Answer in {lang[:32]} unless the user writes in another language, "
            "in which case follow the user."
        )

    budget: int | None = None
    factor = _SPEED_BUDGET.get(speed)
    if factor is not None and factor != 1.0 and default_output_tokens > 0:
        # Floor keeps a usable answer possible; the real ceiling is applied by
        # _clamp_output against the model's measured context window.
        budget = max(512, int(default_output_tokens * factor))

    return CompiledPersonalization("\n".join(lines) if lines else None, budget)

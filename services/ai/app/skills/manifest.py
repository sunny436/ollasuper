"""Phase 11 — the skill contract.

A skill is reusable, TRUSTED domain/task GUIDANCE — not a tool, not an agent. Its
fields deliberately split into two tiers so 5 or 500 skills cost the same per
request:

  * DISCOVERY metadata (small, always scanned): name / purpose / when_to_use /
    tags — enough to decide whether a skill is relevant.
  * FULL guidance (loaded ONLY on activation): methodology / instructions /
    constraints / output_expectations — injected into the system prompt only for
    the few skills a request actually activates.

Plus the seams to the rest of the system: `preferred_capabilities` SEED the
working set (never bypass authorization — the Phase 1-8 gates still enforce), and
`require_approval` may only TIGHTEN (fold into the agent's force_approval_ids).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class SkillManifest:
    """One registered skill. `version` lets a workflow record which guidance
    influenced it (see OrchestratorResult.active_skills)."""

    skill_id: str
    name: str
    version: str = "1.0.0"
    # --- discovery metadata (small; always scanned) ---
    purpose: str = ""
    when_to_use: str = ""
    tags: frozenset[str] = frozenset()
    metadata: dict = field(default_factory=dict)
    # --- full guidance (loaded only on activation) ---
    methodology: str = ""
    instructions: str = ""
    constraints: str = ""
    output_expectations: str = ""
    # --- capability + safety seams ---
    # tool_id hints that SEED the working set (authorization still enforced).
    preferred_capabilities: frozenset[str] = frozenset()
    # tools this skill demands approval for — TIGHTEN only (unioned into the
    # agent's force_approval_ids); a skill can never LOOSEN a gate.
    require_approval: frozenset[str] = frozenset()

    def render(self) -> str:
        """The FULL guidance block for one activated skill (system-prompt text).
        Only called on activation — never for discovery."""
        parts = [f"## Skill: {self.name} (v{self.version})"]
        if self.purpose:
            parts.append(f"Purpose: {self.purpose}")
        if self.methodology:
            parts.append(f"Methodology: {self.methodology}")
        if self.instructions:
            parts.append(f"Instructions: {self.instructions}")
        if self.constraints:
            parts.append(f"Constraints: {self.constraints}")
        if self.output_expectations:
            parts.append(f"Output expectations: {self.output_expectations}")
        return "\n".join(parts)

    def render_compact(self) -> str:
        """A SUPPORTING skill's contribution when the budget cannot carry it whole.

        Skill bodies are dominated by `methodology` + `instructions` — the long
        procedural text describing how to run the job. Exactly one skill can own
        the procedure for a turn, so for the rest that bulk is what gives way.

        What survives is what still composes: identity, when it applies, its
        CONSTRAINTS (the read-only ceilings, never-fabricate rules and safety
        limits — the last thing that should ever be dropped for space), and the
        shape it expects output in. Before this existed the whole skill was
        discarded, constraints included.

        Empty when none of those fields carry anything: a heading on its own is
        not guidance, and spending budget on it would displace a skill that has
        something to say.
        """
        parts = []
        if self.purpose:
            parts.append(f"Purpose: {self.purpose}")
        if self.when_to_use:
            parts.append(f"Applies when: {self.when_to_use}")
        if self.constraints:
            parts.append(f"Constraints: {self.constraints}")
        if self.output_expectations:
            parts.append(f"Output expectations: {self.output_expectations}")
        if not parts:
            return ""
        header = f"## Skill: {self.name} (v{self.version}) — supporting"
        return "\n".join([header, *parts])

    def render_minimal(self) -> str:
        """The irreducible contribution: identity plus RULES, nothing else.

        The last rung before a skill is dropped entirely. Measured on the real
        catalogue: seo-audit renders 17,617 chars and leaves 2,383 of a 20,000
        budget — too little for operations' compact form (4,316) but enough for
        its constraints (1,827). Without this rung that turn carried one skill;
        with it, it carries the second skill's rules too.

        Empty when the skill declares no constraints: there is then nothing here
        worth spending budget on, and the caller drops it instead.
        """
        if not self.constraints:
            return ""
        return (
            f"## Skill: {self.name} (v{self.version}) — supporting\n"
            f"Constraints: {self.constraints}"
        )


@dataclass(frozen=True, slots=True)
class ActiveSkill:
    """A skill selected for a request + its relevance score (score orders the
    bounded composition — highest first, whole skills dropped to fit the budget)."""

    manifest: SkillManifest
    score: float

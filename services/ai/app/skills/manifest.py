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


@dataclass(frozen=True, slots=True)
class ActiveSkill:
    """A skill selected for a request + its relevance score (score orders the
    bounded composition — highest first, whole skills dropped to fit the budget)."""

    manifest: SkillManifest
    score: float

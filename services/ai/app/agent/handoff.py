"""Bounded delegation contract (Phase 1 v2).

`AgentHandoff` is the REQUEST a parent makes to a specialist sub-agent — a typed,
validated boundary in place of two bare `(role, task)` strings. `HandoffResult`
is the bounded RESPONSE: a specialist returns structured evidence/metrics/errors,
not just raw text, so nothing is silently dropped at the delegation seam (the
Phase-0 lossy-delegation blocker) and cross-agent usage can be aggregated.

Both are Pydantic models so limits/shapes are validated, and `text` is capped.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

_TEXT_CAP = 16_000


class HandoffLimits(BaseModel):
    """Hard bounds a sub-agent runs under (never looser than the parent's)."""

    max_steps: int = Field(default=4, ge=1, le=32)
    max_tokens: int = Field(default=32_000, ge=256)
    deadline_s: float = Field(default=120.0, gt=0)


class AgentHandoff(BaseModel):
    """The delegation REQUEST. Built internally from (role, task) + the sub-agent
    spec's allowed capabilities + config limits; validated before the sub-run."""

    objective: str = Field(min_length=1)
    context: str = ""
    allowed_capabilities: list[str] = Field(default_factory=list)
    evidence_requirements: list[str] = Field(default_factory=list)
    limits: HandoffLimits = Field(default_factory=HandoffLimits)
    expected_result: str = ""
    stopping_conditions: list[str] = Field(default_factory=list)


class HandoffResult(BaseModel):
    """The bounded delegation RESPONSE — carries what the old `{ok,outcome,text}`
    dict dropped (data/metrics/error/requested_capability), text capped."""

    ok: bool = True
    outcome: str = ""
    text: str = ""
    data: dict | None = None
    metrics: dict = Field(default_factory=dict)
    error: dict | None = None
    requested_capability: str | None = None

    @classmethod
    def from_agent_result(cls, result) -> HandoffResult:
        """Build from an `AgentResult` (see app.agent.base). Import kept local to
        avoid an import cycle."""
        from app.agent.spec import AgentOutcome

        text = result.text or ""
        return cls(
            ok=result.outcome != AgentOutcome.FAILURE,
            outcome=str(result.outcome),
            text=text[:_TEXT_CAP],
            data=result.data,
            metrics=dict(result.metrics or {}),
            error=result.error,
            requested_capability=result.requested_capability,
        )

    def to_observation(self) -> dict:
        """The dict the delegate closure returns to the executor — a superset of
        the legacy `{ok,outcome,text}` shape so `_run_delegate` is unchanged."""
        return {
            "ok": self.ok,
            "outcome": self.outcome,
            "text": self.text,
            "metrics": self.metrics,
        }

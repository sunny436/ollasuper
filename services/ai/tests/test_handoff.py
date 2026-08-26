"""Phase 1 (v2) — the bounded delegation contract."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.agent.base import AgentResult
from app.agent.handoff import AgentHandoff, HandoffLimits, HandoffResult
from app.agent.spec import AgentOutcome


def test_handoff_requires_objective():
    with pytest.raises(ValidationError):
        AgentHandoff(objective="")
    h = AgentHandoff(objective="audit the homepage")
    assert h.limits.max_steps >= 1  # sensible defaults


def test_handoff_limits_bounds():
    with pytest.raises(ValidationError):
        HandoffLimits(max_steps=0)  # ge=1
    with pytest.raises(ValidationError):
        HandoffLimits(max_steps=999)  # le=32
    assert HandoffLimits(max_steps=8, max_tokens=1000, deadline_s=30.0)


def test_handoff_result_from_agent_result_carries_structured_fields():
    r = AgentResult(
        "researcher", "run1", AgentOutcome.STRUCTURED_RESULT,
        text="the findings", data={"k": "v"}, metrics={"tokens": 123},
    )
    hr = HandoffResult.from_agent_result(r)
    assert hr.ok is True
    assert hr.outcome == str(AgentOutcome.STRUCTURED_RESULT)
    assert hr.text == "the findings"
    assert hr.data == {"k": "v"}
    assert hr.metrics == {"tokens": 123}  # <- was dropped by the old {ok,outcome,text}


def test_handoff_result_failure_maps_ok_false():
    r = AgentResult("x", "run1", AgentOutcome.FAILURE, error={"code": "boom"})
    hr = HandoffResult.from_agent_result(r)
    assert hr.ok is False and hr.error == {"code": "boom"}


def test_handoff_result_text_is_capped():
    big = "x" * 100_000
    r = AgentResult("x", "run1", AgentOutcome.FINAL_ANSWER, text=big)
    hr = HandoffResult.from_agent_result(r)
    assert len(hr.text) < len(big)  # bounded


def test_handoff_result_observation_is_legacy_superset():
    r = AgentResult(
        "x", "run1", AgentOutcome.FINAL_ANSWER, text="ok", metrics={"tokens": 5}
    )
    obs = HandoffResult.from_agent_result(r).to_observation()
    # _run_delegate still reads ok/outcome/text; metrics is the new addition.
    assert set(obs) >= {"ok", "outcome", "text"}
    assert obs["metrics"] == {"tokens": 5}

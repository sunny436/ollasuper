"""Skill-turn quality: the answer standard and skill-only deeper reasoning.

Driven through the REAL run_generation (only the provider clients are fakes), so
what is asserted is what the model is actually sent.
"""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from app.agent.llm import build_llm
from app.models.chat import ModelCandidate
from app.runtime.runner import _skill_reasoning_effort, run_generation
from app.skills.answer_standard import ANSWER_STANDARD
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.test_agent_runner import RecordingConvex, _ok_http, _read_tool
from tests.test_capability_parity import Model, Rec, _req, _routed_settings
from tests.test_user_skills import _install, _live_req, _live_settings, _prompt, _skill

DEEP = "gemini-3.8-flash-high"  # the one model probed to honour reasoning_effort
FAST = "gemini-3.7-flash-high"
SKILL_PROMPT = (
    "Research and compare the evidence from multiple independent sources on "
    "whether a four-day work week raises productivity, and verify the key claims"
)
PLAIN_PROMPT = "What is a mutex?"


async def _run(monkeypatch, prompt: str, model: str = DEEP, **over) -> dict:
    rec = Rec(lambda m, s, n: AIMessage(content="done"))
    efforts: dict[str, set] = {}

    def fake_build_llm(*a, model, streaming=True, reasoning_effort=None, **k):
        efforts.setdefault(model, set()).add(reasoning_effort)
        return Model(rec, model, streaming)

    monkeypatch.setattr("app.runtime.runner.build_llm", fake_build_llm)
    reg = ToolRegistry()
    reg.register(_read_tool())
    http = _ok_http()
    try:
        await run_generation(
            _req(prompt, [ModelCandidate(id=model, contextWindow=0)]),
            _routed_settings(ai_orchestrated_runtime_enabled=True, **over),
            RecordingConvex(),
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    system = "".join(
        str(m.content) for m in rec.first_messages or [] if isinstance(m, SystemMessage)
    )
    return {"system": system, "efforts": efforts.get(model, set())}


# --- the answer standard -----------------------------------------------------
async def test_a_skill_turn_carries_the_answer_standard_once(monkeypatch):
    out = await _run(monkeypatch, SKILL_PROMPT)
    assert "<skill_guidance>" in out["system"], "the research skill never activated"
    assert out["system"].count(ANSWER_STANDARD) == 1
    # After the skill, so the skill's own format is stated first and wins.
    assert out["system"].index("<skill_guidance>") < out["system"].index(
        ANSWER_STANDARD
    )


async def test_a_plain_turn_is_untouched(monkeypatch):
    out = await _run(monkeypatch, PLAIN_PROMPT)
    assert "<skill_guidance>" not in out["system"]
    assert "<answer_standard>" not in out["system"]


async def test_the_answer_standard_has_its_own_switch(monkeypatch):
    out = await _run(monkeypatch, SKILL_PROMPT, ai_skill_answer_standard_enabled=False)
    assert "<skill_guidance>" in out["system"]
    assert "<answer_standard>" not in out["system"]


async def test_a_users_own_skill_also_gets_the_standard(monkeypatch):
    llms = _install(monkeypatch)
    await run_generation(_live_req([_skill()]), _live_settings(), RecordingConvex())
    assert _prompt(llms).count("<answer_standard>") == 1


# --- deeper reasoning: skill turns, allowlisted models, flag on ---------------
async def test_reasoning_is_off_by_default(monkeypatch):
    out = await _run(monkeypatch, SKILL_PROMPT)
    assert out["efforts"] == {None}


async def test_a_skill_turn_on_an_allowlisted_model_reasons_deeper(monkeypatch):
    out = await _run(monkeypatch, SKILL_PROMPT, ai_skill_reasoning_effort="high")
    # Both the streaming client and its non-streaming tool-call twin.
    assert out["efforts"] == {"high"}


async def test_a_plain_turn_never_reasons_deeper(monkeypatch):
    out = await _run(monkeypatch, PLAIN_PROMPT, ai_skill_reasoning_effort="high")
    assert out["efforts"] == {None}


async def test_a_model_off_the_allowlist_never_reasons_deeper(monkeypatch):
    # deepseek spent a 1,500-token budget entirely on reasoning and answered
    # nothing; gemini-3.7 barely changed. Only the probed model is listed.
    out = await _run(
        monkeypatch, SKILL_PROMPT, model=FAST, ai_skill_reasoning_effort="high"
    )
    assert out["efforts"] == {None}


def test_a_custom_skill_counts_as_a_skill_turn():
    s = _routed_settings(ai_skill_reasoning_effort="high")
    assert _skill_reasoning_effort(s, DEEP, PLAIN_PROMPT, user_skill=True) == "high"
    assert _skill_reasoning_effort(s, DEEP, PLAIN_PROMPT, user_skill=False) is None
    assert _skill_reasoning_effort(s, FAST, PLAIN_PROMPT, user_skill=True) is None


def test_build_llm_sends_reasoning_effort_only_when_asked():
    s = _routed_settings()
    msgs = [HumanMessage(content="hi")]
    deep = build_llm(
        s, model=DEEP, reasoning_effort="high", api_key="k", base_url="http://x"
    )
    plain = build_llm(s, model=DEEP, api_key="k", base_url="http://x")
    assert deep._get_request_payload(msgs)["reasoning_effort"] == "high"
    assert "reasoning_effort" not in plain._get_request_payload(msgs)

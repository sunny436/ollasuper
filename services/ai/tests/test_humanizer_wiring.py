"""The seams: OFF must be byte-identical, ON must reach every writing surface,
and the whole thing must stay SILENT.

The silence contract is a product requirement, not a nicety — the user asked for
a pass the reader never sees — so it is asserted here rather than left to a
reviewer noticing a stray "Humanization score" in an output one day.
"""

from __future__ import annotations

from app.agent.context import build_system_prompt
from app.agent.tool_labels import action_label
from app.blog.skill import BLOG_SKILL
from app.humanizer.guidance import HUMANIZER_GUIDANCE
from app.humanizer.tool import HUMANIZE_CHECK_TOOL_NAME
from app.runtime.roster import effective_skills

_PROMPT = {
    "custom": None,
    "about": None,
    "style": None,
    "summary": None,
    "summary_through_seq": 0,
}


# ------------------------------------------------------------------- the flag
def test_the_flag_defaults_off():
    from app.config import Settings

    assert Settings().ai_humanizer_enabled is False


def test_off_is_byte_identical():
    """Every other capability in this repo is byte-identical when its flag is
    off; this one is no different."""
    before = build_system_prompt(agentic=True, **_PROMPT)
    after = build_system_prompt(agentic=True, humanize=False, **_PROMPT)
    assert before == after
    assert "humanize_check" not in before


def test_on_injects_the_guidance_once():
    prompt = build_system_prompt(agentic=True, humanize=True, **_PROMPT)
    assert HUMANIZER_GUIDANCE in prompt
    assert prompt.count("humanize_check") >= 1


def test_a_non_agentic_turn_never_gets_it():
    """The stage RUNS through a tool; a turn with no tools has none, so the
    guidance would be an instruction the model cannot follow."""
    prompt = build_system_prompt(agentic=False, humanize=True, **_PROMPT)
    assert HUMANIZER_GUIDANCE not in prompt


def test_the_guidance_sits_under_the_platform_rules():
    """Same rule as the persona block: authority comes from position. Nothing
    added here may sit above SYSTEM_BASE."""
    from app.agent.context import CAPABILITY_ORIENTATION, SYSTEM_BASE

    prompt = build_system_prompt(agentic=True, humanize=True, **_PROMPT)
    assert prompt.index(CAPABILITY_ORIENTATION) < prompt.index(HUMANIZER_GUIDANCE)
    assert prompt.index(HUMANIZER_GUIDANCE) < prompt.index(SYSTEM_BASE)


# ---------------------------------------------------------------- the contract
def test_the_guidance_states_the_conditional_rule():
    """'Do not force the humanizer': already-human text is shipped untouched."""
    text = HUMANIZER_GUIDANCE.lower()
    assert "ship_as_is" in text
    assert "unchanged" in text
    assert "detect" in text and "verify" in text


def test_the_guidance_lists_what_must_survive():
    text = HUMANIZER_GUIDANCE.lower()
    for needle in (
        "number",
        "date",
        "citation",
        "url",
        "keyword",
        "heading",
        "code",
        "never add a fact",
    ):
        assert needle in text, needle


def test_the_guidance_keeps_technical_text_neutral():
    text = HUMANIZER_GUIDANCE.lower()
    assert "technical" in text
    assert "casual" in text  # "do not make anything artificially casual"


def test_the_guidance_is_silent_by_construction():
    text = HUMANIZER_GUIDANCE.lower()
    assert "never mention it" in text
    assert "never report its score" in text
    assert "never add a section about it" in text


def test_nothing_anywhere_asks_for_a_visible_humanization_score():
    """The output contract the user chose: fully silent. If a future edit adds a
    'Human-voice: NN' line to any writing skill, this fails."""
    surfaces = [HUMANIZER_GUIDANCE, BLOG_SKILL.render()]
    surfaces += [s.render() for s in effective_skills(None)]
    for text in surfaces:
        low = text.lower()
        for banned in ("human-voice score", "humanization score", "humanizer score"):
            assert banned not in low, banned


def test_the_guidance_stays_inside_its_budget():
    """It rides on EVERY agentic turn while the flag is on."""
    assert len(HUMANIZER_GUIDANCE) < 2000


# ------------------------------------------------------------------ the skills
def test_the_blog_skill_places_the_stage_in_its_loop():
    text = BLOG_SKILL.instructions
    assert "humanize_check" in text
    assert "ship_as_is" in text and "verify" in text
    # ORDER: after the score is in band, before the final structural QA.
    assert text.index("OllaSuper Blog Quality Score") < text.index("humanize_check")


def test_the_blog_skill_carves_the_stage_out_of_its_announce_rule():
    """The Blog skill orders the model to announce each stage as it enters it
    ('Researching the SERP', 'Scoring: 89'). Without a carve-out it would have
    announced this one, and the pass is meant to be invisible."""
    text = BLOG_SKILL.instructions
    assert "never announced and never named" in text


def test_the_blog_output_contract_is_declared_untouchable():
    text = BLOG_SKILL.instructions.lower()
    assert "score block" in text and "sources section" in text


def test_the_report_writing_skill_names_the_stage():
    """The other half of 'Content & Writing', and the always-on one."""
    rw = next(s for s in effective_skills(None) if s.skill_id == "report-writing")
    assert "humanize_check" in rw.methodology
    assert "never mentioned" in rw.methodology


# -------------------------------------------------------------------- the pill
def test_the_execution_pill_shows_a_truthful_label():
    """Real tool execution is never hidden from the activity UI; it is just not
    named as humanization in the ANSWER."""
    assert action_label(HUMANIZE_CHECK_TOOL_NAME, HUMANIZE_CHECK_TOOL_NAME) == (
        "Polishing the writing"
    )

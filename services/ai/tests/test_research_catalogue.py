"""Deep Research — catalogue integrity, distinct-from-SEO/Blog registration, the
OPTIONAL trigger routing (simple → NOT surfaced; genuine research → surfaced),
composition, and the skill honesty/render guards. Hermetic; no network, no Convex."""

from __future__ import annotations

import re

from app.blog.capabilities import blog_intent_map
from app.models.tools import SideEffect
from app.research.capabilities import (
    RESEARCH_CAPABILITIES,
    RESEARCH_TOOL_IDS,
    capability_summary,
    research_intent_map,
)
from app.research.skill import RESEARCH_SKILL
from app.runtime.roster import (
    PRODUCTION_SKILLS,
    build_live_runtime,
    effective_skills,
)
from app.seo.capabilities import seo_intent_map
from app.skills.registry import SkillRegistry, render_skills_block
from tests.conftest import make_settings

# op_ids verified against the live /v1/tools OpenAPI snapshot (2026-08-28). Pinned so
# a typo or silent drift is caught hermetically — no invented endpoints.
_VERIFIED = {
    "search_endpoint_v1_search_post",
    "scrape_endpoint_v1_scrape_post",
    "scrape_llm_ready_endpoint_v1_scrape_llm_ready_post",
    "extract_clean_endpoint_v1_extract_clean_post",
    "batch_scrape_endpoint_v1_scrape_batch_post",
    "extract_structured_endpoint_v1_extract_structured_post",
    "crawl_endpoint_v1_crawl_post",
    "text_similarity_endpoint_v1_text_similarity_post",
    "text_diff_endpoint_v1_text_diff_post",
    "text_chunk_endpoint_v1_text_chunk_post",
    "aeo_freshness_signal_endpoint_v1_aeo_freshness_signal_post",
}


def _on(**extra):
    return make_settings("http://x", ai_research_enabled=True, **extra)


# --- catalogue integrity ---------------------------------------------------
def test_every_capability_is_well_formed():
    for c in RESEARCH_CAPABILITIES:
        assert c.intent.startswith("research."), c.intent
        assert c.description.strip() and c.query.strip(), c.intent
        assert c.tool_ids, c.intent
        assert c.side_effect is SideEffect.READ_ONLY, c.intent  # read-only end to end


def test_no_invented_endpoints():
    assert RESEARCH_TOOL_IDS <= _VERIFIED, RESEARCH_TOOL_IDS - _VERIFIED
    for tid in RESEARCH_TOOL_IDS:
        assert re.fullmatch(r"[a-z0-9_]+_post", tid), tid


def test_intent_map_covers_every_capability_and_is_read_only():
    m = research_intent_map()
    assert set(m) == {c.intent for c in RESEARCH_CAPABILITIES}
    for intent, spec in m.items():
        assert spec["query"].strip()
        assert spec["max_side_effect"].value == "read_only", intent


def test_research_intents_never_collide_with_seo_or_blog():
    # Distinct `research.*` keys — enabling all flags must not clobber any map.
    r = set(research_intent_map())
    assert r & set(seo_intent_map()) == set()
    assert r & set(blog_intent_map()) == set()


def test_capability_summary_lists_intents():
    s = capability_summary()
    assert s.strip() and "research.web_search" in s and "research.compare" in s


# --- skill honesty + render guard ------------------------------------------
def test_skill_encodes_the_non_negotiable_rules():
    low = (
        RESEARCH_SKILL.methodology
        + RESEARCH_SKILL.instructions
        + RESEARCH_SKILL.constraints
        + RESEARCH_SKILL.output_expectations
    ).lower()
    assert "never fabricate" in low  # no invented sources/claims/support
    assert "answer directly" in low  # the STEP-0 self-gate (optional-not-default)
    assert "research_reason" in low  # H1 — recorded trigger reason
    assert "provenance" in low  # claim → source attribution
    assert "freshness" in low  # H3 — current-data policy
    assert "citation verification" in low  # H2 — claim → source support check
    assert "conflict" in low and "gap" in low  # conflict + gap handling
    assert "safety budget" in low  # H4 — hard ceilings
    assert "untrusted" in low  # scraped content is untrusted data
    assert "record_research" in low  # the durable-checkpoint discipline


def test_activated_research_skill_is_not_truncated():
    settings = _on()
    budget = settings.ai_skill_instructions_budget_chars
    reg = SkillRegistry(effective_skills(settings))
    active = reg.discover(
        "research and compare the top competitors in the market with evidence"
    )
    assert active and active[0].manifest.skill_id == "deep-research"
    block = render_skills_block(active, char_budget=budget)
    # A methodology marker AND an output-tail marker both survive → no truncation.
    assert "citation verification" in block.lower()
    assert "conflicts, uncertainties" in block.lower()
    assert len(RESEARCH_SKILL.render()) <= budget - 1000


# --- OPTIONAL trigger routing (the core "not-default" property) -------------
def test_flag_off_research_skill_never_activates():
    off = make_settings("http://x", ai_research_enabled=False)
    assert effective_skills(off) == list(PRODUCTION_SKILLS)
    reg = SkillRegistry(effective_skills(off))
    top = reg.discover("research and compare the best CRMs for a startup")
    assert "deep-research" not in {a.manifest.skill_id for a in top}


def test_simple_requests_do_not_trigger_deep_research():
    reg = SkillRegistry(effective_skills(_on()))
    for q in (
        "what is the capital of France",
        "write a haiku about the sea",
        "reverse this string: hello world",
        "add 2 and 2",
        "translate 'good morning' to Spanish",
    ):
        ids = {a.manifest.skill_id for a in reg.discover(q)}
        assert "deep-research" not in ids, q


def test_genuine_research_requests_trigger_deep_research():
    reg = SkillRegistry(effective_skills(_on()))
    for q in (
        "research and compare the top competitors in the CRM market and "
        "evaluate their pricing",
        "do due diligence on this vendor and benchmark the alternatives",
        "investigate the market landscape and compare the leading options with "
        "evidence",
    ):
        top = reg.discover(q)
        assert top and top[0].manifest.skill_id == "deep-research", q


def test_research_and_blog_compose_when_both_enabled():
    # A research-then-write request co-activates BOTH skills (composition).
    reg = SkillRegistry(effective_skills(_on(ai_blog_enabled=True)))
    ids = {
        a.manifest.skill_id
        for a in reg.discover(
            "research the market and compare the top competitors, then write a "
            "blog post about the findings"
        )
    }
    assert "deep-research" in ids and "blog-assist" in ids


def test_all_three_skills_coexist_independently():
    settings = _on(ai_blog_enabled=True, ai_seo_enabled=True)
    reg = SkillRegistry(effective_skills(settings))
    research_top = reg.discover(
        "research and compare the top competitors in the market and evaluate the "
        "alternatives"
    )
    blog_top = reg.discover("write a blog post about kubernetes")
    seo_top = reg.discover("audit the technical SEO of example.com robots canonical")
    assert research_top and research_top[0].manifest.skill_id == "deep-research"
    assert blog_top and blog_top[0].manifest.skill_id == "blog-assist"
    assert seo_top and seo_top[0].manifest.skill_id == "seo-audit"


def test_build_live_runtime_registers_research_intents_when_on():
    from app.orchestrator.capabilities import CapabilityResolver
    from app.orchestrator.intents import is_intent
    from app.tools.registry import ToolRegistry
    from app.tools.selection import ToolSelector

    reg = ToolRegistry()
    resolver = CapabilityResolver(reg, ToolSelector(reg))
    _orch, skill_reg = build_live_runtime(_on(), resolver)
    assert skill_reg.get("deep-research") is not None
    assert is_intent("research.web_search") and is_intent("research.compare")

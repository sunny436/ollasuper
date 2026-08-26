"""Phase 1 (v2) — the shared preparation path.

Proves `Orchestrator.prepare` returns a validated `PreparedRun`: skills activate
UNCONDITIONALLY (no tool dependency), capabilities seed from intents/ids, gaps are
reported honestly, readiness is carried, and the route hint reflects the tool signal.
All in-process — prepare() needs no LLM.
"""

from __future__ import annotations

from app.orchestrator.prepare import PreparedRun, ProviderReadiness, RouteHint
from app.skills.registry import SkillRegistry
from app.tools.registry import ToolRegistry
from tests.test_orchestrator import _registry, _web_tools
from tests.test_skills import _orch, _skill


def test_prepare_knowledge_only_when_no_candidates():
    # No skills, a query that matches no tool -> KNOWLEDGE_ONLY, empty everything.
    orch = _orch(_registry(_web_tools()), SkillRegistry([]))
    p = orch.prepare("zzzzz qqqqq unmatched gibberish")
    assert isinstance(p, PreparedRun)
    assert p.candidates == ()
    assert p.active_skills == ()
    assert p.route_hint == RouteHint.KNOWLEDGE_ONLY


def test_prepare_interactive_tools_when_candidates_match():
    orch = _orch(_registry(_web_tools()), SkillRegistry([]))
    p = orch.prepare("search the web for cats")
    assert p.candidates  # a tool matched
    assert p.route_hint == RouteHint.INTERACTIVE_TOOLS


def test_prepare_activates_skill_unconditionally_without_tools():
    # Ollagraph off => EMPTY tool registry; a knowledge skill still activates.
    empty = ToolRegistry()
    skreg = SkillRegistry(
        [_skill("seo", "SEO Audit", tags=["seo", "audit"], instructions="Do SEO.")]
    )
    orch = _orch(empty, skreg)
    p = orch.prepare("please do an seo audit")
    assert [a.manifest.skill_id for a in p.active_skills] == ["seo"]
    assert "<skill_guidance>" in p.rendered_skills and "Do SEO." in p.rendered_skills
    # No tools exist, so route stays KNOWLEDGE_ONLY but the skill is live.
    assert p.route_hint == RouteHint.KNOWLEDGE_ONLY


def test_prepare_skill_intent_resolves_via_intent_map():
    # A skill declaring the `page.fetch` INTENT seeds the scrape tool.
    reg = _registry(_web_tools())
    skreg = SkillRegistry(
        [_skill("fetcher", "Fetcher", tags=["fetch"], caps=["page.fetch"])]
    )
    orch = _orch(reg, skreg)
    p = orch.prepare("fetch a page")
    tool_ids = {c.tool.tool_id for c in p.candidates}
    assert "scrape_page" in tool_ids  # intent -> scrape tool
    assert p.capability_gaps == ()  # the intent resolved


def test_prepare_reports_capability_gap_for_unknown_id():
    reg = _registry(_web_tools())
    skreg = SkillRegistry(
        [_skill("x", "X", tags=["seo"], caps=["nonexistent_tool_id"])]
    )
    orch = _orch(reg, skreg)
    p = orch.prepare("do an seo thing")
    gaps = {(g.intent_or_id, g.reason) for g in p.capability_gaps}
    assert ("nonexistent_tool_id", "no_tool") in gaps


def test_prepare_carries_readiness():
    orch = _orch(_registry(_web_tools()), SkillRegistry([]))
    ready = (ProviderReadiness("ollagraph", available=True, user_ready=True),)
    p = orch.prepare("search cats", readiness=ready)
    assert p.readiness == ready


def test_prepare_folds_skill_require_approval():
    reg = _registry(_web_tools())
    skreg = SkillRegistry(
        [_skill("s", "S", tags=["seo"], approvals=["scrape_page"])]
    )
    p = _orch(reg, skreg).prepare("seo audit please")
    assert "scrape_page" in p.force_approval_ids

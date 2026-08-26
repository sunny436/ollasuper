"""Phase 2 (SEO) — the read-only SEO agent's HARD capability scope, enforced at
all three Group-1 seams: bind (`_select_candidates`), discovery
(`_run_find_capabilities`) and execution (`check_tool_policy`). The safety property:
the SEO agent may reach every read-only SEO tool but can NEVER reach an AEO /
account / automation / actor tool, nor an Intelligence tool that is not explicitly
allowlisted — even if it discovers one via find_capabilities. Existing agents (no
category scope) are byte-identical.
"""

from __future__ import annotations

import pytest

from app.agent.base import Agent
from app.agent.executor import ToolExecContext, _run_find_capabilities
from app.agent.policy import check_tool_policy
from app.models.tools import SideEffect, ToolCandidate
from app.orchestrator.capabilities import CapabilityResolver
from app.runtime.roster import PRODUCTION_AGENTS
from app.runtime.writer import DeltaWriter
from app.seo.agent import SEO_AGENT
from app.seo.capabilities import ALLOWED_CATEGORIES, ALLOWED_TOOL_IDS
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.conftest import make_settings
from tests.fakes.seo_tools import (
    adversarial_tools,
    mixed_registry,
    seo_catalogue_tools,
)
from tests.test_writer_events import RecordingConvex

pytestmark = pytest.mark.anyio

_RESEARCH = next(a for a in PRODUCTION_AGENTS if a.agent_id == "research")


# --- execution gate (check_tool_policy) -----------------------------------
def test_seo_scope_admits_every_catalogue_tool():
    """Allowlist COMPLETENESS: every tool the SEO catalogue references is admitted
    (a forgotten intel/search/text id in ALLOWED_TOOL_IDS would fail here)."""
    scope = Agent.build_scope(SEO_AGENT)
    for tool in seo_catalogue_tools():
        assert check_tool_policy(tool, scope).allowed, tool.tool_id


def test_seo_scope_denies_every_adversarial_tool():
    scope = Agent.build_scope(SEO_AGENT)
    for tool in adversarial_tools():
        res = check_tool_policy(tool, scope)
        assert res.denied, f"{tool.tool_id} was not denied ({res.decision})"


def test_intelligence_category_not_admitted_wholesale():
    """intel_robots (allowlisted id) is in; intel_whois (same category, not
    allowlisted) is out — the category is never admitted as a whole."""
    scope = Agent.build_scope(SEO_AGENT)
    tools = {t.tool_id: t for t in mixed_registry().list()}
    allowed_intel = "intel_robots_endpoint_v1_intel_robots_post"
    denied_intel = "intel_whois_endpoint_v1_intel_whois_post"
    assert check_tool_policy(tools[allowed_intel], scope).allowed
    assert check_tool_policy(tools[denied_intel], scope).denied


def test_scope_denial_precedes_side_effect_ceiling():
    """An out-of-scope tool is denied for being out of scope, not merely parked for
    approval — the DENY fires before the side-effect ceiling."""
    scope = Agent.build_scope(SEO_AGENT)
    session = next(
        t for t in adversarial_tools() if t.tool_id.startswith("create_session")
    )
    res = check_tool_policy(session, scope)
    assert res.denied and "scope" in res.reason.lower()


# --- bind gate (_select_candidates) ---------------------------------------
def _cands(tools) -> list[ToolCandidate]:
    return [ToolCandidate(tool=t, score=1.0) for t in tools]


def test_select_candidates_keeps_only_in_scope():
    reg = mixed_registry()
    selected = Agent._select_candidates(SEO_AGENT, _cands(reg.list()))
    ids = {c.tool.tool_id for c in selected}
    for t in seo_catalogue_tools():
        assert t.tool_id in ids, t.tool_id
    for t in adversarial_tools():
        assert t.tool_id not in ids, t.tool_id


# --- discovery gate (_run_find_capabilities) ------------------------------
def _seo_ctx(reg: ToolRegistry) -> tuple[ToolExecContext, RecordingConvex]:
    convex = RecordingConvex()
    settings = make_settings("http://x")
    writer = DeltaWriter(convex, "s1", settings)
    resolver = CapabilityResolver(reg, ToolSelector(reg))
    ctx = ToolExecContext(
        registry=reg,
        adapter=None,
        writer=writer,
        scope=Agent.build_scope(SEO_AGENT),
        name_to_tool_id={},
        result_max_chars=8000,
        default_timeout_s=30.0,
        capabilities=resolver,
        pending_capabilities=[],
    )
    return ctx, convex


async def test_find_capabilities_cannot_surface_out_of_scope_tool():
    """Even when an AEO tool lexically matches the query, discovery must NOT load or
    list it for the SEO scope (the Group-1 discovery post-filter)."""
    reg = mixed_registry()
    ctx, _ = _seo_ctx(reg)
    msg = await _run_find_capabilities(
        ctx, "c1", {"query": "heading hierarchy structured data schema"}
    )
    # Nothing out-of-scope was loaded into the strict allowlist (so nothing
    # out-of-scope is callable)...
    loaded = set(ctx.name_to_tool_id.values())
    for t in adversarial_tools():
        assert t.tool_id not in loaded, t.tool_id
    # ...and none even appears in the (injection-framed) discovery result text.
    content = msg.content if isinstance(msg.content, str) else ""
    for t in adversarial_tools():
        assert t.tool_id not in content, t.tool_id


async def test_find_capabilities_still_surfaces_in_scope_seo_tool():
    reg = mixed_registry()
    ctx, _ = _seo_ctx(reg)
    await _run_find_capabilities(
        ctx, "c1", {"query": "robots.txt crawler access rules"}
    )
    loaded = set(ctx.name_to_tool_id.values())
    assert "intel_robots_endpoint_v1_intel_robots_post" in loaded


# --- existing agents are byte-identical (no category scope) ----------------
def test_unrestricted_agent_scope_is_unchanged():
    """A research agent (categories=None, tool_ids=None) still admits any read-only
    tool and only parks a side-effecting one for approval — the scope gate is a
    no-op for it."""
    scope = Agent.build_scope(_RESEARCH)
    assert scope.allowed_categories is None and scope.allowed_tool_ids is None
    # A read-only tool from ANY category is allowed (no scope restriction).
    aeo = next(t for t in adversarial_tools() if t.tool_id.startswith("aeo_"))
    assert check_tool_policy(aeo, scope).allowed
    # A side-effecting tool is parked for approval (ceiling), NOT scope-denied.
    session = next(
        t for t in adversarial_tools() if t.tool_id.startswith("create_session")
    )
    res = check_tool_policy(session, scope)
    assert res.needs_approval and not res.denied


def test_seo_agent_is_read_only():
    assert SEO_AGENT.capability.side_effects_allowed is False
    # No SEO catalogue tool is side-effecting in the fixture (read-only by design).
    assert all(
        t.side_effect is SideEffect.READ_ONLY for t in seo_catalogue_tools()
    )


def test_allowlist_disjoint_from_adversarial():
    adv_ids = {t.tool_id for t in adversarial_tools()}
    adv_cats = {t.category for t in adversarial_tools()}
    assert ALLOWED_TOOL_IDS.isdisjoint(adv_ids)
    assert ALLOWED_CATEGORIES.isdisjoint(adv_cats)

"""Hermetic fake tool registry for the SEO Phase-2 tests (no network, no live
spec). It mirrors the Phase-0 OllaGraph catalogue: every tool_id referenced by
`SEO_CAPABILITIES` is materialised with the category its endpoint family carries
in the live OpenAPI (Intelligence / SEO / Scraping / Crawling / Extraction /
Other), PLUS adversarial NON-SEO tools the SEO agent must never reach — including
an Intelligence tool that is NOT on the explicit allowlist, to prove the
Intelligence category is not admitted wholesale.
"""

from __future__ import annotations

from app.models.tools import (
    Availability,
    SideEffect,
    ToolDefinition,
    ToolPermissions,
)
from app.seo.capabilities import SEO_CAPABILITIES
from app.tools.registry import ToolRegistry


def category_for(tool_id: str) -> str:
    """The OpenAPI-tag category an endpoint family carries in the live catalogue —
    derived from the id INDEPENDENTLY of the SEO allowlist, so a completeness test
    over it is meaningful rather than circular."""
    if tool_id.startswith("intel_"):
        return "Intelligence"
    if tool_id.startswith("seo_"):
        return "SEO"
    if tool_id.startswith(("scrape_", "smart_scrape", "batch_scrape")):
        return "Scraping"
    if tool_id.startswith("crawl_"):
        return "Crawling"
    if tool_id.startswith("extract_"):
        return "Extraction"
    # search_* and text_* live under the catch-all "Other" tag.
    return "Other"


def _tool(
    tool_id: str,
    category: str,
    *,
    side_effect: SideEffect = SideEffect.READ_ONLY,
    enabled: bool = True,
    availability: Availability = Availability.AVAILABLE,
    permissions: ToolPermissions | None = None,
) -> ToolDefinition:
    return ToolDefinition(
        tool_id=tool_id,
        name=tool_id,
        path="/v1/" + tool_id.split("_endpoint_")[0].replace("_", "/"),
        category=category,
        description=f"{category} tool {tool_id}",
        method="post",
        side_effect=side_effect,
        enabled=enabled,
        availability=availability,
        permissions=permissions or ToolPermissions(),
    )


def seo_catalogue_tools() -> list[ToolDefinition]:
    """One ToolDefinition per distinct tool_id the SEO catalogue references."""
    seen: set[str] = set()
    out: list[ToolDefinition] = []
    for cap in SEO_CAPABILITIES:
        for tid in cap.tool_ids:
            if tid in seen:
                continue
            seen.add(tid)
            out.append(_tool(tid, category_for(tid)))
    return out


def adversarial_tools() -> list[ToolDefinition]:
    """NON-SEO tools that MUST be denied to the read-only SEO agent's scope."""
    return [
        # AEO — a sibling domain deliberately kept OUT of the SEO skill.
        _tool(
            "aeo_heading_hierarchy_score_endpoint_v1_aeo_heading_hierarchy_score_post",
            "AEO",
        ),
        _tool("aeo_schema_coverage_endpoint_v1_aeo_schema_coverage_post", "AEO"),
        # An Intelligence tool NOT on the explicit allowlist — proves Intelligence
        # is admitted only by named tool_id, never wholesale by category.
        _tool("intel_whois_endpoint_v1_intel_whois_post", "Intelligence"),
        # A high-impact Account tool — enabled here to prove the CATEGORY scope
        # denies it even if it were reachable (the live one is also enabled=False).
        _tool(
            "create_key_endpoint_v1_keys_post",
            "Account",
            side_effect=SideEffect.HIGH_IMPACT,
            permissions=ToolPermissions(approval_required=True, user_scope=True),
        ),
        # An external side-effect automation tool.
        _tool(
            "create_session_endpoint_v1_session_post",
            "Automation",
            side_effect=SideEffect.EXTERNAL_SIDE_EFFECT,
        ),
        # A read-only Actors tool — wrong domain, must still be denied.
        _tool("actor_run_endpoint_v1_actors_run_post", "Actors"),
        # An unrelated "Other" tool — proves Other is admitted only by named id.
        _tool("legacy_scrape_endpoint_v1_legacy_scrape_post", "Other"),
    ]


def mixed_registry() -> ToolRegistry:
    reg = ToolRegistry()
    reg.replace_all([*seo_catalogue_tools(), *adversarial_tools()])
    return reg

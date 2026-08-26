"""Capability intents — a thin, stable naming layer OVER the existing tool
metadata, so a skill/agent references `page.fetch` rather than an unstable
provider tool_id. An intent decomposes into (a) a canonical selector query and
(b) an optional side-effect ceiling — both already understood by the deterministic
`ToolSelector`/`CapabilityResolver`. No 147-tool taxonomy and no new required
`ToolDefinition` field: intents resolve through the same `select` seam that
`ai_agent_core_capability_queries` already uses.

Dormant until a skill/agent declares intents (all current skills declare none).
"""

from __future__ import annotations

from app.models.tools import SideEffect

# intent -> {query, max_side_effect?}. The `.read` vs `.run`/`.render` suffix maps
# to the side-effect ceiling; the verb/noun maps to a canonical query.
INTENT_MAP: dict[str, dict] = {
    "page.fetch": {"query": "fetch scrape page content"},
    "page.render": {
        "query": "render page browser session",
        "max_side_effect": SideEffect.EXTERNAL_SIDE_EFFECT,
    },
    "crawl.run": {
        "query": "crawl website discover pages",
        "max_side_effect": SideEffect.EXTERNAL_SIDE_EFFECT,
    },
    "search_performance.read": {"query": "search seo performance analytics"},
}


def register_intents(mapping: dict[str, dict]) -> int:
    """ADDITIVELY merge a feature's intents into the global map (used by the SEO
    roster when `ai_seo_enabled`). Existing keys are NEVER overwritten — a feature
    can add `metadata.audit` but must not silently redefine a core intent like
    `crawl.run`. Idempotent: re-registering the same map is a no-op. Returns the
    number of NEW keys added."""
    added = 0
    for name, spec in mapping.items():
        if name not in INTENT_MAP:
            INTENT_MAP[name] = spec
            added += 1
    return added


def is_intent(name: str) -> bool:
    """An intent has the `noun.verb` shape and is in the map; anything else is
    treated as a literal tool_id (backward compatible)."""
    return "." in name and name in INTENT_MAP


def intent_spec(name: str) -> dict | None:
    return INTENT_MAP.get(name)

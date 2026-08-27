"""Phase 4 — register the first-party (GSC / GA4 / PSI) providers + build the
per-request adapters.

Tool DEFINITIONS are hand-built here (there is no OpenAPI to discover) and registered
ONCE via `ToolRegistry.replace_provider`. The ADAPTERS are built PER-REQUEST (with the
turn's `stream_id` baked in, so the streamId-scoped connector-token fetch works) and
placed into `ctx.adapters` / `AgentEnv.adapters` — the provider-dispatch map that is
empty in prod today. All gated by `settings.ai_connectors_enabled`.
"""

from __future__ import annotations

import httpx

from app.clients.google_adapters import Ga4Adapter, GscAdapter, PsiAdapter
from app.models.tools import SideEffect, ToolDefinition

_URL = {"type": "object", "properties": {"url": {"type": "string"}}}


def _tool(
    tool_id: str,
    name: str,
    category: str,
    provider: str,
    desc: str,
    schema: dict,
) -> ToolDefinition:
    return ToolDefinition(
        tool_id=tool_id,
        name=name,
        description=desc,
        input_schema=schema,
        category=category,
        provider=provider,
        method="post",
        path=f"/{tool_id}",  # synthetic — the adapter routes by tool_id, not path
        side_effect=SideEffect.READ_ONLY,
    )


def gsc_tool_defs() -> list[ToolDefinition]:
    return [
        _tool(
            "gsc.search_analytics",
            "GSC Search Analytics",
            "SearchConsole",
            "gsc",
            "First-party Google Search clicks/impressions/CTR/position by dimension "
            "(query/page/country/device/date). Requires a connected GSC property.",
            {
                "type": "object",
                "properties": {
                    "startDate": {"type": "string"},
                    "endDate": {"type": "string"},
                    "dimensions": {"type": "array", "items": {"type": "string"}},
                    "rowLimit": {"type": "integer"},
                    "startRow": {"type": "integer"},
                    "dataState": {"type": "string", "enum": ["final", "all"]},
                    "type": {"type": "string"},
                },
            },
        ),
        _tool(
            "gsc.url_inspection",
            "GSC URL Inspection",
            "SearchConsole",
            "gsc",
            "First-party index status for a URL (coverage/indexing state, canonical, "
            "last crawl). Indexed snapshot only — no live test.",
            {"type": "object", "properties": {"inspectionUrl": {"type": "string"}}},
        ),
        _tool(
            "gsc.sitemaps",
            "GSC Sitemaps",
            "SearchConsole",
            "gsc",
            "Sitemaps submitted to Search Console + their processing status.",
            {"type": "object", "properties": {}},
        ),
        _tool(
            "gsc.sites",
            "GSC Sites",
            "SearchConsole",
            "gsc",
            "The verified Search Console properties the connected user can access.",
            {"type": "object", "properties": {}},
        ),
    ]


def ga4_tool_defs() -> list[ToolDefinition]:
    return [
        _tool(
            "ga4.report",
            "GA4 Report",
            "Analytics",
            "ga4",
            "First-party GA4 analytics (sessions/users/conversions by dimension) with "
            "sampling/thresholding/quota metadata. Requires a connected GA4 property.",
            {
                "type": "object",
                "properties": {
                    "startDate": {"type": "string"},
                    "endDate": {"type": "string"},
                    "dimensions": {"type": "array", "items": {"type": "string"}},
                    "metrics": {"type": "array", "items": {"type": "string"}},
                    "limit": {"type": "integer"},
                },
            },
        ),
    ]


def psi_tool_defs() -> list[ToolDefinition]:
    return [
        _tool(
            "psi.field",
            "PageSpeed CrUX Field Data",
            "Performance",
            "psi",
            "Real-user Core Web Vitals (LCP/INP/CLS at the 75th percentile) from CrUX. "
            "May be absent for low-traffic URLs — then fall back to psi.lab.",
            _URL,
        ),
        _tool(
            "psi.lab",
            "PageSpeed Lighthouse Lab",
            "Performance",
            "psi",
            "Synthetic Lighthouse lab metrics. LAB data — never a substitute for field "
            "Core Web Vitals; label it as lab.",
            _URL,
        ),
    ]


def all_connector_tool_defs() -> list[ToolDefinition]:
    return [*gsc_tool_defs(), *ga4_tool_defs(), *psi_tool_defs()]


def register_connector_providers(registry) -> None:
    """Register the three providers' tool sets (idempotent, additive; leaves the
    OllaGraph provider slice untouched)."""
    registry.replace_provider("gsc", gsc_tool_defs())
    registry.replace_provider("ga4", ga4_tool_defs())
    registry.replace_provider("psi", psi_tool_defs())


def build_connector_adapters(
    settings, http: httpx.AsyncClient, stream_id: str
) -> dict[str, object]:
    """Per-request adapters with the turn's stream_id baked in (for the streamId-scoped
    token fetch). Keyed by `tool.provider` for the executor's dispatch map."""
    return {
        "gsc": GscAdapter(settings, http, stream_id=stream_id),
        "ga4": Ga4Adapter(settings, http, stream_id=stream_id),
        "psi": PsiAdapter(settings, http, stream_id=stream_id),
    }

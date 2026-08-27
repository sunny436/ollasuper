"""Phase 4 — first-party GSC / GA4 / PSI adapters: data-quality flags, field-vs-lab
separation, capability-gap honesty, provider-outage degradation, and the credential
never appearing in the returned envelope. Hermetic: httpx.MockTransport stubs BOTH the
Convex connector-token endpoint and the Google APIs (no network).
"""

from __future__ import annotations

import httpx
import pytest

from app.clients.connector_client import ConnectorClient
from app.clients.google_adapters import Ga4Adapter, GscAdapter, PsiAdapter
from app.models.tools import ToolDefinition
from app.runtime.connectors import build_connector_adapters, gsc_tool_defs
from app.seo import flags as F
from app.seo.normalize import co_present
from app.tools.errors import ToolError
from tests.conftest import make_settings

pytestmark = pytest.mark.anyio

_TOKEN = {
    "connected": True,
    "accessToken": "ya29.LIVE-ACCESS-TOKEN",
    "scopes": ["https://www.googleapis.com/auth/webmasters.readonly"],
    "gscSite": "https://example.com/",
    "ga4Property": "123456789",
}


def _settings(**over):
    return make_settings("http://convex.test", **over)


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _tool(tid: str, provider: str) -> ToolDefinition:
    return ToolDefinition(tool_id=tid, name=tid, provider=provider)


def _route(routes: dict, token=_TOKEN):
    """MockTransport handler: connector-token + Google endpoints, matched by url."""

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if "/ai/connector-token" in url:
            return httpx.Response(200, json=token)
        for needle, resp in routes.items():
            if needle in url:
                if callable(resp):
                    return resp(req)
                return httpx.Response(200, json=resp)
        return httpx.Response(404, json={})

    return handler


# --- GSC Search Analytics flags -------------------------------------------
async def test_gsc_search_analytics_flags():
    rows = [{"keys": [f"q{i}"], "clicks": 1} for i in range(25000)]
    handler = _route(
        {"searchAnalytics/query": {"rows": rows, "responseAggregationType": "byQuery"}}
    )
    client = _client(handler)
    try:
        a = GscAdapter(_settings(), client, stream_id="s1")
        res = await a.call_tool(
            _tool("gsc.search_analytics", "gsc"),
            {"startDate": "2026-01-01", "endDate": "2026-01-28",
             "dimensions": ["query"], "rowLimit": 25000, "dataState": "all"},
        )
    finally:
        await client.aclose()
    flags = res["data"]["data_quality_flags"]
    assert F.TOP_ROWS_ONLY in flags  # a full 25k page
    assert F.ANONYMIZED in flags and F.DIMENSION_DATA_LOSS in flags  # query-dimensioned
    assert F.PROVISIONAL in flags  # dataState=all
    # The token must NEVER appear in the returned envelope.
    assert "ya29" not in str(res)


async def test_gsc_url_inspection_canonical_mismatch():
    handler = _route(
        {
            "urlInspection": {
                "inspectionResult": {
                    "indexStatusResult": {
                        "verdict": "PASS",
                        "coverageState": "Submitted and indexed",
                        "googleCanonical": "https://example.com/a",
                        "userCanonical": "https://example.com/a?ref=x",
                    }
                }
            }
        }
    )
    client = _client(handler)
    try:
        a = GscAdapter(_settings(), client, stream_id="s1")
        res = await a.call_tool(
            _tool("gsc.url_inspection", "gsc"),
            {"inspectionUrl": "https://example.com/a"},
        )
    finally:
        await client.aclose()
    flags = res["data"]["data_quality_flags"]
    assert F.INDEXED_VERSION_NOT_LIVE in flags  # API is indexed-snapshot only
    assert F.CANONICAL_MISMATCH in flags  # google != user canonical


# --- GA4 metadata → flags + structured quality -----------------------------
async def test_ga4_report_metadata_flags():
    handler = _route(
        {
            "runReport": {
                "rowCount": 10,
                "rows": [],
                "metadata": {
                    "samplingMetadatas": [
                        {"samplesReadCount": "5", "samplingSpaceSize": "10"}
                    ],
                    "subjectToThresholding": True,
                    "dataLossFromOtherRow": True,
                    "timeZone": "America/New_York",
                    "currencyCode": "USD",
                },
                "propertyQuota": {"tokensPerDay": {"consumed": 1, "remaining": 199999}},
            }
        }
    )
    client = _client(handler)
    try:
        a = Ga4Adapter(_settings(), client, stream_id="s1")
        res = await a.call_tool(
            _tool("ga4.report", "ga4"),
            {"metrics": ["sessions"], "dimensions": ["date"]},
        )
    finally:
        await client.aclose()
    d = res["data"]
    flags = d["data_quality_flags"]
    assert F.GA4_SAMPLED in flags
    assert F.THRESHOLDED in flags
    assert F.OTHER_ROW_LOSS in flags
    assert F.APPROXIMATE_COUNTS in flags
    assert d["quality"]["timeZone"] == "America/New_York"
    assert d["quality"]["currencyCode"] == "USD"
    assert d["quality"]["propertyQuota"]


# --- PSI field vs lab ------------------------------------------------------
async def test_psi_field_present_then_absent():
    with_field = _route(
        {
            "runPagespeed": {
                "loadingExperience": {
                    "overall_category": "FAST",
                    "metrics": {"LARGEST_CONTENTFUL_PAINT_MS": {"percentile": 2100}},
                }
            }
        }
    )
    client = _client(with_field)
    try:
        a = PsiAdapter(_settings(pagespeed_api_key="k"), client, stream_id="s1")
        res = await a.call_tool(_tool("psi.field", "psi"), {"url": "https://x.com"})
    finally:
        await client.aclose()
    assert res["data"]["hasFieldData"] is True
    assert F.FIELD_DATA in res["data"]["data_quality_flags"]

    no_field = _route({"runPagespeed": {"lighthouseResult": {"audits": {}}}})
    client2 = _client(no_field)
    try:
        a = PsiAdapter(_settings(pagespeed_api_key="k"), client2, stream_id="s1")
        res2 = await a.call_tool(_tool("psi.field", "psi"), {"url": "https://x.com"})
    finally:
        await client2.aclose()
    assert res2["data"]["hasFieldData"] is False
    assert F.NO_FIELD_DATA in res2["data"]["data_quality_flags"]


async def test_psi_lab_labeled_lab():
    handler = _route(
        {
            "runPagespeed": {
                "lighthouseResult": {
                    "audits": {"largest-contentful-paint": {"numericValue": 3200}},
                    "categories": {"performance": {"score": 0.5}},
                }
            }
        }
    )
    client = _client(handler)
    try:
        a = PsiAdapter(_settings(pagespeed_api_key="k"), client, stream_id="s1")
        res = await a.call_tool(_tool("psi.lab", "psi"), {"url": "https://x.com"})
    finally:
        await client.aclose()
    assert F.LAB_DATA in res["data"]["data_quality_flags"]
    assert res["data"]["lcp_ms"] == 3200


# --- capability-gap honesty ------------------------------------------------
async def test_not_connected_is_an_honest_gap_not_fabricated():
    handler = _route({}, token={"connected": False})
    client = _client(handler)
    try:
        a = GscAdapter(_settings(), client, stream_id="s1")
        res = await a.call_tool(_tool("gsc.search_analytics", "gsc"), {})
    finally:
        await client.aclose()
    assert res["data"]["connected"] is False
    assert F.NOT_CONNECTED in res["data"]["data_quality_flags"]
    assert "connect" in res["data"]["guidance"].lower()
    # No fabricated rows/metrics.
    assert "rows" not in res["data"]


async def test_needs_reauth_surfaces_as_gap():
    def handler(req: httpx.Request) -> httpx.Response:
        if "/ai/connector-token" in str(req.url):
            return httpx.Response(
                409, json={"connected": False, "reason": "needs_reauth"}
            )
        return httpx.Response(404, json={})

    client = _client(handler)
    try:
        a = Ga4Adapter(_settings(), client, stream_id="s1")
        res = await a.call_tool(_tool("ga4.report", "ga4"), {})
    finally:
        await client.aclose()
    assert res["data"]["connected"] is False
    assert F.NOT_CONNECTED in res["data"]["data_quality_flags"]
    assert "reconnect" in res["data"]["guidance"].lower()


# --- provider outage / quota -> ToolError (honest failure, not fabricated) --
async def test_provider_outage_and_quota_raise():
    def outage(req: httpx.Request) -> httpx.Response:
        if "/ai/connector-token" in str(req.url):
            return httpx.Response(200, json=_TOKEN)
        return httpx.Response(500, json={"error": "boom"})

    client = _client(outage)
    try:
        a = GscAdapter(_settings(), client, stream_id="s1")
        with pytest.raises(ToolError):
            await a.call_tool(_tool("gsc.sites", "gsc"), {})
    finally:
        await client.aclose()

    def quota(req: httpx.Request) -> httpx.Response:
        if "/ai/connector-token" in str(req.url):
            return httpx.Response(200, json=_TOKEN)
        return httpx.Response(429, json={})

    client2 = _client(quota)
    try:
        a = GscAdapter(_settings(), client2, stream_id="s1")
        with pytest.raises(ToolError):
            await a.call_tool(_tool("gsc.sites", "gsc"), {})
    finally:
        await client2.aclose()


# --- connector client contract ---------------------------------------------
async def test_connector_client_maps_statuses():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_TOKEN)

    client = _client(handler)
    try:
        c = ConnectorClient(_settings(), client)
        tok = await c.fetch_token("s1")
    finally:
        await client.aclose()
    assert tok.connected and tok.access_token == "ya29.LIVE-ACCESS-TOKEN"
    assert tok.gsc_site == "https://example.com/"


# --- registration / dispatch mapping + no reconciliation -------------------
def test_build_adapters_maps_providers():
    client = _client(lambda r: httpx.Response(200, json={}))
    adapters = build_connector_adapters(_settings(), client, "s1")
    assert isinstance(adapters["gsc"], GscAdapter)
    assert isinstance(adapters["ga4"], Ga4Adapter)
    assert isinstance(adapters["psi"], PsiAdapter)
    # Every hand-built GSC tool carries provider="gsc" so the executor dispatches it.
    assert all(t.provider == "gsc" for t in gsc_tool_defs())


def test_gsc_ga4_are_not_reconciled_row_by_row():
    out = co_present({"clicks": 100}, {"sessions": 200})
    assert out["reconciled"] is False
    assert out["search_console"]["provider"] == "gsc"
    assert out["analytics"]["provider"] == "ga4"
    assert "not" in out["reconciliation_note"].lower()


def test_google_token_shapes_are_redacted():
    from app.logging import redact_text

    txt = "authz ya29.abcDEF-123_456 and refresh 1//xYz-0123456789 here"
    red = redact_text(txt)
    assert "ya29.abcDEF" not in red and "1//xYz" not in red
    assert "ya29.***" in red and "1//***" in red

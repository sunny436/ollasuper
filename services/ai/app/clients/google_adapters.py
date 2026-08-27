"""Phase 4 — first-party Google tool adapters (GSC / GA4 / PSI).

These satisfy the provider-neutral `ToolAdapter` Protocol. UNLIKE OllaGraph (one base
host routed by `tool.path`), GSC/GA4/PSI live on DIFFERENT Google hosts, so each
adapter switches on `tool.tool_id` and routes explicitly.

CREDENTIAL SAFETY (load-bearing): the per-user OAuth access token is fetched
out-of-band (streamId-scoped) and injected ONLY into the outbound `Authorization`
header — never into args, the returned envelope's data, tool results, events, or logs.
When a user hasn't connected (or needs reauth), the adapter returns an explicit
`connected:false` DATA envelope with a NOT_CONNECTED flag, so the SEO agent emits an
honest UNSUPPORTED finding — it never fabricates.
"""

from __future__ import annotations

from urllib.parse import quote

import httpx

from app.clients.connector_client import ConnectorClient, ConnectorToken
from app.models.tools import ToolDefinition
from app.seo import flags as F
from app.tools.errors import ToolError, ToolErrorKind

GSC_BASE = "https://www.googleapis.com/webmasters/v3"
GSC_INSPECT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
GA4_BASE = "https://analyticsdata.googleapis.com/v1beta"
PSI_URL = "https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed"


def _envelope(tool_id: str, data: dict) -> dict:
    return {
        "ok": True,
        "tool_id": tool_id,
        "data": data,
        "cost": {"credits": None},
        "provider_request_id": None,
    }


def _gap(tool_id: str, token: ConnectorToken) -> dict:
    """An explicit, honest capability gap — never a fabricated result."""
    flag = F.NOT_CONNECTED
    guidance = "Connect Google in Settings → Connections to enable this evidence."
    if token.needs_reauth:
        guidance = "Reconnect Google in Settings → Connections (authorization expired)."
    return _envelope(
        tool_id,
        {
            "connected": False,
            "reason": token.reason,
            "guidance": guidance,
            "data_quality_flags": [flag],
        },
    )


class _GoogleBase:
    def __init__(self, settings, http: httpx.AsyncClient, *, stream_id: str) -> None:
        self._s = settings
        self._http = http
        self._stream_id = stream_id
        self._connector = ConnectorClient(settings, http)

    async def _token(self) -> ConnectorToken:
        return await self._connector.fetch_token(self._stream_id, "google")

    async def _get(self, url: str, token: str, params: dict | None = None) -> dict:
        return await self._request("GET", url, token, params=params)

    async def _post(self, url: str, token: str, body: dict) -> dict:
        return await self._request("POST", url, token, json=body)

    async def _request(self, method, url, token, *, params=None, json=None) -> dict:
        try:
            r = await self._http.request(
                method,
                url,
                params=params,
                json=json,
                headers={"authorization": f"Bearer {token}"},  # token ONLY here
                timeout=httpx.Timeout(connect=3.0, read=30.0, write=10.0, pool=3.0),
            )
        except httpx.HTTPError as e:
            raise ToolError(
                ToolErrorKind.UNAVAILABLE, "google api unreachable", tool_id=url
            ) from e
        if r.status_code == 429:
            raise ToolError(ToolErrorKind.RATE_LIMITED, "google quota", tool_id=url)
        if r.status_code >= 400:
            raise ToolError(
                ToolErrorKind.UPSTREAM_ERROR,
                "google api error",
                tool_id=url,
                status=r.status_code,
            )
        try:
            return r.json()
        except ValueError as e:
            raise ToolError(
                ToolErrorKind.MALFORMED_RESPONSE, "non-JSON", tool_id=url
            ) from e


class GscAdapter(_GoogleBase):
    """Google Search Console — Search Analytics, Sitemaps, Sites, URL Inspection."""

    async def call_tool(
        self,
        tool: ToolDefinition,
        payload: dict,
        *,
        input_schema: dict | None = None,
        idempotency_key: str | None = None,
        user_id: str = "",
        workspace_id: str = "",
    ) -> dict:
        tok = await self._token()
        if not tok.connected:
            return _gap(tool.tool_id, tok)
        site = tok.gsc_site or str(payload.get("siteUrl") or "")
        tid = tool.tool_id
        if tid == "gsc.search_analytics":
            return await self._search_analytics(site, payload, tok.access_token)
        if tid == "gsc.url_inspection":
            return await self._url_inspection(site, payload, tok.access_token)
        if tid == "gsc.sitemaps":
            return await self._sitemaps(site, tok.access_token)
        if tid == "gsc.sites":
            return await self._sites(tok.access_token)
        raise ToolError(ToolErrorKind.INVALID_TOOL, "unknown gsc tool", tool_id=tid)

    async def _search_analytics(self, site: str, payload: dict, token: str) -> dict:
        if not site:
            return _envelope(
                "gsc.search_analytics",
                {
                    "error": "no GSC site selected",
                    "data_quality_flags": [F.NOT_CONNECTED],
                },
            )
        dims = list(payload.get("dimensions") or ["query"])
        row_limit = int(payload.get("rowLimit") or 1000)
        start_row = int(payload.get("startRow") or 0)
        data_state = str(payload.get("dataState") or "final")
        body = {
            "startDate": payload.get("startDate"),
            "endDate": payload.get("endDate"),
            "dimensions": dims,
            "rowLimit": min(row_limit, 25000),
            "startRow": start_row,
            "dataState": data_state,
            "type": payload.get("type", "web"),
        }
        url = f"{GSC_BASE}/sites/{quote(site, safe='')}/searchAnalytics/query"
        clean = {k: v for k, v in body.items() if v is not None}
        res = await self._post(url, token, clean)
        rows = res.get("rows") or []
        flags: list[str] = []
        # A full page ⇒ more rows may exist (up to the 50k/day/type export ceiling).
        if len(rows) >= body["rowLimit"]:
            flags.append(F.TOP_ROWS_ONLY)
        if start_row + len(rows) >= 50000:
            flags.append(F.CAPPED_50K)
        # Query-dimensioned results omit anonymized queries — rows won't sum to totals.
        if "query" in dims:
            flags.append(F.ANONYMIZED)
            flags.append(F.DIMENSION_DATA_LOSS)
        meta = res.get("metadata") or {}
        if data_state == "all" or meta.get("first_incomplete_date"):
            flags.append(F.PROVISIONAL)
        return _envelope(
            "gsc.search_analytics",
            {
                "site": site,
                "rowCount": len(rows),
                "rows": rows[:1000],
                "responseAggregationType": res.get("responseAggregationType"),
                "metadata": meta,
                "data_quality_flags": flags,
            },
        )

    async def _url_inspection(self, site: str, payload: dict, token: str) -> dict:
        inspection_url = str(payload.get("inspectionUrl") or payload.get("url") or "")
        res = await self._post(
            GSC_INSPECT,
            token,
            {"inspectionUrl": inspection_url, "siteUrl": site},
        )
        idx = (res.get("inspectionResult") or {}).get("indexStatusResult") or {}
        flags = [F.INDEXED_VERSION_NOT_LIVE]  # the API is indexed-snapshot only
        g_canon = idx.get("googleCanonical")
        u_canon = idx.get("userCanonical")
        if g_canon and u_canon and g_canon != u_canon:
            flags.append(F.CANONICAL_MISMATCH)
        return _envelope(
            "gsc.url_inspection",
            {
                "inspectionUrl": inspection_url,
                "verdict": idx.get("verdict"),
                "coverageState": idx.get("coverageState"),
                "indexingState": idx.get("indexingState"),
                "pageFetchState": idx.get("pageFetchState"),
                "lastCrawlTime": idx.get("lastCrawlTime"),
                "googleCanonical": g_canon,
                "userCanonical": u_canon,
                "crawledAs": idx.get("crawledAs"),
                "data_quality_flags": flags,
            },
        )

    async def _sitemaps(self, site: str, token: str) -> dict:
        url = f"{GSC_BASE}/sites/{quote(site, safe='')}/sitemaps"
        res = await self._get(url, token)
        return _envelope(
            "gsc.sitemaps",
            {
                "site": site,
                "sitemap": res.get("sitemap") or [],
                "data_quality_flags": [],
            },
        )

    async def _sites(self, token: str) -> dict:
        res = await self._get(f"{GSC_BASE}/sites", token)
        return _envelope(
            "gsc.sites",
            {"siteEntry": res.get("siteEntry") or [], "data_quality_flags": []},
        )


class Ga4Adapter(_GoogleBase):
    """GA4 Data API runReport, with sampling/thresholding/other-row/quota metadata."""

    async def call_tool(
        self,
        tool: ToolDefinition,
        payload: dict,
        *,
        input_schema: dict | None = None,
        idempotency_key: str | None = None,
        user_id: str = "",
        workspace_id: str = "",
    ) -> dict:
        tok = await self._token()
        if not tok.connected:
            return _gap(tool.tool_id, tok)
        prop = tok.ga4_property or str(payload.get("propertyId") or "")
        if not prop:
            return _envelope(
                tool.tool_id,
                {
                    "error": "no GA4 property selected",
                    "data_quality_flags": [F.NOT_CONNECTED],
                },
            )
        date_range = {
            "startDate": payload.get("startDate", "28daysAgo"),
            "endDate": payload.get("endDate", "today"),
        }
        body = {
            "dateRanges": payload.get("dateRanges") or [date_range],
            "dimensions": [{"name": d} for d in (payload.get("dimensions") or [])],
            "metrics": [{"name": m} for m in (payload.get("metrics") or ["sessions"])],
            "returnPropertyQuota": True,
            "limit": int(payload.get("limit") or 100),
        }
        url = f"{GA4_BASE}/properties/{quote(str(prop), safe='')}:runReport"
        res = await self._post(url, tok.access_token, body)
        meta = res.get("metadata") or {}
        flags: list[str] = []
        quality: dict = {}
        samplings = meta.get("samplingMetadatas") or []
        if samplings:
            flags.append(F.GA4_SAMPLED)
            quality["sampling"] = samplings
        if meta.get("subjectToThresholding"):
            flags.append(F.THRESHOLDED)
        if meta.get("dataLossFromOtherRow"):
            flags.append(F.OTHER_ROW_LOSS)
        if res.get("propertyQuota"):
            quality["propertyQuota"] = res.get("propertyQuota")
        if meta.get("schemaRestrictionResponse"):
            flags.append(F.METRICS_RESTRICTED)
        # Unique-count metrics are HLL++ approximations.
        flags.append(F.APPROXIMATE_COUNTS)
        quality["timeZone"] = meta.get("timeZone")
        quality["currencyCode"] = meta.get("currencyCode")
        return _envelope(
            "ga4.report",
            {
                "property": prop,
                "rowCount": res.get("rowCount"),
                "rows": (res.get("rows") or [])[:500],
                "metricHeaders": res.get("metricHeaders"),
                "dimensionHeaders": res.get("dimensionHeaders"),
                "metadata": meta,
                "quality": quality,
                "data_quality_flags": flags,
            },
        )


class PsiAdapter(_GoogleBase):
    """PageSpeed Insights v5 — CrUX FIELD data vs Lighthouse LAB data (server key)."""

    async def call_tool(
        self,
        tool: ToolDefinition,
        payload: dict,
        *,
        input_schema: dict | None = None,
        idempotency_key: str | None = None,
        user_id: str = "",
        workspace_id: str = "",
    ) -> dict:
        url = str(payload.get("url") or "")
        strategy = str(payload.get("strategy") or "MOBILE").upper()
        params = {"url": url, "strategy": strategy, "category": "PERFORMANCE"}
        if self._s.pagespeed_api_key:
            params["key"] = self._s.pagespeed_api_key
        try:
            r = await self._http.get(
                PSI_URL,
                params=params,
                timeout=httpx.Timeout(connect=3.0, read=60.0, write=10.0, pool=3.0),
            )
        except httpx.HTTPError as e:
            raise ToolError(
                ToolErrorKind.UNAVAILABLE, "psi unreachable", tool_id=tool.tool_id
            ) from e
        if r.status_code == 429:
            raise ToolError(
                ToolErrorKind.RATE_LIMITED, "psi quota", tool_id=tool.tool_id
            )
        if r.status_code >= 400:
            raise ToolError(
                ToolErrorKind.UPSTREAM_ERROR,
                "psi error",
                tool_id=tool.tool_id,
                status=r.status_code,
            )
        data = r.json()
        if tool.tool_id == "psi.field":
            return self._field(url, strategy, data)
        return self._lab(url, strategy, data)

    def _field(self, url: str, strategy: str, data: dict) -> dict:
        le = data.get("loadingExperience") or {}
        origin = data.get("originLoadingExperience") or {}
        metrics = le.get("metrics") or origin.get("metrics") or {}
        if not metrics:
            # Insufficient CrUX coverage → the SEO agent should fall back to psi.lab.
            return _envelope(
                "psi.field",
                {
                    "url": url,
                    "hasFieldData": False,
                    "data_quality_flags": [F.NO_FIELD_DATA],
                    "guidance": "No CrUX field data (low traffic) — use psi.lab (lab).",
                },
            )
        return _envelope(
            "psi.field",
            {
                "url": url,
                "strategy": strategy,
                "hasFieldData": True,
                "overall_category": le.get("overall_category"),
                "lcp": metrics.get("LARGEST_CONTENTFUL_PAINT_MS"),
                "inp": metrics.get("INTERACTION_TO_NEXT_PAINT"),
                "cls": metrics.get("CUMULATIVE_LAYOUT_SHIFT_SCORE"),
                "data_quality_flags": [F.FIELD_DATA],
            },
        )

    def _lab(self, url: str, strategy: str, data: dict) -> dict:
        lh = data.get("lighthouseResult") or {}
        audits = lh.get("audits") or {}

        def num(k: str):
            return (audits.get(k) or {}).get("numericValue")

        return _envelope(
            "psi.lab",
            {
                "url": url,
                "strategy": strategy,
                "lcp_ms": num("largest-contentful-paint"),
                "cls": num("cumulative-layout-shift"),
                "tbt_ms": num("total-blocking-time"),
                "performanceScore": (lh.get("categories") or {})
                .get("performance", {})
                .get("score"),
                # LAB is synthetic — NEVER present as field/CWV.
                "data_quality_flags": [F.LAB_DATA],
            },
        )

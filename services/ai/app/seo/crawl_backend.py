"""Phase 5 (post-phase-7) — the REAL Ollagraph-backed crawl backend for durable runs.

Replaces the unwired seam in `routers/seo_runs.py`. It is DETERMINISTIC (no LLM): the
frontier comes from the live sitemap tool, and each URL is audited by Ollagraph's
`seo/meta-audit` tool whose STRUCTURED response is mapped to typed `SEOFinding`s by
fixed rules here. Ollagraph does the fetch/parse; this module only classifies output —
so the large site-wide audit costs no model tokens per page.

The tool response shape (verified live) drives the mapper:
  {status,title,title_length,meta_description,meta_description_length,canonical,
   robots_directive,is_indexable,h1_count,is_likely_404,bot_blocked_at_origin,
   og_image,issues:[...]}
"""

from __future__ import annotations

from app.clients.ollagraph import ToolError
from app.config import Settings
from app.logging import get_logger
from app.runtime.seo_run import BatchResult, Crawler, Discoverer, SeoRunStep

log = get_logger(__name__)

SITEMAP_TOOL = "intel_sitemap_endpoint_v1_intel_sitemap_post"
META_AUDIT_TOOL = "seo_meta_audit_endpoint_v1_seo_meta_audit_post"

# The subset of the meta-audit response kept as bounded evidence per URL.
_EVIDENCE_KEYS = (
    "status", "final_url", "title", "title_length", "meta_description",
    "meta_description_length", "canonical", "robots_directive", "is_indexable",
    "h1_count", "is_likely_404", "bot_blocked_at_origin", "og_image", "issues",
)


def _finding(
    check_id: str,
    url: str,
    status: str,
    severity: str,
    observation: str,
    expected: str = "",
) -> dict:
    return {
        "check_id": check_id,
        "status": status,
        "severity": severity,
        "observation": observation[:500],
        "expected": expected,
        "affected": [url],
        "intent": "metadata.audit",
    }


def meta_audit_to_findings(url: str, r: dict) -> list[dict]:
    """Classify one `seo/meta-audit` response into typed findings, using the existing
    check_id taxonomy so Phase-6 monitoring diffs line up."""
    if not isinstance(r, dict) or r.get("status") != "success":
        st = r.get("status") if isinstance(r, dict) else "none"
        return [
            _finding("crawl_index.fetch", url, "NOT_TESTED", "medium",
                     f"Audit did not complete (status={st}).",
                     "A successful fetch + parse of the page.")
        ]
    out: list[dict] = []

    def push(cid: str, status: str, sev: str, obs: str, exp: str = "") -> None:
        out.append(_finding(cid, url, status, sev, obs, exp))

    # Title
    title = r.get("title")
    tlen = int(r.get("title_length") or (len(title) if isinstance(title, str) else 0))
    if not title:
        push("onpage.title_unique_descriptive", "FAIL", "high",
             "Missing <title>.", "A unique, descriptive 30–60 char title.")
    elif tlen < 30 or tlen > 60:
        push("onpage.title_unique_descriptive", "WARN", "medium",
             f"Title is {tlen} chars: {title!r}.", "30–60 characters.")
    else:
        push("onpage.title_unique_descriptive", "PASS", "info",
             f"Title present ({tlen} chars).")

    # Meta description
    md = r.get("meta_description")
    mdlen = int(r.get("meta_description_length") or 0)
    if not md:
        push("onpage.meta_description", "FAIL", "medium",
             "Missing meta description.", "A 50–160 char meta description.")
    elif mdlen < 50 or mdlen > 160:
        push("onpage.meta_description", "WARN", "low",
             f"Meta description is {mdlen} chars.", "50–160 characters.")
    else:
        push("onpage.meta_description", "PASS", "info",
             f"Meta description present ({mdlen} chars).")

    # Canonical
    if not r.get("canonical"):
        push("crawl_index.canonical_consistency", "WARN", "low",
             "No rel=canonical link.", "A self- or cross-canonical URL.")
    else:
        push("crawl_index.canonical_consistency", "PASS", "info",
             f"Canonical: {r.get('canonical')}.")

    # Indexability / robots
    if r.get("is_indexable") is False:
        push("crawl_index.noindex_mechanism", "FAIL", "critical",
             f"Not indexable (robots: {r.get('robots_directive')}).",
             "Indexable unless intentionally excluded.")
    else:
        push("crawl_index.noindex_mechanism", "PASS", "info", "Indexable (no noindex).")

    # Soft 404 / bot access
    if r.get("is_likely_404"):
        push("crawl_index.soft_404", "FAIL", "high",
             "Page looks like a soft 404.", "A real 200 page or a hard 404.")
    if r.get("bot_blocked_at_origin"):
        push("crawl_index.bot_access", "WARN", "medium",
             "Bot blocked at origin.", "Allow legitimate SEO crawlers.")

    # H1
    h1 = r.get("h1_count")
    if h1 == 0:
        push("onpage.h1", "WARN", "medium", "No H1 heading.",
             "Exactly one descriptive H1.")
    elif isinstance(h1, int) and h1 > 1:
        push("onpage.h1", "WARN", "low", f"{h1} H1 headings.", "Prefer a single H1.")
    elif isinstance(h1, int):
        push("onpage.h1", "PASS", "info", "Single H1.")

    # Open Graph image
    if not r.get("og_image"):
        push("onpage.og_image", "WARN", "low", "No og:image.",
             "An og:image for social + AI previews.")
    return out


class OllagraphSeoBackend:
    """Calls the live Ollagraph tools for the durable worker (in-process)."""

    def __init__(self, adapter, registry, settings: Settings, *, user_id: str) -> None:
        self._adapter = adapter
        self._registry = registry
        self._settings = settings
        self._user_id = user_id

    async def _call(self, tool_id: str, payload: dict) -> dict:
        tool = self._registry.get(tool_id)
        if tool is None:
            # Tool not discovered (misconfig) — treat as an empty result, never crash.
            return {}
        resp = await self._adapter.call_tool(
            tool, payload, input_schema=None, user_id=self._user_id, workspace_id=""
        )
        data = resp.get("data") if isinstance(resp, dict) else None
        return data if isinstance(data, dict) else {}

    async def discover(self, target: str, scope: str, max_urls: int) -> list[str]:
        """Frontier = the site's sitemap URLs (bounded). A single-page scope, an empty
        sitemap, or a sitemap failure all fall back to auditing just the target."""
        if scope == "page":
            return [target]
        try:
            data = await self._call(SITEMAP_TOOL, {"url": target})
        except ToolError as e:
            log.info("seo_crawl.sitemap_failed", extra={"err": type(e).__name__})
            return [target]
        urls = [u for u in (data.get("urls") or []) if isinstance(u, str)]
        return urls[:max_urls] if urls else [target]

    async def crawl(self, urls: list[str], step: SeoRunStep) -> BatchResult:
        """Audit each URL via meta-audit, classify deterministically. A failed page is a
        NOT_TESTED finding (coverage gap), never a silent drop or batch failure."""
        rows: list[dict] = []
        findings: list[dict] = []
        for url in urls:
            try:
                data = await self._call(META_AUDIT_TOOL, {"url": url})
            except ToolError as e:
                findings.append(
                    _finding("crawl_index.fetch", url, "NOT_TESTED", "medium",
                             f"Audit call failed ({type(e).__name__}).",
                             "A successful fetch + parse.")
                )
                continue
            rows.append({"url": url, "audit": {k: data.get(k) for k in _EVIDENCE_KEYS}})
            findings.extend(meta_audit_to_findings(url, data))
        counts: dict[str, int] = {}
        for f in findings:
            counts[f["status"]] = counts.get(f["status"], 0) + 1
        return BatchResult(
            rows=rows, findings=findings, counts=counts, cost=float(len(urls))
        )


def build_ollagraph_crawl_backend(
    adapter, registry, settings: Settings, *, user_id: str
) -> tuple[Discoverer, Crawler]:
    """The (discoverer, crawler) pair the worker injects — real Ollagraph-backed."""
    backend = OllagraphSeoBackend(adapter, registry, settings, user_id=user_id)
    return backend.discover, backend.crawl


# Re-export so callers need one import site.
__all__ = [
    "META_AUDIT_TOOL",
    "SITEMAP_TOOL",
    "OllagraphSeoBackend",
    "build_ollagraph_crawl_backend",
    "meta_audit_to_findings",
]

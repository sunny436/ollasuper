"""Phase 5 (post-phase-7) — the REAL Ollagraph-backed crawl backend for durable runs.

DETERMINISTIC (no LLM): the frontier comes from the live sitemap tool; a per-run
SITE-LEVEL audit (TLS, robots.txt, homepage broken-links, response headers,
sitemap) runs once, and every URL gets an on-page audit (meta + structured data).
Each tool's STRUCTURED response is mapped to typed `SEOFinding`s by fixed rules
here — so a large site-wide audit costs no model tokens per page.

Tool contracts + interpretation are handled deliberately (a senior-auditor bar):
  * `intel/ssl` takes {"domain": host}, NOT {"url": ...}.
  * `intel/robots` `is_allowed` is treated CAUTIOUSLY — some parsers false-positive
    on wildcard `Disallow: /*?s=*` rules, so a "homepage disallowed" signal is a low
    WARN to verify, never a fabricated CRITICAL.
  * meta-audit is the RETRIED core (429s recover); structured data is best-effort
    enrichment (single-shot, skipped on error) so it never amplifies rate-limit backoff.
"""

from __future__ import annotations

import asyncio
from urllib.parse import urlsplit

from app.clients.ollagraph import ToolError
from app.config import Settings
from app.logging import get_logger
from app.runtime.seo_run import BatchResult, Crawler, Discoverer, SeoRunStep

log = get_logger(__name__)

SITEMAP_TOOL = "intel_sitemap_endpoint_v1_intel_sitemap_post"
META_AUDIT_TOOL = "seo_meta_audit_endpoint_v1_seo_meta_audit_post"
SSL_TOOL = "intel_ssl_endpoint_v1_intel_ssl_post"
ROBOTS_TOOL = "intel_robots_endpoint_v1_intel_robots_post"
HEADERS_TOOL = "intel_headers_endpoint_v1_intel_headers_post"
BROKEN_LINKS_TOOL = "seo_broken_links_endpoint_v1_seo_broken_links_audit_post"
STRUCTURED_TOOL = "extract_structured_endpoint_v1_extract_structured_post"

_AUDIT_RETRIES = 3  # bounded retries on a retryable audit error (429/timeout/upstream)
_RETRY_BASE_S = 0.5  # exponential backoff base
_THROTTLE_S = 0.1  # spacing between per-URL audits so a burst doesn't trip 429

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
    intent: str = "metadata.audit",
) -> dict:
    return {
        "check_id": check_id,
        "status": status,
        "severity": severity,
        "observation": observation[:500],
        "expected": expected,
        "affected": [url],
        "intent": intent,
    }


def meta_audit_to_findings(url: str, r: dict) -> list[dict]:
    """Classify one `seo/meta-audit` response into typed findings."""
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


def structured_to_findings(url: str, r: dict) -> list[dict]:
    """Classify one `extract/structured` response. Best-effort enrichment: a tool error
    (no `json_ld` key) yields NO finding — meta-audit already covers the page, so a
    missing structured probe must not become a false 'no structured data' claim."""
    if not isinstance(r, dict) or "json_ld" not in r:
        return []
    jsonld = r.get("json_ld") if isinstance(r.get("json_ld"), list) else []
    micro = r.get("microdata") if isinstance(r.get("microdata"), list) else []
    if jsonld or micro:
        types: list[str] = []
        for x in jsonld[:5]:
            t = x.get("@type") if isinstance(x, dict) else None
            if isinstance(t, str):
                types.append(t)
            elif isinstance(t, list) and t:
                types.append(str(t[0]))
        label = f" ({', '.join(types)})" if types else ""
        f = _finding("onpage.structured_data_valid", url, "PASS", "info",
                     f"{len(jsonld)} JSON-LD block(s){label}.",
                     intent="structured_data.extract")
    else:
        f = _finding("onpage.structured_data_valid", url, "WARN", "low",
                     "No structured data (JSON-LD/microdata) detected.",
                     "Add relevant schema.org structured data.",
                     intent="structured_data.extract")
    return [f]


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
            return {}  # tool not discovered (misconfig) — empty result, never crash
        resp = await self._adapter.call_tool(
            tool, payload, input_schema=None, user_id=self._user_id, workspace_id=""
        )
        data = resp.get("data") if isinstance(resp, dict) else None
        return data if isinstance(data, dict) else {}

    async def _call_retry(self, tool_id: str, payload: dict) -> dict:
        """Call with bounded backoff on a RETRYABLE error (429/timeout/upstream) — the
        provider rate-limits bursts, so a transient 429 recovers into a real finding."""
        for attempt in range(_AUDIT_RETRIES):
            try:
                return await self._call(tool_id, payload)
            except ToolError as e:
                if not e.retryable or attempt == _AUDIT_RETRIES - 1:
                    raise
                await asyncio.sleep(_RETRY_BASE_S * (2**attempt))
        return {}  # unreachable

    async def discover(self, target: str, scope: str, max_urls: int) -> list[str]:
        """Frontier = the site's sitemap URLs (bounded), with the target lead so the
        site-level audit runs in the first batch. Page scope / empty sitemap / failure
        all fall back to auditing just the target."""
        if scope == "page":
            return [target]
        try:
            data = await self._call(SITEMAP_TOOL, {"url": target})
        except ToolError as e:
            log.info("seo_crawl.sitemap_failed", extra={"err": type(e).__name__})
            return [target]
        urls = [u for u in (data.get("urls") or []) if isinstance(u, str)]
        if not urls:
            return [target]
        frontier = [target, *[u for u in urls if u != target]]
        return frontier[:max_urls]

    async def _site_audit(self, target: str) -> list[dict]:
        """Site-level technical checks that run ONCE per audit (the batch containing the
        target). Wrong input contracts + naive interpretation are handled here."""
        host = urlsplit(target).netloc or target
        out: list[dict] = []

        def push(cid, status, sev, obs, exp="", intent="site.audit"):
            out.append(_finding(cid, target, status, sev, obs, exp, intent))

        # TLS certificate — contract is {"domain": host}, not {"url": ...}.
        ssl = await self._safe(SSL_TOOL, {"domain": host})
        if ssl.get("status") == "success":
            days = ssl.get("days_remaining")
            issuer = ssl.get("issuer") or "unknown issuer"
            if ssl.get("is_valid") is False:
                push("technical.https_ssl", "FAIL", "critical",
                     f"TLS certificate is not valid ({issuer}).",
                     "A valid TLS certificate.")
            elif isinstance(days, int) and days < 14:
                push("technical.https_ssl", "FAIL", "high",
                     f"TLS certificate expires in {days} days.", "Renew before expiry.")
            elif isinstance(days, int) and days < 30:
                push("technical.https_ssl", "WARN", "medium",
                     f"TLS certificate expires in {days} days.", "Renew before expiry.")
            else:
                push("technical.https_ssl", "PASS", "info",
                     f"Valid TLS certificate ({issuer}, {days} days remaining).")

        # robots.txt — report presence; interpret is_allowed CAUTIOUSLY.
        rob = await self._safe(ROBOTS_TOOL, {"url": target})
        if rob.get("status") == "success":
            push("crawl_index.robots_txt", "PASS", "info",
                 f"robots.txt present ({rob.get('robots_url')}).")
            if rob.get("is_allowed") is False:
                push("crawl_index.robots_home_allowed", "WARN", "low",
                     "The robots checker reports the homepage as disallowed — VERIFY "
                     "manually; wildcard rules (e.g. /*?s=*) false-positive in some "
                     "parsers, so this is not treated as a confirmed block.",
                     "Confirm the homepage is crawlable for Googlebot.")

        # Broken links on the homepage.
        bl = await self._safe(BROKEN_LINKS_TOOL, {"url": target})
        if bl.get("status") == "success":
            broken = int(bl.get("broken_count") or 0)
            ib = int(bl.get("internal_broken") or 0)
            eb = int(bl.get("external_broken") or 0)
            if ib > 0:
                push("crawl_index.broken_links", "FAIL", "high",
                     f"{broken} broken link(s) on the homepage ({ib} internal, {eb} "
                     "external).", "No broken internal links.")
            elif broken > 0:
                push("crawl_index.broken_links", "WARN", "low",
                     f"{broken} broken external link(s) on the homepage.",
                     "Fix or remove dead outbound links.")
            else:
                push("crawl_index.broken_links", "PASS", "info",
                     "No broken links detected on the homepage.")

        # Response headers — header-level noindex + HSTS.
        hd = await self._safe(HEADERS_TOOL, {"url": target})
        if hd.get("status") == "success":
            headers = {
                str(k).lower(): v
                for k, v in (hd.get("headers") or [])
                if isinstance(k, str)
            }
            xr = str(headers.get("x-robots-tag") or "")
            if "noindex" in xr.lower():
                push("crawl_index.x_robots_tag", "FAIL", "critical",
                     f"X-Robots-Tag header sets noindex: {xr!r}.",
                     "No header-level noindex on indexable pages.")
            if headers.get("strict-transport-security"):
                push("technical.hsts", "PASS", "info", "HSTS enabled.")
            else:
                push("technical.hsts", "WARN", "low", "No HSTS header.",
                     "Enable Strict-Transport-Security.")

        # Sitemap presence + size.
        sm = await self._safe(SITEMAP_TOOL, {"url": target})
        urls = sm.get("urls") if isinstance(sm.get("urls"), list) else []
        if sm.get("status") == "success" and (urls or sm.get("url_count")):
            n = int(sm.get("url_count") or len(urls))
            push("crawl_index.sitemap_quality", "PASS", "info",
                 f"XML sitemap found ({n} URLs).")
        else:
            push("crawl_index.sitemap_quality", "WARN", "medium",
                 "No XML sitemap found.", "Publish + submit an XML sitemap.")
        return out

    async def _safe(self, tool_id: str, payload: dict) -> dict:
        """Retry-with-backoff, but never raise: a site check that fails yields no
        finding (honest coverage gap) rather than aborting the whole site audit."""
        try:
            return await self._call_retry(tool_id, payload)
        except ToolError as e:
            log.info("seo_crawl.site_tool_failed",
                     extra={"tool": tool_id, "err": type(e).__name__})
            return {}

    async def _audit_url(self, url: str) -> tuple[list[dict], list[dict]]:
        """One URL's on-page audit (meta + structured). Catches its own errors and
        NEVER raises — a failed fetch is a NOT_TESTED finding, never a dropped page —
        so it is safe to run concurrently for many URLs at once."""
        try:
            data = await self._call_retry(META_AUDIT_TOOL, {"url": url})
        except ToolError as e:
            return [], [
                _finding("crawl_index.fetch", url, "NOT_TESTED", "medium",
                         f"Audit call failed ({type(e).__name__}).",
                         "A successful fetch + parse.")
            ]
        rows = [{"url": url, "audit": {k: data.get(k) for k in _EVIDENCE_KEYS}}]
        findings = list(meta_audit_to_findings(url, data))
        # Structured data — best-effort enrichment, but RETRIED (not single-shot): under
        # concurrent 429 pressure a single shot would drop MORE structured findings than
        # a sequential run, so retry recovers them → completeness is never below
        # sequential. Skipped only after retries exhaust.
        try:
            sd = await self._call_retry(STRUCTURED_TOOL, {"url": url})
            findings.extend(structured_to_findings(url, sd))
        except ToolError:
            pass
        return rows, findings

    async def crawl(self, urls: list[str], step: SeoRunStep) -> BatchResult:
        """Site-level audit once (the batch with the target) + per-URL on-page audit
        (meta + structured), run CONCURRENTLY. Read-only tools + order-preserving
        aggregation ⇒ the BatchResult is identical to a sequential run (never less
        complete); a failed page is a NOT_TESTED finding, never dropped."""
        sem = asyncio.Semaphore(max(1, self._settings.ai_seo_crawl_concurrency))

        async def _bounded(url: str) -> tuple[list[dict], list[dict]]:
            async with sem:
                return await self._audit_url(url)

        async def _site() -> list[dict]:
            if step.target not in urls:
                return []
            try:
                return list(await self._site_audit(step.target))
            except Exception:  # noqa: BLE001 — site audit is best-effort, never fatal
                log.warning("seo_crawl.site_audit_failed")
                return []

        # The site audit and every per-URL audit run at the same time; results are
        # then combined in a DETERMINISTIC order (site findings first, then per-URL in
        # `urls` order — asyncio.gather preserves input order) so rows/findings/counts
        # are byte-identical to the sequential version regardless of completion order.
        site_findings, per_url = await asyncio.gather(
            _site(), asyncio.gather(*(_bounded(u) for u in urls))
        )
        rows: list[dict] = []
        findings: list[dict] = list(site_findings)
        for r, f in per_url:
            rows.extend(r)
            findings.extend(f)

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


__all__ = [
    "BROKEN_LINKS_TOOL",
    "HEADERS_TOOL",
    "META_AUDIT_TOOL",
    "ROBOTS_TOOL",
    "SITEMAP_TOOL",
    "SSL_TOOL",
    "STRUCTURED_TOOL",
    "OllagraphSeoBackend",
    "build_ollagraph_crawl_backend",
    "meta_audit_to_findings",
    "structured_to_findings",
]

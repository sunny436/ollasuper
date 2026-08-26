"""SEO capability catalogue — the ONE source that maps SEO capability INTENTS to
the EXACT read-only OllaGraph tools (verified against the live /v1/tools snapshot),
and derives (a) the SEO intent map merged into the runtime intent resolver, (b) the
SEO agent's read-only scope allowlist (categories + explicit tool_ids), and (c) a
capability summary rendered into the skill guidance.

Only read-only, SEO-relevant capabilities are here. The 74 excluded OllaGraph tools
(AEO, Account, Billing, Authentication, Actors, Automation, Captcha, Conversion) are
NEVER in the allowlist — enforced generically by Group-1 scoping + the read-only
ceiling, so the SEO agent can never reach them even via find_capabilities.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.models.tools import SideEffect

# Bulk categories the SEO agent may use wholesale (all their tools are read-only
# SEO-relevant). The Intelligence category is DELIBERATELY excluded here — only its
# named subset (below) is allowed, since Intelligence also holds non-SEO tools.
ALLOWED_CATEGORIES: frozenset[str] = frozenset(
    {"SEO", "Scraping", "Extraction", "Crawling", "Jobs", "Parsing"}
)

# Explicit read-only tool_ids OUTSIDE the bulk categories that the SEO audit needs:
# the Intelligence subset actually used by a capability (robots/sitemap/headers/
# redirects/ssl) + the `Other`-category SEO tools (search, text similarity/diff).
# LEAST PRIVILEGE: only ids a capability references are listed — no unreachable
# scope surface (geoip/uptime/http-versions are read-only but unused, so excluded).
ALLOWED_TOOL_IDS: frozenset[str] = frozenset(
    {
        "intel_robots_endpoint_v1_intel_robots_post",
        "intel_sitemap_endpoint_v1_intel_sitemap_post",
        "intel_headers_endpoint_v1_intel_headers_post",
        "intel_redirects_endpoint_v1_intel_redirects_post",
        "intel_ssl_endpoint_v1_intel_ssl_post",
        "search_endpoint_v1_search_post",
        "text_similarity_endpoint_v1_text_similarity_post",
        "text_diff_endpoint_v1_text_diff_post",
    }
)


@dataclass(frozen=True, slots=True)
class SEOCapability:
    """Provider-agnostic metadata for one SEO capability (item 5)."""

    intent: str
    description: str
    tool_ids: tuple[str, ...]
    query: str  # canonical selector query for intent resolution
    side_effect: SideEffect = SideEffect.READ_ONLY
    inputs: str = "url"
    outputs: str = ""
    freshness: str = "live"  # results reflect the page at call time
    evidence_value: str = ""  # what an auditor can conclude from it
    limitations: str = ""  # what it CANNOT establish
    provider: str = "ollagraph"
    availability: str = "available"
    permissions: tuple[str, ...] = field(default=("ollagraph:read",))


# The catalogue — read-only SEO capabilities only.
SEO_CAPABILITIES: tuple[SEOCapability, ...] = (
    SEOCapability(
        "metadata.audit",
        "Audit title, meta description, H1, canonical, meta-robots, viewport, "
        "Open Graph, indexability and soft-404 signals of a page.",
        ("seo_meta_audit_endpoint_v1_seo_meta_audit_post",),
        "seo meta audit title description canonical robots indexability",
        outputs="title, meta description, canonical, robots directives, indexability",
        evidence_value="on-page indexability + metadata correctness",
        limitations="reflects served HTML, not Google's indexed version",
    ),
    SEOCapability(
        "page.scrape",
        "Fetch a page's HTML/content for on-page inspection.",
        (
            "scrape_endpoint_v1_scrape_post",
            "smart_scrape_endpoint_v1_scrape_smart_post",
            "scrape_llm_ready_endpoint_v1_scrape_llm_ready_post",
        ),
        "fetch scrape page content html",
        outputs="raw/rendered HTML + content",
        evidence_value="what the page actually serves",
        limitations="not a full Googlebot render; JS parity is a known gap",
    ),
    SEOCapability(
        "crawl.run",
        "Crawl a site to discover pages/URLs for site-wide analysis.",
        ("crawl_endpoint_v1_crawl_post",),
        "crawl website discover pages urls",
        inputs="url + depth/limit",
        outputs="discovered URLs + statuses",
        evidence_value="site structure, orphan/deep pages, status distribution",
        limitations="bounded depth; not Google's crawl",
    ),
    SEOCapability(
        "broken_links.check",
        "Find broken links and their HTTP status + final URL.",
        ("seo_broken_links_endpoint_v1_seo_broken_links_audit_post",),
        "seo broken links audit http status final url",
        outputs="broken links with status codes",
        evidence_value="crawl-wasting 4xx/5xx links, UX breakage",
    ),
    SEOCapability(
        "redirects.map",
        "Map a URL's redirect chain + hops (301/302, chain length).",
        (
            "seo_redirect_chain_endpoint_v1_seo_redirect_chain_map_post",
            "intel_redirects_endpoint_v1_intel_redirects_post",
        ),
        "seo redirect chain map hops 301 302",
        outputs="redirect chain, hop count, status types",
        evidence_value="301-vs-302 correctness, chain length, redirect loops",
    ),
    SEOCapability(
        "robots.analyze",
        "Analyze robots.txt rules and crawler access.",
        ("intel_robots_endpoint_v1_intel_robots_post",),
        "robots txt crawler access rules disallow",
        inputs="domain",
        outputs="robots.txt directives per user-agent + sitemap refs",
        evidence_value="whether important paths / CSS-JS are blocked from crawling",
        limitations="robots.txt controls crawling, NOT indexing",
    ),
    SEOCapability(
        "sitemap.inspect",
        "Inspect XML sitemap information.",
        ("intel_sitemap_endpoint_v1_intel_sitemap_post",),
        "xml sitemap inspect urls lastmod",
        inputs="domain/sitemap url",
        outputs="sitemap URLs + metadata",
        evidence_value="are important canonical URLs listed; non-indexable in sitemap",
    ),
    SEOCapability(
        "headers.analyze",
        "Analyze HTTP response headers relevant to technical SEO.",
        ("intel_headers_endpoint_v1_intel_headers_post",),
        "http response headers technical seo x-robots-tag",
        outputs="response headers (incl. X-Robots-Tag, cache, security)",
        evidence_value="header-level noindex, caching, HSTS, status",
    ),
    SEOCapability(
        "structured_data.extract",
        "Extract JSON-LD/Microdata/RDFa/Open Graph/Twitter/product data.",
        ("extract_structured_endpoint_v1_extract_structured_post",),
        "extract structured data json-ld microdata open graph",
        outputs="parsed structured-data blocks",
        evidence_value="presence + type of structured data on the page",
    ),
    SEOCapability(
        "schema.validate",
        "Validate structured data against SEO/schema validation rules.",
        ("seo_schema_validate_endpoint_v1_seo_schema_validate_post",),
        "validate structured data schema seo rules rich results",
        outputs="validation errors/warnings per schema type",
        evidence_value="required-property gaps; validity (not rich-result guarantee)",
    ),
    SEOCapability(
        "content.extract",
        "Extract clean content, title, word count, reading time.",
        ("extract_clean_endpoint_v1_extract_clean_post",),
        "extract clean content word count reading time",
        outputs="main content, word count, reading time",
        evidence_value="content depth/thinness signals (not a ranking verdict)",
    ),
    SEOCapability(
        "keywords.extract",
        "Extract important keywords/phrases from a page or text.",
        ("seo_keyword_extract_endpoint_v1_seo_keyword_extract_post",),
        "extract keywords phrases page text",
        outputs="ranked keywords/phrases",
        evidence_value="topical focus of the page",
    ),
    SEOCapability(
        "readability.measure",
        "Measure content readability for editorial quality.",
        ("seo_readability_endpoint_v1_seo_readability_post",),
        "content readability score editorial quality",
        outputs="readability scores",
        evidence_value="editorial readability (not a direct ranking factor)",
    ),
    SEOCapability(
        "text.compare",
        "Compare text similarity / diff to spot duplicate or changed content.",
        (
            "text_similarity_endpoint_v1_text_similarity_post",
            "text_diff_endpoint_v1_text_diff_post",
        ),
        "text similarity duplicate content compare diff",
        inputs="two texts/urls",
        outputs="similarity score / diff",
        evidence_value="near-duplicate content between pages",
    ),
    SEOCapability(
        "mixed_content.scan",
        "Find HTTP resources loaded by HTTPS pages (mixed content).",
        ("seo_mixed_content_endpoint_v1_seo_mixed_content_post",),
        "mixed content http resources on https page",
        outputs="insecure subresources",
        evidence_value="HTTPS integrity / browser 'not secure' risk",
    ),
    SEOCapability(
        "ssl.check",
        "Check SSL/HTTPS certificate information for a domain.",
        ("intel_ssl_endpoint_v1_intel_ssl_post",),
        "ssl https certificate check domain validity",
        inputs="domain",
        outputs="certificate validity/expiry/issuer",
        evidence_value="HTTPS availability + certificate validity",
    ),
    SEOCapability(
        "anchor_text.audit",
        "Analyze anchor text for internal-link / on-page issues.",
        ("seo_anchor_text_audit_endpoint_v1_seo_anchor_text_audit_post",),
        "anchor text internal link audit descriptive",
        outputs="anchor text distribution/issues",
        evidence_value="internal-link descriptiveness + crawlability signals",
    ),
    SEOCapability(
        "serp.search",
        "Current search-result/SERP research for a query.",
        ("search_endpoint_v1_search_post",),
        "search serp results research query competitors",
        inputs="query",
        outputs="SERP results",
        evidence_value="visibility/competitor context (NOT the site's own ranking)",
        limitations="not GSC ranking data for the audited site",
    ),
)


def seo_intent_map() -> dict[str, dict]:
    """The `{intent: {query, max_side_effect}}` entries to merge into the runtime
    INTENT_MAP so skills/agents resolve SEO intents through the selector."""
    return {
        c.intent: {"query": c.query, "max_side_effect": c.side_effect}
        for c in SEO_CAPABILITIES
    }


def capability_summary(limit: int = 0) -> str:
    """A compact `intent — description` list for the skill guidance."""
    lines = [f"- {c.intent}: {c.description}" for c in SEO_CAPABILITIES]
    if limit:
        lines = lines[:limit]
    return "\n".join(lines)

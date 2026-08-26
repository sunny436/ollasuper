"""The SEO audit RULE BASE — evidence-backed checks distilled from authoritative
sources (Google Search Central / web.dev). Each `SEOCheck` states the normative
`expected` condition, WHICH capability `intent` verifies it, `severity_default`,
the `verification` method, the `applicability` gate (signal-vs-noise), the `source`
doc, and whether OllaGraph can verify it (`supported`) or it is a KNOWN GAP
(`supported=False` -> the finding must be `UNSUPPORTED`, never hallucinated).

No rule is stated beyond what its source supports; effects are described only at the
level Google documents (see the epistemics in skill.py). This catalogue is the
authoritative reference; the skill renders a bounded digest.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.seo.models import Severity


@dataclass(frozen=True, slots=True)
class SEOCheck:
    check_id: str
    # crawl_index | architecture | onpage | content | technical | international | policy
    phase: str
    intent: str  # capability intent that verifies it ("" if a KNOWN GAP)
    expected: str  # the normative condition
    verification: str  # how to reproduce/confirm
    source: str  # authoritative source
    severity_default: Severity = Severity.MEDIUM
    applicability: str = "always"  # WHEN the check applies (the signal-vs-noise gate)
    supported: bool = True  # False => KNOWN GAP => status UNSUPPORTED


SEO_CHECKS: tuple[SEOCheck, ...] = (
    # ---- crawl / index foundations (run FIRST) -----------------------------
    SEOCheck(
        "crawl_index.robots_blocks_important",
        "crawl_index", "robots.analyze",
        "robots.txt must not Disallow important pages or CSS/JS needed for rendering; "
        "robots.txt controls CRAWLING, not indexing.",
        "Fetch robots.txt; confirm important paths + resources are crawlable.",
        "Google Search Central: robots/intro",
        Severity.CRITICAL,
    ),
    SEOCheck(
        "crawl_index.disallow_plus_noindex_conflict",
        "crawl_index", "robots.analyze",
        "A page must NOT be both robots.txt-Disallowed AND carry noindex — Googlebot "
        "never sees the noindex, so the page stays indexable via links.",
        "Cross-check robots.txt Disallow against the page's meta-robots/X-Robots-Tag.",
        "Google Search Central: block-indexing",
        Severity.HIGH,
    ),
    SEOCheck(
        "crawl_index.noindex_mechanism",
        "crawl_index", "metadata.audit",
        "Indexing is controlled by a noindex meta tag or X-Robots-Tag header (NOT "
        "robots.txt); pages meant to be private must carry noindex and be crawlable.",
        "Inspect meta-robots + response headers via metadata/headers.",
        "Google Search Central: block-indexing",
        Severity.HIGH,
    ),
    SEOCheck(
        "crawl_index.canonical_self_referential",
        "crawl_index", "metadata.audit",
        "Canonical pages should carry a self-referential, ABSOLUTE rel=canonical; "
        "no URL fragments; one method; signals must be consistent.",
        "Read rel=canonical (and HTTP Link header); confirm absolute + consistent.",
        "Google Search Central: consolidate-duplicate-urls",
        Severity.MEDIUM,
    ),
    SEOCheck(
        "crawl_index.canonical_consistency",
        "crawl_index", "metadata.audit",
        "rel=canonical, redirects, sitemap and internal links must agree on the same "
        "canonical (redirect > rel=canonical > sitemap > internal-link > HTTPS "
        "strength).",
        "Compare canonical across methods; flag conflicts.",
        "Google Search Central: consolidate-duplicate-urls",
        Severity.MEDIUM,
    ),
    SEOCheck(
        "crawl_index.https_preference",
        "crawl_index", "ssl.check",
        "HTTPS is served with a valid certificate; HTTP redirects to HTTPS (301) or "
        "HSTS is set; canonical points to the HTTPS URL.",
        "Check SSL + that HTTP->HTTPS redirect / HSTS is present.",
        "Google Search Central: page-experience (HTTPS)",
        Severity.HIGH,
    ),
    SEOCheck(
        "crawl_index.redirect_status_correct",
        "crawl_index", "redirects.map",
        "Permanent moves use 301 (302 is a WEAK signal); removed pages return 404/410; "
        "temporary outages 503.",
        "Map the redirect chain; confirm status semantics.",
        "Google Search Central: http-network-errors",
        Severity.MEDIUM,
    ),
    SEOCheck(
        "crawl_index.redirect_chain_length",
        "crawl_index", "redirects.map",
        "Redirect chains should be <=3 hops (Google follows up to ~10); no loops. Long "
        "chains waste crawl and dilute signals.",
        "Count hops in the redirect chain.",
        "Google Search Central: http-network-errors / crawl-budget",
        Severity.MEDIUM,
    ),
    SEOCheck(
        "crawl_index.soft_404",
        "crawl_index", "metadata.audit",
        "A not-found/empty page must return 404/410, NOT 200 (a soft-404 wastes crawl "
        "and won't index).",
        "Detect 200 responses with empty/error content.",
        "Google Search Central: http-network-errors",
        Severity.MEDIUM,
    ),
    SEOCheck(
        "crawl_index.sitemap_quality",
        "crawl_index", "sitemap.inspect",
        "The XML sitemap lists only canonical, indexable URLs (no noindex / redirect "
        "/ 404), with accurate lastmod; <=50,000 URLs / 50MB per file (use an index "
        "otherwise).",
        "Inspect sitemap URLs; cross-check status/canonical/indexability.",
        "Google Search Central: sitemaps/overview",
        Severity.MEDIUM,
    ),
    SEOCheck(
        "crawl_index.broken_links",
        "crawl_index", "broken_links.check",
        "Internal links should not resolve to 4xx/5xx; broken links waste crawl and "
        "break UX + link equity flow.",
        "Run the broken-links audit; list broken targets + status.",
        "Google Search Central: crawl-budget / how-search-works",
        Severity.MEDIUM,
    ),
    # ---- architecture / crawl budget (APPLICABILITY-GATED) ------------------
    SEOCheck(
        "architecture.crawl_budget_waste",
        "architecture", "crawl.run",
        "Crawl budget is not wasted on faceted/parameter/infinite URL spaces, "
        "duplicates, or soft-404s; parasitic facets are robots.txt-blocked.",
        "Crawl a sample; look for URL-space explosion + duplicate/low-value URLs.",
        "Google Search Central: large-site-managing-crawl-budget",
        Severity.MEDIUM,
        # Google: only matters for 1M+ pages (weekly change), 10K+ (daily change), or
        # many 'Discovered - currently not indexed'. Else NOT_APPLICABLE.
        applicability="site >=10k pages OR rapidly-changing OR high discovered-not-idx",
    ),
    SEOCheck(
        "architecture.internal_linking",
        "architecture", "crawl.run",
        "Important pages are reachable via crawlable internal links (not JS-only nav / "
        "orphaned); links distribute authority (link-equity/PageRank basis).",
        "Crawl; identify orphan/deep pages + non-crawlable navigation.",
        "Google Search Central: how-search-works / crawlable links",
        Severity.MEDIUM,
    ),
    SEOCheck(
        "architecture.anchor_text_descriptive",
        "architecture", "anchor_text.audit",
        "Internal anchor text is descriptive (not 'click here'); helps Google + users "
        "understand link targets.",
        "Audit anchor text distribution.",
        "Google Search Central: crawlable links",
        Severity.LOW,
    ),
    # ---- on-page -----------------------------------------------------------
    SEOCheck(
        "onpage.title_unique_descriptive",
        "onpage", "metadata.audit",
        "Every page has a unique, descriptive, concise <title> (no boilerplate/empty/"
        "stuffed). NOTE: titles affect CTR/appearance, NOT direct ranking.",
        "Read <title>; check presence, uniqueness, descriptiveness.",
        "Google Search Central: title-link",
        Severity.MEDIUM,
    ),
    SEOCheck(
        "onpage.meta_description",
        "onpage", "metadata.audit",
        "A relevant meta description is present (influences the SNIPPET, not ranking); "
        "unique per page.",
        "Read meta description; check presence + uniqueness.",
        "Google Search Central: snippet",
        Severity.LOW,
    ),
    SEOCheck(
        "onpage.h1_present",
        "onpage", "content.extract",
        "A page has a clear primary heading reflecting its topic.",
        "Extract headings; confirm a descriptive primary heading exists.",
        "Google Search Central: seo-starter-guide",
        Severity.LOW,
    ),
    SEOCheck(
        "onpage.structured_data_valid",
        "onpage", "schema.validate",
        "Structured data (JSON-LD) is valid, uses schema.org, and has required "
        "properties. Validity does NOT guarantee a rich result.",
        "Validate structured data; list errors + missing required properties.",
        "Google Search Central: structured-data/intro",
        Severity.LOW,
    ),
    SEOCheck(
        "onpage.structured_data_matches_visible",
        "policy", "structured_data.extract",
        "Structured data must describe VISIBLE page content — marking up invisible/"
        "absent content is a spam policy (manual-action risk).",
        "Compare structured-data entities against extracted visible content.",
        "Google Search Central: spam-policies / structured-data",
        Severity.HIGH,
    ),
    # ---- content -----------------------------------------------------------
    SEOCheck(
        "content.thinness",
        "content", "content.extract",
        "Primary content is substantive (not thin/empty). Report as a signal — there "
        "is NO word-count target ('No, we don't').",
        "Extract main content + word count; flag near-empty pages.",
        "Google Search Central: creating-helpful-content",
        Severity.LOW,
    ),
    SEOCheck(
        "content.duplicate",
        "content", "text.compare",
        "Key pages are not near-duplicates of each other without canonicalization.",
        "Compare candidate pages for high similarity.",
        "Google Search Central: consolidate-duplicate-urls",
        Severity.MEDIUM,
    ),
    SEOCheck(
        "content.keyword_stuffing",
        "policy", "keywords.extract",
        "Content is not keyword-stuffed (unnatural repetition to manipulate ranking) — "
        "a spam policy.",
        "Extract keywords/density; flag unnatural repetition.",
        "Google Search Central: spam-policies",
        Severity.MEDIUM,
    ),
    SEOCheck(
        "content.readability",
        "content", "readability.measure",
        "Content readability is reasonable for its audience (editorial quality, NOT a "
        "direct ranking factor).",
        "Measure readability score.",
        "Google Search Central: creating-helpful-content",
        Severity.INFO,
    ),
    # ---- technical ---------------------------------------------------------
    SEOCheck(
        "technical.mixed_content",
        "technical", "mixed_content.scan",
        "HTTPS pages load no insecure (HTTP) subresources (mixed content).",
        "Scan for HTTP resources on the HTTPS page.",
        "Google Search Central: page-experience (HTTPS)",
        Severity.MEDIUM,
    ),
    SEOCheck(
        "technical.response_headers",
        "technical", "headers.analyze",
        "Response headers are sane: no accidental X-Robots-Tag noindex, correct "
        "content-type, caching sane.",
        "Analyze response headers.",
        "Google Search Central: block-indexing / crawling",
        Severity.MEDIUM,
    ),
    SEOCheck(
        "international.hreflang",
        "international", "metadata.audit",
        "hreflang annotations are reciprocal (each version links all + itself), use "
        "ISO 639-1 + ISO 3166-1 codes, x-default, fully-qualified canonical targets.",
        "Read hreflang; verify reciprocity + code validity.",
        "Google Search Central: international/localized-versions",
        Severity.MEDIUM,
        applicability="multilingual/multi-region site only",
    ),
    # ---- policy (violation risk, flagged not verdicted) --------------------
    SEOCheck(
        "policy.cloaking",
        "policy", "page.scrape",
        "The content served to crawlers matches what users see (no cloaking).",
        "Compare content across user-agents where observable.",
        "Google Search Central: spam-policies",
        Severity.HIGH,
    ),
    SEOCheck(
        "policy.hidden_text",
        "policy", "page.scrape",
        "No text/links hidden solely to manipulate search (off-screen CSS, 0-opacity, "
        "same-color-as-background).",
        "Inspect CSS/markup for hidden-text patterns.",
        "Google Search Central: spam-policies",
        Severity.MEDIUM,
    ),
    # ---- KNOWN GAPS (Phase 2) -> status UNSUPPORTED, never fabricated -------
    SEOCheck(
        "gap.index_coverage",
        "crawl_index", "",
        "Actual indexation status / index coverage requires Google Search Console "
        "(URL Inspection / Page Indexing) — not available in Phase 2.",
        "Would require GSC URL Inspection API.",
        "Google Search Central: URL Inspection (API gap)",
        Severity.INFO,
        applicability="reported as UNSUPPORTED",
        supported=False,
    ),
    SEOCheck(
        "gap.core_web_vitals",
        "technical", "",
        "Core Web Vitals (LCP<=2.5s, INP<=200ms, CLS<=0.1 at the 75th pct of CrUX "
        "FIELD data) require CrUX/PageSpeed Insights — not in the SEO tool set. "
        "Page experience is a tiebreaker, not a primary factor.",
        "Would require CrUX/PSI.",
        "web.dev/vitals; Google page-experience (API gap)",
        Severity.INFO,
        applicability="reported as UNSUPPORTED",
        supported=False,
    ),
    SEOCheck(
        "gap.ranking_traffic",
        "crawl_index", "",
        "Actual rankings / organic traffic / manual actions / security issues require "
        "Search Console + Analytics — not available in Phase 2.",
        "Would require GSC + GA4.",
        "Google Search Central: Search Console (API gap)",
        Severity.INFO,
        applicability="reported as UNSUPPORTED",
        supported=False,
    ),
    SEOCheck(
        "gap.render_parity",
        "technical", "",
        "Full JavaScript render parity / mobile-vs-desktop rendered-DOM comparison "
        "requires a rendering engine (excluded Actors tools) — not in Phase 2.",
        "Would require a headless-render capability.",
        "Google Search Central: JavaScript SEO (render gap)",
        Severity.INFO,
        applicability="reported as UNSUPPORTED",
        supported=False,
    ),
)


def checks_digest(supported_only: bool = True) -> str:
    """A compact `check_id [phase] -> expected` digest for the skill guidance."""
    rows = [c for c in SEO_CHECKS if (c.supported or not supported_only)]
    return "\n".join(f"- {c.check_id} [{c.phase}]: {c.expected}" for c in rows)


KNOWN_GAPS: tuple[SEOCheck, ...] = tuple(c for c in SEO_CHECKS if not c.supported)

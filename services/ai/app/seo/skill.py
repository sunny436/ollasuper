"""The ONE canonical SEO skill — TRUSTED, provider-neutral audit GUIDANCE (not a
tool, not an agent). It encodes the methodology, diagnostic order, routing logic,
safety constraints, output standards and the epistemics that keep findings honest.

Every rule traces to an authoritative source (Google Search Central / web.dev);
the volatile specifics live in `checks.py` (the rule base) and `capabilities.py`
(the tool map). This manifest renders a BUDGET-BOUNDED digest of them into the
system prompt on activation — it is guidance, never the full catalogue.
"""

from __future__ import annotations

from app.seo.capabilities import capability_summary
from app.seo.checks import checks_digest
from app.skills.manifest import SkillManifest

_METHODOLOGY = (
    "Model Google as CRAWL -> INDEX -> SERVE, and audit in that order: a serve-time "
    "nicety is worthless if the page cannot be crawled or indexed. The purpose of an "
    "audit is to PREVENT crawl/index interference and to surface the few actionable, "
    "high-impact fixes — not to emit a long list of everything imperfect (Google/"
    "Martin Splitt: finding issues is only half of an audit). Every finding is "
    "evidence-based: state what was OBSERVED, what the rule EXPECTS, and a concrete "
    "VERIFICATION method — never an opinion. Separate signal from noise: a 404 spike "
    "right after content was intentionally removed is EXPECTED (WARN/NOT_APPLICABLE, "
    "not FAIL); a ranking slip 2->4 is normal volatility, 4->29 is a real problem. "
    "Prioritise on TWO independent axes that are never collapsed into one number: "
    "(1) crawl/index impact (does it block crawling, indexing or serving now?) and "
    "(2) business exposure (does it hit high-value pages, and at what scale — one "
    "issue templated across thousands of pages is not 'minor'). NEVER reduce an audit "
    "to a single 0-100 score; Google explicitly warns against arbitrary scores and "
    "numerical limits. Report coverage, pass/fail/warn, and what was NOT tested "
    "instead."
)

_INSTRUCTIONS = (
    "Work the diagnostic order, and for each step name the capability intent that "
    "verifies it and the verification method:\n"
    "1) CRAWL/INDEX FOUNDATIONS (first): robots.txt (robots.analyze — controls "
    "CRAWLING not indexing; never block CSS/JS; a Disallow'd page can still be "
    "indexed if linked); indexability + meta-robots/X-Robots-Tag (metadata.audit, "
    "headers.analyze — a Disallow+noindex combo gives NO protection because Googlebot "
    "never sees the noindex); canonical (metadata.audit — self-referential, absolute, "
    "one method, consistent; signal strength redirect>rel=canonical>sitemap>internal "
    "link>HTTPS); redirects/status (redirects.map — 301 permanent, 302 weak, 404/410 "
    "removed, 503 temporary; chains <=3; no soft-404s); sitemap (sitemap.inspect — "
    "canonical indexable URLs only, <=50k/50MB, accurate lastmod); HTTPS (ssl.check).\n"
    "2) ARCHITECTURE: internal linking + orphans (crawl.run); anchor descriptiveness "
    "(anchor_text.audit); crawl budget ONLY if the site is large/fast-changing (see "
    "applicability) — else NOT_APPLICABLE.\n"
    "3) ON-PAGE: title/meta/headings (metadata.audit, content.extract); structured "
    "data validity + visible-content match (schema.validate, "
    "structured_data.extract).\n"
    "4) CONTENT: thinness/keywords/readability/duplication (content.extract, "
    "keywords.extract, readability.measure, text.compare).\n"
    "5) TECHNICAL: mixed content (mixed_content.scan); response headers "
    "(headers.analyze); international hreflang if multi-locale (metadata.audit).\n"
    "Then synthesise. ROUTING: one page or one bounded check -> call the tools "
    "directly. A whole-site audit, multi-source diagnosis, a traffic-drop "
    "investigation or a migration recovery -> delegate_to_agent('seo', ...). A pure "
    "concept question ('what is a canonical tag?') -> answer from this methodology "
    "with NO tools. A vague ask ('audit this') with no URL/scope -> ask ONE "
    "clarifying question first. Traffic-drop diagnosis follows Google's category tree "
    "(technical vs algorithmic vs manual-action/security vs seasonal vs migration) "
    "and requires a 16-month / year-over-year baseline before concluding a cause.\n\n"
    "Capability intents available:\n" + capability_summary() + "\n\n"
    "Rule base (observed-vs-expected per check):\n" + checks_digest()
)

_CONSTRAINTS = (
    "READ-ONLY: never mutate, submit, purchase, or trigger any side effect; use ONLY "
    "the SEO capability intents above (never account, billing, automation, AEO, or "
    "actor tools). CAPABILITY-GAP HONESTY is mandatory: if a check cannot be verified "
    "with the available tools, mark it UNSUPPORTED with the reason — NEVER hallucinate "
    "data, invent a metric, or pretend another API exists. FIRST-PARTY evidence (when "
    "the user has CONNECTED Google): gsc.url_inspection = real index status; "
    "gsc.search_analytics + ga4.report = traffic-drop diagnosis (the site's own "
    "clicks/positions + sessions); psi.field = real-user Core Web Vitals (CrUX p75), "
    "psi.lab = a synthetic lab view (never present lab as field). Keep these "
    "PROVENANCE-SEPARATED from public/OllaGraph crawl evidence, and do NOT reconcile "
    "GSC and GA4 row-by-row (they measure different populations). If a connector tool "
    "returns connected:false / NOT_CONNECTED (or needs_reauth), emit UNSUPPORTED with "
    "a 'connect Google in Settings → Connections' recommendation — never fabricate. "
    "Remaining hard gaps (always UNSUPPORTED): manual actions & security issues, and "
    "full JavaScript render parity / mobile-vs-desktop rendered-DOM comparison (need a "
    "rendering engine). EPISTEMICS — state effects only at the "
    "level the source supports, and scope Google-specific claims to Google: E-E-A-T "
    "is NOT a direct ranking factor (a concept Google's systems approximate; trust is "
    "central; weighed more for YMYL); page experience / Core Web Vitals are a "
    "TIEBREAKER, and good vitals do NOT guarantee ranking; titles and meta "
    "descriptions affect CTR/appearance, NOT ranking directly, and Google may rewrite "
    "them; there is NO word-count preference; structured-data validity does NOT "
    "guarantee a rich result. NEVER promise a ranking outcome from a fix — describe "
    "the mechanism and the evidence instead."
)

_OUTPUT = (
    "Every finding is a typed SEOFinding: check_id, intent, status (PASS/FAIL/WARN/"
    "NOT_TESTED/NOT_APPLICABLE/UNSUPPORTED), observation, expected, affected URLs, "
    "evidence records, severity, confidence, recommendation, verification, and any "
    "data-quality flags. The whole audit is a typed SEOReport: target, coverage "
    "(intents attempted), checks_performed, passed/failed/warnings, missing_data "
    "(NOT_TESTED + UNSUPPORTED), evidence_freshness, and a QUALITATIVE "
    "business_exposure narrative. There is NO numeric 0-100 score anywhere in the "
    "output."
)

# Intents that SEED the working set on activation (authorization still enforced by
# the agent's read-only scope). The bounded core; the long tail stays reachable via
# find_capabilities.
_PREFERRED = frozenset(
    {
        "metadata.audit",
        "robots.analyze",
        "sitemap.inspect",
        "redirects.map",
        "headers.analyze",
        "schema.validate",
        "broken_links.check",
        "content.extract",
    }
)

SEO_SKILL = SkillManifest(
    skill_id="seo-audit",
    name="SEO Audit",
    version="1.0.0",
    purpose="rigorous, evidence-backed technical SEO auditing",
    when_to_use=(
        "auditing a site or page for SEO; diagnosing indexing, crawling, canonical, "
        "redirect, sitemap, robots, structured-data or traffic-drop issues"
    ),
    tags=frozenset(
        {
            "seo",
            "audit",
            "meta",
            "metadata",
            "crawl",
            "crawling",
            "robots",
            "sitemap",
            "canonical",
            "redirect",
            "redirects",
            "index",
            "indexing",
            "indexation",
            "schema",
            "structured-data",
            "hreflang",
            "keywords",
            "readability",
            "serp",
            "ranking",
            "backlinks",
        }
    ),
    methodology=_METHODOLOGY,
    instructions=_INSTRUCTIONS,
    constraints=_CONSTRAINTS,
    output_expectations=_OUTPUT,
    preferred_capabilities=_PREFERRED,
    require_approval=frozenset(),  # read-only: nothing to gate
)

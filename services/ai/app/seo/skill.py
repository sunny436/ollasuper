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
    "nicety is worthless if the page cannot be crawled or indexed. THE SCOPE OF THE "
    "REPORT IS SET BY THE QUESTION — audit only what was asked (a single page, one "
    "subsystem, a diagnosis) and produce a FULL site audit ONLY when it is explicitly "
    "requested. The purpose is to PREVENT crawl/index interference and to surface the "
    "few actionable, high-impact fixes — not to emit a long list of everything "
    "imperfect (Google/Martin Splitt: finding issues is only half of an audit). Every "
    "finding is evidence-based: state what was OBSERVED, what the rule EXPECTS, and a "
    "concrete VERIFICATION method — never an opinion. Separate signal from noise: a "
    "404 spike right after content was intentionally removed is EXPECTED (WARN/"
    "NOT_APPLICABLE, not FAIL); a ranking slip 2->4 is normal volatility, 4->29 is a "
    "real problem. Prioritise on TWO independent axes: (1) crawl/index impact (does it "
    "block crawling, indexing or serving now?) and (2) business exposure (does it hit "
    "high-value pages, and at what scale — one issue templated across thousands of "
    "pages is not 'minor'). Express overall health as a HYBRID score: a 0-100 "
    "SEO-health number plus a status word, per assessed category and overall, computed "
    "from issue severity, SEO impact, affected-page scope, page importance and "
    "confidence — NOT from the raw percentage of checks passed. The score measures the "
    "HEALTH OF THE AUDITED SIGNALS ONLY; it is NOT a ranking prediction and a higher "
    "score never means 'ranks higher' (Google warns against treating an arbitrary "
    "score as a ranking guarantee). Critical crawl/index problems override the "
    "headline regardless of the number."
)

_INSTRUCTIONS = (
    "STEP 0 — CLASSIFY, SCOPE, ROUTE (before any tool call):\n"
    "• CLASSIFY the query into SEO intent(s); more than one may apply. Split them "
    "into a SUPPORTED cluster {technical, crawlability, indexability-mechanism, "
    "on-page, content, internal-linking, site-architecture, international, on-page "
    "keywords, the technical branch of a ranking/traffic diagnosis} you CAN verify "
    "with the tools below, and a GAP cluster {backlinks, domain authority, live "
    "rankings, organic traffic, competitor authority, keyword volume/difficulty, "
    "local/Google-Business, historical comparison, field Core Web Vitals, GSC index "
    "coverage} that has NO data source — for a GAP intent, state the honest "
    "UNSUPPORTED note and do NOT open a section for it.\n"
    "• SCOPE the answer: page-level, site-level, topic-level, or problem/diagnostic. A "
    "pure concept question ('what is a canonical tag?') -> answer from this "
    "methodology with NO tools. A vague ask ('audit this') with no URL/scope -> ask "
    "ONE clarifying question first.\n"
    "• ROUTE: run ONLY the check groups the activated intents need — never the whole "
    "battery for a narrow ask. A full audit (all groups) runs ONLY when explicitly "
    "requested.\n"
    "DIAGNOSTIC ORDER (subset it to the activated intents), each step naming the "
    "capability intent that verifies it:\n"
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
    "DIAGNOSIS ('why isn't my site ranking / traffic dropped') follows Google's tree: "
    "segment the drop (organic-only vs all-channels, page-level vs sitewide, sudden "
    "cliff vs gradual decay, clicks-vs-impressions — impressions held + clicks fell "
    "points at title/snippet/lost rich result; both fell points at ranking/indexing/"
    "update/demand). Assess the technical/crawl/index branch you CAN see, and state "
    "plainly that the rankings / organic-traffic / algorithmic-update / manual-action "
    "branch needs first-party GSC + Analytics with a 16-month baseline (UNSUPPORTED). "
    "Never conclude a cause you cannot evidence.\n"
    "EXECUTION: gather evidence with the tools FIRST — call every INDEPENDENT check "
    "together in ONE step so they run in parallel (e.g. robots, sitemap, headers, "
    "redirects, mixed-content, broken-links, structured-data, metadata all at once; "
    "for a multi-page audit read the sitemap / crawl first, THEN audit the key URLs in "
    "parallel). Only after the evidence is in do you synthesise and WRITE THE REPORT "
    "yourself, in this same turn, as your streamed answer. RUN THE AUDIT INLINE — do "
    "NOT hand it to another agent.\n\n"
    "Capability intents available:\n" + capability_summary() + "\n\n"
    "Rule base (observed-vs-expected per check):\n" + checks_digest()
)

_CONSTRAINTS = (
    "READ-ONLY: never mutate, submit, purchase, or trigger any side effect; use ONLY "
    "the SEO capability intents above (never account, billing, automation, AEO, or "
    "actor tools). CAPABILITY-GAP HONESTY is mandatory: if a check cannot be verified "
    "with the available tools, mark it UNSUPPORTED with the reason — NEVER hallucinate "
    "data, invent a metric, or pretend another API exists. "
    "Hard gaps (always UNSUPPORTED, no first-party data source): actual index "
    "coverage / live rankings / organic traffic (Search Console + Analytics), "
    "real-user Core Web Vitals field data (CrUX), manual actions & security issues, "
    "backlinks & domain authority, competitor authority, keyword volume/difficulty, "
    "local / Google-Business data, historical / period-over-period comparison, and "
    "full JavaScript render parity / mobile-vs-desktop rendered-DOM comparison (need a "
    "rendering engine).\n"
    "NO EMPTY SECTIONS: render a category only when it has real findings or a stated "
    "UNSUPPORTED note — never a heading with nothing under it.\n"
    "AVOID FALSE POSITIVES (be context-aware, not rule-blind): a theoretical issue "
    "with no real consequence is noise, not a finding. Multiple H1s, a long title, or "
    "a high word count are NOT automatically faults — judge them in context. Absence "
    "seen only through a non-rendering HTTP fetch is NOT proof of absence: JS-injected "
    "schema, content or links can be invisible to the fetch, so write 'not observed in "
    "fetched HTML (may be client-rendered)', never 'missing'.\n"
    "EVIDENCE TIERS: label each claim OBSERVED (a tool measured it), INFERRED (deduced "
    "— give the reasoning), or RECOMMENDED (best practice, not measured); never "
    "present an inference as a fact. Distinguish a confirmed ranking factor from a "
    "best practice from an opportunity.\n"
    "EPISTEMICS — state effects only at the "
    "level the source supports, and scope Google-specific claims to Google: E-E-A-T "
    "is NOT a direct ranking factor (a concept Google's systems approximate; trust is "
    "central; weighed more for YMYL); page experience / Core Web Vitals are a "
    "TIEBREAKER, and good vitals do NOT guarantee ranking; titles and meta "
    "descriptions affect CTR/appearance, NOT ranking directly, and Google may rewrite "
    "them; there is NO word-count preference; structured-data validity does NOT "
    "guarantee a rich result. NEVER promise a ranking outcome from a fix — describe "
    "the mechanism and the evidence instead. The SEO-health score likewise measures "
    "signal health, NOT ranking; never imply a higher score ranks higher."
)

_OUTPUT = (
    "Deliver a POLISHED, QUERY-SHAPED MARKDOWN REPORT the way a senior SEO auditor "
    "writes for a client — streamed as your answer, grounded ONLY in what the tools "
    "observed (cite the real value and affected URL(s); never invent a number, metric "
    "or API). The report ADAPTS to the classified scope: a page/technical/diagnostic "
    "ask gets a FOCUSED report, a full audit gets a comprehensive one — never a fixed "
    "template, never a padded or empty section. Use plain, user-friendly language and "
    "gloss every jargon term the first time it appears. Structure:\n"
    "1. `# SEO Audit — <target>` + a one-line verdict + a scope line stating exactly "
    "what THIS report covers and what it does not.\n"
    "2. If a P0 crawl/index blocker exists, a `> ⚠️ **Critical blocker**` callout "
    "FIRST, before anything else.\n"
    "3. `## Direct answer` — answer the user's ACTUAL question up front (what's wrong, "
    "why, how much it matters, how to fix, what to do first). Lead here, not with a "
    "generic summary.\n"
    "4. `## SEO health` — an overall `SEO Health: NN/100 — <Status>` line + ONE "
    "sentence on what drives it, then a table of the ASSESSED categories "
    "(`Category | Score | Status | Driver`). Status bands: Excellent 90-100 / Good "
    "75-89 / Fair 60-74 / Needs Work 40-59 / Critical 0-39. Score each category from "
    "100 minus, per finding, severity_weight (P0~40 P1~22 P2~10 P3~4) x scope_factor "
    "(sitewide/template 1.0 -> single page 0.25) x confidence_factor (High 1.0 Med 0.7 "
    "Low 0.4), weighting high-value pages more; floor 0. Give a one-line DRIVER per "
    "category (e.g. 'one P1 canonical issue across 8/12 pages') so the number is "
    "auditable. Overall = importance-weighted average of the ASSESSED categories "
    "(crawl/index heaviest). A category with no data source is 'Not assessed — needs "
    "<source>', NEVER 0. A P0 crawl/index blocker caps the overall status (never "
    "Excellent/Good) even when the number is high. Caption once: health of audited "
    "signals, not a ranking prediction.\n"
    "5. `## Findings` — grouped under ONLY the activated categories (`### Crawl & "
    "Indexing`, `### On-Page`, `### Technical`, `### Content`, `### Architecture`, "
    "`### International`, …). CORRELATE related findings that share a root cause into "
    "ONE entry rather than repeating them. Render each as a block led by a "
    "priority+confidence tag:\n"
    "`- **[P1 · High confidence] <title>**` then plain-language lines — *What it is* "
    "(gloss the jargon), *Evidence* (OBSERVED value + affected URLs + scale/% of pages "
    "hit), *Why it matters*, *Root cause* (WHY is this happening), *Impact* (crawl/"
    "index impact AND business exposure — the two axes), *How to fix* (concrete; a "
    "before→after example where it helps), *Recommended action*. Order by priority.\n"
    "6. `### What's already good` — the checks that passed, so the client sees what is "
    "healthy and verified.\n"
    "7. `## Prioritised action plan` — a markdown TABLE (Priority | Action | Impact | "
    "Effort | Where), P0 first.\n"
    "8. `## Limitations` — what needs first-party data this audit cannot see (the "
    "UNSUPPORTED gaps), so nothing reads as falsely clean.\n"
    "Priority P0-P3 reflects impact x SEO importance x affected pages x confidence — "
    "NOT how easy the issue was to detect. Keep it focused: a senior audit surfaces "
    "what matters for the question asked, not an exhaustive dump of every nitpick."
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

"""Marketing Assistant — OUTPUT-QUALITY contract (hermetic). Asserts the skill encodes
each pod's methodology + output, the 3 orchestration sequences, the composition
delegation rules, and the safety frame — so 'the skill was added' can never mean 'the
methodology is missing'. Real output is verified on prod by qa-marketing.js."""

from __future__ import annotations

from app.marketing.skill import MARKETING_SKILL

_ALL = (
    MARKETING_SKILL.methodology
    + "\n"
    + MARKETING_SKILL.instructions
    + "\n"
    + MARKETING_SKILL.constraints
    + "\n"
    + MARKETING_SKILL.output_expectations
)
_LOW = _ALL.lower()


def _has(*needles: str) -> None:
    for n in needles:
        assert n.lower() in _LOW, f"missing output-contract marker: {n!r}"


def test_global_safety_frame():
    _has("fact", "inference", "assumption", "recommendation")
    _has("🟢", "🟡", "🔴")
    _has("never fabricate", "untrusted", "read-only")
    _has(
        "no false automation", "hubspot", "crm"
    )  # never claim ads/analytics/CRM access


# --- pods ------------------------------------------------------------------
def test_strategy_pmm_contract():
    _has(
        "icp",
        "positioning",
        "april dunford",
        "messaging",
        "gtm",
        "launch",
        "market entry",
        "competitive",
        "battlecard",
        "pricing",
    )
    _has("6-8wk", "3-4wk")  # launch tiers


def test_demand_channels_contract():
    _has("demand", "channel mix", "roas", "paid media", "campaign")


def test_content_and_social_contract():
    _has("content strategy", "pillars", "calendar", "social")


def test_cro_contract():
    _has("cro", "funnel", "bottleneck", "friction", "hypotheses", "experiment")


def test_growth_and_aeo_contract():
    _has("referral", "churn", "retention")
    _has("aeo", "e-e-a-t", ">=70", ">=85")  # AEO thresholds


def test_intelligence_contract():
    _has("attribution", "psychology", "campaign analytics")


# --- orchestration sequences (must be preserved, not just mentioned) -------
def test_orchestration_sequences_present():
    _has("launch", "content campaign", "cro sprint")
    _has(
        "marketing-context",
        "launch-strategy",
        "content-strategy",
        "email-sequence",
        "campaign-analytics",
    )  # the launch sequence steps
    _has("ab-test-setup", "analytics-tracking")  # the CRO sprint steps


# --- composition (delegate, don't duplicate) -------------------------------
def test_composition_rules():
    _has("delegate to the seo", "delegate to the blog", "deep research")
    _has("data-analysis", "finance_calc")
    _has("cold outbound", "sales")  # cold outbound email is Sales, not marketing
    _has("lifecycle", "nurture")  # nurture/drip email IS marketing


# --- numbers always from tools ---------------------------------------------
def test_numbers_from_tools():
    _has("marketing_calc", "marketing_reference")
    _has("sample_size", "ab_test", "funnel", "attribution")
    _has("never hand-compute")


def test_time_sensitive_facts_rule_survives_compaction():
    minimal = MARKETING_SKILL.render_minimal().lower()
    for needle in (
        "time-sensitive facts",
        "retrieval date",
        "never 🟢",
        "re-check every 🟢",
    ):
        assert needle in minimal, f"constraint not in minimal render: {needle!r}"

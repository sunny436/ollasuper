"""Finance Assistant (corporate FP&A / SaaS / investment) — OUTPUT-QUALITY contract
(hermetic). Asserts the skill instructs COMPLETE, CORRECT output for EACH source
capability (nothing 'implicitly covered') plus the safety frame — so 'the skill was
added'
can never mean 'the methodology is missing'. Real end-to-end output is verified on prod
by
e2e/qa-finance.js."""

from __future__ import annotations

from app.finance.skill import FINANCE_SKILL

_ALL = (
    FINANCE_SKILL.methodology
    + "\n"
    + FINANCE_SKILL.instructions
    + "\n"
    + FINANCE_SKILL.constraints
    + "\n"
    + FINANCE_SKILL.output_expectations
)
_LOW = _ALL.lower()


def _has(*needles: str) -> None:
    for n in needles:
        assert n.lower() in _LOW, f"missing output-contract marker: {n!r}"


# --- global safety / labels / no-false-automation / privacy ----------------
def test_global_safety_frame():
    _has("fact", "calculation", "assumption", "estimate", "recommendation")
    _has("never fabricate", "untrusted", "read-only")
    _has("no false automation", "erp", "accounting")  # never claim live systems
    _has("privacy", "remember", "not licensed")
    _has("finance_calc")  # numbers always from the deterministic tool


# --- 1. FP&A: statements / ratios / DCF / variance / forecast --------------
def test_fpa_contract():
    _has("ratios", "profitability", "liquidity", "leverage", "efficiency", "valuation")
    _has("dcf", "wacc", "terminal value", "sensitivity", "per-share")
    _has("variance", "favorable", "unfavorable", "materiality", "10%", "$50,000")
    _has("forecast", "base", "bull", "bear", "cash flow")


# --- 2. SaaS metrics + benchmark bands + definitions -----------------------
def test_saas_contract():
    _has(
        "arr",
        "mrr",
        "churn",
        "cac",
        "ltv",
        "ltv:cac",
        "cac payback",
        "nrr",
        "rule of 40",
    )
    _has("one-sentence definition", "benchmark", "band")
    _has("enterprise", "mid-market", "smb", "consumer")  # churn segments
    _has("<80%", ">120%")  # NRR bands


# --- 3. investment appraisal ----------------------------------------------
def test_investment_contract():
    _has("roi", "payback", "npv", "irr", "hurdle", "$25,000")
    _has("10-15%", "20-25%", "30%")  # hurdle tiers
    _has("6-12", "13-20", "21-30")  # scoring rubric bands
    _has("single", "compare", "trade-off")  # modes
    _has("🟢", "🟡", "🔴")  # confidence tags
    _has("recommendation")


# --- jargon-free intent + defer to siblings --------------------------------
def test_plain_language_and_boundaries():
    _has(
        "financially healthy",
        "how much is this company worth",
        "making more sales but still losing money",
        "can we afford",
    )
    _has("equity-research")  # defer listed-stock analysis


def test_business_case_rule_survives_compaction():
    minimal = FINANCE_SKILL.render_minimal().lower()
    assert "kind='business_case'" in minimal
    assert "never npv_irr for that shape" in minimal
    _has("finance_calc kind='business_case' for a recurring-cost case")

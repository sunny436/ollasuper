"""Finance math — NUMERIC CORRECTNESS (hermetic, exact) + the guidance<->code drift
guard.
Every formula/default/threshold is verified against the source finance scripts; the two
Finance skills must document the SAME numbers so guidance and code cannot drift. Also
covers the edge cases the second-pass brief named: divide-by-zero, missing values,
units,
percents, currency parsing, rounding, WACC<=g, and base-FCF<=0."""

from __future__ import annotations

import math

import pytest

from app.finance import calc as C
from app.finance.equity import EQUITY_SKILL
from app.finance.skill import FINANCE_SKILL


# --- helpers / divide-by-zero / parsing ------------------------------------
def test_div_and_parse_edges():
    assert C._div(1, 0) is None and C._div(1, None) is None and C._div(None, 2) is None
    assert C._div(6, 3) == 2.0
    assert C._f("$1,250.50") == 1250.5 and C._f("12%") == 12.0
    assert C._f("", 0.0) == 0.0 and C._f("abc") is None and C._f(None) is None


# --- 1. ratios (exact + benchmark interpretation + ÷0 -> None) -------------
def test_ratios_exact():
    data = {
        "income_statement": {
            "revenue": 1000,
            "cost_of_goods_sold": 600,
            "operating_income": 200,
            "net_income": 100,
            "interest_expense": 20,
            "ebitda": 250,
        },
        "balance_sheet": {
            "total_equity": 500,
            "total_assets": 1200,
            "current_assets": 400,
            "current_liabilities": 200,
            "inventory": 100,
            "cash_and_equivalents": 80,
            "total_debt": 300,
            "accounts_receivable": 125,
        },
        "cash_flow": {"operating_cash_flow": 150},
        "market_data": {
            "share_price": 20,
            "shares_outstanding": 50,
            "earnings_growth_rate": 0.1,
        },
    }
    r = C.ratios(data)["categories"]
    assert r["profitability"]["net_margin"]["value"] == 0.1  # 100/1000
    assert r["profitability"]["gross_margin"]["value"] == 0.4  # (1000-600)/1000
    assert r["profitability"]["roe"]["value"] == 0.2  # 100/500
    assert r["liquidity"]["current_ratio"]["value"] == 2.0  # 400/200
    assert r["liquidity"]["quick_ratio"]["value"] == 1.5  # (400-100)/200
    assert r["leverage"]["debt_to_equity"]["value"] == 0.6  # 300/500
    assert r["leverage"]["interest_coverage"]["value"] == 10.0  # 200/20
    assert r["efficiency"]["receivables_turnover"]["value"] == 8.0  # 1000/125
    assert r["efficiency"]["dso"]["value"] == 45.625  # 365/8
    # EPS=100/50=2, P/E=20/2=10 ; BVPS=500/50=10, P/B=20/10=2
    assert r["valuation"]["pe_ratio"]["value"] == 10.0
    assert r["valuation"]["pb_ratio"]["value"] == 2.0
    assert "interpretation" in r["profitability"]["roe"]


def test_ratio_divide_by_zero_is_none_not_zero():
    data = {
        "income_statement": {"revenue": 0, "net_income": 100},
        "balance_sheet": {"total_equity": 0},
    }
    r = C.ratios(data)["categories"]
    assert r["profitability"]["net_margin"]["value"] is None  # revenue 0
    assert r["profitability"]["roe"]["value"] is None  # equity 0
    assert "Insufficient" in r["profitability"]["roe"]["interpretation"]


# --- 2. WACC / DCF (exact + sensitivity + WACC<=g + missing) ---------------
def test_wacc_exact():
    w = C.wacc()  # CAPM defaults
    assert w["cost_of_equity"] == 0.1  # 0.04 + 1.0*0.06
    assert w["after_tax_cost_of_debt"] == 0.0375  # 0.05*(1-0.25)
    assert w["wacc"] == 0.0812  # 0.70*0.10 + 0.30*0.0375 = 0.08125, displayed to 4dp
    assert C._wacc_raw()[0] == pytest.approx(
        0.08125
    )  # full precision used for the math


def test_dcf_exact_and_sensitivity_grid():
    d = C.dcf(revenue=100.0)
    assert d["wacc"]["wacc"] == 0.0812  # display
    assert d["price_per_share"] == pytest.approx(
        203.2, abs=0.05
    )  # raw-WACC discounting
    assert d["equity_value"] == d["price_per_share"]  # net_debt 0, shares 1
    grid = d["sensitivity"]["price_per_share"]
    assert len(grid) == 5 and all(len(row) == 5 for row in grid)


def test_dcf_wacc_le_growth_zeroes_terminal_and_nulls_cells():
    # terminal growth 10% > WACC 8.125% -> TV 0.0; sensitivity cells where wacc<=g ->
    # None
    d = C.dcf(revenue=100.0, terminal_growth=0.10)
    assert d["terminal_value"] == 0.0
    flat = [c for row in d["sensitivity"]["price_per_share"] for c in row]
    assert any(c is None for c in flat)  # some undefined perpetuity cells


def test_dcf_exit_multiple_method():
    d = C.dcf(revenue=100.0, terminal_method="exit")
    assert d["terminal_value"] > 0 and d["price_per_share"] is not None


def test_dcf_missing_revenue_raises():
    with pytest.raises(ValueError):
        C.dcf(revenue=None)


# --- 3. equity valuation (2-stage+fade, reverse-DCF, EV bridge, scenario) --
def test_ev_bridge_exact():
    b = C.ev_bridge(
        market_cap=1000,
        total_debt=300,
        lease_liabilities=50,
        minority_interest=20,
        preferred=10,
        cash=100,
        associate_investments=30,
    )
    assert b["enterprise_value"] == 1250.0  # 1000+300+50+20+10-100-30
    assert b["net_debt"] == 250.0  # 300+50-100


def test_two_stage_dcf_and_rate_normalization():
    # wacc=10, growth=8 given as PERCENTS (>1.5) -> normalized to 0.10 / 0.08
    r = C.two_stage_dcf(base_fcf=100, wacc_=10, stage1_growth=8, terminal_growth=2.5)
    assert r["value_per_share"] is not None and r["enterprise_value"] > 0


def test_two_stage_wacc_le_terminal_errors():
    r = C.two_stage_dcf(
        base_fcf=100, wacc_=0.02, stage1_growth=0.05, terminal_growth=0.03
    )
    assert "error" in r


def test_reverse_dcf_skips_when_base_fcf_nonpositive():
    r = C.reverse_dcf_implied_growth(enterprise_value=1000, base_fcf=0, wacc_=0.10)
    assert r["implied_growth"] is None and "warning" in r


def test_reverse_dcf_recovers_growth():
    # price EV built FROM a known 12% growth should imply ~12%
    ev = C.two_stage_dcf(
        base_fcf=100, wacc_=0.10, stage1_growth=0.12, terminal_growth=0.025
    )["enterprise_value"]
    r = C.reverse_dcf_implied_growth(
        ev, base_fcf=100, wacc_=0.10, terminal_growth=0.025
    )
    assert r["implied_growth"] == pytest.approx(0.12, abs=0.01)


def test_scenario_table_weighted():
    s = C.scenario_table(
        [
            {"name": "bull", "value_per_share": 120, "probability": 0.3},
            {"name": "base", "eps": 10, "exit_pe": 10, "probability": 0.5},  # 100
            {
                "name": "bear",
                "ebitda": 50,
                "ev_ebitda": 8,
                "net_debt": 0,
                "shares_outstanding": 5,
                "probability": 0.2,
            },  # (400)/5 = 80
        ]
    )
    # 120*.3 + 100*.5 + 80*.2 = 36 + 50 + 16 = 102
    assert s["weighted_value_per_share"] == pytest.approx(102.0, abs=0.01)


# --- 4. investment appraisal (exact) ---------------------------------------
def test_investment_npv_irr_payback_roi_exact():
    r = C.appraise_investment(
        100_000, [30_000, 40_000, 50_000, 60_000], discount_rate=0.12
    )
    assert r["roi_pct"] == 80.0  # (180k-100k)/100k*100
    assert r["payback_years"] == 2.22  # 100k / 45k avg
    assert r["irr"] == pytest.approx(0.2489, abs=0.001)
    assert r["npv"] == pytest.approx(32393.57, abs=1.0)
    assert r["creates_value"] is True


def test_npv_irr_helpers():
    assert C.npv(0.0, [-100, 50, 50, 50]) == 50.0
    assert C.irr([-100, 60, 60]) == pytest.approx(0.1306, abs=0.001)
    assert C.irr([10, 20, 30]) is None  # no sign change
    assert C.roi(50, 0) is None and C.payback(100, 0) is None


# --- 5. SaaS metrics (exact + bands + fallback + ÷0 -> _missing) -----------
def test_saas_metrics_exact_and_bands():
    s = C.saas_metrics(
        mrr=100_000,
        mrr_prev=90_000,
        customers=100,
        churned_customers=3,
        sm_spend=50_000,
        new_customers=10,
        gross_margin=0.8,
        segment="smb",
        stage="growth",
    )
    assert s["arr"]["value"] == 1_200_000
    assert s["mrr_growth_pct"]["value"] == pytest.approx(11.11, abs=0.01)
    assert s["customer_churn_pct"]["value"] == 3.0
    assert s["customer_churn_pct"]["band"] == "healthy"  # SMB churn <4%
    assert s["arpa"]["value"] == 1000.0
    assert s["cac"]["value"] == 5000.0
    assert s["ltv"]["value"] == pytest.approx(26666.67, abs=0.01)  # (1000/0.03)*0.8
    assert s["ltv_cac"]["value"] == pytest.approx(5.33, abs=0.01)
    assert s["ltv_cac"]["band"] == "excellent"  # >5
    assert s["cac_payback_months"]["value"] == pytest.approx(6.25, abs=0.01)
    assert s["nrr_pct"]["value"] == 100.0  # no expansion/contraction given


def test_saas_missing_metric_listed_not_fabricated():
    s = C.saas_metrics(mrr=100_000)  # nothing else
    assert "cac" in s["_missing"] and s["cac"]["value"] is None
    assert "rule_of_40" in s["_missing"]  # no profit margin


def test_saas_bands_thresholds():
    assert (
        C.saas_band("nrr", 79) == "critical"
        and C.saas_band("nrr", 125) == "world-class"
    )
    assert (
        C.saas_band("cac_payback", 5) == "excellent"
        and C.saas_band("cac_payback", 30) == "critical"
    )
    assert C.saas_band("churn", 0.5, segment="enterprise") == "healthy"
    assert C.saas_band("churn", 4, segment="enterprise") == "critical"
    assert C.saas_band("rule_of_40", 45) == "healthy"
    assert C.saas_band("gross_margin", 90) == "world-class"


def test_quick_ratio():
    q = C.quick_ratio(
        new_mrr=8000, expansion_mrr=2000, churned_mrr=1500, contraction_mrr=500
    )
    assert q["quick_ratio"] == 5.0  # (8000+2000)/(1500+500)
    assert C.quick_ratio(1, 0, 0, 0)["quick_ratio"] is None  # no gross churn


# --- 6. variance + materiality ---------------------------------------------
def test_variance_favorability_and_materiality():
    v = C.variance(
        [
            {
                "name": "Revenue",
                "type": "revenue",
                "actual": 1_000_000,
                "budget": 900_000,
            },
            {"name": "COGS", "type": "expense", "actual": 480_000, "budget": 500_000},
            {"name": "Rent", "type": "expense", "actual": 51_000, "budget": 50_000},
        ]
    )
    rev, cogs, rent = v["lines"]
    assert (
        rev["favorability"] == "Favorable" and rev["is_material"]
    )  # +100k over budget
    assert cogs["favorability"] == "Favorable"  # under budget on an expense
    assert (
        rent["favorability"] == "Unfavorable" and not rent["is_material"]
    )  # +2% / +1k
    # only Revenue is material: +100k >= $50k. COGS -20k/-4% and Rent +1k/+2% are below
    # both thresholds.
    assert v["material_count"] == 1
    assert not cogs["is_material"]


def test_is_material_thresholds():
    assert C.is_material(10, 0) and C.is_material(0, 50_000)
    assert not C.is_material(9.9, 49_999)
    assert C.MATERIALITY_PCT == 10.0 and C.MATERIALITY_AMT == 50_000.0


# --- 7. driver forecast ----------------------------------------------------
def test_driver_forecast_compounds_with_scenarios():
    f = C.driver_forecast(base_revenue=1_000_000, periods=12, growth_rate=0.05)
    base = f["scenarios"]["base"]
    assert len(base["periods"]) == 12
    assert base["periods"][0]["revenue"] == 1_050_000.0  # 1M * 1.05
    assert f["scenarios"]["bull"]["growth_rate"] > base["growth_rate"]
    assert f["scenarios"]["bear"]["growth_rate"] < base["growth_rate"]


# --- drift guard: the skills cite the SAME numbers calc uses ---------------
def test_finance_skill_cites_same_constants():
    t = (
        FINANCE_SKILL.methodology
        + FINANCE_SKILL.instructions
        + FINANCE_SKILL.constraints
    ).lower()
    assert "10%" in t and "$50,000" in t  # materiality
    assert "risk-free 4%" in t and "2.5%" in t and "12x" in t  # DCF defaults
    assert "10-15%" in t and "20-25%" in t and "30%" in t  # hurdle
    assert "6-12" in t and "13-20" in t and "21-30" in t  # rubric
    assert "$25,000" in t  # NPV/IRR trigger
    assert "<80%" in t and ">120%" in t  # NRR bands
    assert "3-5 healthy" in t and "12-18" in t  # LTV:CAC + CAC payback


def test_equity_skill_states_nonnegotiables():
    t = (
        EQUITY_SKILL.methodology
        + EQUITY_SKILL.instructions
        + EQUITY_SKILL.constraints
        + EQUITY_SKILL.output_expectations
    ).lower()
    assert "never invent a number" in t
    assert "page" in t and "period" in t  # cite document/page/period
    assert "consolidated" in t and "standalone" in t
    assert "crore" in t and ("million" in t or "billion" in t)  # units
    assert "as-of date" in t
    assert "analysis, not advice" in t or "not licensed investment" in t
    assert "finance_reference" in t and "finance_calc" in t
    assert "reverse_dcf" in t or "reverse-dcf" in t
    assert "bear case" in t


def test_no_fabricated_saas_metrics_in_source():
    # Magic Number and Burn Multiple are NOT in the source — must not be invented.
    both = (FINANCE_SKILL.render() + EQUITY_SKILL.render()).lower()
    assert "magic number" not in both and "burn multiple" not in both


def test_no_nan_or_inf_leaks_to_json():
    # WACC<=g sensitivity cells must serialize as None, never inf/nan.
    d = C.dcf(revenue=100.0, terminal_growth=0.10)
    for row in d["sensitivity"]["price_per_share"]:
        for c in row:
            assert c is None or math.isfinite(c)

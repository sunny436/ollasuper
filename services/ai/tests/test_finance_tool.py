"""The `finance_calc` + `finance_reference` reserved tools — per-kind exact numbers,
tolerant $/,/% parsing, and bad-input -> {"error": …} (never raises into the
tool loop)."""

from __future__ import annotations

import pytest

from app.finance.tool import (
    FINANCE_TOOL_NAMES,
    compute_finance_calc,
    run_finance_reference,
)


def test_tool_names():
    assert FINANCE_TOOL_NAMES == {"finance_calc", "finance_reference"}


def test_kind_ratios_through_tool():
    out = compute_finance_calc(
        {
            "kind": "ratios",
            "statements": {
                "income_statement": {"revenue": 1000, "net_income": 100},
                "balance_sheet": {"total_equity": 500},
            },
        }
    )
    assert out["categories"]["profitability"]["roe"]["value"] == 0.2


def test_kind_dcf_tolerant_parsing():
    # revenue passed as a currency string must parse.
    out = compute_finance_calc({"kind": "dcf", "dcf": {"revenue": "$100"}})
    assert out["price_per_share"] == pytest.approx(203.2, abs=0.05)


def test_kind_npv_irr_exact():
    out = compute_finance_calc(
        {
            "kind": "npv_irr",
            "npv_irr": {
                "initial_investment": "100,000",
                "cash_flows": ["30,000", "40,000", "50,000", "60,000"],
                "discount_rate": "12%",
            },
        }
    )
    assert out["roi_pct"] == 80.0
    assert out["irr"] == pytest.approx(0.2489, abs=0.001)


def test_kind_saas_metrics_bands():
    out = compute_finance_calc(
        {
            "kind": "saas_metrics",
            "saas": {
                "mrr": 100000,
                "mrr_prev": 90000,
                "customers": 100,
                "churned_customers": 3,
                "sm_spend": 50000,
                "new_customers": 10,
                "gross_margin": 0.8,
                "segment": "smb",
                "stage": "growth",
            },
        }
    )
    assert out["arr"]["value"] == 1_200_000
    assert out["ltv_cac"]["band"] == "excellent"


def test_kind_variance_and_forecast():
    v = compute_finance_calc(
        {
            "kind": "variance",
            "variance": {
                "lines": [
                    {
                        "name": "Rev",
                        "type": "revenue",
                        "actual": 1000000,
                        "budget": 900000,
                    }
                ]
            },
        }
    )
    assert v["material_count"] == 1
    f = compute_finance_calc(
        {
            "kind": "forecast",
            "forecast": {"base_revenue": 1000000, "growth_rate": 0.05, "periods": 12},
        }
    )
    assert f["scenarios"]["base"]["periods"][0]["revenue"] == 1_050_000.0


def test_kind_equity_reverse_evbridge_scenario():
    assert "value_per_share" in compute_finance_calc(
        {
            "kind": "equity_valuation",
            "equity_valuation": {"base_fcf": 100, "wacc": 0.1, "stage1_growth": 0.1},
        }
    )
    assert "implied_growth" in compute_finance_calc(
        {
            "kind": "reverse_dcf",
            "reverse_dcf": {"enterprise_value": 2000, "base_fcf": 100, "wacc": 0.1},
        }
    )
    assert (
        compute_finance_calc(
            {"kind": "ev_bridge", "ev_bridge": {"market_cap": 1000, "cash": 100}}
        )["net_debt"]
        == -100.0
    )
    assert "weighted_value_per_share" in compute_finance_calc(
        {
            "kind": "scenario",
            "scenario": {"rows": [{"value_per_share": 100, "probability": 1}]},
        }
    )


# --- bad input never raises; returns {"error": …} --------------------------
def test_bad_input_returns_error_not_raise():
    assert "error" in compute_finance_calc({"kind": "nonsense"})
    assert "error" in compute_finance_calc({"kind": "dcf", "dcf": {}})  # no revenue
    assert "error" in compute_finance_calc({"kind": "npv_irr", "npv_irr": {}})
    assert "error" in compute_finance_calc({"kind": "variance", "variance": {}})
    assert "error" in compute_finance_calc({})  # no kind
    assert "error" in compute_finance_calc("not a dict")  # type: ignore[arg-type]


# --- finance_reference through the tool ------------------------------------
def test_reference_tool_loads_and_errors():
    ref = run_finance_reference({"doc": "equity/sectors/banks"})
    assert "sections" in ref and ref["sections"]
    sec = run_finance_reference(
        {"doc": "equity/sectors/banks", "section": ref["sections"][0]}
    )
    assert "content" in sec and len(sec["content"]) <= 6600
    assert "error" in run_finance_reference({"doc": "nope/nope"})
    assert "error" in run_finance_reference({"doc": "../../config"})  # traversal guard
    assert "error" in run_finance_reference("bad")  # type: ignore[arg-type]

"""The deterministic `compute_sales_forecast` reserved tool — exact numbers + robust
parsing. This is what GUARANTEES forecast numeric correctness on prod (the model reports
the tool's numbers instead of substituting its own stage-win priors)."""

from __future__ import annotations

from app.sales.tool import (
    SALES_FORECAST_TOOL_NAME,
    SALES_FORECAST_TOOL_SPEC,
    compute_forecast,
)

_ARGS = {
    "deals": [
        {"name": "Acme", "amount": 100000, "stage": "Negotiation"},
        {"name": "Beta", "amount": 50000, "stage": "Proposal sent"},
        {"name": "Gamma", "amount": 200000, "stage": "Discovery"},
        {"name": "Delta", "amount": 30000, "stage": "Prospecting"},
    ],
    "quota": 300000,
    "closed": 50000,
}


def test_spec_is_well_formed():
    fn = SALES_FORECAST_TOOL_SPEC["function"]
    assert fn["name"] == SALES_FORECAST_TOOL_NAME == "compute_sales_forecast"
    assert "deals" in fn["parameters"]["properties"]
    assert fn["parameters"]["required"] == ["deals"]


def test_exact_forecast_numbers():
    r = compute_forecast(_ARGS)
    assert r["weighted_forecast"] == 153000.0          # 80k+30k+40k+3k
    assert r["open_pipeline"] == 380000.0
    assert r["projected_total_incl_closed"] == 203000.0  # 50k + 153k
    assert r["scenarios"] == {"best": 380000.0, "likely": 153000.0, "worst": 100000.0}
    assert round(r["coverage_ratio"], 2) == 1.27       # 380k / 300k
    assert r["coverage_band"] == "risky"               # < 2x
    assert r["gap_to_quota"] == 97000.0                # 300k - (50k + 153k)
    assert r["commit_amount"] == 100000.0              # Negotiation only
    assert r["upside_amount"] == 280000.0              # the rest


def test_tolerant_parsing_of_money_strings():
    r = compute_forecast(
        {
            "deals": [
                {"amount": "$100,000", "stage": "Negotiation"},
                {"amount": "50000", "stage": "Proposal"},
            ],
            "quota": "$300,000",
        }
    )
    assert r["weighted_forecast"] == 110000.0  # 80k + 30k
    assert r["open_pipeline"] == 150000.0


def test_per_deal_probability_override_accepts_0_100():
    # a CRM probability of 90 (0-100) overrides the stage default -> 0.90
    r = compute_forecast(
        {"deals": [{"amount": 100000, "stage": "Discovery", "probability": 90}]}
    )
    assert r["weighted_forecast"] == 90000.0


def test_custom_stage_probabilities_override_all():
    r = compute_forecast(
        {
            "deals": [{"amount": 100000, "stage": "Discovery"}],
            "custom_probabilities": {"Discovery": 0.5},
        }
    )
    assert r["weighted_forecast"] == 50000.0


def test_bad_input_returns_error_not_raise():
    assert "error" in compute_forecast({})
    assert "error" in compute_forecast({"deals": []})
    assert "error" in compute_forecast({"deals": "not a list"})


def test_zero_quota_coverage_is_none_not_fabricated():
    args = {"deals": [{"amount": 1000, "stage": "Discovery"}], "quota": 0}
    r = compute_forecast(args)
    assert r["coverage_ratio"] is None
    assert r["coverage_band"] == "unknown"

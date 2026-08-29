"""The `marketing_calc` + `marketing_reference` reserved tools — per-kind exact numbers,
tolerant parsing, and bad-input -> {"error": …} (never raises into the tool loop)."""

from __future__ import annotations

import pytest

from app.marketing.tool import (
    MARKETING_TOOL_NAMES,
    compute_marketing_calc,
    run_marketing_reference,
)


def test_tool_names():
    assert MARKETING_TOOL_NAMES == {"marketing_calc", "marketing_reference"}


def test_sample_size_and_ab_test():
    r = compute_marketing_calc(
        {"kind": "sample_size", "sample_size": {"baseline": 0.05, "mde": 0.2}}
    )
    assert r["sample_size_per_variation"] == 8155
    ab = compute_marketing_calc(
        {
            "kind": "ab_test",
            "ab_test": {
                "control_n": 1000,
                "control_conv": 50,
                "variant_n": 1000,
                "variant_conv": 100,
            },
        }
    )
    assert ab["significant"] is True and ab["winner"] == "variant"


def test_funnel_roas_attribution_cac_budget():
    f = compute_marketing_calc(
        {
            "kind": "funnel",
            "funnel": {"stages": ["V", "S", "P"], "counts": [1000, 200, 50]},
        }
    )
    assert f["overall_conversion_pct"] == 5.0 and f["bottleneck"] == "S"
    # tolerant parsing: $ and %
    rr = compute_marketing_calc(
        {
            "kind": "roas",
            "roas": {
                "spend": "$5,000",
                "revenue": "$18,000",
                "conversions": 120,
                "margin_pct": "40%",
            },
        }
    )
    assert rr["roas"] == 3.6 and rr["break_even_roas"] == 2.5
    a = compute_marketing_calc(
        {
            "kind": "attribution",
            "attribution": {
                "model": "position-based",
                "journeys": [
                    {
                        "converted": True,
                        "revenue": 100,
                        "touchpoints": ["email", "ads", "organic"],
                    }
                ],
            },
        }
    )
    assert a["credits"]["email"] == 40.0 and a["credits"]["ads"] == 20.0
    c = compute_marketing_calc(
        {
            "kind": "cac",
            "cac": {
                "channels": [
                    {"channel": "ads", "spend": 5000, "customers": 50},
                    {"channel": "seo", "spend": 1000, "customers": 40},
                ]
            },
        }
    )
    assert c["blended_cac"] == pytest.approx(66.67, abs=0.01)
    b = compute_marketing_calc(
        {
            "kind": "budget_allocation",
            "budget_allocation": {
                "total_budget": 10000,
                "channels": [{"channel": "a", "roas": 4}, {"channel": "b", "roas": 1}],
            },
        }
    )
    assert {r["channel"]: r["allocation"] for r in b["allocations"]} == {
        "a": 8000.0,
        "b": 2000.0,
    }


def test_bad_input_returns_error_not_raise():
    assert "error" in compute_marketing_calc({"kind": "nope"})
    assert "error" in compute_marketing_calc({"kind": "sample_size", "sample_size": {}})
    assert "error" in compute_marketing_calc({"kind": "funnel", "funnel": {}})
    assert "error" in compute_marketing_calc({"kind": "attribution", "attribution": {}})
    assert "error" in compute_marketing_calc({})
    assert "error" in compute_marketing_calc("bad")  # type: ignore[arg-type]


def test_reference_tool_loads_and_errors():
    ref = run_marketing_reference({"doc": "marketing-strategy-pmm"})
    assert "sections" in ref and ref["sections"]
    sec = run_marketing_reference(
        {"doc": "marketing-strategy-pmm", "section": ref["sections"][0]}
    )
    assert "content" in sec and len(sec["content"]) <= 6600
    assert "error" in run_marketing_reference(
        {"doc": "seo-audit"}
    )  # delegated, not bundled
    assert "error" in run_marketing_reference({"doc": "../../config"})  # traversal
    assert "error" in run_marketing_reference("bad")  # type: ignore[arg-type]

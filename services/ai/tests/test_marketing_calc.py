"""Marketing math — NUMERIC CORRECTNESS (hermetic, exact) + the guidance<->code drift
guard. Every formula/default is verified against the source marketing-skill scripts; the
Marketing skill must document the SAME numbers so guidance and code cannot drift. Covers
the named edge cases: divide-by-zero, missing values, %, currency parsing, rounding."""

from __future__ import annotations

import pytest

from app.marketing import calc as M
from app.marketing.skill import MARKETING_SKILL


# --- normal helpers --------------------------------------------------------
def test_norm_helpers():
    assert M._norm_ppf(0.975) == pytest.approx(
        1.95996, abs=1e-3
    )  # z for 95% two-tailed
    assert M._norm_ppf(0.80) == pytest.approx(0.84162, abs=1e-3)  # z for 80% power
    assert M._norm_cdf(0.0) == 0.5
    assert M._norm_cdf(1.95996) == pytest.approx(0.975, abs=1e-4)


# --- 1. A/B sample size (verified formula) ---------------------------------
def test_sample_size_exact():
    r = M.sample_size(0.05, 0.20)
    assert r["sample_size_per_variation"] == 8155  # (1.96+0.8416)²·pooled / 0.01²
    assert r["total_sample_size"] == 8155 * 2
    assert r["z_alpha_2"] == pytest.approx(1.96, abs=0.01)
    r2 = M.sample_size(0.05, 0.20, daily_traffic=2000)
    assert r2["estimated_days"] == pytest.approx(9, abs=1)


def test_sample_size_edges():
    assert "error" in M.sample_size(0.05, 20)  # p2 = 1.05 outside (0,1)
    assert "error" in M.sample_size(0, 0.2)  # baseline not in (0,1)


# --- 2. A/B significance ---------------------------------------------------
def test_ab_test_not_significant():
    r = M.ab_test(1000, 50, 1000, 65)
    assert r["variant_rate"] == 0.065
    assert r["relative_lift_pct"] == 30.0  # (0.065-0.05)/0.05
    assert r["p_value"] == pytest.approx(0.1496, abs=0.001)
    assert r["significant"] is False and r["winner"] == "inconclusive"


def test_ab_test_significant():
    r = M.ab_test(1000, 50, 1000, 100)
    assert r["significant"] is True and r["winner"] == "variant"
    assert r["p_value"] < 0.05
    assert "error" in M.ab_test(0, 0, 0, 0)


# --- 3. funnel (verified) --------------------------------------------------
def test_funnel_exact():
    f = M.funnel(["Visit", "Signup", "Paid"], [1000, 200, 50])
    assert f["overall_conversion_pct"] == 5.0  # 50/1000
    assert f["stages"][1]["conversion_pct"] == 20.0  # 200/1000
    assert f["stages"][1]["dropoff_pct"] == 80.0
    assert f["stages"][2]["conversion_pct"] == 25.0  # 50/200
    assert f["bottleneck"] == "Signup"  # biggest drop-off
    assert "error" in M.funnel(["a"], [0])  # zero top-of-funnel


# --- 4. ROAS (verified) ----------------------------------------------------
def test_roas_exact():
    r = M.roas(5000, 18000, 120, 40)
    assert r["roas"] == 3.6  # 18000/5000
    assert r["break_even_roas"] == 2.5  # 100/40
    assert r["profitable"] is True
    assert r["cpa"] == pytest.approx(41.67, abs=0.01)  # 5000/120
    assert M.roas(1000, 500)["roas"] == 0.5
    assert "error" not in M.roas(1000)  # revenue defaults 0


# --- 5. attribution — 5 models, weights sum to 1 ---------------------------
def test_attribution_all_models_sum_to_revenue():
    j = [
        {"converted": True, "revenue": 100, "touchpoints": ["email", "ads", "organic"]}
    ]
    for model in (
        "first-touch",
        "last-touch",
        "linear",
        "time-decay",
        "position-based",
    ):
        a = M.attribution(j, model)
        assert a["total_attributed_revenue"] == pytest.approx(100.0, abs=0.01), model
        assert sum(a["share_pct"].values()) == pytest.approx(100.0, abs=0.1), model
    assert M.attribution(j, "first-touch")["credits"] == {"email": 100.0}
    assert M.attribution(j, "last-touch")["credits"] == {"organic": 100.0}
    pb = M.attribution(j, "position-based")["credits"]
    assert pb["email"] == 40.0 and pb["organic"] == 40.0 and pb["ads"] == 20.0
    lin = M.attribution(j, "linear")["credits"]
    assert lin["email"] == pytest.approx(33.33, abs=0.01)
    assert "error" in M.attribution(j, "made-up-model")


# --- 6. CAC (verified) -----------------------------------------------------
def test_cac_blended():
    r = M.cac(
        [
            {"channel": "ads", "spend": 5000, "customers": 50},
            {"channel": "seo", "spend": 1000, "customers": 40},
        ]
    )
    assert r["blended_cac"] == pytest.approx(66.67, abs=0.01)  # 6000/90
    assert r["channels"][0]["cac"] == 100.0  # 5000/50
    assert (
        M.cac([{"channel": "x", "spend": 100, "customers": 0}])["channels"][0]["cac"]
        is None
    )


# --- 7. budget allocation --------------------------------------------------
def test_budget_allocation_by_roas():
    r = M.budget_allocation(
        [{"channel": "a", "roas": 4}, {"channel": "b", "roas": 1}], 10000
    )
    allocs = {row["channel"]: row["allocation"] for row in r["allocations"]}
    assert allocs["a"] == 8000.0 and allocs["b"] == 2000.0  # 4:1
    zero = M.budget_allocation([{"channel": "a", "roas": 0}], 10000)
    assert zero["allocations"][0]["allocation"] == 0.0


# --- tolerant parsing ------------------------------------------------------
def test_tolerant_parsing():
    assert M._f("$5,000") == 5000.0 and M._f("40%") == 40.0
    assert M._f("", 0.0) == 0.0 and M._f("bad") is None


# --- drift guard: the skill cites the same numbers/thresholds --------------
def test_skill_cites_same_constants():
    t = (MARKETING_SKILL.methodology + MARKETING_SKILL.instructions).lower()
    assert "sample_size" in t and "ab_test" in t and "funnel" in t
    assert "roas" in t and "attribution" in t
    assert (
        ">=70" in t and ">=85" in t
    )  # AEO E-E-A-T thresholds (saas / healthcare-finance)
    assert "6-8wk" in t and "3-4wk" in t  # launch tiers
    assert "first-touch" in t and "position-based" in t  # attribution models

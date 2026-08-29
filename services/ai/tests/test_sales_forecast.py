"""Sales forecast/pipeline — NUMERIC CORRECTNESS (hermetic, exact) + the guidance↔code
drift guard: the pure reference math in `app/sales/forecast.py` must be arithmetically
correct, and the Sales skill text must cite the SAME constants so guidance and code can
never silently drift."""

from __future__ import annotations

from datetime import date

from app.sales import forecast as F
from app.sales.forecast import Deal
from app.sales.skill import SALES_SKILL

# A fixed pipeline with hand-computable expected values.
_QUOTA = 300_000.0
_CLOSED = 50_000.0
_DEALS = [
    Deal(amount=100_000, stage="Negotiation"),   # 0.8 -> 80,000 ; commit
    Deal(amount=50_000, stage="Proposal sent"),  # 0.6 -> 30,000
    Deal(amount=200_000, stage="Discovery"),     # 0.2 -> 40,000
    Deal(amount=30_000, stage="Prospecting"),    # 0.1 ->  3,000
]


def test_stage_probability_defaults():
    sp = F.stage_probability
    assert sp("Closed Won") == 1.0
    assert sp("Negotiation") == 0.8 and sp("Contract review") == 0.8
    assert sp("Proposal sent") == 0.6 and sp("Quote out") == 0.6
    assert sp("Demo scheduled") == 0.4 and sp("Evaluation") == 0.4
    assert sp("Discovery") == 0.2 and sp("Qualification") == 0.2
    assert sp("Prospecting") == 0.1 and sp("New lead") == 0.1
    assert sp("Totally unknown stage") == 0.1  # default low, never invented high
    # the canonical table carries exactly the six documented probability bands
    bands = {v for _keys, v in F.DEFAULT_STAGE_PROBABILITY}
    assert bands == {1.0, 0.8, 0.6, 0.4, 0.2, 0.1}


def test_custom_probability_overrides_default():
    assert F.stage_probability("Discovery", {"Discovery": 0.55}) == 0.55
    d = Deal(amount=100_000, stage="Discovery", probability=0.5)
    assert F.deal_probability(d) == 0.5  # deal-level override wins


def test_weighted_forecast_exact():
    assert F.weighted_forecast(_DEALS) == 153_000.0  # 80k+30k+40k+3k
    assert F.open_pipeline(_DEALS) == 380_000.0


def test_scenarios_exact():
    s = F.scenarios(_DEALS)
    assert s["best"] == 380_000.0          # every open deal closes
    assert s["likely"] == 153_000.0        # stage-weighted
    assert s["worst"] == 100_000.0         # only commit (prob>=0.8) => Negotiation
    assert {d.amount for d in F.commit_deals(_DEALS)} == {100_000}
    assert {d.amount for d in F.upside_deals(_DEALS)} == {50_000, 200_000, 30_000}


def test_coverage_and_gap_exact():
    cov = F.coverage_ratio(F.open_pipeline(_DEALS), _QUOTA)
    assert abs(cov - (380_000 / 300_000)) < 1e-9
    assert F.coverage_band(cov) == "risky"           # 1.27x < 2x
    assert F.coverage_band(3.5) == "healthy" and F.coverage_band(2.4) == "adequate"
    assert F.coverage_ratio(100.0, 0.0) is None      # undefined, never fabricated
    gap = F.gap_to_quota(_QUOTA, _CLOSED, F.weighted_forecast(_DEALS))
    assert gap == 97_000.0                            # 300k-(50k+153k)


# --- pipeline health --------------------------------------------------------
_TODAY = date(2026, 8, 28)


def _d(**kw) -> Deal:
    base = dict(amount=10_000, stage="Discovery", contacts=3)
    base.update(kw)
    return Deal(**base)


def test_deal_flags_thresholds():
    assert "stale" in F.deal_flags(_d(last_activity=date(2026, 8, 8)), _TODAY)  # 20d
    assert "stale" not in F.deal_flags(_d(last_activity=date(2026, 8, 25)), _TODAY)
    assert "stuck" in F.deal_flags(_d(stage_since=date(2026, 7, 1)), _TODAY)     # 58d
    assert "stuck" not in F.deal_flags(_d(stage_since=date(2026, 8, 20)), _TODAY)  # 8d
    assert "overdue" in F.deal_flags(_d(close_date=date(2026, 8, 1)), _TODAY)
    assert "overdue" not in F.deal_flags(_d(close_date=date(2026, 9, 30)), _TODAY)
    assert "single_threaded" in F.deal_flags(_d(contacts=1), _TODAY)
    assert "single_threaded" not in F.deal_flags(_d(contacts=3), _TODAY)


def test_priority_score_orders_deals():
    hot = _d(  # big, imminent, single-threaded, overdue -> should rank high
        amount=500_000,
        stage="Negotiation",
        close_date=date(2026, 8, 20),
        last_activity=date(2026, 8, 27),
        contacts=1,
    )
    cold = _d(  # small, distant, clean
        amount=5_000,
        stage="Prospecting",
        close_date=date(2026, 12, 1),
        last_activity=date(2026, 8, 26),
        contacts=4,
    )
    ph = F.priority_score(hot, _TODAY, max_amount=500_000)
    pc = F.priority_score(cold, _TODAY, max_amount=500_000)
    assert 0.0 <= pc < ph <= 1.0
    assert abs(sum(F.PRIORITY_WEIGHTS.values()) - 1.0) < 1e-9  # 30/25/20/15/10


# --- drift guard: the skill cites the SAME constants as the code ------------
def test_skill_text_cites_the_same_constants():
    t = SALES_SKILL.instructions
    # default stage probabilities
    for pct in ("100%", "80%", "60%", "40%", "20%", "10%"):
        assert pct in t, pct
    # coverage thresholds + formulas
    assert "3x" in t and "2x" in t
    assert "coverage ratio = open pipeline / quota" in t.lower()
    assert "weighted forecast = sum" in t.lower()
    assert "gap to quota = quota - (closed + weighted" in t.lower()
    # pipeline thresholds
    assert "30+" in t and "14+" in t
    for kw in ("single-threaded", "stale", "stuck", "overdue"):
        assert kw in t.lower(), kw
    # prioritization weights
    for w in ("30%", "25%", "20%", "15%", "10%"):
        assert w in t, w

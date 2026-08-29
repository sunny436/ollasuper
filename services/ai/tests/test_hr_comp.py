"""HR compensation math — NUMERIC CORRECTNESS (hermetic, exact) + the guidance↔code
drift guard: the pure reference math in `app/hr/comp.py` must be arithmetically correct,
and the HR skill must document the SAME formulas so guidance and code cannot drift."""

from __future__ import annotations

from app.hr import comp as C
from app.hr.skill import HR_SKILL

# A band: min 100k / mid 120k / max 140k.
_MIN, _MID, _MAX = 100_000.0, 120_000.0, 140_000.0


def test_compa_ratio_exact():
    assert C.compa_ratio(120_000, _MID) == 1.0
    assert C.compa_ratio(96_000, _MID) == 0.8
    assert C.compa_ratio(144_000, _MID) == 1.2
    assert C.compa_ratio(100_000, 0) is None  # unknown midpoint, never fabricated


def test_band_placement_exact():
    p = C.band_placement
    assert p(90_000, _MIN, _MID, _MAX) == "below_min"
    assert p(110_000, _MIN, _MID, _MAX) == "below_mid"
    assert p(120_000, _MIN, _MID, _MAX) == "at_mid"
    assert p(130_000, _MIN, _MID, _MAX) == "above_mid"
    assert p(150_000, _MIN, _MID, _MAX) == "above_max"


def test_gap_to_mid_exact():
    assert C.gap_to_mid(110_000, _MID) == 10_000.0   # 10k below midpoint
    assert C.gap_to_mid(130_000, _MID) == -10_000.0  # 10k above midpoint


def test_percentile_position_exact():
    q = C.percentile_position
    assert q(90, 100, 120, 140, 160) == "below_p25"
    assert q(110, 100, 120, 140, 160) == "p25_p50"
    assert q(130, 100, 120, 140, 160) == "p50_p75"
    assert q(150, 100, 120, 140, 160) == "p75_p90"
    assert q(170, 100, 120, 140, 160) == "above_p90"


def test_outlier_thresholds():
    assert C.is_outlier(0.79) and C.is_outlier(1.21)
    assert not C.is_outlier(1.0)
    assert not C.is_outlier(None)  # unknown ratio is not an outlier
    assert C.COMPA_RATIO_LOW == 0.80 and C.COMPA_RATIO_HIGH == 1.20


def test_total_first_year_exact():
    # base 150k + signing 20k + 15% target of base (22.5k) + annualized equity 40k
    assert C.total_first_year(150_000, 20_000, 0.15, 40_000) == 232_500.0


# --- drift guard: the skill cites the same formulas -------------------------
def test_skill_cites_the_same_comp_formulas():
    t = HR_SKILL.instructions.lower()
    assert "compa-ratio" in t and "salary / band midpoint" in t
    assert "band placement" in t and "below_min" in t and "above_max" in t
    assert "midpoint - salary" in t  # gap to mid
    assert "0.80" in t and "1.20" in t  # outlier thresholds
    assert "25th / 50th / 75th / 90th" in t
    assert "total first-year" in HR_SKILL.instructions.lower()

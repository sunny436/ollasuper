"""Pure, unit-tested reference math for compensation analysis.

This module is the SINGLE SOURCE OF TRUTH for the comp FORMULAS the HR skill documents
to the model. `tests/test_hr_comp.py` asserts both that the math is correct on fixtures
AND that the skill text cites the same formulas, so guidance and code cannot silently
drift. No I/O → fully hermetic and deterministic.

At runtime the model computes these over an uploaded comp CSV via the REUSED
Data-Analysis compute tools (or reasons over small provided data) applying this same
methodology; this module is not wired into the runtime — it exists to keep the
documented formulas correct and to make numeric correctness testable. (If prod ever
shows the model mis-computing comp, promote it to a reserved tool, exactly as Sales did
for `forecast.py`.)

Adapted from the Anthropic HR `comp-analysis` / `compensation-benchmarking` skills.
"""

from __future__ import annotations

# Compa-ratio bands: a common convention flags <0.80 (underpaid) and >1.20 (overpaid).
COMPA_RATIO_LOW = 0.80
COMPA_RATIO_HIGH = 1.20
# Market benchmark percentiles the skill reports.
PERCENTILES = (25, 50, 75, 90)


def compa_ratio(salary: float, band_mid: float) -> float | None:
    """salary ÷ band midpoint. 1.0 == exactly at midpoint. None when the midpoint is
    unknown/zero (never fabricate a ratio)."""
    if band_mid <= 0:
        return None
    return salary / band_mid


def band_placement(
    salary: float, band_min: float, band_mid: float, band_max: float
) -> str:
    """Where a salary sits relative to the band's min / mid / max:
    'below_min' (< min), 'below_mid' (min..<mid), 'at_mid' (== mid),
    'above_mid' (>mid..max), 'above_max' (> max)."""
    if salary < band_min:
        return "below_min"
    if salary > band_max:
        return "above_max"
    if salary < band_mid:
        return "below_mid"
    if salary > band_mid:
        return "above_mid"
    return "at_mid"


def gap_to_mid(salary: float, band_mid: float) -> float:
    """band midpoint − salary. Positive ⇒ paid BELOW midpoint (that much to reach mid);
    negative ⇒ paid above midpoint."""
    return band_mid - salary


def percentile_position(
    value: float, p25: float, p50: float, p75: float, p90: float
) -> str:
    """Which market band a value falls in: 'below_p25', 'p25_p50', 'p50_p75',
    'p75_p90', 'above_p90' (boundaries round DOWN into the lower band)."""
    if value < p25:
        return "below_p25"
    if value < p50:
        return "p25_p50"
    if value < p75:
        return "p50_p75"
    if value <= p90:
        return "p75_p90"
    return "above_p90"


def is_outlier(ratio: float | None) -> bool:
    """A compa-ratio outlier: below COMPA_RATIO_LOW or above COMPA_RATIO_HIGH."""
    if ratio is None:
        return False
    return ratio < COMPA_RATIO_LOW or ratio > COMPA_RATIO_HIGH


def total_first_year(
    base: float,
    signing_bonus: float = 0.0,
    target_bonus: float = 0.0,
    equity_annualized: float = 0.0,
) -> float:
    """Total first-year comp = base + signing + (base × target-bonus%) + annualized
    equity. `target_bonus` is a fraction (0.15 for 15%); pass 0 if it is an amount you
    add to signing instead."""
    return base + signing_bonus + base * target_bonus + equity_annualized

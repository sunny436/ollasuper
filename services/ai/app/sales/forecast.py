"""Pure, unit-tested reference math for Sales forecasting + pipeline health.

This module is the SINGLE SOURCE OF TRUTH for the forecast/pipeline CONSTANTS and
FORMULAS that the Sales skill documents to the model. The skill guidance is written to
cite exactly these numbers; `tests/test_sales_forecast.py` asserts both (a) the math is
arithmetically correct on fixtures and (b) the skill text cites the same constants, so
guidance and code can never silently drift.

No I/O, no dates-from-the-clock in the core (callers pass `today`) → fully hermetic and
deterministic. The live model computes over an uploaded CSV via the reused Data-Analysis
tools (or reasons over small provided data) applying this same methodology; this module
does not need to be called at runtime — it exists to keep the documented numbers correct
and to make numeric correctness testable.

Adapted from the Anthropic Sales `forecast` + `pipeline-review` skills; the methodology,
not any connector.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

# Optional per-stage probability overrides (exact stage string → win probability).
Custom = dict[str, float] | None

# --- forecast constants (verbatim from the source skill) --------------------
# Default stage → win probability. CRM stage names vary, so matching is by
# normalized keyword (see `stage_probability`). Order matters: the FIRST keyword
# group that matches wins, most-advanced first.
DEFAULT_STAGE_PROBABILITY: tuple[tuple[tuple[str, ...], float], ...] = (
    (("closed won", "won", "closed-won"), 1.0),
    (("negotiation", "contract", "verbal", "commit"), 0.8),
    (("proposal", "quote", "quoted"), 0.6),
    (("evaluation", "demo", "poc", "trial", "technical"), 0.4),
    (("discovery", "qualification", "qualified", "scoping"), 0.2),
    (("prospecting", "lead", "prospect", "new", "sql", "mql"), 0.1),
)

# "commit" = high-confidence deals that make up the WORST-case scenario.
COMMIT_THRESHOLD = 0.8
# Coverage-ratio health bands (open pipeline ÷ quota).
COVERAGE_HEALTHY = 3.0
COVERAGE_RISKY = 2.0

# --- pipeline-health thresholds (verbatim from the source skill) ------------
STALE_DAYS = 14  # no activity for 14+ days → stale
STUCK_DAYS = 30  # same stage for 30+ days → stuck
SINGLE_THREAD_CONTACTS = 1  # one (or zero) contact → single-threaded

# Prioritization weights (sum to 1.0). Custom weights may override.
PRIORITY_WEIGHTS: dict[str, float] = {
    "close_proximity": 0.30,
    "deal_size": 0.25,
    "stage": 0.20,
    "recent_activity": 0.15,
    "risk": 0.10,
}


@dataclass(frozen=True, slots=True)
class Deal:
    """One open opportunity. Dates are `date` (None = unknown). `probability` overrides
    the stage default when the CRM supplies its own; `contacts` counts distinct
    stakeholders (for single-threading)."""

    amount: float
    stage: str = ""
    close_date: date | None = None
    last_activity: date | None = None
    stage_since: date | None = None
    contacts: int = 1
    probability: float | None = None


def stage_probability(stage: str, custom: Custom = None) -> float:
    """Win probability for a stage. A `custom` map (exact stage → prob) overrides;
    otherwise the normalized stage name is matched against DEFAULT_STAGE_PROBABILITY.
    Unknown stages default to the lowest band (0.1) — never invent a higher number."""
    if custom:
        # exact, then case-insensitive match
        if stage in custom:
            return _clamp(custom[stage])
        low = stage.strip().lower()
        for k, v in custom.items():
            if k.strip().lower() == low:
                return _clamp(v)
    s = stage.strip().lower()
    for keys, prob in DEFAULT_STAGE_PROBABILITY:
        if any(k in s for k in keys):
            return prob
    return 0.1


def deal_probability(deal: Deal, custom: Custom = None) -> float:
    """The deal's own probability if the CRM supplied one, else the stage default."""
    if deal.probability is not None:
        return _clamp(deal.probability)
    return stage_probability(deal.stage, custom)


def weighted_forecast(deals: list[Deal], custom: Custom = None) -> float:
    """Σ (amount × probability) over the OPEN deals — the 'likely' projected close from
    the pipeline (add already-closed revenue for the period total)."""
    return sum(d.amount * deal_probability(d, custom) for d in deals)


def open_pipeline(deals: list[Deal]) -> float:
    """Total face value of the open pipeline (Σ amount)."""
    return sum(d.amount for d in deals)


def scenarios(
    deals: list[Deal], custom: Custom = None
) -> dict[str, float]:
    """Projected close from the OPEN pipeline under three scenarios:
      best   = every open deal closes (Σ amount)
      likely = stage-weighted (Σ amount × probability)
      worst  = only high-confidence commit deals close (Σ amount where prob ≥ 0.8)
    Add already-closed revenue separately for the period totals."""
    best = open_pipeline(deals)
    likely = weighted_forecast(deals, custom)
    worst = sum(
        d.amount for d in deals if deal_probability(d, custom) >= COMMIT_THRESHOLD
    )
    return {"best": best, "likely": likely, "worst": worst}


def commit_deals(deals: list[Deal], custom: Custom = None) -> list[Deal]:
    """The commit set (prob ≥ 0.8) — high-confidence deals."""
    return [d for d in deals if deal_probability(d, custom) >= COMMIT_THRESHOLD]


def upside_deals(deals: list[Deal], custom: Custom = None) -> list[Deal]:
    """The upside set (0 < prob < 0.8) — open, not yet commit."""
    return [d for d in deals if 0 < deal_probability(d, custom) < COMMIT_THRESHOLD]


def coverage_ratio(open_amount: float, quota: float) -> float | None:
    """Open pipeline ÷ quota. None when quota is 0 (undefined, never fabricate)."""
    if quota <= 0:
        return None
    return open_amount / quota


def coverage_band(ratio: float | None) -> str:
    """Health band for a coverage ratio: healthy ≥ 3×, risky < 2×, else 'adequate'."""
    if ratio is None:
        return "unknown"
    if ratio >= COVERAGE_HEALTHY:
        return "healthy"
    if ratio < COVERAGE_RISKY:
        return "risky"
    return "adequate"


def gap_to_quota(quota: float, closed: float, weighted: float) -> float:
    """Quota − (already-closed + weighted forecast). Positive = still short; negative =
    projected over quota."""
    return quota - (closed + weighted)


# --- pipeline health --------------------------------------------------------
def _days(a: date | None, b: date) -> int | None:
    return None if a is None else (b - a).days


def deal_flags(deal: Deal, today: date) -> set[str]:
    """The risk flags on one deal at `today`:
      'stale'          — no activity for STALE_DAYS+ (14+)
      'stuck'          — same stage for STUCK_DAYS+ (30+)
      'overdue'        — close_date is in the past
      'single_threaded'— SINGLE_THREAD_CONTACTS or fewer contacts (1)"""
    flags: set[str] = set()
    inactive = _days(deal.last_activity, today)
    if inactive is not None and inactive >= STALE_DAYS:
        flags.add("stale")
    in_stage = _days(deal.stage_since, today)
    if in_stage is not None and in_stage >= STUCK_DAYS:
        flags.add("stuck")
    if deal.close_date is not None and deal.close_date < today:
        flags.add("overdue")
    if deal.contacts <= SINGLE_THREAD_CONTACTS:
        flags.add("single_threaded")
    return flags


def priority_score(
    deal: Deal,
    today: date,
    *,
    max_amount: float,
    horizon_days: int = 90,
    weights: dict[str, float] | None = None,
    custom_probs: dict[str, float] | None = None,
) -> float:
    """A 0–1 prioritization score = Σ weightᵢ × componentᵢ, with the source weights
    (close-proximity .30, deal-size .25, stage .20, recent-activity .15, risk .10). Each
    component is normalized to 0–1; higher = work this first. `max_amount` scales size;
    `horizon_days` scales close-proximity and recency. Deterministic given `today`."""
    w = weights or PRIORITY_WEIGHTS

    # close proximity: sooner (and not long overdue) scores higher; capped to [0,1].
    days_to_close = _days(deal.close_date, today)
    if days_to_close is None:
        prox = 0.0
    else:
        # days_to_close = today - close_date  (positive when overdue).
        remaining = -days_to_close  # days until close (negative if overdue)
        prox = _clamp(1.0 - (remaining / horizon_days)) if remaining >= 0 else 0.5

    size = _clamp(deal.amount / max_amount) if max_amount > 0 else 0.0
    stage = deal_probability(deal, custom_probs)  # already 0–1

    inactive = _days(deal.last_activity, today)
    recency = 1.0 if inactive is None else _clamp(1.0 - (inactive / horizon_days))

    risk = _clamp(len(deal_flags(deal, today)) / 4.0)  # more flags → more urgent

    return (
        w.get("close_proximity", 0) * prox
        + w.get("deal_size", 0) * size
        + w.get("stage", 0) * stage
        + w.get("recent_activity", 0) * recency
        + w.get("risk", 0) * risk
    )


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))

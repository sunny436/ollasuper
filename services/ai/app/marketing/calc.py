"""Pure, hermetic, JSON-safe deterministic Marketing math — the SINGLE SOURCE OF TRUTH.

Every formula + default is verified verbatim against the source `marketing-skill`
scripts
(MIT, alirezarezvani/claude-skills): ab-test sample_size_calculator.py (Acklam inverse-
normal-CDF + two-proportion sample size), campaign-analytics funnel_analyzer.py /
attribution_analyzer.py, paid-ads roas_calculator.py, marketing-demand-acquisition
calculate_cac.py. The A/B *significance* p-value uses a stdlib `math.erf` normal CDF
(the
companion to the source's sample-size z-scores). The Marketing skill documents these
SAME
numbers; `test_marketing_calc` binds guidance to code so they cannot drift.

No I/O, no network, no clock, no scipy. Division by zero / missing inputs return `None`
for an undefined METRIC (never a fabricated 0). Callers (the `marketing_calc` tool)
report
these numbers; the model never does the arithmetic itself.
"""

from __future__ import annotations

import math
from typing import Any


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _f(v: Any, default: float | None = None) -> float | None:
    """Tolerant float parse: strips $ , % and spaces; None/''/bad -> default."""
    if isinstance(v, bool):
        return default
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip().replace("$", "").replace(",", "").replace("%", "").strip()
        if not s:
            return default
        try:
            return float(s)
        except ValueError:
            return default
    return default


def _div(a: float | None, b: float | None) -> float | None:
    """a / b, or None when b is 0/None (undefined — never fabricated)."""
    if a is None or b is None or b == 0:
        return None
    return a / b


def _r(x: float | None, nd: int = 2) -> float | None:
    return None if x is None else round(x, nd)


# --------------------------------------------------------------------------- #
# standard-normal helpers (stdlib only)
# --------------------------------------------------------------------------- #
def _norm_cdf(x: float) -> float:
    """Standard-normal CDF via math.erf."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_ppf(p: float) -> float:
    """Inverse standard-normal CDF (Acklam / Abramowitz-Stegun rational approximation,
    ~1e-9) — verbatim from the source ab-test calculator. Raises on p outside (0,1)."""
    if p <= 0 or p >= 1:
        raise ValueError(f"p must be in (0, 1), got {p}")
    a = [
        -3.969683028665376e01,
        2.209460984245205e02,
        -2.759285104469687e02,
        1.383577518672690e02,
        -3.066479806614716e01,
        2.506628277459239e00,
    ]
    b = [
        -5.447609879822406e01,
        1.615858368580409e02,
        -1.556989798598866e02,
        6.680131188771972e01,
        -1.328068155288572e01,
    ]
    c = [
        -7.784894002430293e-03,
        -3.223964580411365e-01,
        -2.400758277161838e00,
        -2.549732539343734e00,
        4.374664141464968e00,
        2.938163982698783e00,
    ]
    d = [
        7.784695709041462e-03,
        3.224671290700398e-01,
        2.445134137142996e00,
        3.754408661907416e00,
    ]
    p_low = 0.02425
    if p < p_low:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1
        )
    if p <= 1 - p_low:
        q = p - 0.5
        r = q * q
        return (
            (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5])
            * q
            / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
        )
    q = math.sqrt(-2 * math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
        (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1
    )


# --------------------------------------------------------------------------- #
# 1. A/B sample size (sample_size_calculator.py — verbatim formula)
# --------------------------------------------------------------------------- #
def sample_size(
    baseline: float,
    mde: float,
    alpha: float = 0.05,
    power: float = 0.80,
    daily_traffic: float | None = None,
) -> dict:
    """Two-proportion z-test sample size (two-tailed):
    n = (Z_α/2 + Z_β)² · (p1(1−p1) + p2(1−p2)) / (p2−p1)², p2 = baseline·(1+mde)."""
    p1 = baseline
    p2 = baseline * (1 + mde)
    if not (0 < p1 < 1):
        return {"error": f"baseline must be in (0,1), got {p1}"}
    if not (0 < p2 < 1):
        return {"error": f"baseline*(1+mde)={p2:.4f} outside (0,1); reduce mde"}
    z_alpha = _norm_ppf(1 - alpha / 2)
    z_beta = _norm_ppf(power)
    pooled_var = p1 * (1 - p1) + p2 * (1 - p2)
    n = math.ceil(((z_alpha + z_beta) ** 2 * pooled_var) / ((p2 - p1) ** 2))
    out: dict[str, Any] = {
        "sample_size_per_variation": n,
        "total_sample_size": n * 2,
        "expected_variant_rate": _r(p2, 6),
        "absolute_lift": _r(p2 - p1, 6),
        "relative_lift_pct": _r(mde * 100, 2),
        "z_alpha_2": _r(z_alpha, 4),
        "z_beta": _r(z_beta, 4),
        "alpha": alpha,
        "power": power,
        "formula": "n = (Z_α/2 + Z_β)² × (p1(1−p1) + p2(1−p2)) / (p2−p1)²",
    }
    if daily_traffic and daily_traffic > 0:
        days = math.ceil((n * 2) / daily_traffic)
        out["estimated_days"] = days
        out["estimated_weeks"] = _r(days / 7, 1)
    return out


# --------------------------------------------------------------------------- #
# 2. A/B significance (two-proportion z-test — analyze results)
# --------------------------------------------------------------------------- #
def ab_test(
    control_n: float,
    control_conv: float,
    variant_n: float,
    variant_conv: float,
    alpha: float = 0.05,
) -> dict:
    """Two-proportion z-test on observed results. p-value two-tailed via normal CDF;
    significant if p < alpha. Reports lift + a (1−alpha) CI for the difference."""
    if control_n <= 0 or variant_n <= 0:
        return {"error": "control_n and variant_n must be > 0"}
    p1 = control_conv / control_n
    p2 = variant_conv / variant_n
    pooled = (control_conv + variant_conv) / (control_n + variant_n)
    se_pool = math.sqrt(pooled * (1 - pooled) * (1 / control_n + 1 / variant_n))
    z = (p2 - p1) / se_pool if se_pool > 0 else 0.0
    p_value = 2 * (1 - _norm_cdf(abs(z)))
    se_diff = math.sqrt(p1 * (1 - p1) / control_n + p2 * (1 - p2) / variant_n)
    zc = _norm_ppf(1 - alpha / 2)
    return {
        "control_rate": _r(p1, 6),
        "variant_rate": _r(p2, 6),
        "absolute_diff": _r(p2 - p1, 6),
        "relative_lift_pct": _r((p2 - p1) / p1 * 100, 2) if p1 > 0 else None,
        "z_score": _r(z, 4),
        "p_value": _r(p_value, 6),
        "significant": bool(p_value < alpha),
        "alpha": alpha,
        "confidence_pct": _r((1 - alpha) * 100, 1),
        "diff_ci": [_r((p2 - p1) - zc * se_diff, 6), _r((p2 - p1) + zc * se_diff, 6)],
        "winner": ("variant" if p2 > p1 else "control")
        if p_value < alpha
        else "inconclusive",
    }


# --------------------------------------------------------------------------- #
# 3. funnel (funnel_analyzer.py — verbatim)
# --------------------------------------------------------------------------- #
def funnel(stages: list[str], counts: list[float]) -> dict:
    """Per-stage conversion + drop-off + cumulative + overall + bottleneck.
    conv = count/prev·100 ; dropoff = 100−conv ; cumulative = count/first·100."""
    if not counts or len(counts) != len(stages) or counts[0] in (0, None):
        return {"error": "need matching stages/counts with a non-zero first stage"}
    rows = []
    for i, (name, count) in enumerate(zip(stages, counts, strict=False)):
        row: dict[str, Any] = {
            "stage": name,
            "count": count,
            "cumulative_conversion_pct": _r((count / counts[0]) * 100, 2),
        }
        if i == 0:
            row["conversion_pct"] = 100.0
            row["dropoff_pct"] = 0.0
        else:
            prev = counts[i - 1]
            conv = (count / prev * 100) if prev else 0.0
            row["conversion_pct"] = _r(conv, 2)
            row["dropoff_pct"] = _r(100 - conv, 2)
        rows.append(row)
    # bottleneck = the step with the largest drop-off (lowest stage conversion, after
    # 1st)
    worst = max(rows[1:], key=lambda r: r["dropoff_pct"] or 0, default=None)
    return {
        "stages": rows,
        "overall_conversion_pct": _r((counts[-1] / counts[0]) * 100, 2),
        "total_entered": counts[0],
        "total_converted": counts[-1],
        "bottleneck": (worst or {}).get("stage") if worst else None,
    }


# --------------------------------------------------------------------------- #
# 4. ROAS / paid metrics (roas_calculator.py — verbatim)
# --------------------------------------------------------------------------- #
def _roas_label(r: float) -> str:
    if r >= 4:
        return "excellent"
    if r >= 2:
        return "healthy"
    if r >= 1:
        return "break-even-ish"
    return "unprofitable"


def roas(
    spend: float,
    revenue: float = 0.0,
    conversions: float = 0.0,
    margin_pct: float | None = None,
) -> dict:
    """ROAS = revenue/spend ; break-even ROAS = 100/margin% ;
    CPA = spend/conversions."""
    out: dict[str, Any] = {"spend": spend, "revenue": revenue}
    r = _div(revenue, spend)
    out["roas"] = _r(r)
    out["roas_label"] = _roas_label(r) if r is not None else None
    if margin_pct and margin_pct > 0:
        be = 100 / margin_pct
        out["break_even_roas"] = _r(be)
        if r is not None:
            out["profitable"] = bool(r >= be)
            out["roas_gap_vs_breakeven"] = _r(r - be)
    if conversions and conversions > 0:
        out["cpa"] = _r(_div(spend, conversions))
    return out


# --------------------------------------------------------------------------- #
# 5. multi-touch attribution (attribution_analyzer.py — 5 models, verbatim)
# --------------------------------------------------------------------------- #
_ATTR_MODELS = ("first-touch", "last-touch", "linear", "time-decay", "position-based")


def _touch_channels(journey: dict) -> list[str]:
    """Ordered channel list from a journey's touchpoints (chronological as given)."""
    tps = journey.get("touchpoints") or []
    out = []
    for t in tps:
        if isinstance(t, str):
            out.append(t)
        elif isinstance(t, dict) and t.get("channel"):
            out.append(str(t["channel"]))
    return out


def attribution(
    journeys: list[dict], model: str = "linear", half_life_days: float = 7.0
) -> dict:
    """Distribute each converted journey's revenue across its touchpoint channels by
    the chosen model. Touchpoints are an ORDERED channel list (first → last=conversion);
    a per-touch `days_before` may be supplied for time-decay, else position is used."""
    model = (model or "linear").lower()
    if model not in _ATTR_MODELS:
        return {"error": f"model must be one of {', '.join(_ATTR_MODELS)}"}
    credits: dict[str, float] = {}

    def add(ch: str, amt: float) -> None:
        credits[ch] = credits.get(ch, 0.0) + amt

    for j in journeys:
        if not j.get("converted", True):
            continue
        chans = _touch_channels(j)
        if not chans:
            continue
        rev = _f(j.get("revenue"), 1.0) or 1.0
        n = len(chans)
        if model == "first-touch":
            add(chans[0], rev)
        elif model == "last-touch":
            add(chans[-1], rev)
        elif model == "linear":
            for ch in chans:
                add(ch, rev / n)
        elif model == "time-decay":
            decay = math.log(2) / half_life_days
            tps = j.get("touchpoints") or []
            weights = []
            for i in range(n):
                db = None
                if i < len(tps) and isinstance(tps[i], dict):
                    db = _f(tps[i].get("days_before"))
                if db is None:
                    db = float(n - 1 - i)  # position proxy: last touch = 0 days before
                weights.append(math.exp(-decay * db))
            tot = sum(weights)
            if tot > 0:
                for ch, w in zip(chans, weights, strict=False):
                    add(ch, rev * w / tot)
        elif model == "position-based":
            if n == 1:
                add(chans[0], rev)
            elif n == 2:
                add(chans[0], rev * 0.5)
                add(chans[-1], rev * 0.5)
            else:
                add(chans[0], rev * 0.4)
                add(chans[-1], rev * 0.4)
                mid = rev * 0.2 / (n - 2)
                for ch in chans[1:-1]:
                    add(ch, mid)
    total = sum(credits.values())
    return {
        "model": model,
        "credits": {
            c: _r(v) for c, v in sorted(credits.items(), key=lambda kv: -kv[1])
        },
        "share_pct": {c: _r(v / total * 100, 2) for c, v in credits.items()}
        if total
        else {},
        "total_attributed_revenue": _r(total),
    }


# --------------------------------------------------------------------------- #
# 6. CAC (calculate_cac.py — per-channel + blended)
# --------------------------------------------------------------------------- #
def cac(channels: list[dict]) -> dict:
    """Per-channel CAC = spend/customers + blended CAC across all channels."""
    rows, tot_spend, tot_cust = [], 0.0, 0.0
    for ch in channels:
        spend = _f(ch.get("spend"), 0.0) or 0.0
        cust = _f(ch.get("customers"), 0.0) or 0.0
        tot_spend += spend
        tot_cust += cust
        rows.append(
            {
                "channel": ch.get("channel", "channel"),
                "spend": spend,
                "customers": cust,
                "cac": _r(_div(spend, cust)),
            }
        )
    return {
        "channels": rows,
        "blended_cac": _r(_div(tot_spend, tot_cust)),
        "total_spend": _r(tot_spend),
        "total_customers": tot_cust,
    }


# --------------------------------------------------------------------------- #
# 7. budget allocation (split total budget by ROAS/efficiency)
# --------------------------------------------------------------------------- #
def budget_allocation(channels: list[dict], total_budget: float) -> dict:
    """Allocate `total_budget` across channels PROPORTIONAL to each channel's ROAS
    (efficiency weight). Channels with unknown/zero ROAS get no allocation."""
    weights = []
    for ch in channels:
        r = _f(ch.get("roas"))
        if r is None:
            r = _div(_f(ch.get("revenue"), 0.0), _f(ch.get("spend")))
        weights.append(max(0.0, r or 0.0))
    tot = sum(weights)
    rows = []
    for ch, w in zip(channels, weights, strict=False):
        share = (w / tot) if tot > 0 else 0.0
        rows.append(
            {
                "channel": ch.get("channel", "channel"),
                "roas": _r(w) if w else None,
                "allocation_pct": _r(share * 100, 2),
                "allocation": _r(share * total_budget),
            }
        )
    return {
        "total_budget": total_budget,
        "allocations": rows,
        "note": None if tot > 0 else "no positive ROAS signal; allocation is zero",
    }

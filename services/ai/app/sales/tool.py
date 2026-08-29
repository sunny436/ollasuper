"""The `compute_sales_forecast` reserved built-in — DETERMINISTIC forecast math.

Prod verification proved the model will NOT reliably honor prompt-documented numeric
constants: asked to weight a pipeline it substituted its own stage-win priors (75%/50%
instead of the documented 80%/60%) and its own coverage convention (÷ remaining quota
instead of ÷ quota). Numeric correctness therefore cannot live in the prompt — it must
be COMPUTED. This tool wraps the pure, tested `app/sales/forecast.py` so the weighted
forecast, scenarios, coverage and gap-to-quota are always exact and always use the
documented stage-probability defaults (a probability supplied per deal still overrides).

Stateless: it computes from the deals the model passes (read from the uploaded pipeline
CSV / pasted list) — no dataset, no I/O, no side effect. The model reports the returned
numbers; it does not do the arithmetic itself.
"""

from __future__ import annotations

from app.sales import forecast as F

SALES_FORECAST_TOOL_NAME = "compute_sales_forecast"

SALES_FORECAST_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": SALES_FORECAST_TOOL_NAME,
        "description": (
            "Compute a DETERMINISTIC weighted forecast + pipeline coverage from a "
            "list of open deals, applying the standard stage-win probabilities (Closed "
            "Won 100%, Negotiation/Contract 80%, Proposal/Quote 60%, Evaluation/Demo "
            "40%, Discovery/Qualification 20%, Prospecting/Lead 10%). ALWAYS call this "
            "for FORECAST and pipeline-coverage numbers instead of computing the "
            "weighted forecast, coverage or gap yourself — it guarantees the exact "
            "probabilities and formulas. Pass every open deal (amount + stage; add a "
            "per-deal probability if the CSV/user gave one). It returns the weighted "
            "forecast, best/likely/worst scenarios, coverage ratio, gap to quota, the "
            "per-stage breakdown, and the commit vs upside split; report THOSE numbers."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "deals": {
                    "type": "array",
                    "description": "Every open deal in the pipeline.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "amount": {
                                "type": "number",
                                "description": "Deal value (numeric).",
                            },
                            "stage": {
                                "type": "string",
                                "description": "Sales stage, e.g. 'Negotiation'.",
                            },
                            "probability": {
                                "type": "number",
                                "description": (
                                    "OPTIONAL 0-1 (or 0-100) win probability from the "
                                    "CRM/user; overrides the stage default."
                                ),
                            },
                        },
                        "required": ["amount"],
                    },
                },
                "quota": {"type": "number", "description": "The period quota."},
                "closed": {
                    "type": "number",
                    "description": "Revenue already closed-won (default 0).",
                },
                "custom_probabilities": {
                    "type": "object",
                    "description": (
                        "OPTIONAL map of stage -> probability (0-1) to override the "
                        "defaults for ALL deals in that stage."
                    ),
                },
            },
            "required": ["deals"],
        },
    },
}


def _num(v: object) -> float:
    """Tolerant numeric parse: strips $, commas, spaces; '' / bad -> 0.0."""
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip().replace("$", "").replace(",", "").replace("%", "")
        try:
            return float(s)
        except ValueError:
            return 0.0
    return 0.0


def _prob(v: object) -> float | None:
    """A per-deal probability: accept 0-1 or 0-100 (e.g. 75 -> 0.75)."""
    if v is None:
        return None
    p = _num(v)
    if p > 1:
        p = p / 100.0
    return max(0.0, min(1.0, p))


def compute_forecast(args: dict) -> dict:
    """Pure: build the forecast result from the tool args via `forecast.py`. Never
    raises — a bad shape comes back as {"error": …} so the turn continues."""
    raw = args.get("deals")
    if not isinstance(raw, list) or not raw:
        return {"error": "no deals provided; pass the open pipeline as `deals`"}
    custom_in = args.get("custom_probabilities")
    custom = None
    if isinstance(custom_in, dict) and custom_in:
        custom = {str(k): _prob(v) or 0.0 for k, v in custom_in.items()}

    deals: list[F.Deal] = []
    for d in raw:
        if not isinstance(d, dict):
            continue
        deals.append(
            F.Deal(
                amount=_num(d.get("amount")),
                stage=str(d.get("stage") or ""),
                probability=_prob(d.get("probability")),
            )
        )
    if not deals:
        return {"error": "deals list had no usable rows (need amount + stage)"}

    quota = _num(args.get("quota"))
    closed = _num(args.get("closed"))
    weighted = F.weighted_forecast(deals, custom)
    sc = F.scenarios(deals, custom)
    open_amt = F.open_pipeline(deals)
    cov = F.coverage_ratio(open_amt, quota)

    # per-stage breakdown (grouped by the raw stage label)
    by_stage: dict[str, dict] = {}
    for src, d in zip(raw, deals, strict=False):
        label = str((src or {}).get("stage") or "(unknown)")
        p = F.deal_probability(d, custom)
        b = by_stage.setdefault(
            label, {"stage": label, "count": 0, "amount": 0.0, "probability": p}
        )
        b["count"] += 1
        b["amount"] += d.amount
    for b in by_stage.values():
        b["weighted"] = round(b["amount"] * b["probability"], 2)

    def _round(x: float | None) -> float | None:
        return None if x is None else round(x, 2)

    return {
        "quota": quota,
        "closed": closed,
        "open_pipeline": open_amt,
        "weighted_forecast": _round(weighted),
        "projected_total_incl_closed": _round(closed + weighted),
        "scenarios": {
            "best": _round(sc["best"]),
            "likely": _round(sc["likely"]),
            "worst": _round(sc["worst"]),
        },
        "coverage_ratio": _round(cov),
        "coverage_band": F.coverage_band(cov),
        "gap_to_quota": _round(F.gap_to_quota(quota, closed, weighted)),
        "commit_amount": _round(sum(d.amount for d in F.commit_deals(deals, custom))),
        "upside_amount": _round(sum(d.amount for d in F.upside_deals(deals, custom))),
        "by_stage": list(by_stage.values()),
        "default_stage_probabilities": {
            "Closed Won": 1.0,
            "Negotiation/Contract": 0.8,
            "Proposal/Quote": 0.6,
            "Evaluation/Demo": 0.4,
            "Discovery/Qualification": 0.2,
            "Prospecting/Lead": 0.1,
        },
        "coverage_formula": "open_pipeline / quota",
        "gap_formula": "quota - (closed + weighted_forecast)",
    }

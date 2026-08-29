"""The two reserved Marketing built-ins — DETERMINISTIC math + on-demand playbooks.

`marketing_calc` wraps the pure, tested `app/marketing/calc.py` so A/B sample-size &
significance, funnel conversion, ROAS/attribution, CAC and budget splits are COMPUTED,
never produced by LLM arithmetic (the Finance work proved the model gets stats wrong).
`marketing_reference` serves the bundled MARKETING-owned specialist playbooks on demand.
Both are stateless, read-only, no network; a bad shape comes back as {"error": …}.
"""

from __future__ import annotations

from app.marketing import calc as C
from app.marketing import references as R

MARKETING_CALC_TOOL_NAME = "marketing_calc"
MARKETING_REFERENCE_TOOL_NAME = "marketing_reference"

_KINDS = (
    "sample_size",
    "ab_test",
    "funnel",
    "roas",
    "attribution",
    "cac",
    "budget_allocation",
)


def _num(v: object, default: float | None = None) -> float | None:
    return C._f(v, default)


def _obj(args: dict, key: str) -> dict:
    v = args.get(key)
    return v if isinstance(v, dict) else args


MARKETING_CALC_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": MARKETING_CALC_TOOL_NAME,
        "description": (
            "Compute DETERMINISTIC marketing numbers. ALWAYS call this for A/B-test "
            "math, funnel conversion, ROAS/attribution, CAC and budget allocation "
            "instead of doing the arithmetic yourself. Set `kind`: 'sample_size' (A/B "
            "test size from baseline + minimum detectable effect), 'ab_test' "
            "(two-proportion significance / p-value / lift / winner from observed "
            "results), 'funnel' (stage conversion + drop-off + bottleneck), 'roas' "
            "(ROAS, break-even ROAS, CPA), 'attribution' (multi-touch credit across "
            "channels: first-touch/last-touch/linear/time-decay/position-based), 'cac' "
            "(per-channel + blended), 'budget_allocation' (split a budget by channel "
            "ROAS). Report the returned numbers; a null value is undefined (never "
            "invent one). For CAC/LTV/ROI/NPV use finance_calc; for aggregating a big "
            "campaign CSV use the data-analysis tools first."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": list(_KINDS)},
                "sample_size": {
                    "type": "object",
                    "description": "sample_size: {baseline (0-1 conversion), mde "
                    "(relative lift, e.g. 0.2), alpha (default 0.05), power "
                    "(default 0.8), daily_traffic?}.",
                },
                "ab_test": {
                    "type": "object",
                    "description": "ab_test: {control_n, control_conv, variant_n, "
                    "variant_conv, alpha (default 0.05)}.",
                },
                "funnel": {
                    "type": "object",
                    "description": "funnel: {stages: [names], counts: [ints]} "
                    "(first count is the top of the funnel).",
                },
                "roas": {
                    "type": "object",
                    "description": "roas: {spend, revenue, conversions?, margin_pct?}.",
                },
                "attribution": {
                    "type": "object",
                    "description": "attribution: {model (first-touch|last-touch|linear|"
                    "time-decay|position-based), half_life_days?, journeys: "
                    "[{converted, revenue, touchpoints: [channel names in "
                    "chronological "
                    "order, or "
                    "{channel, days_before}]}]}.",
                },
                "cac": {
                    "type": "object",
                    "description": "cac: {channels: [{channel, spend, customers}]}.",
                },
                "budget_allocation": {
                    "type": "object",
                    "description": "budget_allocation: {total_budget, channels: "
                    "[{channel, roas | revenue+spend}]}.",
                },
            },
            "required": ["kind"],
        },
    },
}

MARKETING_REFERENCE_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": MARKETING_REFERENCE_TOOL_NAME,
        "description": (
            "Load a bundled Marketing specialist playbook on demand (positioning/PMM, "
            "launch-strategy, pricing-strategy, demand-acquisition, the CRO family "
            "page-cro/form-cro/signup-flow-cro/onboarding-cro/popup-cro/paywall-upgrade"
            "-cro, paid-ads, ad-creative, social-media-manager, x-twitter-growth, "
            "youtube-full, webinar-marketing, app-store-optimization, email-sequence, "
            "referral-program, free-tool-strategy, churn-prevention, aeo, "
            "marketing-psychology, brand-guidelines, competitor-alternatives, "
            "content-strategy, social-content, campaign-analytics, analytics-tracking, "
            "marketing-ops [the 3 orchestration sequences], marketing-context). Call "
            "with `doc` (a playbook id) to get its section list + intro, then again "
            "with `section` for a specific section. Trusted reference methodology — "
            "not "
            "a source of company figures. NOTE: SEO and content-WRITING requests are "
            "delegated to the existing SEO and Blog capabilities, not served here."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "doc": {
                    "type": "string",
                    "description": "Playbook id, e.g. "
                    "'marketing-strategy-pmm', 'page-cro', 'aeo', 'launch-strategy', "
                    "'marketing-ops'.",
                },
                "section": {
                    "type": "string",
                    "description": "Optional section header to "
                    "return in full (omit first to see the section list).",
                },
            },
            "required": ["doc"],
        },
    },
}


def compute_marketing_calc(args: dict) -> dict:
    """Pure dispatch over `kind` to `calc.py`. Never raises — bad input ->
    {"error": …}."""
    if not isinstance(args, dict):
        return {"error": "invalid arguments"}
    kind = str(args.get("kind") or "").strip().lower()
    try:
        if kind == "sample_size":
            p = _obj(args, "sample_size")
            base, mde = _num(p.get("baseline")), _num(p.get("mde"))
            if base is None or mde is None:
                return {"error": "sample_size requires baseline and mde"}
            return C.sample_size(
                base,
                mde,
                alpha=_num(p.get("alpha"), 0.05) or 0.05,
                power=_num(p.get("power"), 0.80) or 0.80,
                daily_traffic=_num(p.get("daily_traffic")),
            )
        if kind == "ab_test":
            p = _obj(args, "ab_test")
            cn, cc = _num(p.get("control_n")), _num(p.get("control_conv"))
            vn, vc = _num(p.get("variant_n")), _num(p.get("variant_conv"))
            if None in (cn, cc, vn, vc):
                return {"error": "ab_test requires control_n/conv and variant_n/conv"}
            return C.ab_test(cn, cc, vn, vc, alpha=_num(p.get("alpha"), 0.05) or 0.05)
        if kind == "funnel":
            p = _obj(args, "funnel")
            stages = p.get("stages")
            counts = [_num(x, 0.0) or 0.0 for x in (p.get("counts") or [])]
            if not isinstance(stages, list) or not counts:
                return {"error": "funnel requires stages[] and counts[]"}
            return C.funnel([str(s) for s in stages], counts)
        if kind == "roas":
            p = _obj(args, "roas")
            spend = _num(p.get("spend"))
            if spend is None:
                return {"error": "roas requires spend"}
            return C.roas(
                spend,
                revenue=_num(p.get("revenue"), 0.0) or 0.0,
                conversions=_num(p.get("conversions"), 0.0) or 0.0,
                margin_pct=_num(p.get("margin_pct")),
            )
        if kind == "attribution":
            p = _obj(args, "attribution")
            journeys = p.get("journeys")
            if not isinstance(journeys, list) or not journeys:
                return {"error": "attribution requires journeys[]"}
            return C.attribution(
                journeys,
                model=str(p.get("model") or "linear"),
                half_life_days=_num(p.get("half_life_days"), 7.0) or 7.0,
            )
        if kind == "cac":
            p = _obj(args, "cac")
            channels = p.get("channels")
            if not isinstance(channels, list) or not channels:
                return {"error": "cac requires channels[]"}
            return C.cac(channels)
        if kind == "budget_allocation":
            p = _obj(args, "budget_allocation")
            channels = p.get("channels")
            total = _num(p.get("total_budget"))
            if not isinstance(channels, list) or not channels or total is None:
                return {
                    "error": "budget_allocation requires total_budget and channels[]"
                }
            return C.budget_allocation(channels, total)
        return {"error": f"unknown kind '{kind}'; expected one of {', '.join(_KINDS)}"}
    except Exception as exc:  # never raise into the tool loop
        return {"error": f"{kind or 'marketing_calc'}: {exc}"}


def run_marketing_reference(args: dict) -> dict:
    """Pure wrapper over the bundled-playbook loader. Never raises."""
    if not isinstance(args, dict):
        return {"error": "invalid arguments"}
    try:
        return R.load_reference(
            str(args.get("doc") or ""), section=(args.get("section") or None)
        )
    except Exception as exc:
        return {"error": f"marketing_reference: {exc}"}


MARKETING_TOOL_NAMES: frozenset[str] = frozenset(
    {MARKETING_CALC_TOOL_NAME, MARKETING_REFERENCE_TOOL_NAME}
)

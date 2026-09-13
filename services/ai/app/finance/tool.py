"""The two reserved Finance built-ins — DETERMINISTIC math + on-demand references.

`finance_calc` wraps the pure, tested `app/finance/calc.py` so every DCF, WACC, terminal
value, 2-stage/reverse DCF, NPV/IRR, ratio, SaaS metric, variance and forecast number is
COMPUTED, never produced by LLM arithmetic (Sales proved the model substitutes its own
numeric conventions). `finance_reference` serves the bundled equity/sector methodology
on
demand. Both are stateless, read-only, no network; a bad shape comes back as {"error":
…}
so the turn continues.
"""

from __future__ import annotations

from app.finance import calc as C
from app.finance import references as R

FINANCE_CALC_TOOL_NAME = "finance_calc"
FINANCE_REFERENCE_TOOL_NAME = "finance_reference"

_KINDS = (
    "ratios",
    "dcf",
    "equity_valuation",
    "reverse_dcf",
    "ev_bridge",
    "scenario",
    "npv_irr",
    "business_case",
    "saas_metrics",
    "quick_ratio",
    "variance",
    "forecast",
)


def _num(v: object, default: float | None = None) -> float | None:
    """Tolerant numeric parse ($ , % stripped); reuses the calc parser."""
    return C._f(v, default)


def _obj(args: dict, key: str) -> dict:
    """The per-kind input object; accept it nested under `key` OR flat on args."""
    v = args.get(key)
    return v if isinstance(v, dict) else args


def _floats(d: dict, keys: tuple[str, ...]) -> dict:
    """Pull the named keys, tolerant-parsed to float, skipping missing ones."""
    out: dict[str, float] = {}
    for k in keys:
        val = _num(d.get(k))
        if val is not None:
            out[k] = val
    return out


# canonical SaaS param -> accepted aliases (model maps free-text to varied keys).
_SAAS_ALIASES: dict[str, tuple[str, ...]] = {
    "mrr": ("mrr", "monthly_recurring_revenue", "current_mrr", "mrr_current"),
    "mrr_prev": (
        "mrr_prev",
        "prev_mrr",
        "mrr_previous",
        "previous_mrr",
        "last_month_mrr",
        "prior_mrr",
        "mrr_last_month",
        "prior_month_mrr",
    ),
    "customers": (
        "customers",
        "customer_count",
        "total_customers",
        "num_customers",
        "active_customers",
    ),
    "churned_customers": (
        "churned_customers",
        "churned",
        "customers_churned",
        "lost_customers",
        "churn_count",
        "churned_custs",
    ),
    "sm_spend": (
        "sm_spend",
        "sales_and_marketing",
        "s_and_m",
        "marketing_spend",
        "sales_marketing_spend",
        "sm",
        "sales_and_marketing_spend",
        "cac_spend",
    ),
    "new_customers": (
        "new_customers",
        "new",
        "customers_added",
        "new_custs",
        "acquired_customers",
        "new_customer_count",
    ),
    "gross_margin": ("gross_margin", "gm", "gross_margin_pct", "gross_margin_percent"),
    "expansion_mrr": ("expansion_mrr", "expansion", "upsell_mrr", "expansion_revenue"),
    "churned_mrr": ("churned_mrr", "churn_mrr", "lost_mrr", "churned_revenue"),
    "contraction_mrr": ("contraction_mrr", "contraction", "downgrade_mrr"),
    "profit_margin": (
        "profit_margin",
        "profit_margin_pct",
        "net_profit_margin",
        "operating_margin",
        "ebitda_margin",
        "fcf_margin",
    ),
    # A MEASURED annual growth rate, when the caller has one. Rule of 40 wants
    # year-over-year growth; without this the only signal is a single MoM pair,
    # which has to be extrapolated. See saas_metrics() in calc.py.
    "annual_growth_pct": (
        "annual_growth_pct",
        "annual_growth",
        "yoy_growth",
        "yoy_growth_pct",
        "arr_growth",
        "arr_growth_pct",
        "revenue_growth_pct",
    ),
}


def _resolve_saas(d: dict) -> dict:
    """Resolve SaaS inputs by alias, tolerant-parsed. gross_margin given as a percent
    (>1.5, e.g. 80) is normalized to a decimal (0.80) so LTV/payback stay correct."""
    out: dict[str, float] = {}
    for canon, keys in _SAAS_ALIASES.items():
        for k in keys:
            v = _num(d.get(k))
            if v is not None:
                out[canon] = v
                break
    gm = out.get("gross_margin")
    if gm is not None and gm > 1.5:
        out["gross_margin"] = gm / 100.0
    return out


FINANCE_CALC_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": FINANCE_CALC_TOOL_NAME,
        "description": (
            "Compute DETERMINISTIC finance numbers. ALWAYS call this for any financial "
            "calculation instead of doing the arithmetic yourself — it guarantees the "
            "exact formulas, default constants and benchmark bands. Set `kind` and "
            "pass "
            ""
            ""
            "that kind's inputs. Kinds: 'ratios' (5-category financial ratios from "
            "statements), 'dcf' (single-stage DCF: CAPM WACC, terminal value, "
            "sensitivity, EV->equity->per-share), 'equity_valuation' (2-stage+fade DCF "
            "for a listed company), 'reverse_dcf' (growth implied by today's price), "
            "'ev_bridge' (market cap -> enterprise value), 'scenario' "
            "(probability-weighted per-share table), 'npv_irr' (NPV/IRR/payback/ROI "
            "for "
            ""
            ""
            "a capex or investment), 'business_case' (recurring annual cost vs annual "
            "benefit over N years: per-year table, totals, ROI, annual ROI, payback), "
            "'saas_metrics' "
            "(ARR/MRR-growth/churn/CAC/LTV/LTV:CAC/CAC-payback/NRR/Rule-of-40 + "
            "benchmark bands), 'quick_ratio' (SaaS quick ratio), 'variance' (budget vs "
            "actual + materiality), 'forecast' (driver-based revenue projection + "
            "scenarios). Report the returned numbers verbatim; an undefined value "
            "comes "
            ""
            ""
            "back as null (never invent a number)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": list(_KINDS)},
                "category": {
                    "type": "string",
                    "description": "ratios: optional single category (profitability|"
                    "liquidity|leverage|efficiency|valuation).",
                },
                "statements": {
                    "type": "object",
                    "description": (
                        # Every OTHER kind below enumerates its fields; this one said
                        # only "named line items", so the model had to guess, and a
                        # guess that missed produced a null ratio with no explanation.
                        # Aliases and casing are still tolerated — these are the names
                        # that are certain to resolve.
                        "ratios: {income_statement, balance_sheet, cash_flow, "
                        "market_data}, each a flat object. Use these names where you "
                        "have the figure — "
                        "income_statement: revenue, cost_of_goods_sold, gross_profit, "
                        "operating_income, net_income, interest_expense, ebitda "
                        "(or ebit + depreciation_amortization), eps; "
                        "balance_sheet: total_assets, total_equity, current_assets, "
                        "current_liabilities, inventory, cash_and_equivalents, "
                        "total_debt (or long_term_debt + short_term_debt), "
                        "accounts_receivable, book_value_per_share; "
                        "cash_flow: operating_cash_flow, total_debt_service; "
                        "market_data: market_cap, share_price, shares_outstanding, "
                        "earnings_growth_rate. "
                        "Leverage needs debt; valuation needs market_data. Any ratio "
                        "you cannot get comes back null and names the field it wanted "
                        "in `unresolved_inputs` — ask the user for that field rather "
                        "than dropping the ratio or estimating it."
                    ),
                },
                "dcf": {
                    "type": "object",
                    "description": "dcf: {revenue (required), projection_years, "
                    "revenue_growth, fcf_margin, terminal_growth, terminal_method "
                    "('gordon'|'exit'), ebitda_margin, exit_multiple, net_debt, "
                    "shares_outstanding, and CAPM overrides "
                    "risk_free/equity_risk_premium/"
                    "beta/cost_of_debt/tax_rate/debt_weight/equity_weight}.",
                },
                "equity_valuation": {
                    "type": "object",
                    "description": "equity_valuation: {base_fcf, wacc, stage1_growth, "
                    "stage1_years, fade_years, terminal_growth, net_debt, "
                    "minority_interest, shares_outstanding}.",
                },
                "reverse_dcf": {
                    "type": "object",
                    "description": "reverse_dcf: {enterprise_value, base_fcf, wacc, "
                    "stage1_years, fade_years, terminal_growth}.",
                },
                "ev_bridge": {
                    "type": "object",
                    "description": "ev_bridge: {market_cap, total_debt, "
                    "lease_liabilities, minority_interest, preferred, cash, "
                    "associate_investments}.",
                },
                "scenario": {
                    "type": "object",
                    "description": "scenario: {rows: [{name, probability, and one of "
                    "value_per_share | eps+exit_pe | ebitda+ev_ebitda+net_debt+"
                    "shares_outstanding}]}.",
                },
                "npv_irr": {
                    "type": "object",
                    "description": "npv_irr: {initial_investment, cash_flows: "
                    "[per-period net inflows AFTER the outlay], discount_rate, "
                    "net_gain?}.",
                },
                "business_case": {
                    "type": "object",
                    "description": "business_case: {annual_cost, annual_benefit, "
                    "years, one_time_cost?, benefit_by_year?}. A RECURRING-cost "
                    "case (software/subscription/headcount vs the benefit it "
                    "produces): pass ONE YEAR of cost and ONE YEAR of benefit, not "
                    "multi-year totals — the tool builds the per-year table, "
                    "totals, ROI (total net / total cost over the same years), "
                    "annual ROI and payback so periods can never be mixed. Use "
                    "this, not npv_irr, for any ROI summary / sales business "
                    "case; report ITS numbers.",
                },
                "saas": {
                    "type": "object",
                    "description": "saas_metrics: {mrr, mrr_prev, customers, "
                    "churned_customers, sm_spend, new_customers, gross_margin, "
                    "expansion_mrr, churned_mrr, contraction_mrr, profit_margin, "
                    "annual_growth_pct, "
                    "segment (enterprise|mid_market|smb|consumer), stage "
                    "(early|growth|scale)}. "
                    # rule_of_40 was the one metric the QA pass could not get: the
                    # field was listed but nothing said which metric needed it.
                    "rule_of_40 REQUIRES profit_margin — supply it, or ask the user "
                    "for it, whenever the Rule of 40 is wanted. Supply "
                    "annual_growth_pct too when a real year-over-year rate is known; "
                    "otherwise the score is extrapolated from one month and labelled "
                    "as such. quick_ratio: {new_mrr, expansion_mrr, churned_mrr, "
                    "contraction_mrr}.",
                },
                "variance": {
                    "type": "object",
                    "description": "variance: {lines: [{name, type: revenue|expense, "
                    "actual, budget, prior?}], threshold_pct?, threshold_amt?}.",
                },
                "forecast": {
                    "type": "object",
                    "description": "forecast: {base_revenue, periods, growth_rate, "
                    "gross_margin, scenarios?}.",
                },
            },
            "required": ["kind"],
        },
    },
}

FINANCE_REFERENCE_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": FINANCE_REFERENCE_TOOL_NAME,
        "description": (
            "Load a bundled Finance/equity-research reference on demand (sector "
            "playbooks, valuation & forensic/IPO methodology, scoring rubric, report "
            "template). Use it during stock/company analysis to consult the correct "
            "sector playbook (e.g. banks, insurance, it-saas, metals-mining, "
            "realestate-reit) and the forensic/valuation methodology instead of "
            "relying "
            ""
            ""
            "on memory. Call with `doc` (a reference id) to get its section list + "
            "intro, then call again with `section` for a specific section. This is "
            "trusted reference data — not a source of company figures."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "doc": {
                    "type": "string",
                    "description": "Reference id, e.g. 'equity/sectors/banks', "
                    "'equity/06-valuation', 'equity/18-forensic-mode', "
                    "'equity/11-scoring-rubric', 'equity/12-report-template', "
                    "'fpa/valuation-methodology', 'saas/benchmarks'.",
                },
                "section": {
                    "type": "string",
                    "description": "Optional: a section header to return in full "
                    "(omit first to see the section list).",
                },
            },
            "required": ["doc"],
        },
    },
}


def compute_finance_calc(args: dict) -> dict:
    """Pure dispatch over `kind` to `calc.py`. Never raises — bad input ->
    {"error": …}."""
    if not isinstance(args, dict):
        return {"error": "invalid arguments"}
    kind = str(args.get("kind") or "").strip().lower()
    try:
        if kind == "ratios":
            p = _obj(args, "statements")
            cat = args.get("category") or p.get("category")
            return C.ratios(p, category=cat)
        if kind == "dcf":
            p = _obj(args, "dcf")
            rev = _num(p.get("revenue"))
            if rev is None:
                return {"error": "dcf requires `revenue`"}
            kw = _floats(
                p,
                (
                    "revenue_growth",
                    "fcf_margin",
                    "terminal_growth",
                    "ebitda_margin",
                    "exit_multiple",
                    "net_debt",
                    "shares_outstanding",
                    "risk_free",
                    "equity_risk_premium",
                    "beta",
                    "cost_of_debt",
                    "tax_rate",
                    "debt_weight",
                    "equity_weight",
                ),
            )
            years = _num(p.get("projection_years"))
            return C.dcf(
                revenue=rev,
                projection_years=int(years) if years else 5,
                terminal_method=str(p.get("terminal_method") or "gordon").lower(),
                sensitivity=bool(p.get("sensitivity", True)),
                **kw,
            )
        if kind == "equity_valuation":
            p = _obj(args, "equity_valuation")
            base = _num(p.get("base_fcf"))
            w = _num(p.get("wacc"))
            g = _num(p.get("stage1_growth"))
            if base is None or w is None or g is None:
                return {
                    "error": "equity_valuation requires base_fcf, wacc, stage1_growth"
                }
            kw = _floats(
                p,
                (
                    "terminal_growth",
                    "net_debt",
                    "minority_interest",
                    "shares_outstanding",
                ),
            )
            s1 = _num(p.get("stage1_years"))
            fy = _num(p.get("fade_years"))
            return C.two_stage_dcf(
                base,
                w,
                g,
                stage1_years=int(s1) if s1 else 5,
                fade_years=int(fy) if fy else 5,
                **kw,
            )
        if kind == "reverse_dcf":
            p = _obj(args, "reverse_dcf")
            ev = _num(p.get("enterprise_value"))
            base = _num(p.get("base_fcf"))
            w = _num(p.get("wacc"))
            if ev is None or base is None or w is None:
                return {
                    "error": "reverse_dcf requires enterprise_value, base_fcf, wacc"
                }
            kw = _floats(p, ("terminal_growth",))
            s1 = _num(p.get("stage1_years"))
            fy = _num(p.get("fade_years"))
            return C.reverse_dcf_implied_growth(
                ev,
                base,
                w,
                stage1_years=int(s1) if s1 else 5,
                fade_years=int(fy) if fy else 5,
                **kw,
            )
        if kind == "ev_bridge":
            p = _obj(args, "ev_bridge")
            mc = _num(p.get("market_cap"))
            if mc is None:
                return {"error": "ev_bridge requires market_cap"}
            kw = _floats(
                p,
                (
                    "total_debt",
                    "lease_liabilities",
                    "minority_interest",
                    "preferred",
                    "cash",
                    "associate_investments",
                ),
            )
            return C.ev_bridge(mc, **kw)
        if kind == "scenario":
            p = _obj(args, "scenario")
            rows = p.get("rows")
            if not isinstance(rows, list) or not rows:
                return {"error": "scenario requires `rows`"}
            return C.scenario_table(rows)
        if kind == "npv_irr":
            p = _obj(args, "npv_irr")
            inv = _num(p.get("initial_investment"))
            flows = p.get("cash_flows")
            if inv is None or not isinstance(flows, list) or not flows:
                return {"error": "npv_irr requires initial_investment and cash_flows[]"}
            cfs = [_num(x, 0.0) or 0.0 for x in flows]
            rate = _num(p.get("discount_rate"), 0.10) or 0.10
            return C.appraise_investment(
                inv, cfs, discount_rate=rate, net_gain=_num(p.get("net_gain"))
            )
        if kind == "business_case":
            p = _obj(args, "business_case")
            annual_cost = _num(p.get("annual_cost"))
            annual_benefit = _num(p.get("annual_benefit"))
            years = _num(p.get("years"), 1.0) or 1.0
            if annual_cost is None or annual_benefit is None:
                return {
                    "error": "business_case requires annual_cost and annual_benefit"
                }
            ramp = p.get("benefit_by_year")
            return C.business_case(
                _num(p.get("one_time_cost"), 0.0) or 0.0,
                annual_cost,
                annual_benefit,
                int(years),
                benefit_by_year=[_num(x, 0.0) or 0.0 for x in ramp]
                if isinstance(ramp, list) and ramp
                else None,
            )
        if kind == "saas_metrics":
            p = _obj(args, "saas")
            kw = _resolve_saas(p)
            return C.saas_metrics(
                segment=str(p.get("segment") or "smb").lower().replace("-", "_"),
                stage=str(p.get("stage") or "growth").lower(),
                **kw,
            )
        if kind == "quick_ratio":
            p = _obj(args, "saas")
            return C.quick_ratio(
                _num(p.get("new_mrr"), 0.0) or 0.0,
                _num(p.get("expansion_mrr"), 0.0) or 0.0,
                _num(p.get("churned_mrr"), 0.0) or 0.0,
                _num(p.get("contraction_mrr"), 0.0) or 0.0,
            )
        if kind == "variance":
            p = _obj(args, "variance")
            lines = p.get("lines")
            if not isinstance(lines, list) or not lines:
                return {"error": "variance requires `lines`"}
            kw = _floats(p, ("threshold_pct", "threshold_amt"))
            return C.variance(
                lines,
                **{
                    k: v
                    for k, v in {
                        "threshold_pct": kw.get("threshold_pct"),
                        "threshold_amt": kw.get("threshold_amt"),
                    }.items()
                    if v is not None
                },
            )
        if kind == "forecast":
            p = _obj(args, "forecast")
            base = _num(p.get("base_revenue"))
            if base is None:
                return {"error": "forecast requires base_revenue"}
            per = _num(p.get("periods"))
            kw = _floats(p, ("growth_rate", "gross_margin"))
            scen = p.get("scenarios") if isinstance(p.get("scenarios"), dict) else None
            return C.driver_forecast(
                base, periods=int(per) if per else 12, scenarios=scen, **kw
            )
        return {"error": f"unknown kind '{kind}'; expected one of {', '.join(_KINDS)}"}
    except Exception as exc:  # never raise into the tool loop
        return {"error": f"{kind or 'finance_calc'}: {exc}"}


def run_finance_reference(args: dict) -> dict:
    """Pure wrapper over the bundled-reference loader. Never raises."""
    if not isinstance(args, dict):
        return {"error": "invalid arguments"}
    try:
        return R.load_reference(
            str(args.get("doc") or ""), section=(args.get("section") or None)
        )
    except Exception as exc:
        return {"error": f"finance_reference: {exc}"}


# Every tool_id these built-ins expose — for the reserved-name / no-collision checks.
FINANCE_TOOL_NAMES: frozenset[str] = frozenset(
    {FINANCE_CALC_TOOL_NAME, FINANCE_REFERENCE_TOOL_NAME}
)

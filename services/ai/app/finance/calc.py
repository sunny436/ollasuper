"""Pure, hermetic, JSON-safe deterministic Finance math — the SINGLE SOURCE OF TRUTH.

Every formula, default constant and benchmark band here is verified verbatim against the
source `finance/` scripts (MIT, alirezarezvani/claude-skills): `ratio_calculator.py`,
`dcf_valuation.py`, stock `valuation.py`, `metrics_calculator.py` + `quick_ratio_
calculator.py`, `budget_variance_analyzer.py`, `forecast_builder.py`, and the
investment-advisor SKILL. The Finance skills document these SAME numbers; the
`test_finance_calc` drift-guard binds guidance to code so they can never silently drift.

No I/O, no network, no clock, no hidden state → fully deterministic. Division by zero or
missing inputs return `None` for an undefined METRIC (never a fabricated 0), while
genuine
zero terms inside a sum stay 0.0. Callers (the `finance_calc` tool) report these
numbers;
the model never does the arithmetic itself.
"""

from __future__ import annotations

from typing import Any

Number = float | int


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
    """a / b, or None when b is 0/None/missing (undefined — never fabricated)."""
    if a is None or b is None or b == 0:
        return None
    return a / b


def _r(x: float | None, nd: int = 2) -> float | None:
    return None if x is None else round(x, nd)


def _pick(value: float | None, cuts: list[tuple[float, str]]) -> str | None:
    """Return the label of the first (cut, label) whose `value < cut`; else the last
    label. `cuts` is ordered ascending so it works for both higher-better and
    lower-better metrics (the labels encode the direction). None -> None."""
    if value is None:
        return None
    for cut, label in cuts:
        if value < cut:
            return label
    return cuts[-1][1]


_INF = float("inf")


# --------------------------------------------------------------------------- #
# 1. financial ratios (ratio_calculator.py — 5 categories)
# --------------------------------------------------------------------------- #
# Industry benchmark ranges (low, typical, high) — verbatim from the source.
RATIO_BENCHMARKS: dict[str, tuple[float, float, float]] = {
    "roe": (0.08, 0.15, 0.25),
    "roa": (0.03, 0.06, 0.12),
    "gross_margin": (0.25, 0.40, 0.60),
    "operating_margin": (0.05, 0.15, 0.25),
    "net_margin": (0.03, 0.10, 0.20),
    "current_ratio": (1.0, 1.5, 3.0),
    "quick_ratio": (0.8, 1.0, 2.0),
    "cash_ratio": (0.2, 0.5, 1.0),
    "debt_to_equity": (0.3, 0.8, 2.0),
    "interest_coverage": (2.0, 5.0, 10.0),
    "dscr": (1.0, 1.5, 2.5),
    "asset_turnover": (0.5, 1.0, 2.0),
    "inventory_turnover": (4.0, 8.0, 12.0),
    "receivables_turnover": (6.0, 10.0, 15.0),
    "dso": (30.0, 45.0, 60.0),
    "pe_ratio": (10.0, 20.0, 35.0),
    "pb_ratio": (1.0, 2.5, 5.0),
    "ps_ratio": (1.0, 3.0, 8.0),
    "ev_ebitda": (6.0, 12.0, 20.0),
    "peg_ratio": (0.5, 1.0, 2.0),
}

_RATIO_FORMULA: dict[str, str] = {
    "roe": "Net Income / Total Equity",
    "roa": "Net Income / Total Assets",
    "gross_margin": "(Revenue - COGS) / Revenue",
    "operating_margin": "Operating Income / Revenue",
    "net_margin": "Net Income / Revenue",
    "current_ratio": "Current Assets / Current Liabilities",
    "quick_ratio": "(Current Assets - Inventory) / Current Liabilities",
    "cash_ratio": "Cash & Equivalents / Current Liabilities",
    "debt_to_equity": "Total Debt / Total Equity",
    "interest_coverage": "Operating Income / Interest Expense",
    "dscr": "Operating Cash Flow / Total Debt Service",
    "asset_turnover": "Revenue / Total Assets",
    "inventory_turnover": "COGS / Inventory",
    "receivables_turnover": "Revenue / Accounts Receivable",
    "dso": "365 / Receivables Turnover",
    "pe_ratio": "Share Price / EPS",
    "pb_ratio": "Share Price / Book Value Per Share",
    "ps_ratio": "Market Cap / Revenue",
    "ev_ebitda": "Enterprise Value / EBITDA",
    "peg_ratio": "P/E / (Earnings Growth Rate %)",
}


def interpret_ratio(key: str, value: float | None) -> str:
    """Interpret a ratio against its benchmark (verbatim thresholds/wording)."""
    if value is None:
        return "Insufficient data to calculate"
    bm = RATIO_BENCHMARKS.get(key)
    if not bm:
        return "No benchmark available"
    low, typical, high = bm
    if key == "dso":  # inverse — lower is better
        if value <= low:
            return "Excellent - collections well above average"
        if value <= typical:
            return "Good - collections within normal range"
        if value <= high:
            return "Acceptable - monitor collection trends"
        return "Concern - collections significantly slower than peers"
    if key == "debt_to_equity":  # lower generally better
        if value <= low:
            return "Conservative leverage - strong equity position"
        if value <= typical:
            return "Moderate leverage - well balanced"
        if value <= high:
            return "Elevated leverage - monitor debt levels"
        return "High leverage - potential financial risk"
    if value < low:
        return "Below average - needs improvement"
    if value <= typical:
        return "Acceptable - within normal range"
    if value <= high:
        return "Good - above average performance"
    return "Excellent - significantly above peers"


def ratios(data: dict, category: str | None = None) -> dict:
    """5-category financial ratios from statement data. `data` may carry
    income_statement / balance_sheet / cash_flow / market_data sections (missing
    fields default to 0). Every ratio -> {value, formula, name, interpretation};
    an undefined ratio has value None (never a fabricated 0)."""
    # Robust to how the model maps free-text -> JSON: search the labelled section
    # first, then a MERGED view of every section + top-level scalar, so a field placed
    # flat, in the "wrong" section, or under an alias is still found (e2e showed the
    # model nests some lines and drops/moves others, e.g. COGS).
    inc = data.get("income_statement")
    bal = data.get("balance_sheet")
    cf = data.get("cash_flow")
    mkt = data.get("market_data")
    merged: dict = {}
    for _sec in ("income_statement", "balance_sheet", "cash_flow", "market_data"):
        _v = data.get(_sec)
        if isinstance(_v, dict):
            merged.update(_v)
    for _k, _v in data.items():
        if not isinstance(_v, dict):
            merged.setdefault(_k, _v)

    def g(section: object, *keys: str) -> float:
        """First present ALIAS (section first, then the merged all-fields view),
        tolerant-parsed; 0.0 if none. Alias + placement tolerance is load-bearing: an
        unmapped/misplaced field must not silently poison a ratio."""
        for src in (section, merged):
            if isinstance(src, dict):
                for k in keys:
                    v = _f(src.get(k))
                    if v is not None:
                        return v
        return 0.0

    revenue = g(
        inc,
        "revenue",
        "sales",
        "total_revenue",
        "net_revenue",
        "net_sales",
        "revenue_from_operations",
        "total_sales",
        "turnover",
    )
    cogs = g(
        inc,
        "cost_of_goods_sold",
        "cogs",
        "cost_of_sales",
        "cost_of_revenue",
        "cost_of_goods",
        "cost_of_goods_sold_cogs",
    )
    # If the model gave gross profit instead of COGS, derive COGS so gross margin AND
    # inventory turnover stay correct (e2e: model dropped COGS -> margin read 100%).
    gross_profit = g(inc, "gross_profit", "gross_income", "gross_profit_loss")
    if cogs == 0 and gross_profit and revenue:
        cogs = revenue - gross_profit
    op_income = g(
        inc,
        "operating_income",
        "operating_profit",
        "ebit",
        "operating_income_loss",
        "income_from_operations",
    )
    net_income = g(
        inc,
        "net_income",
        "net_profit",
        "profit",
        "net_earnings",
        "pat",
        "profit_after_tax",
        "net_income_loss",
    )
    interest = g(
        inc,
        "interest_expense",
        "interest",
        "finance_costs",
        "interest_expenses",
        "interest_cost",
    )
    ebitda = g(inc, "ebitda") or g(mkt, "ebitda")
    equity = g(
        bal,
        "total_equity",
        "equity",
        "shareholders_equity",
        "stockholders_equity",
        "total_shareholders_equity",
        "net_worth",
    )
    assets = g(bal, "total_assets", "assets")
    cur_assets = g(bal, "current_assets", "total_current_assets")
    cur_liab = g(bal, "current_liabilities", "total_current_liabilities")
    inventory = g(bal, "inventory", "inventories", "stock", "stock_in_trade")
    cash = g(
        bal,
        "cash_and_equivalents",
        "cash",
        "cash_and_cash_equivalents",
        "cash_equivalents",
        "cash_and_bank",
    )
    debt = g(bal, "total_debt", "debt", "total_borrowings", "borrowings")
    ar = g(
        bal,
        "accounts_receivable",
        "receivables",
        "trade_receivables",
        "ar",
        "accounts_receivables",
        "debtors",
    )
    ocf = g(
        cf,
        "operating_cash_flow",
        "cash_from_operations",
        "ocf",
        "cfo",
        "operating_cashflow",
        "cash_flow_from_operations",
    )
    debt_service = _f((cf or {}).get("total_debt_service"), interest) or 0.0
    mkt_cap = g(
        mkt,
        "market_cap",
        "market_capitalization",
        "mktcap",
        "marketcap",
        "market_value",
    )
    price = g(mkt, "share_price", "price", "current_price", "stock_price")
    shares = g(
        mkt,
        "shares_outstanding",
        "shares",
        "diluted_shares",
        "number_of_shares",
        "total_shares",
    )
    growth = g(
        mkt, "earnings_growth_rate", "growth_rate", "eps_growth", "earnings_growth"
    )

    if mkt_cap == 0 and price > 0 and shares > 0:
        mkt_cap = price * shares
    eps = _div(net_income, shares)
    bvps = _div(equity, shares)
    ev = mkt_cap + debt - cash
    rec_turn = _div(revenue, ar)

    vals: dict[str, float | None] = {
        "roe": _div(net_income, equity),
        "roa": _div(net_income, assets),
        "gross_margin": _div(revenue - cogs, revenue),
        "operating_margin": _div(op_income, revenue),
        "net_margin": _div(net_income, revenue),
        "current_ratio": _div(cur_assets, cur_liab),
        "quick_ratio": _div(cur_assets - inventory, cur_liab),
        "cash_ratio": _div(cash, cur_liab),
        "debt_to_equity": _div(debt, equity),
        "interest_coverage": _div(op_income, interest),
        "dscr": _div(ocf, debt_service),
        "asset_turnover": _div(revenue, assets),
        "inventory_turnover": _div(cogs, inventory),
        "receivables_turnover": rec_turn,
        "dso": _div(365.0, rec_turn),
        "pe_ratio": _div(price, eps),
        "pb_ratio": _div(price, bvps),
        "ps_ratio": _div(mkt_cap, revenue),
        "ev_ebitda": _div(ev, ebitda),
        "peg_ratio": _div(_div(price, eps), growth * 100) if growth > 0 else None,
    }
    cats = {
        "profitability": [
            "roe",
            "roa",
            "gross_margin",
            "operating_margin",
            "net_margin",
        ],
        "liquidity": ["current_ratio", "quick_ratio", "cash_ratio"],
        "leverage": ["debt_to_equity", "interest_coverage", "dscr"],
        "efficiency": [
            "asset_turnover",
            "inventory_turnover",
            "receivables_turnover",
            "dso",
        ],
        "valuation": ["pe_ratio", "pb_ratio", "ps_ratio", "ev_ebitda", "peg_ratio"],
    }
    out: dict[str, dict] = {}
    keep = [category] if category in cats else cats.keys()
    for cat in keep:
        out[cat] = {
            k: {
                "value": _r(vals[k], 4),
                "formula": _RATIO_FORMULA[k],
                "interpretation": interpret_ratio(k, vals[k]),
            }
            for k in cats[cat]
        }
    return {"categories": out}


# --------------------------------------------------------------------------- #
# 2. WACC / DCF (dcf_valuation.py — single-stage Gordon)
# --------------------------------------------------------------------------- #
def _wacc_raw(
    risk_free: float = 0.04,
    equity_risk_premium: float = 0.06,
    beta: float = 1.0,
    cost_of_debt: float = 0.05,
    tax_rate: float = 0.25,
    debt_weight: float = 0.30,
    equity_weight: float = 0.70,
) -> tuple[float, float, float]:
    """Full-precision CAPM WACC (w, cost_of_equity, after_tax_cost_of_debt) for the
    DCF math — never pre-rounded, so the discounting stays exact."""
    cost_equity = risk_free + beta * equity_risk_premium
    after_tax_debt = cost_of_debt * (1 - tax_rate)
    return (
        equity_weight * cost_equity + debt_weight * after_tax_debt,
        cost_equity,
        after_tax_debt,
    )


def wacc(**kwargs: Any) -> dict:
    """CAPM WACC (rounded for display).
    Re = Rf + β·ERP ; WACC = E/V·Re + D/V·Rd·(1-T)."""
    w, cost_equity, after_tax_debt = _wacc_raw(**kwargs)
    return {
        "wacc": _r(w, 4),
        "cost_of_equity": _r(cost_equity, 4),
        "after_tax_cost_of_debt": _r(after_tax_debt, 4),
    }


def terminal_value_gordon(terminal_fcf: float, wacc_: float, g: float = 0.025) -> float:
    """Gordon growth TV = FCF·(1+g)/(WACC-g). WACC<=g -> 0.0 (undefined perpetuity)."""
    if wacc_ <= g:
        return 0.0
    return terminal_fcf * (1 + g) / (wacc_ - g)


def terminal_value_exit(
    terminal_revenue: float, ebitda_margin: float = 0.20, exit_multiple: float = 12.0
) -> float:
    """Exit-multiple TV = (terminal revenue · EBITDA margin) · EV/EBITDA multiple."""
    return terminal_revenue * ebitda_margin * exit_multiple


def dcf(
    revenue: float | None = None,
    projection_years: int = 5,
    revenue_growth: float = 0.05,
    fcf_margin: float = 0.10,
    terminal_growth: float = 0.025,
    ebitda_margin: float = 0.20,
    exit_multiple: float = 12.0,
    terminal_method: str = "gordon",
    net_debt: float = 0.0,
    shares_outstanding: float = 1.0,
    sensitivity: bool = True,
    **wacc_kwargs: Any,
) -> dict:
    """Single-stage DCF (dcf_valuation.py). Projects FCF = revenue·margin growing at
    revenue_growth, discounts at CAPM WACC, adds terminal value, bridges EV->equity->
    per-share, and (optionally) a ±2% WACC × ±1% terminal-growth sensitivity grid.
    Missing revenue -> ValueError. ÷0 -> None. WACC<=g -> TV 0 /
    sensitivity cell null."""
    if revenue is None:
        raise ValueError("dcf requires a base `revenue`")
    wr = wacc(**wacc_kwargs)
    w = _wacc_raw(**wacc_kwargs)[0]  # full precision for the discounting math

    def _run(w_: float, tg_: float) -> dict:
        fcfs, pv_sum, rev = [], 0.0, revenue
        for year in range(1, projection_years + 1):
            rev = rev * (1 + revenue_growth)
            fcf = rev * fcf_margin
            fcfs.append(fcf)
            pv_sum += fcf / ((1 + w_) ** year)
        if terminal_method == "exit":
            tv = terminal_value_exit(rev, ebitda_margin, exit_multiple)
        else:
            tv = terminal_value_gordon(fcfs[-1], w_, tg_)
        pv_tv = tv / ((1 + w_) ** projection_years)
        ev = pv_sum + pv_tv
        equity = ev - net_debt
        return {
            "enterprise_value": ev,
            "equity_value": equity,
            "price_per_share": _div(equity, shares_outstanding),
            "pv_terminal_value": pv_tv,
            "pv_explicit_fcf": pv_sum,
            "terminal_value": tv,
            "projected_fcf": [round(x, 2) for x in fcfs],
        }

    base = _run(w, terminal_growth)
    out = {
        "wacc": wr,
        "assumptions": {
            "revenue": revenue,
            "projection_years": projection_years,
            "revenue_growth": revenue_growth,
            "fcf_margin": fcf_margin,
            "terminal_growth": terminal_growth,
            "terminal_method": terminal_method,
            "net_debt": net_debt,
            "shares_outstanding": shares_outstanding,
        },
        "enterprise_value": _r(base["enterprise_value"]),
        "equity_value": _r(base["equity_value"]),
        "price_per_share": _r(base["price_per_share"]),
        "pv_explicit_fcf": _r(base["pv_explicit_fcf"]),
        "pv_terminal_value": _r(base["pv_terminal_value"]),
        "terminal_value": _r(base["terminal_value"]),
        "projected_fcf": base["projected_fcf"],
    }
    if sensitivity:
        w_axis = [round(w + d, 4) for d in (-0.02, -0.01, 0.0, 0.01, 0.02)]
        g_axis = [
            round(terminal_growth + d, 4) for d in (-0.01, -0.005, 0.0, 0.005, 0.01)
        ]
        grid = []
        for wv in w_axis:
            row = []
            for gv in g_axis:
                if wv <= gv:  # undefined perpetuity -> null cell
                    row.append(None)
                else:
                    row.append(_r(_run(wv, gv)["price_per_share"]))
            grid.append(row)
        out["sensitivity"] = {
            "wacc_axis": w_axis,
            "growth_axis": g_axis,
            "price_per_share": grid,
        }
    return out


# --------------------------------------------------------------------------- #
# 3. equity valuation (stock valuation.py — 2-stage + fade, reverse-DCF, EV bridge)
# --------------------------------------------------------------------------- #
def _norm_rate(v: float | None) -> float | None:
    """Percent-vs-decimal normalization: |v|>1.5 is read as a percent (÷100)."""
    if v is None:
        return None
    return v / 100.0 if abs(v) > 1.5 else v


def ev_bridge(
    market_cap: float,
    total_debt: float = 0.0,
    lease_liabilities: float = 0.0,
    minority_interest: float = 0.0,
    preferred: float = 0.0,
    cash: float = 0.0,
    associate_investments: float = 0.0,
) -> dict:
    """EV = MktCap + Debt + Leases + Minority + Preferred - Cash - Associates.
    Net debt = Debt + Leases - Cash."""
    ev = (
        market_cap
        + total_debt
        + lease_liabilities
        + minority_interest
        + preferred
        - cash
        - associate_investments
    )
    return {
        "enterprise_value": _r(ev),
        "net_debt": _r(total_debt + lease_liabilities - cash),
    }


def _two_stage_raw(
    base_fcf: float,
    wacc_: float,
    stage1_growth: float,
    stage1_years: int,
    fade_years: int,
    terminal_growth: float,
    net_debt: float,
    minority_interest: float,
    shares_outstanding: float,
) -> dict:
    """The 2-stage FCFF DCF core — assumes DECIMAL rates and wacc_ > terminal_growth
    (the caller guarantees both), so the reverse-DCF search can drive `stage1_growth`
    across its full decimal band WITHOUT the percent-normalization
    heuristic re-firing."""
    fcf, pv, year = base_fcf, 0.0, 0
    for _ in range(stage1_years):
        year += 1
        fcf *= 1 + stage1_growth
        pv += fcf / ((1 + wacc_) ** year)
    for i in range(1, fade_years + 1):
        year += 1
        g = stage1_growth + (terminal_growth - stage1_growth) * (i / fade_years)
        fcf *= 1 + g
        pv += fcf / ((1 + wacc_) ** year)
    tv = fcf * (1 + terminal_growth) / (wacc_ - terminal_growth)
    pv_tv = tv / ((1 + wacc_) ** year)
    ev = pv + pv_tv
    equity = ev - net_debt - minority_interest
    return {
        "enterprise_value": _r(ev),
        "equity_value": _r(equity),
        "value_per_share": _r(_div(equity, shares_outstanding)),
        "pv_terminal_value": _r(pv_tv),
        "terminal_value": _r(tv),
    }


def two_stage_dcf(
    base_fcf: float,
    wacc_: float,
    stage1_growth: float,
    stage1_years: int = 5,
    fade_years: int = 5,
    terminal_growth: float = 0.025,
    net_debt: float = 0.0,
    minority_interest: float = 0.0,
    shares_outstanding: float = 1.0,
) -> dict:
    """2-stage FCFF DCF with a LINEAR fade from stage1_growth to terminal_growth over
    fade_years, then a Gordon terminal. Percent-vs-decimal normalized on the inputs;
    WACC<=terminal_growth -> error (infinite TV)."""
    wacc_ = _norm_rate(wacc_) or 0.0
    stage1_growth = _norm_rate(stage1_growth) or 0.0
    terminal_growth = _norm_rate(terminal_growth) or 0.0
    if wacc_ <= terminal_growth:
        return {
            "error": "WACC must exceed terminal growth (Gordon terminal is undefined)"
        }
    return _two_stage_raw(
        base_fcf,
        wacc_,
        stage1_growth,
        stage1_years,
        fade_years,
        terminal_growth,
        net_debt,
        minority_interest,
        shares_outstanding,
    )


def reverse_dcf_implied_growth(
    enterprise_value: float,
    base_fcf: float,
    wacc_: float,
    stage1_years: int = 5,
    fade_years: int = 5,
    terminal_growth: float = 0.025,
) -> dict:
    """Solve (bisection, -95%..+200%) for the constant stage-1 growth that reproduces
    today's EV via the 2-stage model. base_fcf<=0 -> skipped with a warning."""
    if base_fcf <= 0:
        return {"implied_growth": None, "warning": "base FCF <= 0; reverse-DCF skipped"}
    wacc_ = _norm_rate(wacc_) or 0.0
    terminal_growth = _norm_rate(terminal_growth) or 0.0
    if wacc_ <= terminal_growth:
        return {"error": "WACC must exceed terminal growth"}

    def ev_for(g: float) -> float | None:
        # g is already a DECIMAL rate from the search — call the raw core so the
        # percent-normalization heuristic does not re-interpret e.g. 2.0 as 200%->2%.
        r = _two_stage_raw(
            base_fcf, wacc_, g, stage1_years, fade_years, terminal_growth, 0.0, 0.0, 1.0
        )
        return r.get("enterprise_value")

    lo, hi = -0.95, 2.0
    lo_ev, hi_ev = ev_for(lo), ev_for(hi)
    if lo_ev is None or hi_ev is None or not (lo_ev <= enterprise_value <= hi_ev):
        return {
            "implied_growth": None,
            "warning": "target EV outside solvable growth band",
        }
    for _ in range(100):
        mid = (lo + hi) / 2
        ev_mid = ev_for(mid) or 0.0
        if abs(ev_mid - enterprise_value) < 1e-6:
            break
        if ev_mid < enterprise_value:
            lo = mid
        else:
            hi = mid
    g = (lo + hi) / 2
    return {"implied_growth": _r(g, 4), "demanding": g >= 0.15}


def scenario_table(rows: list[dict]) -> dict:
    """Probability-weighted per-share table. Each row prices by priority: explicit
    value_per_share -> EPS·exit_pe -> (EBITDA·ev_ebitda -> equity -> per share).
    Weighted
    average across rows by `probability` (normalized)."""
    priced, wsum, weighted = [], 0.0, 0.0
    for row in rows:
        name = row.get("name", "scenario")
        vps = _f(row.get("value_per_share"))
        if vps is None:
            eps, pe = _f(row.get("eps")), _f(row.get("exit_pe"))
            if eps is not None and pe is not None:
                vps = eps * pe
        if vps is None:
            ebitda, mult = _f(row.get("ebitda")), _f(row.get("ev_ebitda"))
            nd, sh = _f(row.get("net_debt"), 0.0), _f(row.get("shares_outstanding"))
            if ebitda is not None and mult is not None and sh:
                vps = _div(ebitda * mult - (nd or 0.0), sh)
        prob = _f(row.get("probability"), 0.0) or 0.0
        priced.append({"name": name, "value_per_share": _r(vps), "probability": prob})
        if vps is not None:
            wsum += prob
            weighted += vps * prob
    return {
        "scenarios": priced,
        "weighted_value_per_share": _r(weighted / wsum) if wsum > 0 else None,
    }


# --------------------------------------------------------------------------- #
# 4. investment appraisal (business-investment-advisor)
# --------------------------------------------------------------------------- #
def roi(net_gain: float, cost: float) -> float | None:
    """ROI% = (net gain / cost) · 100."""
    r = _div(net_gain, cost)
    return None if r is None else _r(r * 100)


def payback(investment: float, annual_net_cash_flow: float) -> float | None:
    """Payback (years) = investment / annual net cash flow."""
    return _r(_div(investment, annual_net_cash_flow))


def npv(rate: float, cash_flows: list[float]) -> float | None:
    """NPV = Σ CF_t / (1+r)^t, with cash_flows[0] at t=0
    (the initial outflow, negative)."""
    if not cash_flows or rate <= -1:
        return None
    return _r(sum(cf / ((1 + rate) ** t) for t, cf in enumerate(cash_flows)))


def irr(cash_flows: list[float]) -> float | None:
    """IRR = rate where NPV = 0 (bisection in (-0.9999, 10]). None if no sign change /
    no root in range. cash_flows[0] is the initial outflow (negative)."""
    if (
        not cash_flows
        or all(c >= 0 for c in cash_flows)
        or all(c <= 0 for c in cash_flows)
    ):
        return None

    def _npv(r: float) -> float:
        return sum(cf / ((1 + r) ** t) for t, cf in enumerate(cash_flows))

    lo, hi = -0.9999, 10.0
    f_lo, f_hi = _npv(lo), _npv(hi)
    if f_lo * f_hi > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        f_mid = _npv(mid)
        if abs(f_mid) < 1e-9:
            return _r(mid, 4)
        if f_lo * f_mid < 0:
            hi, f_hi = mid, f_mid
        else:
            lo, f_lo = mid, f_mid
    return _r((lo + hi) / 2, 4)


def appraise_investment(
    initial_investment: float,
    cash_flows: list[float],
    discount_rate: float = 0.10,
    net_gain: float | None = None,
) -> dict:
    """One capex/project: builds [-initial, cf1, cf2, …], returns NPV/IRR/payback/ROI +
    the NPV>0 verdict. `cash_flows` are per-period NET inflows AFTER the
    initial outlay."""
    flows = [-abs(initial_investment), *[float(c) for c in cash_flows]]
    annual = (sum(cash_flows) / len(cash_flows)) if cash_flows else 0.0
    gain = net_gain if net_gain is not None else (sum(cash_flows) - initial_investment)
    npv_v = npv(discount_rate, flows)
    return {
        "npv": npv_v,
        "irr": irr(flows),
        "payback_years": payback(initial_investment, annual),
        "roi_pct": roi(gain, initial_investment),
        "discount_rate": discount_rate,
        "creates_value": (npv_v is not None and npv_v > 0),
    }


# --------------------------------------------------------------------------- #
# 5. SaaS metrics (metrics_calculator.py + quick_ratio_calculator.py) + bands
# --------------------------------------------------------------------------- #
DEFAULT_GROSS_MARGIN = 0.70

# Benchmark bands (benchmarks.md) — ascending cut points; label = first cut value<cut.
_CHURN_BANDS = {
    "enterprise": [(1.0, "healthy"), (3.0, "watch"), (_INF, "critical")],
    "mid_market": [(2.0, "healthy"), (5.0, "watch"), (_INF, "critical")],
    "smb": [(4.0, "healthy"), (8.0, "watch"), (_INF, "critical")],
    "consumer": [(5.0, "healthy"), (10.0, "watch"), (_INF, "critical")],
}
_MRR_GROWTH_BANDS = {
    "early": [
        (5.0, "critical"),
        (10.0, "watch"),
        (20.0, "healthy"),
        (_INF, "excellent"),
    ],
    "growth": [
        (3.0, "critical"),
        (7.0, "watch"),
        (15.0, "healthy"),
        (_INF, "excellent"),
    ],
    "scale": [(1.0, "critical"), (3.0, "watch"), (7.0, "healthy"), (_INF, "excellent")],
}
_LTV_CAC_BANDS = [
    (1.0, "critical"),
    (2.0, "poor"),
    (3.0, "watch"),
    (5.0, "healthy"),
    (8.0, "excellent"),
    (_INF, "watch (overspending on growth)"),
]
_CAC_PAYBACK_BANDS = [
    (6.0, "excellent"),
    (12.0, "good"),
    (18.0, "healthy"),
    (24.0, "watch"),
    (_INF, "critical"),
]
_NRR_BANDS = [
    (80.0, "critical"),
    (90.0, "poor"),
    (100.0, "watch"),
    (110.0, "healthy"),
    (120.0, "excellent"),
    (_INF, "world-class"),
]
_GROSS_MARGIN_BANDS = [
    (50.0, "critical"),
    (65.0, "watch"),
    (75.0, "healthy"),
    (85.0, "excellent"),
    (_INF, "world-class"),
]
_RULE40_BANDS = [
    (20.0, "concerning"),
    (40.0, "developing"),
    (60.0, "healthy"),
    (_INF, "excellent"),
]


def saas_band(
    metric: str, value: float | None, *, segment: str = "smb", stage: str = "growth"
) -> str | None:
    """Benchmark band label for a SaaS metric value
    (percent-scaled where applicable)."""
    m = metric.lower()
    if m == "churn":
        return _pick(value, _CHURN_BANDS.get(segment, _CHURN_BANDS["smb"]))
    if m in ("mrr_growth", "mom_growth"):
        return _pick(value, _MRR_GROWTH_BANDS.get(stage, _MRR_GROWTH_BANDS["growth"]))
    if m in ("ltv_cac", "ltv:cac"):
        return _pick(value, _LTV_CAC_BANDS)
    if m in ("cac_payback", "payback"):
        return _pick(value, _CAC_PAYBACK_BANDS)
    if m == "nrr":
        return _pick(value, _NRR_BANDS)
    if m == "gross_margin":
        return _pick(value, _GROSS_MARGIN_BANDS)
    if m in ("rule_of_40", "rule40"):
        return _pick(value, _RULE40_BANDS)
    return None


def saas_metrics(
    mrr: float | None = None,
    mrr_prev: float | None = None,
    customers: float | None = None,
    churned_customers: float | None = None,
    sm_spend: float | None = None,
    new_customers: float | None = None,
    gross_margin: float = DEFAULT_GROSS_MARGIN,
    expansion_mrr: float = 0.0,
    churned_mrr: float = 0.0,
    contraction_mrr: float = 0.0,
    profit_margin: float | None = None,
    *,
    segment: str = "smb",
    stage: str = "growth",
) -> dict:
    """SaaS unit-economics + growth metrics (verbatim formulas). Undefined metrics come
    back None and are listed in `_missing` (never fabricated). Band labels attached."""
    missing: list[str] = []
    out: dict[str, Any] = {}

    arr = None if mrr is None else _r(mrr * 12)
    mom = _div(None if mrr is None or mrr_prev is None else (mrr - mrr_prev), mrr_prev)
    mom = None if mom is None else _r(mom * 100)
    churn = _div(churned_customers, customers)
    churn = None if churn is None else _r(churn * 100)
    arpa = _div(mrr, customers)
    cac = _div(sm_spend, new_customers)
    # LTV = (ARPA / churn_decimal) · gross_margin ; churn_decimal = churn%/100
    ltv = None
    if arpa is not None and churn not in (None, 0):
        ltv = _r((arpa / (churn / 100)) * gross_margin)
    ltv_cac = _div(ltv, cac)
    cac_payback = None
    if cac is not None and arpa not in (None, 0):
        cac_payback = _div(cac, arpa * gross_margin)
    # NRR = (prev + expansion - churned - contraction)/prev · 100 ; fallback
    # (1-churn)·100
    nrr = None
    if mrr_prev not in (None, 0):
        nrr = _r(
            ((mrr_prev + expansion_mrr - churned_mrr - contraction_mrr) / mrr_prev)
            * 100
        )
    elif churn is not None:
        nrr = _r((1 - churn / 100) * 100)
    rule40 = None
    if mom is not None and profit_margin is not None:
        rule40 = _r(mom * 12 + profit_margin)

    def add(key: str, val: float | None, band_metric: str | None = None) -> None:
        rec: dict[str, Any] = {"value": val}
        if val is None:
            missing.append(key)
        elif band_metric:
            rec["band"] = saas_band(band_metric, val, segment=segment, stage=stage)
        out[key] = rec

    add("arr", arr)
    add("mrr_growth_pct", mom, "mrr_growth")
    add("customer_churn_pct", churn, "churn")
    add("arpa", _r(arpa))
    add("cac", _r(cac))
    add("ltv", ltv)
    add("ltv_cac", _r(ltv_cac), "ltv_cac")
    add("cac_payback_months", _r(cac_payback), "cac_payback")
    add("nrr_pct", nrr, "nrr")
    add("rule_of_40", rule40, "rule_of_40")
    out["_missing"] = missing
    out["gross_margin_used"] = gross_margin
    return out


def quick_ratio(
    new_mrr: float, expansion_mrr: float, churned_mrr: float, contraction_mrr: float
) -> dict:
    """SaaS Quick Ratio = (new + expansion) / (churned + contraction)."""
    qr = _div(new_mrr + expansion_mrr, churned_mrr + contraction_mrr)
    return {
        "quick_ratio": _r(qr),
        "interpretation": (
            "healthy (>4)"
            if qr is not None and qr > 4
            else "acceptable (2-4)"
            if qr is not None and qr >= 2
            else "weak (<2)"
            if qr is not None
            else "undefined (no gross churn)"
        ),
    }


# --------------------------------------------------------------------------- #
# 6. budget variance (budget_variance_analyzer.py)
# --------------------------------------------------------------------------- #
MATERIALITY_PCT = 10.0
MATERIALITY_AMT = 50_000.0


def is_material(
    variance_pct: float | None,
    variance_amount: float | None,
    threshold_pct: float = MATERIALITY_PCT,
    threshold_amt: float = MATERIALITY_AMT,
) -> bool:
    """Material if |variance %| >= 10 OR |variance $| >= 50,000 (source defaults)."""
    p = abs(variance_pct) >= threshold_pct if variance_pct is not None else False
    a = abs(variance_amount) >= threshold_amt if variance_amount is not None else False
    return p or a


def _favorability(line_type: str, variance_amount: float) -> str:
    """Revenue: over budget (variance>0) favorable.
    Expense: under budget (<0) favorable."""
    if (line_type or "revenue").lower().startswith("rev"):
        return "Favorable" if variance_amount > 0 else "Unfavorable"
    return "Favorable" if variance_amount < 0 else "Unfavorable"


def variance(
    lines: list[dict],
    threshold_pct: float = MATERIALITY_PCT,
    threshold_amt: float = MATERIALITY_AMT,
) -> dict:
    """Actual vs budget (and vs prior) variance with favorable/unfavorable +
    materiality.
    Each line: {name, type: revenue|expense, actual, budget, prior?}."""
    rows = []
    for ln in lines:
        name = ln.get("name", "line")
        ltype = ln.get("type", "revenue")
        actual = _f(ln.get("actual"), 0.0) or 0.0
        budget = _f(ln.get("budget"), 0.0) or 0.0
        prior = _f(ln.get("prior"))
        var_amt = actual - budget
        var_pct = _div(var_amt, abs(budget))
        var_pct = None if var_pct is None else _r(var_pct * 100)
        rec = {
            "name": name,
            "type": ltype,
            "actual": actual,
            "budget": budget,
            "variance_amount": _r(var_amt),
            "variance_pct": var_pct,
            "favorability": _favorability(ltype, var_amt),
            "is_material": is_material(var_pct, var_amt, threshold_pct, threshold_amt),
        }
        if prior is not None:
            rec["prior"] = prior
            rec["yoy_amount"] = _r(actual - prior)
            yoy = _div(actual - prior, abs(prior))
            rec["yoy_pct"] = None if yoy is None else _r(yoy * 100)
        rows.append(rec)
    material = [r for r in rows if r["is_material"]]
    return {
        "lines": rows,
        "material_variances": material,
        "material_count": len(material),
        "thresholds": {"pct": threshold_pct, "amount": threshold_amt},
    }


# --------------------------------------------------------------------------- #
# 7. driver-based forecast (forecast_builder.py)
# --------------------------------------------------------------------------- #
def driver_forecast(
    base_revenue: float,
    periods: int = 12,
    growth_rate: float = 0.05,
    gross_margin: float = 0.40,
    scenarios: dict | None = None,
) -> dict:
    """Driver-based revenue projection compounding `growth_rate` for `periods`, with
    optional base/bull/bear scenarios
    ({name: {growth_adjustment, margin_adjustment}})."""
    scen = scenarios or {
        "base": {"growth_adjustment": 0.0, "margin_adjustment": 0.0},
        "bull": {"growth_adjustment": 0.03, "margin_adjustment": 0.03},
        "bear": {"growth_adjustment": -0.03, "margin_adjustment": -0.03},
    }
    out: dict[str, Any] = {}
    for name, adj in scen.items():
        g = growth_rate + adj.get("growth_adjustment", 0.0)
        m = gross_margin + adj.get("margin_adjustment", 0.0)
        rev, series = base_revenue, []
        for _ in range(periods):
            rev = rev * (1 + g)
            series.append({"revenue": _r(rev), "gross_profit": _r(rev * m)})
        out[name] = {
            "growth_rate": _r(g, 4),
            "gross_margin": _r(m, 4),
            "ending_revenue": series[-1]["revenue"] if series else _r(base_revenue),
            "total_revenue": _r(sum(p["revenue"] for p in series)),
            "periods": series,
        }
    return {"base_revenue": base_revenue, "periods": periods, "scenarios": out}

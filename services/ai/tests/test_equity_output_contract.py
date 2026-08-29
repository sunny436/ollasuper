"""Equity-Research Assistant (stock-analysis) — OUTPUT-QUALITY contract (hermetic).
Asserts the skill encodes the 10-stage sector-relative workflow, the depth modes, the
progressive-disclosure wiring (finance_reference for sectors + forensic/IPO/template)
and
the deterministic valuation (finance_calc), plus EVERY non-negotiable and the not-advice
boundary — so the source's depth is not silently dropped. Real output verified on prod
by
e2e/qa-finance.js."""

from __future__ import annotations

from app.finance.equity import EQUITY_SKILL

_ALL = (
    EQUITY_SKILL.methodology
    + "\n"
    + EQUITY_SKILL.instructions
    + "\n"
    + EQUITY_SKILL.constraints
    + "\n"
    + EQUITY_SKILL.output_expectations
)
_LOW = _ALL.lower()


def _has(*needles: str) -> None:
    for n in needles:
        assert n.lower() in _LOW, f"missing output-contract marker: {n!r}"


# --- depth modes + 10-stage workflow ---------------------------------------
def test_depth_modes():
    _has("screen", "standard", "deep dive", "forensic", "ipo")
    _has("f0-f5", "i0-i7")


def test_ten_stage_workflow():
    _has(
        "identity",
        "acquire data",
        "classify sector",
        "kill-criteria",
        "red flag",
        "core analysis",
        "peer set",
        "benchmark",
        "valuation",
        "bear case",
        "score",
        "challenge pass",
        "lint",
    )
    _has("earnings quality", "dupont", "roic")


# --- progressive disclosure + deterministic valuation wiring ---------------
def test_tool_wiring():
    _has("finance_reference", "finance_calc")
    _has(
        "equity/sectors/",
        "equity/18-forensic-mode",
        "equity/12-report-template",
        "equity/11-scoring-rubric",
        "equity/06-valuation",
    )
    _has("reverse_dcf", "equity_valuation")
    _has("banks", "insurance", "reit")  # sector-relative valuation methods


# --- the non-negotiables (never lose these) --------------------------------
def test_nonnegotiables():
    _has("never invent a number", "document name, page and period")
    _has("aggregator", "screener.in", "navigation")
    _has("consolidated", "standalone")
    _has("crore", "lakh", "million", "billion", "10x")  # units discipline
    _has("as-of date", "cross-check")
    _has("share price", "exception")  # the one live figure
    _has("analysis, not advice")
    _has("show uncertainty", "decline")


# --- output: report + scorecard + bear case + labels -----------------------
def test_output_shape():
    _has("report", "scorecard", "verdict", "key risks", "bear case", "data-quality")
    _has("fact", "calculation", "assumption", "estimate")
    _has("not investment advice")

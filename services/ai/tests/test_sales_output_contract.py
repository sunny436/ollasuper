"""Sales Assistant — OUTPUT-QUALITY contract (hermetic). Asserts the skill guidance
actually instructs the model to produce COMPLETE, CORRECT outputs for every workflow —
the exact templates, the plain-text-email rule, the forecast/pipeline constants, the
factuality rules — so 'the skill was added' can never mean 'the output methodology is
missing'. This is the drift guard that keeps the guidance faithful to the source
methodology; real end-to-end output is verified on prod by e2e/qa-sales.js."""

from __future__ import annotations

from app.sales.skill import SALES_SKILL

_ALL = (
    SALES_SKILL.methodology
    + "\n"
    + SALES_SKILL.instructions
    + "\n"
    + SALES_SKILL.constraints
    + "\n"
    + SALES_SKILL.output_expectations
)
_LOW = _ALL.lower()


def _has_all(*needles: str, ci: bool = True) -> None:
    hay = _LOW if ci else _ALL
    for n in needles:
        assert (n.lower() if ci else n) in hay, f"missing output-contract marker: {n!r}"


# --- global evidence/factuality frame --------------------------------------
def test_fact_inference_unknown_labels_and_no_fabrication():
    _has_all("confirmed fact", "reasonable inference", "unknown")
    _has_all("never fabricate", "untrusted", "read-only", "graceful degradation")
    _has_all("remember")  # seller context reuses the memory tool


# --- account research -------------------------------------------------------
def test_account_research_contract():
    _has_all(
        "7-search",
        "quick assessment",
        "company-profile",
        "hiring signals",
        "key people",
        "qualification",
        "engagement recommendations",
        "sources",
    )


# --- call prep --------------------------------------------------------------
def test_call_prep_contract():
    _has_all(
        "account snapshot",
        "discovery questions",
        "potential objections",
        # the 4 meeting-type variations
        "discovery",
        "demo",
        "negotiation",
        "qbr",
    )
    assert "# Call Prep:" in SALES_SKILL.instructions


# --- outreach: AIDA + PLAIN TEXT (the load-bearing format rule) -------------
def test_outreach_plain_text_and_aida_contract():
    _has_all("aida", "plain-text", "verified email", "subject line")
    # email BODIES go in a fenced text block, never markdown
    assert "```text" in SALES_SKILL.instructions
    _has_all("no markdown", "no asterisks")
    # the avoid-list is present
    _has_all("i hope this email finds you well", "fake personalization", "feature dump")


# --- call summary -----------------------------------------------------------
def test_call_summary_contract():
    _has_all(
        "action items",
        "owner",
        "due date",
        "follow-up email",
        "factual fidelity",
    )
    # the follow-up email is also plain text
    assert SALES_SKILL.instructions.count("```text") >= 2  # outreach + call-summary


# --- pipeline review: exact thresholds + weights ---------------------------
def test_pipeline_review_contract():
    _has_all(
        "30+ days",
        "14+ days",
        "single-threaded",
        "stale",
        "stuck",
        "overdue",
        "weekly action checklist",
    )
    for w in ("30%", "25%", "20%", "15%", "10%"):
        assert w in SALES_SKILL.instructions, w


# --- forecast: exact probabilities + formulas + scenarios ------------------
def test_forecast_contract():
    for pct in ("100%", "80%", "60%", "40%", "20%", "10%"):
        assert pct in SALES_SKILL.instructions, pct
    _has_all(
        "weighted forecast = sum",
        "best case",
        "likely case",
        "worst case",
        "coverage ratio = open pipeline / quota",
        "gap to quota = quota - (closed + weighted",
        "3x",
        "2x",
    )


# --- competitive intelligence ----------------------------------------------
def test_competitive_intel_contract():
    _has_all(
        "comparison matrix",
        "talk tracks",
        "objection handling",
        "landmine",
        "public fact",
    )


# --- assets -----------------------------------------------------------------
def test_asset_contract():
    _has_all(
        "generate_file",
        "clarifying-questions",
        "quality checklist",
        "speaker notes",
        "downloadable",
    )


# --- daily briefing (never claim live data) --------------------------------
def test_daily_briefing_contract():
    _has_all("#1 priority", "$50k", "today's numbers", "suggested actions")
    # explicitly disclaims live calendar/CRM/email access
    assert "do not have live" in _LOW or "no crm/email/calendar" in _LOW


# --- the QA report: numbers from a tool, figures keep their noun -------------
def test_numbers_and_nouns_rules_survive_compaction():
    """These rules live in `constraints` on purpose: when Sales is the SECOND
    skill of a turn it is compacted to its constraints, and the ROI asset prompt
    is exactly such a turn (sales + finance). A rule in `instructions` would
    vanish there."""
    minimal = SALES_SKILL.render_minimal().lower()
    for needle in (
        "finance_calc kind='business_case'",
        "never computed in prose",
        "figures keep their noun",
        "8,000 employees",
        "proof points are only the user's own",
    ):
        assert needle in minimal, f"constraint not in minimal render: {needle!r}"
    _has_all("business_case", "never from your own arithmetic")

"""HR Assistant — OUTPUT-QUALITY contract (hermetic). Asserts the skill guidance
instructs the model to produce COMPLETE, CORRECT outputs for EACH of the 12 source
capabilities (nothing "implicitly covered") plus the sensitive-data safety rules — so
'the skill was added' can never mean 'the methodology is missing'. Real end-to-end
output is verified on prod by e2e/qa-hr.js."""

from __future__ import annotations

from app.hr.skill import HR_SKILL

_ALL = (
    HR_SKILL.methodology
    + "\n"
    + HR_SKILL.instructions
    + "\n"
    + HR_SKILL.constraints
    + "\n"
    + HR_SKILL.output_expectations
)
_LOW = _ALL.lower()


def _has(*needles: str) -> None:
    for n in needles:
        assert n.lower() in _LOW, f"missing output-contract marker: {n!r}"


# --- global evidence / safety / privacy / no-false-automation --------------
def test_global_safety_frame():
    _has("confirmed fact", "reasonable inference", "unknown")
    _has("never fabricate", "never invent", "untrusted", "read-only")
    _has("no false automation", "hris", "ats")  # never claim live systems
    _has("privacy", "no new storage", "remember", "avoid legal")


# --- 1. recruiting pipeline (+ candidate evaluation) -----------------------
def test_recruiting_contract():
    _has("sourced", "screen", "debrief", "accepted")
    _has("velocity", "conversion", "source effectiveness", "acceptance rate")
    _has("time-to-fill", "stale", "bottleneck")


# --- 2. interview prep ------------------------------------------------------
def test_interview_contract():
    _has("competenc", "behavioral", "situational", "scorecard", "1-4", "anchor")
    _has("panel", "debrief")


# --- 3. draft offer ---------------------------------------------------------
def test_offer_contract():
    _has("total first-year", "equity", "vesting", "signing bonus", "target bonus")
    _has("generate_file", "never invent")


# --- 4. onboarding ----------------------------------------------------------
def test_onboarding_contract():
    _has("pre-start", "day 1", "week 1", "30/60/90", "buddy")
    _has("key-contacts", "tools-access")


# --- 5. performance review --------------------------------------------------
def test_performance_contract():
    _has("self-assessment", "manager review", "calibration")
    _has("be specific", "measurable impact", "never invent")


# --- 6. policy lookup + employee handbook (BOTH names) ---------------------
def test_policy_and_handbook_contract():
    _has("handbook", "125", "cite the source", "avoid legal", "never invent")
    assert "admit the gap" in _LOW or "cannot verify" in _LOW


# --- 7. compensation analysis + benchmarking (BOTH names) ------------------
def test_compensation_and_benchmarking_contract():
    _has("location", "total compensation", "percentile")
    _has("25th", "50th", "75th", "90th")
    _has("band placement", "compa-ratio", "gap to mid")
    _has("verified market data", "estimate", "assumption", "never fabricate")


# --- 8. people analytics + people report (BOTH names) ----------------------
def test_people_analytics_and_report_contract():
    _has("headcount", "attrition", "voluntary", "average tenure", "diversity")
    _has("span of control", "revenue per employee")
    _has("sql_query", "methodology")  # reuse Data Analysis + caveats


# --- 9. org planning --------------------------------------------------------
def test_org_planning_contract():
    _has("management layers", "span of control", "ic-to-manager")
    _has("roadmap", "assumptions", "tradeoffs")

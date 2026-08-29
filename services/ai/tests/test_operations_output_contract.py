"""Operations Assistant — OUTPUT-QUALITY contract (hermetic). Asserts the skill encodes
each of the 9 domains' DECISION RULES + exact source structure (not just headings), the
composition rules, and the safety frame — so 'the skill was added' can never mean 'the
methodology is missing'. Real output is verified on prod by e2e/qa-operations.js."""

from __future__ import annotations

from app.operations.skill import OPERATIONS_SKILL

_ALL = (
    OPERATIONS_SKILL.methodology
    + "\n"
    + OPERATIONS_SKILL.instructions
    + "\n"
    + OPERATIONS_SKILL.constraints
    + "\n"
    + OPERATIONS_SKILL.output_expectations
)
_LOW = _ALL.lower()


def _has(*needles: str) -> None:
    for n in needles:
        assert n.lower() in _LOW, f"missing output-contract marker: {n!r}"


# --- global safety / labels / no-false-automation --------------------------
def test_global_safety_frame():
    _has("fact", "interpretation", "assumption", "recommendation")
    _has("finding", "evidence", "impact", "owner", "priority", "next step")
    _has("never fabricate", "untrusted", "read-only")
    _has("no false automation", "jira", "servicenow", "slack")
    _has("i prepared the change request", "based on the updates you provided")


# --- the 9 domains (decision rules, not just headings) ---------------------
def test_vendor_contract():
    _has("total cost of ownership", "total year 1", "total 3-year", "exit costs")
    _has("proceed / negotiate / pass", "negotiation points", "never invent contract")


def test_process_doc_contract():
    _has("raci", "responsible", "accountable", "consulted", "informed")
    _has("exceptions", "metrics", "start messy")


def test_process_optimization_contract():
    _has(
        "waiting", "rework", "handoffs", "over-processing", "manual work"
    )  # 5 waste types
    _has("before/after", "future state", "estimated impact")


def test_change_contract():
    _has("assess", "plan", "execute", "sustain")
    _has("rollback plan (trigger", "steps", "verification")
    _has("200 billing", "why before the what")


def test_capacity_contract():
    _has("75-80%", "60-70%", "50-60%", "never plan to 100%")
    _has("overallocated", "scenarios", "bottleneck")


def test_status_contract():
    _has("🟢", "🟡", "🔴", "on track", "at risk", "off track")
    _has("decisions needed", "recommended action")
    _has("based on the updates you provided")


def test_risk_contract():
    _has("high likelihood + high impact = critical")
    _has(
        "operational",
        "financial",
        "compliance",
        "strategic",
        "reputational",
        "security",
    )
    _has("open / mitigated / accepted / closed", "controllable")


def test_compliance_contract():
    _has("framework-agnostic", "examples", "never hardcoded")
    _has("control inventory", "audit calendar", "evidence", "gap analysis")
    _has(
        "india-first",
        "current authoritative",
        "regulations change",
        "legal uncertainty",
    )


def test_runbook_contract():
    # the 8 sections
    _has(
        "purpose",
        "prerequisites",
        "procedure",
        "verification",
        "troubleshooting",
        "rollback",
        "escalation",
        "history",
    )
    _has("exact command", "if it fails")


# --- composition (reuse, don't duplicate) ----------------------------------
def test_composition_rules():
    _has("data-analysis", "finance_calc", "deep research")
    _has("staffing/headcount -> hr", "financial forecast -> finance")
    _has("never hand-compute")

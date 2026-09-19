"""The end-of-turn notices — ONE system-authored block, in one fixed order.

Before this, three separate pushes could each append their own "---" section
(the requirement ledger's report, the standalone truncation / no-evidence
notices, the claim correction), and the freshness, evidence-coverage and
traceability checks added by the 18.09.2026 skill fixes would have made six. Two
of them could say the same thing ("the search returned nothing" and "the search
found no result inside the window") in different words. This module renders all
of them once, in the order a reader needs them:

    requirement ledger  →  evidence / retrieval (freshness supersedes the generic
    no-evidence notice when a temporal requirement exists)  →  research coverage
    →  traceability  →  claim correction  →  truncation  →  stopped-early

Everything here is computed from recorded state and appended AFTER the streamed
answer — the design rule shared with `ledger.py` and `claims.py`.
"""

from __future__ import annotations

from app.agent.freshness import FreshnessLedger, render_freshness
from app.runtime.claims import render_correction
from app.runtime.ledger import NO_EVIDENCE_NOTICE, TRUNCATION_NOTICE, TurnLedger
from app.runtime.traceability import render_traceability


def render_coverage(coverage: dict | None) -> str:
    if not coverage:
        return ""
    parts: list[str] = []
    unc = [s for s in coverage.get("uncovered") or [] if s]
    single = [s for s in coverage.get("single_sourced") or [] if s]
    if unc:
        parts.append(
            "**No evidence was recorded for:**\n"
            + "\n".join(f"- {s}" for s in unc[:12])
            + "\nAnything the answer says about these is not backed by a recorded "
            "source."
        )
    if single:
        parts.append(
            "**Resting on a single non-primary source** (independence is judged by "
            "domain, a heuristic):\n" + "\n".join(f"- {s}" for s in single[:12])
        )
    return "\n\n".join(parts)


def render_turn_notices(
    answer: str,
    *,
    ledger: TurnLedger | None,
    freshness: FreshnessLedger | None,
    research_coverage: dict | None,
    artifacts: list[dict],
    external_tool_succeeded: bool,
    search_returned_nothing: bool,
    finish_reason: str | None,
    deadline: bool = False,
) -> str:
    """Everything the turn must say about itself, or "" for a clean turn."""
    parts: list[str] = []

    if ledger is not None:
        parts.extend(ledger.render_sections())

    fresh = render_freshness(answer, freshness) if freshness is not None else ""
    if fresh:
        parts.append(fresh)
    elif search_returned_nothing:
        # No temporal requirement to frame it — the plain notice still applies.
        parts.append(NO_EVIDENCE_NOTICE)

    cov = render_coverage(research_coverage)
    if cov:
        parts.append(cov)

    trace = render_traceability(answer, freshness)
    if trace:
        parts.append(trace)

    claim = render_correction(
        answer, artifacts=artifacts, external_tool_succeeded=external_tool_succeeded
    )
    if claim:
        parts.append(claim.strip().removeprefix("---").strip())

    truncated = (finish_reason or "").lower() == "length" or bool(
        ledger is not None and ledger.output_truncated
    )
    if truncated:
        parts.append(TRUNCATION_NOTICE)
    if ledger is not None and deadline:
        parts.append(ledger.render_stopped_early())

    parts = [p for p in parts if p and p.strip()]
    if not parts:
        return ""
    return "\n\n---\n\n" + "\n\n".join(parts)

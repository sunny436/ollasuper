"""Deep Research — resume seeding + per-turn context construction.

Bridges the durable `researchRuns` state (read owner-scoped by Convex and pushed in
`GenerateRequest.activeResearchRun`) into the live turn:

  * `build_research_context` mints a fresh run id, or CONTINUES the active run's id
    (so checkpoints upsert the same row), seeding the source-ceiling counter from the
    prior findings so resume respects the same H4 budget.
  * `render_research_seed` renders a COMPACT, trusted block telling the model what has
    already been researched so it continues OPEN sub-questions and does NOT re-research
    completed ones. Advisory: if the new request is a different topic, the model's
    STEP-0 self-gate ignores it.
"""

from __future__ import annotations

import uuid

from app.models.chat import ActiveResearchRun
from app.research.tool import ResearchContext


def build_research_context(
    settings: object, active: ActiveResearchRun | None
) -> ResearchContext:
    """The per-turn ResearchContext. Continues an incomplete run's id (idempotent
    upsert into the SAME row) or mints a fresh one; seeds the distinct-source counter
    from the prior findings so the source budget spans the whole run, not one turn."""
    if active is not None and active.runId:
        seen = {f.sourceUrl for f in active.findings if f.sourceUrl}
        return ResearchContext(
            settings=settings,
            run_id=active.runId,
            objective=active.objective,
            plan_recorded=bool(active.subquestions or active.findings),
            seen_sources=seen,
            branch_count=len(active.subquestions),
        )
    return ResearchContext(settings=settings, run_id=uuid.uuid4().hex)


def render_research_seed(active: ActiveResearchRun | None) -> str:
    """A compact, trusted 'prior research' block for the system prompt, or "" when
    there is nothing to resume. Frames what is DONE vs OPEN so the model continues
    only the open sub-questions."""
    if active is None or not active.runId:
        return ""
    done = {(f.subquestion or "").strip().lower() for f in active.findings}
    open_qs = [
        q for q in active.subquestions if (q or "").strip().lower() not in done
    ]
    lines: list[str] = [
        "<prior_research>",
        "You have DURABLE prior research on this thread. If THIS request continues it, "
        "do NOT repeat the completed sub-questions — build on the findings below and "
        "research only what is still open. If the request is a different topic, start "
        "fresh (record a new plan).",
        f"Objective: {active.objective}" if active.objective else "",
        f"Status: {active.status}; sources so far: {active.sourceCount}."
        if active.status
        else "",
    ]
    if active.completed:
        lines.append("Completed sub-questions: " + "; ".join(active.completed[:32]))
    if open_qs:
        lines.append("Still open: " + "; ".join(open_qs[:32]))
    if active.findings:
        lines.append("Findings already established (reuse; do not re-research):")
        for f in active.findings[:60]:
            cite = f.sourceTitle or f.sourceUrl
            date = f" ({f.sourceDate})" if f.sourceDate else ""
            conf = f" [{f.confidence}]" if f.confidence else ""
            lines.append(f"- {f.claim} — {cite}{date}{conf}")
    lines.append("</prior_research>")
    return "\n".join(x for x in lines if x)

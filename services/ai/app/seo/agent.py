"""The ONE SEO specialist agent — a declarative `AgentSpec` over the existing
execution engine (it adds NO new execution path; it can only NARROW Phases 1-8).

Its capability policy is a HARD read-only SEO allowlist: `categories` +
`tool_ids` from the SEO catalogue, `side_effects_allowed=False`. The Group-1
generic scoping enforces this at all three seams (bind, find_capabilities
discovery, execution), so the agent can NEVER reach AEO / account / billing /
automation / actor tools, nor the 36 high-impact tools (already unreachable) —
even by discovering them via find_capabilities.

Its `OutputContract.schema` is the LENIENT `SEO_AGENT_OUTPUT_SCHEMA` (requires only a
`checks_performed` array), NOT the strict SEOReport schema: the report emitter's
`build_envelope` already coerces/salvages every field, so gating the LLM on the strict
schema only failed good audits on formatting technicalities. The sub-agent's result is
validated (and repaired once, with the allowed keys named) before it returns as a
HandoffResult; the strict SEOReport schema still governs the deterministic durable run.
"""

from __future__ import annotations

from app.agent.spec import (
    AgentOutcome as _Outcome,
)
from app.agent.spec import (
    AgentSpec,
    CapabilityPolicy,
    ContextPolicy,
    OutputContract,
)
from app.seo.capabilities import ALLOWED_CATEGORIES, ALLOWED_TOOL_IDS
from app.seo.models import SEO_AGENT_OUTPUT_SCHEMA

_INSTRUCTIONS = (
    "You are an SEO specialist running a READ-ONLY audit. Work adaptively — there is "
    "NO fixed tool sequence:\n"
    "1) UNDERSTAND the objective and its scope (one page, a section, the whole site, "
    "or a traffic-drop diagnosis).\n"
    "2) PLAN the checks that matter for THIS objective, in crawl -> index -> serve "
    "order (foundations before niceties).\n"
    "3) DISCOVER capabilities with find_capabilities; SELECT only the relevant "
    "read-only SEO tools.\n"
    "4) EXECUTE, then INSPECT each result: does it answer the check, or is more "
    "evidence needed? Re-plan and gather more only when it changes a conclusion.\n"
    "5) SYNTHESISE typed, evidence-backed findings and STOP when the evidence is "
    "sufficient — do not pad the audit.\n\n"
    "For every finding record the OBSERVED value, the EXPECTED condition, the "
    "evidence, a severity, a confidence, and a concrete verification method. "
    "Distinguish signal from noise (an expected post-change 404 spike is WARN/"
    "NOT_APPLICABLE, not FAIL). Prioritise crawl/index impact SEPARATELY from "
    "business exposure; never emit a single 0-100 score.\n\n"
    "CAPABILITY-GAP HONESTY: if a check cannot be verified with the available tools "
    "(e.g. real indexation status, live rankings/traffic, Core Web Vitals field data, "
    "full JS render parity — none are available here), mark it UNSUPPORTED with the "
    "reason. NEVER fabricate data, invent a metric, or claim another API exists. "
    "State effects only at the level the evidence supports and never promise a "
    "ranking outcome from a fix. Emit a single SEOReport as your structured result."
)

SEO_AGENT = AgentSpec(
    agent_id="seo",
    role="SEO specialist",
    instructions=_INSTRUCTIONS,
    capability=CapabilityPolicy(
        categories=ALLOWED_CATEGORIES,
        tool_ids=ALLOWED_TOOL_IDS,
        include_shared=True,
        side_effects_allowed=False,  # HARD read-only ceiling
    ),
    # Audits need several evidence-gathering steps; results are bounded per step.
    context=ContextPolicy(max_steps=8, tool_result_max_chars=8000),
    output=OutputContract(
        schema=SEO_AGENT_OUTPUT_SCHEMA,
        expects=frozenset({_Outcome.STRUCTURED_RESULT, _Outcome.FINAL_ANSWER}),
        role_hint="find",
        # Phase 3: the delegate seam persists the structured result as a secure,
        # downloadable SEO report artifact + rich card.
        report_kind="seo_audit",
    ),
)

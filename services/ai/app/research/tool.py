"""The `record_research` reserved built-in — Deep Research's DURABLE checkpoint.

A model-decided tool (a direct sibling of `remember`) that the model calls to
persist its structured research state — the PLAN (objective + safe reason +
sub-questions), each FINDING (claim + full provenance), and COMPLETE. The executor
routes the write to Convex (`op:"research-checkpoint"`), where ownership is derived
from the streamId capability and the row is upserted idempotently by researchRunId.
The LLM never writes a record directly.

Two jobs beyond persistence:
  * STRUCTURED CAPTURE — Python cannot see sub-question boundaries in free text, so
    the model producing structured plan/findings IS how durable state + provenance
    are captured (and how raw source text can then leave the context).
  * SAFETY BUDGETS (H4, code-enforced) — the checkpoint counts distinct sources and
    branches and REFUSES beyond the configured ceilings, telling the model to stop
    and synthesise. The prompt chooses depth; the code caps it.

Security mirrors `remember`: identity is never read from the model — the write's
ownership is enforced Convex-side from the streamId capability, and the resume seed
is derived server-side from the stream's thread, never client-sent.
"""

from __future__ import annotations

from dataclasses import dataclass, field

RECORD_RESEARCH_TOOL_NAME = "record_research"

# Caps mirrored on the Convex write side (bounded JSON).
_REASON_MAX = 300
_CLAIM_MAX = 600
_OBJECTIVE_MAX = 600
_URL_MAX = 2000
_FIELD_MAX = 200
_MAX_SUBQUESTIONS = 24  # a plan's sub-question list is bounded regardless of config
_CONFIDENCE = ("high", "medium", "low")

RECORD_RESEARCH_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": RECORD_RESEARCH_TOOL_NAME,
        "description": (
            "Record your DEEP-RESEARCH state so it is durable and resumable. Call it "
            "with kind='plan' ONCE when you start researching (objective, a short safe "
            "research_reason, the sub-questions, and whether the topic is "
            "time_sensitive); with kind='finding' for each material evidence item you "
            "establish (the claim + its source_url/title/type/dates + confidence); and "
            "with kind='complete' when the research is finished. It only persists YOUR "
            "own research state — it changes nothing in the world. If a finding is "
            "refused because a safety budget is reached, STOP researching and "
            "synthesise the best-supported answer with an honest 'still open' note."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": ["plan", "finding", "complete"],
                    "description": "plan (start), finding (evidence), or complete.",
                },
                # --- plan ---
                "objective": {"type": "string", "description": "The research goal."},
                "research_reason": {
                    "type": "string",
                    "description": (
                        "A SHORT, safe one-line reason research is warranted (NOT your "
                        "hidden reasoning), e.g. 'multi-source comparison needing "
                        "current pricing'."
                    ),
                },
                "subquestions": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "The sub-questions the research decomposes into.",
                },
                "time_sensitive": {
                    "type": "boolean",
                    "description": "True if the answer depends on current/recent data.",
                },
                # --- finding ---
                "subquestion": {
                    "type": "string",
                    "description": "Which sub-question this finding answers.",
                },
                "claim": {
                    "type": "string",
                    "description": "The established fact/finding, phrased plainly.",
                },
                "source_url": {"type": "string", "description": "The source URL."},
                "source_title": {"type": "string", "description": "The source title."},
                "source_type": {
                    "type": "string",
                    "description": "e.g. official/docs/news/paper/community.",
                },
                "source_date": {
                    "type": "string",
                    "description": "The source's publication date, if known.",
                },
                "retrieved_date": {
                    "type": "string",
                    "description": "When you retrieved it, if known.",
                },
                "confidence": {
                    "type": "string",
                    "enum": list(_CONFIDENCE),
                    "description": "How well-supported this finding is.",
                },
                "supports": {
                    "type": "boolean",
                    "description": "True iff the source actually supports the claim.",
                },
            },
            "required": ["kind"],
        },
    },
}


def _s(v: object, cap: int) -> str:
    return v.strip()[:cap] if isinstance(v, str) and v.strip() else ""


def clean_plan_args(args: dict) -> dict | None:
    """Validate a kind='plan' call (advisory; Convex is the authority)."""
    objective = _s(args.get("objective"), _OBJECTIVE_MAX)
    if not objective:
        return None
    subs = args.get("subquestions")
    subquestions = (
        [s.strip()[:_FIELD_MAX] for s in subs if isinstance(s, str) and s.strip()][
            :_MAX_SUBQUESTIONS
        ]
        if isinstance(subs, list)
        else []
    )
    return {
        "objective": objective,
        "reason": _s(args.get("research_reason"), _REASON_MAX),
        "subquestions": subquestions,
        "timeSensitive": bool(args.get("time_sensitive")),
    }


def clean_finding_args(args: dict) -> dict | None:
    """Validate a kind='finding' call. A finding needs at least a claim + a source."""
    claim = _s(args.get("claim"), _CLAIM_MAX)
    source_url = _s(args.get("source_url"), _URL_MAX)
    if not claim or not source_url:
        return None
    conf = args.get("confidence")
    return {
        "subquestion": _s(args.get("subquestion"), _FIELD_MAX),
        "claim": claim,
        "sourceUrl": source_url,
        "sourceTitle": _s(args.get("source_title"), _FIELD_MAX),
        "sourceType": _s(args.get("source_type"), _FIELD_MAX),
        "sourceDate": _s(args.get("source_date"), _FIELD_MAX),
        "retrievedDate": _s(args.get("retrieved_date"), _FIELD_MAX),
        "confidence": conf if conf in _CONFIDENCE else "medium",
        "supports": bool(args.get("supports", True)),
    }


@dataclass(slots=True)
class ResearchContext:
    """Per-turn deep-research state for the `record_research` tool. `run_id` is the
    stable idempotency key (continued from an active run on resume, else fresh);
    `seen_sources` + the ceilings enforce the H4 safety budgets in code. Ownership is
    never here — it is derived Convex-side from the streamId capability."""

    settings: object
    run_id: str
    objective: str = ""
    plan_recorded: bool = False
    seen_sources: set[str] = field(default_factory=set)
    branch_count: int = 0

    @property
    def max_sources(self) -> int:
        return int(getattr(self.settings, "ai_research_max_sources", 40))

    @property
    def max_branches(self) -> int:
        return int(getattr(self.settings, "ai_research_max_branches", 8))

    def sources_exhausted(self, next_url: str) -> bool:
        """True iff recording `next_url` would exceed the source ceiling (a NEW
        source beyond the cap). Re-recording an already-seen source is always fine."""
        return (
            next_url not in self.seen_sources
            and len(self.seen_sources) >= self.max_sources
        )

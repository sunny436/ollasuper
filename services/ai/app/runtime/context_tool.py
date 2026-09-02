"""`record_context` — the ENRICHMENT half of conversational state.

WHAT IT MAY AND MAY NOT DO. The floor — active artifact, version, lineage,
subject, entity activation order, operation — is derived in code from rows the
application owns, on every turn, and this tool cannot touch any of it. It writes
only the three things that genuinely are not derivable from data:

    constraints · decisions · open loops

That split is the whole design. A model that never calls this leaves those three
empty and nothing else degrades; a model that calls it wrongly cannot corrupt
what a reference resolves against.

WHY IT ACCUMULATES RATHER THAN WRITES. The turn already POSTs `context-state`
after finalize with the floor. This tool drops its values into a per-turn holder
that the same POST picks up, so there is exactly ONE write path and one place
where the floor-wins merge happens. A second write path would be a second thing
to keep consistent, and the merge rule is the part that must not drift.
"""

from __future__ import annotations

from dataclasses import dataclass, field

RECORD_CONTEXT_TOOL_NAME = "record_context"

# Bounded so a model cannot turn state into a dumping ground; the same caps the
# ingress op enforces server-side.
MAX_ITEMS = 12
MAX_ITEM_CHARS = 240


@dataclass(slots=True)
class ContextToolState:
    """Per-turn accumulator. Empty is the normal, correct resting state."""

    constraints: list[str] = field(default_factory=list)
    decisions: list[str] = field(default_factory=list)
    open_loops: list[str] = field(default_factory=list)
    called: bool = False

    def merge(
        self,
        *,
        constraints: list[str] | None,
        decisions: list[str] | None,
        open_loops: list[str] | None,
    ) -> None:
        self.called = True
        for target, incoming in (
            (self.constraints, constraints),
            (self.decisions, decisions),
            (self.open_loops, open_loops),
        ):
            if not incoming:
                continue
            for raw in incoming:
                if not isinstance(raw, str):
                    continue
                item = raw.strip()[:MAX_ITEM_CHARS]
                # De-duplicated: a model restating the same constraint across
                # several turns must not grow the list without bound.
                if item and item not in target and len(target) < MAX_ITEMS:
                    target.append(item)


RECORD_CONTEXT_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": RECORD_CONTEXT_TOOL_NAME,
        "description": (
            "Record the durable REQUIREMENTS of this conversation so they survive "
            "into later turns. Call it when the user states a standing constraint "
            "(tone, audience, length, technical depth, format, something to avoid), "
            "makes a decision you should not revisit, or asks for something you "
            "have not delivered yet. Do NOT call it to describe what you just "
            "wrote, what it is about, or which version it is — the system already "
            "tracks all of that and your input is ignored for those. Pass only NEW "
            "or CHANGED items; existing ones are kept automatically."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "constraints": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Requirements that keep applying to the work, e.g. "
                        "'technically accurate', 'SEO-friendly', 'British English', "
                        "'no marketing fluff'. These are carried into later edits, "
                        "so a narrow request like 'make it more human' does not "
                        "silently discard them."
                    ),
                },
                "decisions": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Choices already settled, e.g. 'targeting self-hosted "
                        "readers, not SaaS buyers'."
                    ),
                },
                "open_loops": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Asked for and not yet delivered, e.g. 'still owes an AWS "
                        "example'."
                    ),
                },
            },
            "required": [],
        },
    },
}

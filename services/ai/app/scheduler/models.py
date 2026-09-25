"""Shared scheduler types and the occurrence state machine.

MIRRORS packages/backend/convex/scheduled/schedule.ts `LEGAL_TRANSITIONS` —
keep BOTH in sync. The duplication is deliberate and follows the precedent in
app/models/execution.py: the authority is Convex (it owns the rows), but the
worker must be able to reason about legality locally without a round-trip.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# MIRRORS convex/scheduled/schedule.ts — keep BOTH in sync.
LEGAL_TRANSITIONS: dict[str, frozenset[str]] = {
    "queued": frozenset({"running", "held", "cancelled", "retrying", "failed"}),
    "running": frozenset({"succeeded", "failed", "retrying", "cancelled"}),
    "retrying": frozenset({"queued", "running", "failed", "cancelled", "held"}),
    "held": frozenset({"queued", "cancelled"}),
    "succeeded": frozenset(),
    "failed": frozenset(),
    "cancelled": frozenset(),
}

TERMINAL: frozenset[str] = frozenset({"succeeded", "failed", "cancelled"})


def is_terminal(status: str) -> bool:
    return status in TERMINAL


def can_transition(src: str, dst: str) -> bool:
    return dst in LEGAL_TRANSITIONS.get(src, frozenset())


@dataclass(frozen=True)
class TaskRow:
    """One row of the scheduler work list.

    Carries SCHEDULE data only. There is deliberately no prompt or title here:
    the ingress secret must not become a cross-user read capability over
    everyone's standing scheduled prompts.
    """

    task_id: str
    status: str
    spec: dict[str, Any]
    cursor_at: int
    paused_at: int | None
    revision: int
    # The invalidReason already recorded on the task (None = valid, or a Convex
    # build that does not send it yet).
    invalid_reason: str | None = None

    @staticmethod
    def from_json(raw: dict[str, Any]) -> TaskRow:
        return TaskRow(
            task_id=str(raw["taskId"]),
            status=str(raw["status"]),
            spec=dict(raw["spec"]),
            cursor_at=int(raw["cursorAt"]),
            paused_at=(
                int(raw["pausedAt"]) if raw.get("pausedAt") is not None else None
            ),
            revision=int(raw.get("revision", 1)),
            invalid_reason=(
                str(raw["invalidReason"])
                if raw.get("invalidReason") is not None
                else None
            ),
        )


@dataclass(frozen=True)
class Claim:
    """A lease on exactly one occurrence."""

    occurrence_key: str
    task_id: str
    revision: int
    scheduled_for: int
    kind: str
    attempts: int
    lease_token: str

    @staticmethod
    def from_json(raw: dict[str, Any]) -> Claim:
        return Claim(
            occurrence_key=str(raw["occurrenceKey"]),
            task_id=str(raw["taskId"]),
            revision=int(raw["revision"]),
            scheduled_for=int(raw["scheduledFor"]),
            kind=str(raw["kind"]),
            attempts=int(raw.get("attempts", 0)),
            lease_token=str(raw["leaseToken"]),
        )

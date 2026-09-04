"""Canonical tool-execution identity + lifecycle (Phase 1).

The application-authoritative record of ONE tool execution. It exists so that a
tool run has a durable, explicit identity and an explicit state machine — instead
of leaning on the model's per-turn `tool_call_id` (untrusted, not stable) as if it
were an execution identity.

Four separate identities are kept distinct on purpose:
  * run_id        — the durable generation/run (= streamId); stable across resume.
  * step_id       — one orchestration step (executor pass): f"{run}:a{attempt}:s{n}".
  * tool_call_id  — the MODEL's id. Correlation metadata only; NEVER the identity.
  * execution_id  — app-minted uuid4. THE authoritative identity (+ attempt_id/try).

This module is pure data + a transition guard: no I/O, no tool execution, no LLM.
Phase 1 does NOT attempt exactly-once — see ROADMAP / the executor for what the
lifecycle can and cannot yet guarantee (a crash between an external side effect
and its recorded result still re-executes on resume; INDETERMINATE names that
window, it does not close it).
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from enum import StrEnum


class ExecutionState(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    WAITING_APPROVAL = "waiting_approval"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMED_OUT = "timed_out"
    # The "UNKNOWN / ambiguous external op" of the contract: the external effect
    # may or may not have happened (e.g. a timeout on a side-effecting tool).
    INDETERMINATE = "indeterminate"
    # A call the runtime deliberately did not execute because an identical (tool,
    # args) already ran this turn. Neither a success nor a failure.
    DEDUPED = "deduped"


TERMINAL: frozenset[ExecutionState] = frozenset(
    {
        ExecutionState.SUCCEEDED,
        ExecutionState.FAILED,
        ExecutionState.CANCELLED,
        ExecutionState.TIMED_OUT,
        ExecutionState.INDETERMINATE,
        ExecutionState.DEDUPED,
    }
)

# The ONLY legal transitions. Terminal states have no outgoing edges. Note there
# is deliberately NO RUNNING->RUNNING self-edge: a retry is a new attempt WITHIN
# the RUNNING state (see `begin_attempt`), not a transition.
_TRANSITIONS: dict[ExecutionState, frozenset[ExecutionState]] = {
    ExecutionState.PENDING: frozenset(
        {
            ExecutionState.RUNNING,
            ExecutionState.WAITING_APPROVAL,
            ExecutionState.CANCELLED,
            ExecutionState.DEDUPED,
            ExecutionState.FAILED,
        }
    ),
    ExecutionState.RUNNING: frozenset(
        {
            ExecutionState.SUCCEEDED,
            ExecutionState.FAILED,
            ExecutionState.TIMED_OUT,
            ExecutionState.INDETERMINATE,
            ExecutionState.CANCELLED,
        }
    ),
    ExecutionState.WAITING_APPROVAL: frozenset(
        {
            ExecutionState.RUNNING,
            ExecutionState.FAILED,
            ExecutionState.CANCELLED,
        }
    ),
    # terminals -> nothing
    ExecutionState.SUCCEEDED: frozenset(),
    ExecutionState.FAILED: frozenset(),
    ExecutionState.CANCELLED: frozenset(),
    ExecutionState.TIMED_OUT: frozenset(),
    ExecutionState.INDETERMINATE: frozenset(),
    ExecutionState.DEDUPED: frozenset(),
}


class InvalidStateTransition(RuntimeError):
    """An attempt to move an execution along an edge the state machine forbids.
    Raised by `ToolExecution.transition`; the executor guards against it so a
    bookkeeping mistake can never break the tool_call<->result pairing lock."""

    def __init__(self, frm: ExecutionState, to: ExecutionState) -> None:
        super().__init__(f"illegal execution transition: {frm} -> {to}")
        self.frm = frm
        self.to = to


def _now_ms() -> int:
    return int(time.time() * 1000)


def hash_args(args: dict) -> str:
    """Canonical, stable args fingerprint. The single source of truth for the
    dedup-set key (`{tool_id}:{args_hash}`), shared by the executor + the resume
    re-seed so they never drift."""
    canonical = json.dumps(args or {}, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


@dataclass(slots=True)
class ToolExecution:
    """One tool execution. `execution_id` (app uuid4) is authoritative; the
    model's `tool_call_id` is correlation only. Mutated in place as the execution
    advances; `transition`/`begin_attempt` are the only mutators of state/attempt."""

    run_id: str
    step_id: str
    tool_call_id: str
    tool_id: str
    args: dict = field(default_factory=dict)
    # The step whose observations this call was made in response to — i.e. the
    # PREVIOUS executor pass. Deterministic, not model-declared: tools inside one
    # step are siblings that run concurrently, and a step always follows the
    # results of the one before it, so this is the turn's real dependency chain
    # rather than a guess at one. Durable via `toolExecutions.parentStep`, whose
    # schema field was reserved for exactly this and never populated.
    parent_step: str | None = None
    # Reserved for the future orchestrator; kept in code, NEVER put on the wire
    # (event_fields omits it) so the high-frequency event payloads stay lean.
    workflow_id: str | None = None

    execution_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    args_hash: str = ""
    state: ExecutionState = ExecutionState.PENDING
    attempt: int = 0
    attempt_id: str = ""
    result: dict | None = None
    error: dict | None = None
    created_at: int = field(default_factory=_now_ms)
    started_at: int | None = None
    ended_at: int | None = None
    updated_at: int = field(default_factory=_now_ms)

    def __post_init__(self) -> None:
        if not self.args_hash:
            self.args_hash = hash_args(self.args)
        if not self.attempt_id:
            self.attempt_id = f"{self.execution_id}:a{self.attempt}"

    @property
    def is_terminal(self) -> bool:
        return self.state in TERMINAL

    def transition(self, to: ExecutionState) -> None:
        """Advance to `to`, or raise InvalidStateTransition. Stamps timestamps:
        `started_at` on first entry to RUNNING, `ended_at` on any terminal."""
        if to not in _TRANSITIONS.get(self.state, frozenset()):
            raise InvalidStateTransition(self.state, to)
        self.state = to
        self.updated_at = _now_ms()
        if to is ExecutionState.RUNNING and self.started_at is None:
            self.started_at = self.updated_at
        if to in TERMINAL:
            self.ended_at = self.updated_at

    def begin_attempt(self) -> None:
        """Record a new execution attempt (a retry). STATE-NEUTRAL by design —
        a retry stays within RUNNING, so this bumps the counter + attempt_id
        without a transition (there is no RUNNING->RUNNING edge)."""
        self.attempt += 1
        self.attempt_id = f"{self.execution_id}:a{self.attempt}"
        now = _now_ms()
        if self.started_at is None:
            self.started_at = now
        self.updated_at = now

    def event_fields(self) -> dict:
        """The identity/state fields merged (as top-level SIBLINGS) into a
        TOOL_CALL/TOOL_RESULT payload. Omits None so a reserved-but-unset field
        (e.g. workflow_id) never bloats the hot path."""
        fields = {
            "execution_id": self.execution_id,
            "run_id": self.run_id,
            "step_id": self.step_id,
            "attempt_id": self.attempt_id,
            "attempt": self.attempt,
            "state": str(self.state),
        }
        return {k: v for k, v in fields.items() if v is not None}


class ExecutionLedger:
    """Per-turn registry of executions. `create` is IDEMPOTENT by the authoritative
    key (run_id, step_id, tool_call_id): a second create for the same logical call
    returns the SAME record (same execution_id) rather than minting a duplicate."""

    __slots__ = ("_by_key",)

    def __init__(self) -> None:
        self._by_key: dict[tuple[str, str, str], ToolExecution] = {}

    def create(
        self,
        *,
        run_id: str,
        step_id: str,
        tool_call_id: str,
        tool_id: str,
        args: dict,
        workflow_id: str | None = None,
        parent_step: str | None = None,
    ) -> ToolExecution:
        key = (run_id, step_id, tool_call_id)
        existing = self._by_key.get(key)
        if existing is not None:
            return existing
        execution = ToolExecution(
            run_id=run_id,
            step_id=step_id,
            tool_call_id=tool_call_id,
            tool_id=tool_id,
            args=args if isinstance(args, dict) else {},
            workflow_id=workflow_id,
            parent_step=parent_step,
        )
        self._by_key[key] = execution
        return execution

    def get(
        self, run_id: str, step_id: str, tool_call_id: str
    ) -> ToolExecution | None:
        return self._by_key.get((run_id, step_id, tool_call_id))

    def all(self) -> list[ToolExecution]:
        return list(self._by_key.values())

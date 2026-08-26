"""Phase 1 — ToolExecution identity, the lifecycle state machine, and the ledger.

Pure unit tests (no I/O). Proves: the app mints an authoritative execution_id
that is NOT the model's tool_call_id; the ledger creates one record per logical
call and is idempotent; and only whitelisted state transitions are legal.
"""

from __future__ import annotations

import pytest

from app.models.execution import (
    ExecutionLedger,
    ExecutionState,
    InvalidStateTransition,
    ToolExecution,
)


def _exec(**over) -> ToolExecution:
    base = dict(
        run_id="run1",
        step_id="run1:a0:s1",
        tool_call_id="c1",
        tool_id="t1",
        args={"q": "x"},
    )
    base.update(over)
    return ToolExecution(**base)


# --- identity -------------------------------------------------------------
def test_execution_id_is_app_minted_not_the_tool_call_id():
    e = _exec(tool_call_id="model_call_abc")
    assert e.execution_id and e.execution_id != "model_call_abc"
    assert e.attempt_id == f"{e.execution_id}:a0"


def test_two_executions_get_unique_ids():
    assert _exec().execution_id != _exec().execution_id


def test_args_hash_is_canonical_and_stable():
    a = _exec(args={"q": "x", "n": 1})
    b = _exec(args={"n": 1, "q": "x"})  # key order differs
    assert a.args_hash == b.args_hash and a.args_hash


# --- ledger ---------------------------------------------------------------
def test_ledger_mints_unique_ids_for_distinct_calls():
    led = ExecutionLedger()
    a = led.create(run_id="r", step_id="s", tool_call_id="c1", tool_id="t", args={})
    b = led.create(run_id="r", step_id="s", tool_call_id="c2", tool_id="t", args={})
    assert a.execution_id != b.execution_id


def test_ledger_create_is_idempotent_no_duplicate_record():
    led = ExecutionLedger()
    a = led.create(run_id="r", step_id="s", tool_call_id="c1", tool_id="t", args={})
    b = led.create(run_id="r", step_id="s", tool_call_id="c1", tool_id="t", args={})
    assert a is b  # SAME record — not a duplicate
    assert len(led.all()) == 1


def test_same_model_tool_call_id_in_different_runs_is_a_different_execution():
    led = ExecutionLedger()
    a = led.create(
        run_id="runA", step_id="runA:a0:s1", tool_call_id="c1", tool_id="t", args={}
    )
    b = led.create(
        run_id="runB", step_id="runB:a0:s1", tool_call_id="c1", tool_id="t", args={}
    )
    assert a.execution_id != b.execution_id  # the model id is NOT the identity


def test_same_tool_call_in_different_steps_is_distinct():
    led = ExecutionLedger()
    a = led.create(
        run_id="r", step_id="r:a0:s1", tool_call_id="c1", tool_id="t", args={}
    )
    b = led.create(
        run_id="r", step_id="r:a0:s2", tool_call_id="c1", tool_id="t", args={}
    )
    assert a.execution_id != b.execution_id


def test_step_id_differs_across_run_attempt_avoids_resume_collision():
    led = ExecutionLedger()
    a = led.create(
        run_id="r", step_id="r:a0:s1", tool_call_id="c1", tool_id="t", args={}
    )
    b = led.create(
        run_id="r", step_id="r:a1:s1", tool_call_id="c1", tool_id="t", args={}
    )
    assert a.execution_id != b.execution_id


# --- state machine: valid transitions -------------------------------------
@pytest.mark.parametrize(
    "path",
    [
        [ExecutionState.RUNNING, ExecutionState.SUCCEEDED],
        [ExecutionState.RUNNING, ExecutionState.FAILED],
        [ExecutionState.RUNNING, ExecutionState.TIMED_OUT],
        [ExecutionState.RUNNING, ExecutionState.INDETERMINATE],
        [ExecutionState.RUNNING, ExecutionState.CANCELLED],
        [
            ExecutionState.WAITING_APPROVAL,
            ExecutionState.RUNNING,
            ExecutionState.SUCCEEDED,
        ],
        [ExecutionState.WAITING_APPROVAL, ExecutionState.FAILED],
        [ExecutionState.WAITING_APPROVAL, ExecutionState.CANCELLED],
        [ExecutionState.CANCELLED],
        [ExecutionState.DEDUPED],
        [ExecutionState.FAILED],
    ],
)
def test_valid_transition_paths_reach_a_terminal(path):
    e = _exec()
    for to in path:
        e.transition(to)
    assert e.state == path[-1] and e.is_terminal


def test_timestamps_stamped_on_running_and_terminal():
    e = _exec()
    assert e.started_at is None and e.ended_at is None
    e.transition(ExecutionState.RUNNING)
    assert e.started_at is not None and e.ended_at is None
    e.transition(ExecutionState.SUCCEEDED)
    assert e.ended_at is not None


# --- state machine: invalid transitions -----------------------------------
def test_pending_cannot_jump_straight_to_succeeded():
    with pytest.raises(InvalidStateTransition):
        _exec().transition(ExecutionState.SUCCEEDED)


def test_no_running_self_edge():
    e = _exec()
    e.transition(ExecutionState.RUNNING)
    with pytest.raises(InvalidStateTransition):
        e.transition(ExecutionState.RUNNING)


@pytest.mark.parametrize(
    "terminal",
    [
        ExecutionState.SUCCEEDED,
        ExecutionState.FAILED,
        ExecutionState.CANCELLED,
        ExecutionState.TIMED_OUT,
        ExecutionState.INDETERMINATE,
        ExecutionState.DEDUPED,
    ],
)
def test_terminal_states_have_no_outgoing_edges(terminal):
    e = _exec()
    if terminal in (
        ExecutionState.SUCCEEDED,
        ExecutionState.TIMED_OUT,
        ExecutionState.INDETERMINATE,
    ):
        e.transition(ExecutionState.RUNNING)
    e.transition(terminal)
    for to in ExecutionState:
        with pytest.raises(InvalidStateTransition):
            e.transition(to)


# --- begin_attempt is state-neutral (retry stays within RUNNING) ----------
def test_begin_attempt_bumps_counter_without_a_transition():
    e = _exec()
    e.transition(ExecutionState.RUNNING)
    assert e.attempt == 0
    e.begin_attempt()
    assert e.attempt == 1 and e.state is ExecutionState.RUNNING
    assert e.attempt_id == f"{e.execution_id}:a1"
    e.begin_attempt()  # a retry — must NOT raise (no RUNNING->RUNNING edge)
    assert e.attempt == 2 and e.state is ExecutionState.RUNNING


# --- event_fields ---------------------------------------------------------
def test_event_fields_omit_none_and_exclude_workflow_id():
    e = _exec()
    e.transition(ExecutionState.RUNNING)
    fields = e.event_fields()
    assert fields["execution_id"] == e.execution_id
    assert fields["run_id"] == "run1" and fields["step_id"] == "run1:a0:s1"
    assert fields["state"] == "running" and fields["attempt"] == 0
    assert "workflow_id" not in fields  # reserved, kept off the wire

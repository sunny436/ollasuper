"""Phase 9 — the reusable AGENT abstraction (declarative half).

An agent is a specialized execution UNIT: a stable, declarative configuration
over the Phase 1-8 execution engine. It is NOT necessarily a separate model — the
SAME LLM backs many agents that differ only by this spec. The runtime
(`app/agent/base.py`) composes the EXISTING engine from a spec; it adds no
execution path and can only NARROW what Phases 1-8 already permit.

Anti-pattern guard (from the contract): do NOT create one agent per tool or per
skill. `AgentSpec` is generic; the example agents (Research/Coding/Data/…) live
in the tests as FIXTURES, and no agent name is hardcoded here. Only `DEFAULT_AGENT`
(the current assistant, for the grounding proof) is defined.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class AgentOutcome(StrEnum):
    """The kind of a structured, handoff-friendly agent result. A supervisor
    (next phase) ROUTES on this — an agent never merely "returns text"."""

    FINAL_ANSWER = "final_answer"
    FINDINGS = "findings"
    STRUCTURED_RESULT = "structured_result"
    # An external decision is required before the agent can continue (e.g. a
    # side-effecting tool parked awaiting approval).
    NEXT_ACTION = "next_action"
    # The agent tried a capability it was NOT granted (unknown/denied tool) — the
    # supervisor may hand it a different agent or widen the grant.
    NEEDS_CAPABILITY = "needs_capability"
    # Phase 10: the agent needs user input to proceed (via request_clarification) —
    # the orchestrator stops and surfaces the question.
    NEEDS_CLARIFICATION = "needs_clarification"
    FAILURE = "failure"


@dataclass(frozen=True, slots=True)
class CapabilityPolicy:
    """WHICH tools an agent may use, plus its authorization ceiling. Enforced by
    the EXISTING two gates: (1) only these tools are offered/bound this turn, and
    (2) `check_tool_policy` re-decides per call from the scope below. An agent can
    only NARROW the engine's permissions, never widen them."""

    # None = every shared candidate; a frozenset = an explicit allowlist of
    # tool_ids (an agent-specific / restricted tool set).
    tool_ids: frozenset[str] | None = None
    # Phase 2: an allowed-CATEGORY set (a coarse companion to `tool_ids`). When set,
    # a tool is in scope iff its category is here OR its tool_id is in `tool_ids`;
    # enforced at bind, discovery (find_capabilities) AND execution. None (default)
    # = no category restriction, byte-identical to today.
    categories: frozenset[str] | None = None
    include_shared: bool = True
    # A read-only agent (False) drops side-effecting candidates AND runs under
    # READ_SCOPE; a side-effect agent (True) runs under WRITE_SCOPE — still
    # approval-gated, never auto-run.
    side_effects_allowed: bool = False
    # Extra grants/capability tags unioned into the scope (default: the read grant
    # only, from READ_SCOPE).
    granted_permissions: frozenset[str] = frozenset()
    capabilities: frozenset[str] = frozenset()


@dataclass(frozen=True, slots=True)
class ContextPolicy:
    """Bounded working state (Phase 6). No agent stores unlimited context; the
    in-flight history stays `fit_messages`-bounded."""

    max_steps: int = 4
    tool_result_max_chars: int = 8000
    # None -> the runtime uses the request/window default; a value overrides.
    history_budget_tokens: int | None = None


@dataclass(frozen=True, slots=True)
class ExecutionPolicy:
    """The Phase 4/5/7 execution knobs the agent's tools run under."""

    # Run a whole step's independent tool calls at once, bounded by the Ollagraph
    # httpx pool (ollagraph_max_connections) and the adaptive 429 gate — the only
    # real limits. The model batches independent calls (PARALLEL_TOOL_GUIDANCE) and
    # the executor runs them concurrently; a batch wider than the budget QUEUES
    # rather than being refused. `max_tool_calls_per_step` is 0 (off) by default:
    # an emergency backstop, not routine policy. Kept in lockstep with the config
    # defaults + the grounding test (test_agent.py).
    max_concurrent_tools: int = 100
    max_tool_calls_per_step: int = 0
    tool_max_retries: int = 2
    tool_retry_base_s: float = 0.5
    default_timeout_s: float = 30.0
    force_approval_ids: frozenset[str] = frozenset()
    retry_ambiguous_side_effects: bool = False


@dataclass(frozen=True, slots=True)
class OutputContract:
    """The shape the agent is expected to hand off. `schema` (optional) turns a
    JSON final answer into STRUCTURED_RESULT (best-effort, never raises);
    `role_hint` chooses FINDINGS vs FINAL_ANSWER for a plain-text answer."""

    expects: frozenset[AgentOutcome] = frozenset({AgentOutcome.FINAL_ANSWER})
    schema: dict | None = None
    role_hint: str = "answer"  # "answer" | "find"


@dataclass(frozen=True, slots=True)
class AgentSpec:
    """The stable, declarative agent interface: identity, role, instructions, and
    capability / context / execution / output policy. Reusable and testable — the
    unit a future supervisor instantiates many times over ONE LLM."""

    agent_id: str
    role: str = ""
    # STATIC persona fragment. The final system prompt is COMPOSED at run time
    # (this + any per-request custom instructions / memory framing), so a static
    # spec never has to reproduce the runner's dynamic prompt byte-for-byte.
    instructions: str = ""
    capability: CapabilityPolicy = field(default_factory=CapabilityPolicy)
    context: ContextPolicy = field(default_factory=ContextPolicy)
    execution: ExecutionPolicy = field(default_factory=ExecutionPolicy)
    output: OutputContract = field(default_factory=OutputContract)


# The current assistant expressed as a spec — the GROUNDING proof that the
# abstraction can represent the live runner's tool/scope/budget assembly (the
# grounding test asserts `Agent.build_context(DEFAULT_AGENT, …)` reproduces it).
# Values mirror the Settings defaults the runner reads (app/config.py), so the two
# cannot drift on VALUES; the grounding test guards STRUCTURAL drift.
DEFAULT_AGENT = AgentSpec(
    agent_id="assistant",
    role="general assistant",
    instructions="",  # the runner composes the live system prompt per request
    capability=CapabilityPolicy(
        tool_ids=None,  # all discovered/shared candidates
        include_shared=True,
        side_effects_allowed=False,  # default READ scope (side-effect flag off)
    ),
    context=ContextPolicy(max_steps=4, tool_result_max_chars=8000),
    execution=ExecutionPolicy(
        max_concurrent_tools=100,
        max_tool_calls_per_step=0,
        tool_max_retries=2,
        tool_retry_base_s=0.5,
        default_timeout_s=30.0,
        retry_ambiguous_side_effects=False,
    ),
    output=OutputContract(),
)

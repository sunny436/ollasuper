"""Phase 9 — the reusable AGENT abstraction (runtime half).

`Agent` turns an (`AgentSpec`, `AgentEnv`) into a run over the EXISTING Phase 1-8
engine and maps the terminal graph state to a structured `AgentResult`. It holds
no state of its own:

  * the SPEC is policy (identity / capability / context / execution / output);
  * the ENV is per-request infra (llm, writer, registry, adapter, candidates,
    identity, resume state);

and every tool still flows through `execute_tool_calls` -> the Phase-5 strict
allowlist -> `check_tool_policy` -> the Phase-2/3 write-ahead -> the adapter. The
agent NEVER bypasses execution policy — its `CapabilityPolicy` can only NARROW the
tools the engine already permits (a restricted set is simply not offered; the
per-call gate still re-decides).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any

from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, ToolMessage

from app.agent.budget import cumulative_tokens
from app.agent.context import PARALLEL_TOOL_GUIDANCE
from app.agent.executor import ToolExecContext, build_tool_specs
from app.agent.graph import build_graph
from app.agent.orchestration_tools import (
    CLARIFY_TOOL_SPEC,
    DELEGATE_TOOL_SPEC,
    FIND_CAPABILITIES_TOOL_SPEC,
    ORCHESTRATION_BUILTIN_NAMES,
)
from app.agent.policy import READ_SCOPE, WRITE_SCOPE, PolicyScope
from app.agent.spec import AgentOutcome, AgentSpec
from app.logging import get_logger
from app.models.tools import SideEffect

if TYPE_CHECKING:
    from app.models.tools import ToolCandidate

log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class AgentEnv:
    """Per-request INFRA an agent runs against (NOT policy — that is `AgentSpec`).
    A supervisor builds ONE env and runs MANY specs against it."""

    writer: Any  # DeltaWriter — the reactive transport + cancel/suspend authority.
    llm: Any  # the plain chat model (no tools bound).
    run_id: str  # = streamId; the Phase-1 durable run identity.
    user_id: str = ""
    workspace_id: str = ""
    attempt: int = 0
    registry: Any = None  # ToolRegistry | None
    adapter: Any = None  # the single/default ToolAdapter (Ollagraph today)
    adapters: dict = field(default_factory=dict)  # provider -> ToolAdapter (v2)
    candidates: list = field(default_factory=list)  # list[ToolCandidate]
    # bind(specs) -> a tools-bound Runnable. Defaults to `llm.bind_tools`;
    # injectable for tests. A None return -> the runtime falls back to the plain
    # graph rather than failing the turn (mirrors the runner's degradation).
    bind: Callable[[list[dict]], Any] | None = None
    approvals: dict[str, dict] = field(default_factory=dict)
    fit_budget: int | None = None
    reserved_names: frozenset[str] = frozenset()
    # Phase-3 resume state: the durable seen-sets the runner re-seeds so a
    # completed execution is NOT re-run. The agent HONORS this (it does not
    # orchestrate resume itself).
    resume_seen: dict[str, str] = field(default_factory=dict)
    resume_seen_set: frozenset[str] = frozenset()
    # Passed through unchanged when the agent binds the reserved built-ins.
    rag: Any = None
    memory: Any = None
    # Phase 10: when set, the agent gains the orchestration built-ins.
    # `capabilities` (a CapabilityResolver) binds `find_capabilities` + enables
    # dynamic loading; `delegator` (an async callable(role, task) -> dict) binds
    # `delegate_to_agent`. Both None (the Phase-9 default) => unchanged.
    capabilities: Any = None
    delegator: Any = None
    # Phase 1 (v2) execution lineage — correlates records across delegation.
    # All defaulted so existing call sites are unaffected; a top-level run leaves
    # `delegation_id` empty, so its step key is byte-identical to today.
    agent_id: str = ""
    delegation_id: str = ""
    workflow_id: str = ""
    parent_execution_id: str = ""


@dataclass(slots=True)
class AgentState:
    """Mutable, BOUNDED working record of one agent run. The transient in-flight
    messages live in the graph `ChatState` (Phase-6 bounded); this keeps only the
    small structured envelope a supervisor holds — never a second copy of history."""

    task_input: str
    decisions: list[str] = field(default_factory=list)
    intermediate: list[dict] = field(default_factory=list)
    # pending -> running -> done | failed | cancelled | suspended
    completion: str = "pending"


@dataclass(frozen=True, slots=True)
class AgentResult:
    """The structured, handoff-friendly output. A supervisor routes on `outcome`;
    `run_id` links back to the Phase-8 ledger / event trace."""

    agent_id: str
    run_id: str
    outcome: AgentOutcome
    text: str = ""
    data: dict | None = None
    requested_capability: str | None = None
    error: dict | None = None
    metrics: dict = field(default_factory=dict)


class Agent:
    """Stateless runtime: (spec, env) -> AgentResult, composing the Phase 1-8
    engine. All methods are static — an `Agent` instance would carry no state the
    spec/env do not already."""

    @staticmethod
    def build_scope(
        spec: AgentSpec, *, user_id: str = "", workspace_id: str = ""
    ) -> PolicyScope:
        """The per-agent authorization scope. `agent_id` (the reserved Phase-5
        field) becomes LIVE here; a read-only agent inherits READ_SCOPE, a
        side-effect agent WRITE_SCOPE (still approval-gated). Identity is threaded
        from the authenticated request, never the model."""
        base = WRITE_SCOPE if spec.capability.side_effects_allowed else READ_SCOPE
        return replace(
            base,
            user_id=user_id,
            workspace_id=workspace_id,
            tenant_id=workspace_id,
            agent_id=spec.agent_id,
            granted_permissions=(
                base.granted_permissions | spec.capability.granted_permissions
            ),
            capabilities=spec.capability.capabilities,
            # Phase 2: carry the agent's category/tool_id allowlist onto the scope so
            # check_tool_policy hard-DENYs out-of-scope tools at execution (the third,
            # backstop gate). None on both (existing agents) => unrestricted.
            allowed_categories=spec.capability.categories,
            allowed_tool_ids=spec.capability.tool_ids,
        )

    @staticmethod
    def _select_candidates(
        spec: AgentSpec, candidates: list
    ) -> list[ToolCandidate]:
        """Apply the CapabilityPolicy as a candidate filter: an explicit allowlist
        (restricted / agent-specific tools) and the read-only ceiling (a read-only
        agent never even offers a side-effecting tool). This is the first of the
        two existing gates; `check_tool_policy` is the second."""
        out = []
        allow_ids = spec.capability.tool_ids
        allow_cats = spec.capability.categories
        restricted = allow_ids is not None or allow_cats is not None
        for c in candidates:
            tool = c.tool
            # Allowlist: category ∈ categories OR tool_id ∈ tool_ids. Unrestricted
            # (both None) keeps every shared candidate — byte-identical to before.
            if restricted:
                in_scope = (
                    allow_cats is not None and tool.category in allow_cats
                ) or (allow_ids is not None and tool.tool_id in allow_ids)
                if not in_scope:
                    continue
            if (
                not spec.capability.side_effects_allowed
                and tool.side_effect is not SideEffect.READ_ONLY
            ):
                continue
            out.append(c)
        return out

    @staticmethod
    def build_context(
        spec: AgentSpec, env: AgentEnv
    ) -> tuple[ToolExecContext | None, list[dict]]:
        """CANONICAL assembly of the agent's `ToolExecContext` + bound specs from
        the spec + env — the same construction the runner does inline (the
        grounding test guards drift). Returns (None, []) for a no-tool agent (or
        when nothing survives the capability filter and no orchestration built-in is
        enabled) -> the runtime uses the plain graph.

        Phase 10: when the env carries a resolver/delegator, the orchestration
        built-in specs are appended and the ctx is wired for dynamic loading /
        delegation. Guarded on the env fields, so a Phase-9 env is unchanged."""
        # Phase 10 orchestration built-ins (bound when the env enables them).
        orch_specs: list[dict] = []
        if env.capabilities is not None:
            orch_specs.append(FIND_CAPABILITIES_TOOL_SPEC)
            orch_specs.append(CLARIFY_TOOL_SPEC)
        if env.delegator is not None:
            orch_specs.append(DELEGATE_TOOL_SPEC)

        specs: list[dict] = []
        name_to_id: dict[str, str] = {}
        if env.registry is not None:
            selected = Agent._select_candidates(spec, env.candidates)
            if selected:
                specs, name_to_id = build_tool_specs(
                    selected,
                    env.registry,
                    reserved=set(env.reserved_names) | ORCHESTRATION_BUILTIN_NAMES,
                )

        if not name_to_id and not orch_specs:
            return None, []  # nothing to bind -> plain graph

        scope = Agent.build_scope(
            spec, user_id=env.user_id, workspace_id=env.workspace_id
        )
        ctx = ToolExecContext(
            registry=env.registry,
            adapter=env.adapter,
            adapters=dict(env.adapters),
            writer=env.writer,
            scope=scope,
            name_to_tool_id=name_to_id,
            result_max_chars=spec.context.tool_result_max_chars,
            default_timeout_s=spec.execution.default_timeout_s,
            tool_max_retries=spec.execution.tool_max_retries,
            tool_retry_base_s=spec.execution.tool_retry_base_s,
            max_tool_calls_per_step=spec.execution.max_tool_calls_per_step,
            max_stall_steps=spec.execution.max_stall_steps,
            max_concurrent_tools=spec.execution.max_concurrent_tools,
            approvals=dict(env.approvals),
            force_approval_ids=spec.execution.force_approval_ids,
            retry_ambiguous_side_effects=spec.execution.retry_ambiguous_side_effects,
            rag=env.rag,
            memory=env.memory,
            run_id=env.run_id,
            run_attempt=env.attempt,
            # Phase 1 (v2) lineage — empty defaults keep the top-level step key
            # byte-identical; a delegated env sets delegation_id/parent/workflow.
            agent_id=env.agent_id or spec.agent_id,
            delegation_id=env.delegation_id,
            workflow_id=env.workflow_id,
            parent_execution_id=env.parent_execution_id,
            # Phase-3 resume state: honor the runner's re-seeded seen-sets so a
            # completed execution is deduped, never re-run.
            seen_calls=dict(env.resume_seen),
            seen_call_set=set(env.resume_seen_set),
            # Phase 10: dynamic capability resolution + delegation wiring.
            capabilities=env.capabilities,
            delegator=env.delegator,
            rebind=env.bind,
        )
        return ctx, specs + orch_specs

    @staticmethod
    async def run(
        spec: AgentSpec,
        task: str,
        env: AgentEnv,
        *,
        system_prefix: str = "",
        history: list[AnyMessage] | None = None,
    ) -> AgentResult:
        """Run the agent to a terminal `AgentResult`. Composes the system prompt
        (static persona + per-request prefix), builds the graph via the EXISTING
        `build_graph`, invokes it, and maps the terminal state -> outcome."""
        state = AgentState(task_input=task, completion="running")
        ctx, specs = Agent.build_context(spec, env)
        system_prompt = "\n\n".join(
            p for p in (spec.instructions, system_prefix) if p
        )

        llm_tools = None
        if ctx is not None and specs:
            binder = env.bind or getattr(env.llm, "bind_tools", None)
            if binder is not None:
                try:
                    llm_tools = binder(specs)
                except Exception:  # noqa: BLE001 — a bad bind must not fail the turn
                    log.warning("agent.bind_failed", extra={"agent_id": spec.agent_id})
                    llm_tools = None

        use_tools = llm_tools is not None and ctx is not None
        if use_tools:
            # A tool-bound sub-agent (SEO and any future one) gets the same
            # parallel-batching directive as the main model, so it calls independent
            # tools together instead of one-per-step. The executor already runs a
            # step's calls concurrently.
            system_prompt = "\n\n".join(
                p for p in (system_prompt, PARALLEL_TOOL_GUIDANCE) if p
            )
        graph = (
            build_graph(env.llm, llm_tools=llm_tools, tools_ctx=ctx)
            if use_tools
            else build_graph(env.llm)
        )

        init: dict = {
            "messages": [*(history or []), HumanMessage(content=task)],
            "system_prompt": system_prompt,
            "tool_budget": spec.context.max_steps,
        }
        if env.fit_budget:
            init["fit_budget"] = env.fit_budget
        # Phase 10: seed the dynamic working set so the model node can grow + re-bind
        # it as `find_capabilities` discovers more (progressive disclosure).
        if ctx is not None and ctx.capabilities is not None:
            init["bound_specs"] = specs

        try:
            out = await graph.ainvoke(init)
        except Exception as e:  # noqa: BLE001 — a graph crash is a FAILURE outcome
            log.exception("agent.run_failed", extra={"agent_id": spec.agent_id})
            state.completion = "failed"
            return AgentResult(
                spec.agent_id,
                env.run_id,
                AgentOutcome.FAILURE,
                error={"error": "agent_run_failed", "detail": str(e)[:200]},
            )
        result = Agent._finalize(spec, env, ctx, state, out.get("messages", []))
        # Phase 1 (v2): ONE bounded schema repair. Dormant unless output.schema is
        # set (so byte-identical for every current spec). On a schema-invalid
        # result, re-invoke once with a correction; keep the honest failure if the
        # repair still fails or crashes.
        if (
            spec.output.schema is not None
            and result.error is not None
            and result.error.get("code") == "schema_invalid"
        ):
            # Name the EXACT allowed top-level keys in the correction. The bare error
            # ("additional properties are not allowed ('findings', …)") says what is
            # wrong but not what is right, so a model with a strong prior for its own
            # field names (e.g. `findings` instead of `checks_performed`) cannot
            # self-correct from it. Listing the schema's keys makes the one repair
            # attempt actually land. General: any schema-carrying spec benefits.
            props = spec.output.schema.get("properties")
            allowed = ", ".join(props.keys()) if isinstance(props, dict) else ""
            keys_hint = (
                f" The ONLY permitted top-level keys are: {allowed} — use these exact "
                "names (omit any you cannot fill) and include NO other keys."
                if allowed
                else ""
            )
            correction = HumanMessage(
                content=(
                    "Your previous reply did not satisfy the required JSON schema: "
                    f"{result.error.get('detail', '')}.{keys_hint} Return ONLY a JSON "
                    "object matching the schema, with no prose or code fences."
                )
            )
            repair_init = {
                **init,
                "messages": [*out.get("messages", []), correction],
            }
            try:
                out = await graph.ainvoke(repair_init)
                result = Agent._finalize(
                    spec, env, ctx, state, out.get("messages", [])
                )
            except Exception:  # noqa: BLE001 — repair failure keeps the honest result
                log.warning(
                    "agent.schema_repair_failed",
                    extra={"agent_id": spec.agent_id},
                )
        return result

    # -- terminal state -> structured outcome ------------------------------
    @staticmethod
    def _finalize(
        spec: AgentSpec,
        env: AgentEnv,
        ctx: ToolExecContext | None,
        state: AgentState,
        messages: list,
    ) -> AgentResult:
        metrics = Agent._metrics(messages)
        # Authoritative control flags (a Convex field, not model output).
        if env.writer.cancel_requested:
            state.completion = "cancelled"
            return AgentResult(
                spec.agent_id, env.run_id, AgentOutcome.FAILURE,
                error={"status": "cancelled"}, metrics=metrics,
            )
        # Phase 10: the model explicitly asked the user a clarifying question.
        if ctx is not None and getattr(ctx, "clarification", None):
            state.completion = "needs_clarification"
            return AgentResult(
                spec.agent_id, env.run_id, AgentOutcome.NEEDS_CLARIFICATION,
                text=ctx.clarification or "", metrics=metrics,
            )
        if getattr(env.writer, "suspended", False):
            state.completion = "suspended"
            return AgentResult(
                spec.agent_id, env.run_id, AgentOutcome.NEXT_ACTION,
                text="awaiting approval", metrics=metrics,
            )
        # A policy-refusal / unknown-tool observation => the agent needed a
        # capability it was not granted (a real supervisor handoff signal).
        requested = Agent._refused_capability(messages)
        if requested is not None:
            state.completion = "done"
            return AgentResult(
                spec.agent_id, env.run_id, AgentOutcome.NEEDS_CAPABILITY,
                requested_capability=requested, metrics=metrics,
            )
        # The final text answer.
        last = messages[-1] if messages else None
        text = (
            last.content
            if isinstance(last, AIMessage) and isinstance(last.content, str)
            else ""
        )
        state.completion = "done"
        if spec.output.schema is not None:
            data = Agent._try_parse(text)
            ok, detail = Agent._validate_output(data, spec.output.schema)
            if ok:
                return AgentResult(
                    spec.agent_id, env.run_id, AgentOutcome.STRUCTURED_RESULT,
                    text=text, data=data, metrics=metrics,
                )
            # Invalid: a repairable marker — Agent.run may retry ONCE, else this
            # stands as an honest failure (never a silently-wrong structured result).
            return AgentResult(
                spec.agent_id, env.run_id, AgentOutcome.FAILURE,
                text=text, metrics=metrics,
                error={"code": "schema_invalid", "detail": detail},
            )
        if spec.output.role_hint == "find":
            return AgentResult(
                spec.agent_id, env.run_id, AgentOutcome.FINDINGS,
                text=text, metrics=metrics,
            )
        return AgentResult(
            spec.agent_id, env.run_id, AgentOutcome.FINAL_ANSWER,
            text=text, metrics=metrics,
        )

    @staticmethod
    def _refused_capability(messages: list) -> str | None:
        """Scan the run for a tool the agent was NOT allowed to use: an unknown
        (unbound / hallucinated) name, or a `check_tool_policy` DENY. Both come
        back as an error ToolMessage with a plain-JSON body (a SUCCESS result is
        injection-framed text and won't parse — so it is never mistaken for one)."""
        for m in messages:
            if not isinstance(m, ToolMessage) or getattr(m, "status", None) != "error":
                continue
            body = Agent._try_parse(m.content)
            if not isinstance(body, dict):
                continue
            err = str(body.get("error") or "")
            if err.startswith("unknown tool"):
                return err.split(":", 1)[-1].strip() or "unknown"
            if err == "not permitted":
                return body.get("reason") or "not permitted"
        return None

    @staticmethod
    def _metrics(messages: list) -> dict:
        return {
            "messages": len(messages),
            "tool_messages": sum(1 for m in messages if isinstance(m, ToolMessage)),
            "tokens": cumulative_tokens(messages),
        }

    @staticmethod
    def _try_parse(text: object) -> dict | None:
        if not isinstance(text, str):
            return None
        try:
            data = json.loads(text)
        except (ValueError, TypeError):
            return None
        return data if isinstance(data, dict) else None

    @staticmethod
    def _validate_output(data: dict | None, schema: dict) -> tuple[bool, str]:
        """Validate a parsed structured result against its declared JSON-schema.
        Returns (ok, detail). Dormant until an AgentSpec sets `output.schema`, so
        every existing spec (schema=None) never reaches here."""
        if not isinstance(data, dict):
            return False, "output was not a JSON object"
        try:
            import jsonschema

            jsonschema.validate(instance=data, schema=schema)
            return True, ""
        except jsonschema.ValidationError as e:
            return False, str(getattr(e, "message", e))[:300]
        except Exception as e:  # noqa: BLE001 — a bad schema fails closed, not crashes
            return False, f"schema validation error: {type(e).__name__}"

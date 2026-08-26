"""Phase 10 — the orchestrator (routing + adaptive composition + stop conditions).

Decides HOW a task is solved WITHOUT a fixed pipeline and WITHOUT forcing an
agent. It is deliberately thin: the adaptive plan->execute->observe->reassess loop
already lives in the Phase-9 agent graph (the model reassesses each step, and can
`find_capabilities` to reach any tool or `delegate_to_agent` to change strategy).
The orchestrator adds the three things that live ABOVE a single agent:

  1. ROUTING  — a data-driven gate (capability signal), not a giant if/else:
                no capability matches -> direct answer (no agent); else -> agent.
  2. DELEGATION — an injected `delegator` callable turns `delegate_to_agent` into a
                sub-agent run (agent -> agent), bounded by depth. Dependency
                inversion keeps the executor free of any orchestrator import.
  3. PARALLELISM — independent sub-agent branches run concurrently (bounded) and
                are synthesized.

Extensibility: capabilities live in the registry (Phase 2) and agents in the
`AgentRegistry` — adding either is a registration, never a central-switch edit.
The model is never an execution/security authority; every tool a (sub-)agent runs
still passes the Phase 1-8 gates.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from langchain_core.messages import HumanMessage

from app.agent.base import Agent, AgentEnv, AgentResult
from app.agent.graph import build_graph
from app.agent.spec import DEFAULT_AGENT, AgentOutcome, AgentSpec
from app.logging import get_logger
from app.skills.registry import render_skills_block

if TYPE_CHECKING:
    from app.orchestrator.capabilities import CapabilityResolver, ResolvedCapability
    from app.skills.registry import SkillRegistry

log = get_logger(__name__)


class OrchestratorRoute(StrEnum):
    DIRECT_ANSWER = "direct_answer"
    AGENT = "agent"


class AgentRegistry:
    """Extensible role -> AgentSpec map. Adding an agent is a registration, not a
    central-switch edit — the orchestrator never hardcodes a role name."""

    def __init__(self, specs: list[AgentSpec] | None = None) -> None:
        self._by_role: dict[str, AgentSpec] = {}
        for s in specs or ():
            self.register(s)

    def register(self, spec: AgentSpec) -> AgentRegistry:
        self._by_role[spec.agent_id] = spec
        return self

    def get(self, role: str | None) -> AgentSpec | None:
        return self._by_role.get(role) if role else None

    def roles(self) -> list[str]:
        return list(self._by_role)


@dataclass(frozen=True, slots=True)
class OrchestratorResult:
    """The orchestrator's terminal decision + outcome for one request."""

    route: OrchestratorRoute
    outcome: AgentOutcome
    text: str = ""
    data: dict | None = None
    steps: int = 0
    agent_id: str | None = None
    requested_capability: str | None = None
    error: dict | None = None
    metrics: dict = field(default_factory=dict)
    # Phase 11: which skill guidance (id + version) influenced this run.
    active_skills: list[dict] = field(default_factory=list)


class Orchestrator:
    """Routes a request to a direct answer or an agent, wires dynamic capability
    resolution + delegation, and enforces the top-level stop conditions."""

    def __init__(
        self,
        *,
        resolver: CapabilityResolver,
        registry: AgentRegistry,
        settings: Any,
        min_score: float | None = None,
        working_set: int | None = None,
        skills: SkillRegistry | None = None,
        skill_budget_chars: int | None = None,
    ) -> None:
        self._resolver = resolver
        self._registry = registry
        self._settings = settings
        self._min_score = min_score
        self._working_set = working_set or getattr(
            settings, "ai_capability_working_set", 8
        )
        # Phase 11: optional skill layer. None (the Phase-10 default) -> no skill
        # discovery, no guidance composed -> behavior byte-identical.
        self._skills = skills
        self._skill_budget = skill_budget_chars or getattr(
            settings, "ai_skill_instructions_budget_chars", 6000
        )

    async def run(
        self,
        request: str,
        env: AgentEnv,
        *,
        agent_role: str | None = None,
        system_prompt: str = "",
        history: list | None = None,
    ) -> OrchestratorResult:
        """Route + run one request. STOP conditions are enforced here (cancel) and
        inside the agent (approval/clarification/budget); the outcome mapping
        surfaces each terminal faithfully. `history` carries prior conversation
        (Phase 12 — multi-turn)."""
        # STOP: user cancellation, checked before any work.
        if env.writer.cancel_requested:
            return OrchestratorResult(
                OrchestratorRoute.AGENT, AgentOutcome.FAILURE,
                error={"status": "cancelled"},
            )
        # Phase 11: skill discovery + capability seeding (shared with delegation).
        candidates, skill_prompt, skill_approvals, active_skills = self._prepare_run(
            request
        )
        sys = self._compose(system_prompt, skill_prompt)
        # ROUTE: no capability (from request OR skill) -> answer directly (NO agent),
        # still carrying any skill guidance (skill -> direct answer).
        if not candidates:
            return await self._direct_answer(
                request, env, sys, active_skills, history=history
            )

        # else -> engage a skill-guided agent with dynamic resolution + delegation.
        base_spec = self._registry.get(agent_role) or DEFAULT_AGENT
        spec = self._tighten(base_spec, skill_approvals)
        agent_env = replace(
            env,
            candidates=candidates,
            capabilities=self._resolver,
            delegator=self._make_delegator(env, 0),
        )
        result = await Agent.run(
            spec, request, agent_env, system_prefix=sys, history=history
        )
        return self._to_result(
            OrchestratorRoute.AGENT, result, steps=1, active_skills=active_skills
        )

    def _prepare_run(
        self, task: str
    ) -> tuple[list, str, frozenset[str], list[dict]]:
        """Phase 11: skill discovery + capability seeding for one task. Shared by
        `run` and the delegator so skills compose through delegation. Returns the
        bounded working-set candidates (skill hints first, then request matches,
        deduped + capped), the composed TRUSTED guidance block, the skills'
        tighten-only approvals, and the active-skill (id, version) records."""
        active = (
            self._skills.discover(
                task,
                limit=getattr(self._settings, "ai_skill_max_active", 3),
                min_score=getattr(self._settings, "ai_skill_min_score", 0.2),
            )
            if self._skills is not None
            else []
        )
        skill_prompt = (
            render_skills_block(active, char_budget=self._skill_budget)
            if active
            else ""
        )
        skill_ids: set[str] = set()
        approvals: set[str] = set()
        for a in active:
            skill_ids |= set(a.manifest.preferred_capabilities)
            approvals |= set(a.manifest.require_approval)
        skill_caps = self._resolver.by_ids(skill_ids) if skill_ids else []
        request_caps = self._resolver.resolve(
            task, limit=self._working_set, scope=None, min_score=self._min_score
        )
        deduped = self._dedupe(list(skill_caps) + list(request_caps))
        candidates = [r.candidate for r in deduped[: self._working_set]]
        active_meta = [
            {"id": a.manifest.skill_id, "version": a.manifest.version} for a in active
        ]
        return candidates, skill_prompt, frozenset(approvals), active_meta

    @staticmethod
    def _dedupe(caps: list[ResolvedCapability]) -> list[ResolvedCapability]:
        seen: set[str] = set()
        out: list[ResolvedCapability] = []
        for c in caps:
            if c.tool.tool_id in seen:
                continue
            seen.add(c.tool.tool_id)
            out.append(c)
        return out

    @staticmethod
    def _compose(system_prompt: str, skill_prompt: str) -> str:
        return "\n\n".join(p for p in (system_prompt, skill_prompt) if p)

    @staticmethod
    def _tighten(spec: AgentSpec, approvals: frozenset[str]) -> AgentSpec:
        """Fold a skill's required approvals into the agent's force_approval_ids —
        UNION only (tighten). A skill can never loosen a gate."""
        if not approvals:
            return spec
        exe = spec.execution
        return replace(
            spec,
            execution=replace(
                exe, force_approval_ids=exe.force_approval_ids | approvals
            ),
        )

    async def run_parallel(
        self,
        tasks: list[str],
        env: AgentEnv,
        *,
        roles: list[str] | None = None,
        synthesize: Callable[[list[str]], str] | None = None,
    ) -> OrchestratorResult:
        """Run independent sub-agent branches CONCURRENTLY (bounded) and synthesize
        — the parallel-branch route. Reuses the Phase-7 bounded-concurrency shape
        (semaphore + gather); each branch is a self-contained sub-agent run."""
        cap = max(
            1, getattr(self._settings, "ai_orchestrator_max_parallel_branches", 4)
        )
        sem = asyncio.Semaphore(cap)
        delegator = self._make_delegator(env, 0)
        roles = roles or [DEFAULT_AGENT.agent_id] * len(tasks)

        async def branch(role: str, task: str) -> dict:
            async with sem:
                return await delegator(role, task)

        results = await asyncio.gather(
            *(branch(r, t) for r, t in zip(roles, tasks, strict=False))
        )
        texts = [r.get("text", "") for r in results]
        combined = (
            synthesize(texts) if synthesize else "\n\n".join(t for t in texts if t)
        )
        return OrchestratorResult(
            route=OrchestratorRoute.AGENT,
            outcome=AgentOutcome.FINDINGS,
            text=combined,
            steps=len(tasks),
            data={"branches": results},
        )

    # -- internals ---------------------------------------------------------
    async def _direct_answer(
        self,
        request: str,
        env: AgentEnv,
        system_prompt: str,
        active_skills: list[dict] | None = None,
        *,
        history: list | None = None,
    ) -> OrchestratorResult:
        """No capability signal -> a direct LLM answer via the PLAIN graph. No agent
        is constructed (the simple-task requirement); any skill guidance still rides
        the system prompt (skill -> direct answer)."""
        graph = build_graph(env.llm)
        out = await graph.ainvoke(
            {
                "messages": [*(history or []), HumanMessage(content=request)],
                "system_prompt": system_prompt,
            }
        )
        last = out["messages"][-1] if out.get("messages") else None
        text = getattr(last, "content", "") if last is not None else ""
        return OrchestratorResult(
            OrchestratorRoute.DIRECT_ANSWER,
            AgentOutcome.FINAL_ANSWER,
            text=text if isinstance(text, str) else "",
            steps=0,
            active_skills=active_skills or [],
        )

    def make_delegator(self, env: AgentEnv) -> Callable[[str, str], Any]:
        """Public entry to the tested delegator (Phase 13): the live streaming runner
        injects this into the top agent's executor as `delegate_to_agent`, so a
        specialist sub-agent runs as a batch tool observation while the top agent's
        answer keeps streaming."""
        return self._make_delegator(env, 0)

    def _make_delegator(
        self, env: AgentEnv, depth: int
    ) -> Callable[[str, str], Any]:
        """Build the `delegate_to_agent` callable injected into the executor. Each
        sub-agent runs with its OWN execution context (own ledger/allowlist) and
        the SHARED writer; delegation is bounded by `max_delegation_depth`. Phase 11:
        the sub-task runs its OWN skill discovery (skills compose through
        delegation)."""
        max_depth = getattr(self._settings, "ai_orchestrator_max_delegation_depth", 2)
        registry = self._registry

        async def delegate(role: str, task: str) -> dict:
            if depth >= max_depth:
                return {
                    "ok": False, "outcome": "failure",
                    "text": "maximum delegation depth reached",
                }
            spec = registry.get(role)
            if spec is None:
                return {
                    "ok": False, "outcome": str(AgentOutcome.NEEDS_CAPABILITY),
                    "text": f"unknown agent role: {role}",
                }
            candidates, skill_prompt, skill_approvals, _ = self._prepare_run(task)
            spec = self._tighten(spec, skill_approvals)
            sub_env = replace(
                env,
                candidates=candidates,
                capabilities=self._resolver,
                delegator=self._make_delegator(env, depth + 1),
            )
            result = await Agent.run(spec, task, sub_env, system_prefix=skill_prompt)
            return {
                "ok": result.outcome != AgentOutcome.FAILURE,
                "outcome": str(result.outcome),
                "text": result.text,
            }

        return delegate

    @staticmethod
    def _to_result(
        route: OrchestratorRoute,
        result: AgentResult,
        *,
        steps: int,
        active_skills: list[dict] | None = None,
    ) -> OrchestratorResult:
        return OrchestratorResult(
            route=route,
            outcome=result.outcome,
            text=result.text,
            data=result.data,
            steps=steps,
            active_skills=active_skills or [],
            agent_id=result.agent_id,
            requested_capability=result.requested_capability,
            error=result.error,
            metrics=result.metrics,
        )

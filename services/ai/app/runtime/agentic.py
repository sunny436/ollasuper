"""Phase 12 — the full agentic runtime (final integration).

ONE entrypoint that COMPOSES the contracts built in Phases 1-11 — it introduces no
new architecture. The final system resembles:

    LLM + Orchestrator + Capability Discovery + Skills + Agents + Tools
        + Durable Execution Engine + Policy + Memory/Context + Observability

not one giant prompt / agent / tool-list / executor. `AgenticRuntime` is the thin
assembly of those components + the single `run` lifecycle:

    request -> orchestrator -> understanding/discovery -> authorization
        -> plan / next action -> direct tool | skill | agent | combination
        -> execution engine -> result -> observation -> reassessment
        -> next action or completion -> final synthesis -> user

Reasoning/execution complexity scales to the task: a simple request is a direct
LLM answer (no agent built); a complex one fans out to tools/skills/agents. There
is no arbitrary Top-K capability ceiling — `find_capabilities` reaches any
registered tool by progressive loading, while context stays bounded.

NOTE (honest): this composes the SAME `build_graph`/executor the live `runner.py`
uses, but via `graph.ainvoke` (batch). The live streaming path (`graph.astream`)
is not yet wired to this runtime — see ARCHITECTURE.md "known limitations".
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from app.agent.spec import DEFAULT_AGENT, AgentSpec
from app.orchestrator.capabilities import CapabilityResolver
from app.orchestrator.orchestrator import (
    AgentRegistry,
    Orchestrator,
    OrchestratorResult,
)
from app.skills.registry import SkillRegistry
from app.tools.selection import ToolSelector

if TYPE_CHECKING:
    from app.agent.base import AgentEnv
    from app.skills.manifest import SkillManifest
    from app.tools.registry import ToolRegistry


class AgenticRuntime:
    """The integrated agentic runtime. Holds the assembled orchestrator + the
    capability/agent/skill registries; `run` executes the full lifecycle for one
    request, `run_parallel` fans out independent branches."""

    def __init__(
        self,
        *,
        orchestrator: Orchestrator,
        tool_registry: ToolRegistry,
        agent_registry: AgentRegistry,
        skill_registry: SkillRegistry | None,
    ) -> None:
        self.orchestrator = orchestrator
        self.tools = tool_registry
        self.agents = agent_registry
        self.skills = skill_registry

    @classmethod
    def build(
        cls,
        settings: Any,
        *,
        tool_registry: ToolRegistry,
        skills: list[SkillManifest] = (),
        agents: list[AgentSpec] = (),
        working_set: int | None = None,
        skill_budget_chars: int | None = None,
    ) -> AgenticRuntime:
        """Assemble the runtime from the settings + a discovered tool registry.
        The agent registry always carries the DEFAULT_AGENT (the general
        assistant); empty `skills` -> no skill layer (Phase-10 byte-identical)."""
        resolver = CapabilityResolver(tool_registry, ToolSelector(tool_registry))
        agent_specs = list(agents) or [DEFAULT_AGENT]
        if all(s.agent_id != DEFAULT_AGENT.agent_id for s in agent_specs):
            agent_specs = [DEFAULT_AGENT, *agent_specs]
        agent_registry = AgentRegistry(agent_specs)
        skill_registry = SkillRegistry(list(skills)) if skills else None
        orchestrator = Orchestrator(
            resolver=resolver,
            registry=agent_registry,
            settings=settings,
            working_set=working_set,
            skills=skill_registry,
            skill_budget_chars=skill_budget_chars,
        )
        return cls(
            orchestrator=orchestrator,
            tool_registry=tool_registry,
            agent_registry=agent_registry,
            skill_registry=skill_registry,
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
        """Run one request through the full lifecycle. Simple requests stay simple
        (direct answer, no agent); complex ones scale up. Every tool a
        (sub-)agent runs still passes the Phase 1-8 gates."""
        return await self.orchestrator.run(
            request,
            env,
            agent_role=agent_role,
            system_prompt=system_prompt,
            history=history,
        )

    async def run_parallel(
        self,
        tasks: list[str],
        env: AgentEnv,
        *,
        roles: list[str] | None = None,
        synthesize: Callable[[list[str]], str] | None = None,
    ) -> OrchestratorResult:
        """Run independent branches concurrently (bounded) + synthesize."""
        return await self.orchestrator.run_parallel(
            tasks, env, roles=roles, synthesize=synthesize
        )

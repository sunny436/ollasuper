"""The ONE factory that builds a fully-populated `AgentEnv` (Phase 1 v2).

Before this, only the delegator got an `AgentEnv`, and the runner hand-built it
missing seven fields (approvals/RAG/memory/resume/fit_budget/attempt/reserved),
so delegated sub-agents silently lost that context. The runner now builds the
delegator env HERE, so a sub-agent inherits the same infra the top agent has.

Delegator-fix-only (by decision): the top-level path keeps its proven inline
`ToolExecContext` construction; this factory is the single source for the env the
delegator consumes.
"""

from __future__ import annotations

from typing import Any

from app.agent.base import AgentEnv


def build_live_agent_env(
    *,
    writer: Any,
    llm: Any,
    req: Any,
    registry: Any = None,
    adapter: Any = None,
    adapters: dict | None = None,
    candidates: list | None = None,
    bind: Any = None,
    capabilities: Any = None,
    rag: Any = None,
    memory: Any = None,
    fit_budget: int | None = None,
    reserved_names: frozenset[str] = frozenset(),
    approvals: dict | None = None,
    resume_seen: dict | None = None,
    resume_seen_set: frozenset[str] = frozenset(),
    workflow_id: str = "",
) -> AgentEnv:
    """Assemble the rich per-request env. Identity comes from `req` (streamId /
    userId / workspaceId / attempt); every context field is passed through so a
    delegated agent keeps approvals, RAG, memory, resume state, budget, and
    execution identity."""
    return AgentEnv(
        writer=writer,
        llm=llm,
        run_id=req.streamId,
        user_id=req.userId,
        workspace_id=req.workspaceId,
        attempt=getattr(req, "attempt", 0),
        registry=registry,
        adapter=adapter,
        adapters=dict(adapters or {}),
        candidates=list(candidates or []),
        bind=bind,
        approvals=dict(approvals or {}),
        fit_budget=fit_budget,
        reserved_names=frozenset(reserved_names or ()),
        resume_seen=dict(resume_seen or {}),
        resume_seen_set=frozenset(resume_seen_set or ()),
        rag=rag,
        memory=memory,
        capabilities=capabilities,
        workflow_id=workflow_id or req.streamId,
    )
